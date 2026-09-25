//! A small background controller: D-Bus tray and one disposable Chromium process.
use crate::{
    Args, agent,
    files::Dirs,
    ipc,
    shell::{self, Shell},
    smoke, window,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::linux::net::SocketAddrExt;
use std::os::unix::{
    net::{SocketAddr, UnixListener, UnixStream},
    process::CommandExt,
};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
use url::Url;

pub struct Host {
    resources: PathBuf,
    electron: PathBuf,
    software: bool,
    inspector: Option<std::net::SocketAddr>,
    gui: Mutex<Option<Arc<Gui>>>,
    stopped: Condvar,
}
struct Gui {
    writer: Mutex<UnixStream>,
    pid: u32,
}
impl Gui {
    fn send(&self, value: &Value) -> io::Result<()> {
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        serde_json::to_writer(&mut *writer, value)?;
        writer.write_all(b"\n")
    }
}

pub fn run(args: Args) {
    if let Err(e) = start(args) {
        eprintln!("quotum: {e}");
        std::process::exit(1);
    }
}
fn start(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let data = xdg("XDG_DATA_HOME", ".local/share")?.join("com.padurets.quotum");
    let logs = xdg("XDG_CACHE_HOME", ".cache")?.join("com.padurets.quotum/logs");
    let dirs = Dirs::new(data, logs, args.smoke.is_some());
    dirs.ensure()?;
    let mut hash = DefaultHasher::new();
    dirs.data.canonicalize()?.hash(&mut hash);
    let address = SocketAddr::from_abstract_name(format!("quotum-{}-{:x}", unsafe { libc::getuid() }, hash.finish()))?;
    let lock = match quotum_core::config::lock_file(&dirs.app_lock()) {
        Ok(lock) => lock,
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
            if !args.hidden {
                // The winner may still be between taking the lock and binding its socket.
                for _ in 0..20 {
                    if let Ok(mut socket) = UnixStream::connect_addr(&address) {
                        socket.write_all(b"O")?;
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                return Err("another copy runs but could not open its window; quit it before switching builds".into());
            }
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };
    let listener = UnixListener::bind_addr(&address)?;
    let exe = std::env::current_exe()?;
    let bin = exe.parent().ok_or("no executable directory")?;
    let packaged = bin.join("../share/quotum");
    let resources = if cfg!(debug_assertions) && !packaged.exists() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
    } else {
        packaged
    };
    let packaged_node = bin.join("quotum-node");
    let node = if cfg!(debug_assertions) && !packaged_node.exists() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/quotum-node-x86_64-unknown-linux-gnu")
    } else {
        packaged_node
    };
    let host = Host {
        electron: resources.join("electron/electron"),
        resources: resources.clone(),
        software: args.software_rendering,
        inspector: qa_inspector(
            std::env::var("QUOTUM_NATIVE_QA").ok().as_deref(),
            std::env::var("QUOTUM_INSPECTOR_SERVER").ok().as_deref(),
            ["QUOTUM_APP_DATA_DIR", "QUOTUM_STATE_DIR", "QUOTUM_CONFIG"]
                .iter()
                .all(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty())),
        ),
        gui: Mutex::new(None),
        stopped: Condvar::new(),
    };
    let _ = window::HUB_LOG.set(dirs.hub_log().display().to_string());
    let shell = Arc::new(Shell::new(dirs, node, resources.join("hub"), args.smoke.map(smoke::Smoke::new), lock, host));
    shell.hub_log.line(&format!(
        "app: Quotum {} ({}) starts with Chromium",
        env!("CARGO_PKG_VERSION"),
        env!("QUOTUM_COMMIT")
    ));
    let accepting = shell.clone();
    thread::spawn(move || {
        for mut socket in listener.incoming().flatten() {
            let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            // The abstract socket only accepts an Open signal from the same user.
            let same_user = unsafe {
                libc::getsockopt(
                    socket.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut credentials as *mut libc::ucred).cast(),
                    &mut size,
                ) == 0
                    && credentials.uid == libc::getuid()
            };
            if !same_user {
                continue;
            }
            let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
            let mut byte = [0];
            if socket.read_exact(&mut byte).is_ok() && byte == *b"O" {
                open(&accepting);
            }
        }
    });
    let mut signals = signal_hook::iterator::Signals::new([libc::SIGTERM, libc::SIGINT, libc::SIGHUP])?;
    let ending = shell.clone();
    thread::spawn(move || {
        if signals.forever().next().is_some() {
            shell::shutdown(&ending, true, false);
        }
    });
    create_tray(&shell);
    if shell.smoke.is_some() {
        smoke::Smoke::watch(&shell);
    }
    let hub = shell.clone();
    thread::spawn(move || shell::run_hub(hub));
    let ticker = shell.clone();
    thread::spawn(move || shell::run_ticker(ticker));
    if !args.hidden {
        open(&shell);
    }
    loop {
        thread::park();
    }
}
/// Native profiling needs CDP. Only an explicitly isolated debug build can listen;
/// installed release builds ignore these variables even if inherited from a test shell.
fn qa_inspector(qa: Option<&str>, endpoint: Option<&str>, isolated: bool) -> Option<std::net::SocketAddr> {
    if !cfg!(debug_assertions) || qa != Some("1") || !isolated {
        return None;
    }
    endpoint
        .and_then(|value| value.parse::<std::net::SocketAddr>().ok())
        .filter(|address| address.ip() == std::net::Ipv4Addr::LOCALHOST && address.port() != 0)
}

fn xdg(variable: &str, fallback: &str) -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os(variable).map(PathBuf::from).filter(|p| p.is_absolute()) {
        return Ok(path);
    }
    std::env::var_os("HOME").map(|p| PathBuf::from(p).join(fallback)).ok_or_else(|| io::Error::other("HOME is not set"))
}

pub fn grant_port(_: &Shell, _: u16) {}
pub fn is_open(shell: &Shell) -> bool {
    shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}
pub fn open(shell: &Arc<Shell>) {
    let shell = shell.clone();
    thread::spawn(move || {
        let _opening = shell.window_lock.lock().unwrap_or_else(|e| e.into_inner());
        if shell.exiting() {
            return;
        }
        let gui = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(gui) = gui {
            let _ = gui.send(&json!({"type":"focus"}));
            return;
        }
        if let Err(e) = launch(&shell) {
            shell.hub_log.line(&format!("app: the Chromium window did not open: {e}"));
            if shell.smoke.is_some() {
                smoke::fail("the Chromium window did not open");
            }
        }
    });
}

fn launch(shell: &Arc<Shell>) -> io::Result<()> {
    let (parent, child) = UnixStream::pair()?;
    parent.set_write_timeout(Some(Duration::from_secs(2)))?;
    let reader = parent.try_clone()?;
    let fd = child.as_raw_fd();
    let mut command = Command::new(&shell.host.electron);
    command
        .arg(shell.host.resources.join("gui/main.cjs"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0);
    // Do not let inherited Node/Electron switches open a debugger or disable isolation.
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_some_and(|n| {
            n.starts_with("ELECTRON_") || n.starts_with("NODE_") || n.starts_with("WEBKIT_") || n.starts_with("QUOTUM_")
        }) {
            command.env_remove(name);
        }
    }
    // This driver is verified with XWayland; choose it before Chromium initializes Ozone.
    if std::env::var_os("DISPLAY").is_some() && nvidia() {
        command.arg("--ozone-platform=x11").env("GDK_BACKEND", "x11");
    }
    // An unpacked/AppImage helper is not setuid. Chromium still uses its userns sandbox.
    use std::os::unix::fs::MetadataExt;
    let helper = shell.host.electron.with_file_name("chrome-sandbox");
    if !std::fs::metadata(helper).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o4000 != 0) {
        command.arg("--disable-setuid-sandbox");
    }
    if let Some(address) = shell.host.inspector {
        command.arg("--remote-debugging-address=127.0.0.1").arg(format!("--remote-debugging-port={}", address.port()));
    }
    if shell.host.software {
        command.arg("--quotum-software-rendering");
    }
    // Only async-signal-safe operations after fork; fd 3 is a private socket, not a port.
    // Its EOF ends the GUI when the controller dies. PDEATHSIG would track this
    // short-lived opening thread, not the lifetime of the controller process.
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut process = command.spawn()?;
    drop(child);
    let gui = Arc::new(Gui { writer: Mutex::new(parent), pid: process.id() });
    *shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()) = Some(gui.clone());
    shell.hub_log.line(&format!("app: Chromium starts (pid {})", gui.pid));
    let logging = shell.clone();
    let stderr = process.stderr.take().expect("piped stderr");
    thread::spawn(move || {
        let mut lines = BufReader::new(stderr);
        while let Ok(Some(line)) = read_frame(&mut lines) {
            let line = if let crate::hub::HubState::Ready(ready) = logging.hub().0 {
                line.replace(&ready.key, "[key]").replace(&ready.token, "[token]")
            } else {
                line
            };
            logging.hub_log.line(&format!("chromium: {line}"));
        }
    });
    let reading = shell.clone();
    let channel = gui.clone();
    let reading = thread::spawn(move || read_messages(&reading, &channel, reader));
    let waiting = shell.clone();
    thread::spawn(move || {
        let status = process.wait();
        // Drain the private channel before publishing completion: a child-fault report
        // written during teardown must not race the controller's successful exit.
        let _ = reading.join();
        if !status.as_ref().is_ok_and(|s| s.success()) && waiting.smoke.is_some() {
            smoke::fail("Chromium exited unsuccessfully");
        }
        waiting.hub_log.line(&format!("app: Chromium ended ({status:?})"));
        let mut current = waiting.host.gui.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_ref().is_some_and(|g| Arc::ptr_eq(g, &gui)) {
            current.take();
        }
        waiting.host.stopped.notify_all();
        drop(current);
        if !waiting.exiting() {
            let state = waiting.agent.lock().unwrap_or_else(|e| e.into_inner()).state.clone();
            if agent::closing_quits(&state, waiting.take_over_confirmed()) {
                shell::quit(&waiting);
            }
        }
    });
    Ok(())
}
fn nvidia() -> bool {
    std::fs::read_dir("/sys/class/drm").into_iter().flatten().flatten().any(|e| {
        e.file_name().to_string_lossy().starts_with("renderD")
            && e.path()
                .join("device/driver")
                .canonicalize()
                .ok()
                .and_then(|p| p.file_name().map(|s| s == "nvidia"))
                .unwrap_or(false)
    })
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Message {
    Ready,
    Request { id: u64, origin: String, request: Value },
    Loaded { url: String },
    Fault { process: String, reason: String },
    Graphics { electron: String, chromium: String, backend: String, compositing: String, rasterization: String },
}
/// Bounded frames: neither a broken GUI nor stderr can allocate unbounded memory.
fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let count = reader.take(65537).read_until(b'\n', &mut bytes)?;
    if count == 0 {
        return Ok(None);
    }
    if count > 65536 || bytes.last() != Some(&b'\n') {
        return Err(io::Error::other("invalid GUI frame"));
    }
    String::from_utf8(bytes).map(|s| Some(s.trim_end().to_owned())).map_err(io::Error::other)
}
fn read_messages(shell: &Arc<Shell>, gui: &Arc<Gui>, socket: UnixStream) {
    let mut reader = BufReader::new(socket);
    while let Ok(Some(frame)) = read_frame(&mut reader) {
        let Ok(message) = serde_json::from_str::<Message>(&frame) else {
            break;
        };
        match message {
            Message::Ready => {
                let _ = gui.send(&json!({"type":"init", "inspect": shell.host.inspector.is_some(), "profile": shell.dirs.webview.clone().unwrap_or_else(|| shell.dirs.data.join("chromium")), "geometry": shell.dirs.data.join("window.json")}));
                send_state(shell, gui, false);
            }
            Message::Request { id, origin, request } => {
                // Serialize operations per window, with a bounded input stream.
                let result = Url::parse(&origin).map_err(|_| "invalid origin".into()).and_then(|url| {
                    let request = serde_json::from_value(request).map_err(|_| "invalid app command".to_string())?;
                    ipc::execute(shell, &url, request)
                });
                let response = match result {
                    Ok(value) => json!({"type":"response", "id":id, "value":value}),
                    Err(error) => json!({"type":"response", "id":id, "error":error}),
                };
                if gui.send(&response).is_err() {
                    break;
                }
            }
            Message::Loaded { url } => {
                if let (Some(smoke), Ok(url)) = (&shell.smoke, Url::parse(&url)) {
                    smoke.page_loaded(shell, &url);
                }
            }
            Message::Graphics { electron, chromium, backend, compositing, rasterization } => {
                shell.hub_log.line(&format!("app: Electron {electron}, Chromium {chromium}, display {backend}, compositing {compositing}, rasterization {rasterization}"));
            }
            Message::Fault { process, reason } => {
                shell.hub_log.line(&format!("app: Chromium child ended unexpectedly ({process}: {reason})"));
                if shell.smoke.is_some() {
                    smoke::fail("a Chromium child failed");
                }
            }
        }
    }
    // EOF also occurs during normal close. Any unreadable protocol must end this GUI.
    let _ = gui.send(&json!({"type":"close"}));
}
fn send_state(shell: &Arc<Shell>, gui: &Gui, force: bool) {
    let (state, generation) = shell.hub();
    let _ = gui
        .send(&json!({"type":"state", "generation":generation, "url":window::target(&state).as_str(), "force":force}));
}
pub fn follow(shell: &Arc<Shell>) {
    if let Some(gui) = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        send_state(shell, &gui, false);
    }
}
pub fn reenter(shell: &Arc<Shell>) {
    let gui = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(gui) = gui {
        send_state(shell, &gui, true);
    } else {
        open(shell);
    }
}
pub fn leave(shell: &Arc<Shell>) {
    if let Some(gui) = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        let _ = gui.send(&json!({"type":"leave"}));
    }
}
pub fn close(shell: &Arc<Shell>) {
    let gui = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(gui) = gui {
        let _ = gui.send(&json!({"type":"close"}));
        let current = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner());
        let (current, timeout) = shell
            .host
            .stopped
            .wait_timeout_while(current, Duration::from_secs(5), |g| g.as_ref().is_some_and(|g| Arc::ptr_eq(g, &gui)))
            .unwrap_or_else(|e| e.into_inner());
        drop(current);
        if timeout.timed_out() {
            shell.hub_log.line("app: Chromium did not close within five seconds; ending its process group");
            unsafe {
                libc::kill(-(gui.pid as libc::pid_t), libc::SIGKILL);
            }
            if shell.smoke.is_some() {
                smoke::fail("Chromium needed forced termination");
            }
            let current = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner());
            let _ended = shell.host.stopped.wait_timeout_while(current, Duration::from_secs(2), |g| {
                g.as_ref().is_some_and(|g| Arc::ptr_eq(g, &gui))
            });
        }
    }
}
pub fn exit(shell: &Arc<Shell>, _: bool) {
    close(shell);
    std::process::exit(0);
}

pub fn autostart_enabled(_: &Shell) -> bool {
    autostart_file()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|s| s.contains("Exec=") && !s.lines().any(|l| l == "Hidden=true"))
}
fn autostart_file() -> io::Result<PathBuf> {
    Ok(xdg("XDG_CONFIG_HOME", ".config")?.join("autostart/Quotum.desktop"))
}
pub fn set_autostart(_: &Shell, on: bool) -> Result<(), String> {
    let change = || -> io::Result<()> {
        let file = autostart_file()?;
        if !on {
            return match std::fs::remove_file(file) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                other => other,
            };
        }
        let exe =
            std::env::var_os("APPIMAGE").map(PathBuf::from).map_or_else(std::env::current_exe, Ok)?.canonicalize()?;
        let exec = desktop_exec(&exe.to_string_lossy())?;
        std::fs::create_dir_all(file.parent().expect("autostart directory"))?;
        let next = file.with_extension("desktop.new");
        std::fs::write(
            &next,
            format!(
                "[Desktop Entry]\nType=Application\nName=Quotum\nExec={exec} --hidden\nIcon=quotum\nTerminal=false\n"
            ),
        )?;
        std::fs::rename(next, file)
    };
    change().map_err(|e| e.to_string())
}
fn desktop_exec(path: &str) -> io::Result<String> {
    if path.contains(['\n', '\r', '\0']) {
        return Err(io::Error::other("invalid executable path"));
    }
    // Desktop Entry escaping is applied after the quoted Exec argument is parsed.
    Ok(format!(
        "\"{}\"",
        path.replace('\\', "\\\\\\\\")
            .replace('"', "\\\\\"")
            .replace('`', "\\\\`")
            .replace('$', "\\\\$")
            .replace('%', "%%")
    ))
}

struct Tray {
    shell: Arc<Shell>,
}
impl ksni::Tray for Tray {
    fn id(&self) -> String {
        "quotum".into()
    }
    fn title(&self) -> String {
        "Quotum".into()
    }
    fn icon_name(&self) -> String {
        self.shell.host.resources.join("icon.png").to_string_lossy().into_owned()
    }
    fn activate(&mut self, _: i32, _: i32) {
        open(&self.shell);
    }
    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        let ru = sys_locale::get_locale().is_some_and(|s| s.to_lowercase().starts_with("ru"));
        vec![
            ksni::menu::StandardItem {
                label: if ru { "Открыть Quotum" } else { "Open Quotum" }.into(),
                activate: Box::new(|this: &mut Self| open(&this.shell)),
                ..Default::default()
            }
            .into(),
            ksni::menu::StandardItem {
                label: if ru { "Выйти" } else { "Quit" }.into(),
                activate: Box::new(|this: &mut Self| shell::quit(&this.shell)),
                ..Default::default()
            }
            .into(),
        ]
    }
}
fn create_tray(shell: &Arc<Shell>) {
    use ksni::blocking::TrayMethods;
    let shell = shell.clone();
    thread::spawn(move || match (Tray { shell: shell.clone() }).spawn() {
        Ok(handle) => {
            while !shell.exiting() {
                thread::park();
            }
            drop(handle);
        }
        Err(e) => shell.hub_log.line(&format!("app: no tray icon: {e}")),
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inspection_is_only_for_explicit_isolated_debug_runs_on_loopback() {
        assert_eq!(qa_inspector(Some("1"), Some("127.0.0.1:9123"), true).is_some(), cfg!(debug_assertions));
        assert!(qa_inspector(None, Some("127.0.0.1:9123"), true).is_none());
        assert!(qa_inspector(Some("1"), Some("127.0.0.1:9123"), false).is_none());
        for address in ["0.0.0.0:9123", "localhost:9123", "127.0.0.1:0", "10.0.0.1:9123"] {
            assert!(qa_inspector(Some("1"), Some(address), true).is_none());
        }
    }

    #[test]
    fn protocol_frames_are_bounded_and_require_a_complete_line() {
        assert_eq!(read_frame(&mut io::Cursor::new(b"{}\n")).unwrap(), Some("{}".into()));
        assert!(read_frame(&mut io::Cursor::new(b"{}")).is_err());
        assert!(read_frame(&mut io::Cursor::new(vec![b'x'; 65537])).is_err());
    }
    #[test]
    fn autostart_paths_cannot_inject_desktop_entry_fields() {
        assert!(desktop_exec("/tmp/a\nHidden=false").is_err());
        assert_eq!(desktop_exec("/home/Ann Lee/100%/Quotum").unwrap(), "\"/home/Ann Lee/100%%/Quotum\"");
    }
}
