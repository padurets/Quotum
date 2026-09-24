//! `quotum`: the subscription limits of the coding agents on this machine.

mod update;

use std::collections::BTreeMap;
use std::fs;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as Process, ExitCode, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use clap::{Parser, Subcommand};
use quotum_core::activity::{Activity, Origin, Session};
use quotum_core::config::{Config, Credentials, Hub, Paths, home, machine};
use quotum_core::model::{Batch, ErrorKind, INGEST_VERSION, Kind, Millis, Outcome, Provider, Window, now_ms};
use quotum_core::process::{detach, kill};
use quotum_core::providers::{adapter, find_client};
use quotum_core::runner::{Event, Runner};
use quotum_core::sink::{self, Discard, HubSink, Sink, not_the_hub};
use quotum_core::stop;

#[derive(Parser)]
#[command(
    name = "quotum",
    version,
    about = "Subscription limits of your coding agents: Claude Code, Codex, Antigravity."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    /// Print JSON in the hub's ingest format instead of a table.
    #[arg(long, global = true)]
    json: bool,
    /// Only these providers, comma-separated: claude, codex, antigravity.
    #[arg(long, global = true, value_delimiter = ',')]
    only: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Measure once and show the limits (the default).
    Status,
    /// Keep measuring on the schedule and deliver to the hub, if one is configured.
    Run {
        /// Hub address, instead of the settings or `connect`.
        #[arg(long)]
        hub: Option<String>,
        /// Your machine token (qt_m_…) or a device token for that hub. Other users of this
        /// machine can read it in the process list: prefer QUOTUM_HUB_TOKEN or the config file.
        #[arg(long)]
        token: Option<String>,
        /// Write the log to this file instead of stderr (`quotum start` does).
        #[arg(long, hide = true)]
        log: Option<PathBuf>,
    },
    /// Run in the background, as `run` does, with the log in a file; `quotum stop` stops it.
    Start {
        /// Hub address, instead of the settings or `connect`.
        #[arg(long)]
        hub: Option<String>,
        /// Your machine token (qt_m_…) or a device token for that hub; handed over to the
        /// background agent privately, not in its command line.
        #[arg(long)]
        token: Option<String>,
    },
    /// Stop the agent running on this machine, in the background or not.
    Stop,
    /// Connect this machine to your account on a hub with a one-time code confirmed in the browser.
    Connect {
        /// The hub's address, e.g. https://quotum.example.com
        url: String,
    },
    /// Forget the hub this machine was connected to with `connect`.
    Disconnect,
    /// Show where the settings live and what is in effect.
    Config,
    /// Replace this program with the latest release, if there is a newer one. Quick when
    /// there is not: one small request.
    Update {
        /// Only say whether there is a newer release.
        #[arg(long)]
        check: bool,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    // Before the settings are read: an update needs none of them, and should work even
    // when they are broken.
    if let Some(Command::Update { check }) = cli.command {
        return self_update(check);
    }
    let mut only = Vec::new();
    for name in &cli.only {
        match Provider::parse(name.trim()) {
            Some(p) => only.push(p),
            None => return fail(&format!("unknown provider `{name}` (claude, codex, antigravity)")),
        }
    }
    let paths = Paths::resolve();
    let config = match Config::load(&paths.config) {
        Ok(config) => config,
        Err(e) => return fail(&e),
    };
    if config.owner.is_some() {
        log(&format!(
            "note: `owner` in {} is no longer used: a machine belongs to the person whose token it uses",
            paths.config.display()
        ));
    }
    if let Err(e) = paths.ensure() {
        return fail(&format!("{}: {e}", paths.state.display()));
    }
    match cli.command.unwrap_or(Command::Status) {
        Command::Status => status(config, paths, &only, cli.json),
        Command::Run { hub, token, log: file } => {
            if let Some(file) = file {
                let _ = LOG_FILE.set(file);
            }
            let mut config = config;
            match (hub, token) {
                (Some(url), Some(token)) => {
                    log("warning: --token shows the token to everyone on this machine who can list processes; \
                         put it in QUOTUM_HUB_TOKEN or the config file (`quotum config` shows where) instead");
                    config.hub = Some(Hub { url, token });
                }
                (None, None) => {}
                _ => return fail("--hub and --token go together"),
            }
            run(config, paths, &only)
        }
        Command::Start { hub, token } => start(&config, &paths, &cli.only, hub, token),
        Command::Stop => stop_running(&paths),
        Command::Connect { url } => connect(&config, &paths, &url),
        Command::Disconnect => {
            println!("{}", if Credentials::remove(&paths) { "disconnected" } else { "not connected" });
            ExitCode::SUCCESS
        }
        Command::Config => show_config(&config, &paths),
        Command::Update { .. } => unreachable!("handled before the settings are read"),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("quotum: {message}");
    ExitCode::FAILURE
}

/// The file the log goes to instead of stderr, for an agent started in the background.
static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();
/// A log file this large is moved to `<name>.1` (replacing the one before) and started anew.
const LOG_LIMIT: u64 = 1 << 20;

/// A line of the agent's log: UTC time, then the message, on stderr or in the log file.
fn log(line: &str) {
    let line = format!("{} {line}", clock(now_ms()));
    let Some(file) = LOG_FILE.get() else {
        eprintln!("{line}");
        return;
    };
    if fs::metadata(file).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = fs::rename(file, file.with_extension("log.1"));
    }
    let written = fs::OpenOptions::new().create(true).append(true).open(file).and_then(|mut f| writeln!(f, "{line}"));
    if written.is_err() {
        eprintln!("{line}");
    }
}

/// `quotum start`: `quotum run` as a process of its own, detached from this terminal, with
/// its log in the state directory. It is started once it holds the state directory.
fn start(config: &Config, paths: &Paths, only: &[String], hub: Option<String>, token: Option<String>) -> ExitCode {
    if let Some(pid) = paths.running() {
        return fail(&format!("the agent runs already{}; `quotum stop` stops it", pid_text(pid)));
    }
    let target = match (&hub, &token) {
        (Some(url), Some(_)) => Some(url.clone()),
        (None, None) => config.hub_or_connected(paths).map(|hub| hub.url),
        _ => return fail("--hub and --token go together"),
    };
    let log_file = paths.log_file();
    let program = match std::env::current_exe() {
        Ok(program) => program,
        Err(e) => return fail(&format!("cannot find this program to start it again: {e}")),
    };
    // What the agent prints before its log is set up (or when it dies) goes to the log too.
    let errors = match fs::OpenOptions::new().create(true).append(true).open(&log_file) {
        Ok(file) => file,
        Err(e) => return fail(&format!("{}: {e}", log_file.display())),
    };
    let mut command = Process::new(program);
    command.arg("run").arg("--log").arg(&log_file).stdin(Stdio::null()).stdout(Stdio::null()).stderr(errors);
    if !only.is_empty() {
        command.arg("--only").arg(only.join(","));
    }
    if let (Some(url), Some(token)) = (hub, token) {
        command.env("QUOTUM_HUB_URL", url).env("QUOTUM_HUB_TOKEN", token);
    }
    detach(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return fail(&format!("could not start the agent: {e}")),
    };
    // Started once it holds the state directory; stopped at once, it says why in its log.
    for _ in 0..50 {
        thread::sleep(Duration::from_millis(100));
        if let Ok(Some(status)) = child.try_wait() {
            return fail(&format!(
                "the agent stopped at once ({status}); the end of its log, {}:\n{}",
                log_file.display(),
                tail(&log_file, 5)
            ));
        }
        if paths.running() == Some(Some(child.id())) {
            break;
        }
    }
    let delivering = target.map_or_else(|| "measuring without a hub".to_string(), |url| format!("delivering to {url}"));
    println!("Quotum runs in the background (pid {}), {delivering}.", child.id());
    println!("Log: {}", log_file.display());
    println!("`quotum stop` stops it. It does not start again by itself after a restart of the machine.");
    ExitCode::SUCCESS
}

/// `quotum update`: this program replaced by the latest release, when there is a newer one.
fn self_update(check: bool) -> ExitCode {
    // The file itself, not a link to it (~/.local/bin/quotum may be one).
    let program = match std::env::current_exe().and_then(fs::canonicalize) {
        Ok(program) => program,
        Err(e) => return fail(&format!("cannot find this program to update it: {e}")),
    };
    update::tidy(&program);
    match update::update(&update::releases(), &program, check, update::reports) {
        Ok(update::Outcome::Latest(version)) => println!("quotum {version} is the latest release."),
        Ok(update::Outcome::Available { current, latest }) => {
            println!("quotum {latest} is out (this is {current}); `quotum update` installs it.")
        }
        Ok(update::Outcome::Updated { from, to, program }) => {
            println!("quotum updated: {from} → {to} ({}).", program.display());
            if let Some(pid) = Paths::resolve().running() {
                println!(
                    "The agent running in the background{} is still {from}: restart it the way you started it \
                     (`quotum stop`, then `quotum start`).",
                    pid_text(pid)
                );
            }
        }
        Ok(update::Outcome::Npm) => println!(
            "quotum was installed with npm, which updates it: `npm install -g quotum@latest` (npx takes the latest by itself)."
        ),
        Err(e) => return fail(&e),
    }
    ExitCode::SUCCESS
}

/// `quotum stop`: asks the agent on this state directory to stop, as Ctrl-C would, and
/// ends it outright if it has not stopped after a while.
fn stop_running(paths: &Paths) -> ExitCode {
    let Some(pid) = paths.running() else {
        println!("The agent is not running.");
        return ExitCode::SUCCESS;
    };
    if let Err(e) = fs::write(paths.stop_file(), "") {
        return fail(&format!("{}: {e}", paths.stop_file().display()));
    }
    let stopped = |seconds: u64| {
        (0..seconds * 10).any(|_| {
            thread::sleep(Duration::from_millis(100));
            paths.running().is_none()
        })
    };
    if stopped(15) {
        println!("Stopped{}.", pid_text(pid));
        return ExitCode::SUCCESS;
    }
    let Some(pid) = pid else {
        return fail("the agent did not stop within 15 s, and it did not say which process it is");
    };
    kill(pid);
    let _ = fs::remove_file(paths.stop_file());
    if stopped(5) {
        println!("Stopped (pid {pid}): it did not stop within 15 s, so it was ended outright.");
        ExitCode::SUCCESS
    } else {
        fail(&format!("the agent (pid {pid}) does not stop"))
    }
}

fn pid_text(pid: Option<u32>) -> String {
    pid.map(|pid| format!(" (pid {pid})")).unwrap_or_default()
}

/// The last `lines` lines of a file.
fn tail(file: &Path, lines: usize) -> String {
    let text = fs::read_to_string(file).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

fn status(config: Config, paths: Paths, only: &[Provider], json: bool) -> ExitCode {
    let machine = json.then(|| machine(&paths, &config));
    let connected = Credentials::load(&paths).filter(|_| config.hub.is_none());
    let running = paths.running();
    let paths_log = Some(paths.log_file());
    let mut runner = Runner::new(config, paths, only);
    let style = Style::detect();
    let mut outcomes = Vec::new();
    if !json {
        println!("{}", style.dim(&format!("{:<14}{:<20}{:>5}  {}", "", "", "left", "resets")));
    }
    // The agents running here are looked at before and after measuring: the CPU time they
    // spent meanwhile tells which of them work, with no wait of its own.
    let mut activity = (!json).then(|| Activity::new(home()));
    if let Some(activity) = activity.as_mut() {
        activity.look();
    }
    runner.measure_all(|outcome| {
        if !json {
            print_outcome(outcome, &style);
            let _ = std::io::stdout().flush();
        }
        outcomes.push(outcome.clone());
    });
    if let Some(activity) = activity.as_mut() {
        print_sessions(&activity.look(), &style);
    }
    if let (false, Some(credentials)) = (json, &connected) {
        println!("\n{}", style.dim(&format!("connected {}", connected_to(credentials))));
    }
    if let (false, Some(pid)) = (json, running) {
        let log =
            paths_log.filter(|file| file.exists()).map(|file| format!(" · log {}", file.display())).unwrap_or_default();
        println!("{}", style.dim(&format!("agent running{}{log} · `quotum stop` stops it", pid_text(pid))));
    }
    if let Some(machine) = machine {
        let (snapshots, failures) = outcomes.into_iter().partition::<Vec<_>, _>(|o| o.is_ok());
        let batch = Batch {
            version: INGEST_VERSION,
            agent: concat!("quotum/", env!("CARGO_PKG_VERSION")).into(),
            machine,
            sent_at: now_ms(),
            snapshots: snapshots.into_iter().filter_map(Result::ok).collect(),
            failures: failures.into_iter().filter_map(Result::err).collect(),
        };
        println!("{}", serde_json::to_string_pretty(&batch).unwrap_or_default());
    }
    ExitCode::SUCCESS
}

fn run(config: Config, paths: Paths, only: &[Provider]) -> ExitCode {
    // Held until the agent exits: two runs on one state directory would share its spool.
    let _lock = match paths.lock_run() {
        Ok(lock) => lock,
        Err(e) => return fail(&e),
    };
    let mut sink: Box<dyn Sink> = match config.hub_or_connected(&paths) {
        Some(hub) => {
            log(&format!("delivering to {}", hub.url));
            if insecure(&hub.url) {
                log("warning: the hub is reached over plain http; its token travels unencrypted");
            }
            let machine = machine(&paths, &config);
            Box::new(HubSink::new(&hub, machine, paths.state.join("spool.jsonl"), Box::new(log)))
        }
        None => {
            log("no hub configured: measuring and logging only");
            Box::new(Discard)
        }
    };
    let stop_file = paths.stop_file();
    let mut runner = Runner::new(config, paths, only);
    if runner.providers().is_empty() {
        return fail("every provider is disabled");
    }
    stop::on_signals();
    stop::on_file(stop_file);
    // Waiting is logged once per change, not on every check-in; a failure that repeats
    // itself is logged once too.
    let mut waiting: BTreeMap<Provider, bool> = BTreeMap::new();
    let mut failing: BTreeMap<Provider, String> = BTreeMap::new();
    let refused = runner.run(sink.as_mut(), |event| match event {
        Event::Measured(outcome, next) => {
            let (provider, summary, repeated) = match outcome {
                Ok(s) => {
                    failing.remove(&s.provider);
                    let windows: Vec<String> = s
                        .windows
                        .iter()
                        .map(|w| format!("{} {}%", window_name(w), fmt_percent(w.remaining())))
                        .collect();
                    (s.provider, windows.join(", "), false)
                }
                Err(f) => {
                    let detail = f.detail.as_ref().map(|d| format!(": {d}")).unwrap_or_default();
                    let summary = format!("{}{detail}", f.error.describe());
                    let repeated = failing.insert(f.provider, summary.clone()).as_ref() == Some(&summary);
                    (f.provider, summary, repeated)
                }
            };
            waiting.insert(provider, false);
            if !repeated {
                log(&format!("{}: {summary} (next {})", provider.id(), until(next - now_ms())));
            }
        }
        Event::Waiting(provider, next) => {
            if waiting.insert(provider, true) != Some(true) {
                log(&format!(
                    "{}: another device measures this subscription; checking again in {}",
                    provider.id(),
                    until(next - now_ms())
                ));
            }
        }
    });
    match refused {
        Some(reason) => fail(&format!("stopped: {reason}")),
        None => ExitCode::SUCCESS,
    }
}

/// Plain http to anything but this machine: the bearer token can be read on the way.
fn insecure(url: &str) -> bool {
    let rest = url.strip_prefix("http://");
    rest.is_some_and(|host| !["localhost", "127.0.0.1", "[::1]"].iter().any(|local| host.starts_with(local)))
}

/// The device-code flow: ask the hub for a code, show it, wait until a person confirms it.
fn connect(config: &Config, paths: &Paths, url: &str) -> ExitCode {
    let url = url.trim_end_matches('/');
    let http = sink::http();
    let request =
        serde_json::json!({"machine": machine(paths, config), "agent": concat!("quotum/", env!("CARGO_PKG_VERSION"))});
    let mut response = match http.post(&format!("{url}/v1/device/code")).send_json(&request) {
        Ok(response) => response,
        Err(e) => return fail(&format!("{url} is unreachable: {e}")),
    };
    if let Some(why) = not_the_hub(&response) {
        return fail(&format!("{url}: {why}"));
    }
    let status = response.status();
    let started: serde_json::Value = response.body_mut().read_json().unwrap_or_default();
    if !status.is_success() {
        let code = started["error"].as_str().map(|code| format!(" ({code})")).unwrap_or_default();
        return fail(&format!("{url} answered HTTP {}{code}", status.as_u16()));
    }
    let (Some(device_code), Some(user_code)) = (started["deviceCode"].as_str(), started["userCode"].as_str()) else {
        return fail(&format!("{url} does not look like a Quotum hub"));
    };
    let style = Style::detect();
    println!("Open this page and confirm the code:\n");
    println!("  {}", started["verificationUriComplete"].as_str().unwrap_or(url));
    println!("  code {}\n", style.bold(user_code));
    println!("{}", style.dim("Waiting for confirmation… (Ctrl+C to cancel)"));

    // Whatever the hub says, poll every 1 to 60 seconds for at most an hour.
    let mut interval = started["interval"].as_u64().unwrap_or(5).clamp(1, 60);
    let deadline =
        std::time::Instant::now() + Duration::from_secs(started["expiresIn"].as_u64().unwrap_or(600).min(3600));
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(interval));
        let answer =
            http.post(&format!("{url}/v1/device/token")).send_json(serde_json::json!({"deviceCode": device_code}));
        let Ok(mut response) = answer else { continue };
        if let Some(why) = not_the_hub(&response) {
            return fail(&format!("{url}: {why}"));
        }
        let ok = response.status().is_success();
        let body: serde_json::Value = response.body_mut().read_json().unwrap_or_default();
        if ok {
            let Some(token) = body["token"].as_str().filter(|t| !t.is_empty()) else {
                return fail(&format!("{url} confirmed the code but sent no token"));
            };
            let credentials = Credentials {
                url: url.to_string(),
                token: token.to_string(),
                account: body["account"]["name"].as_str().unwrap_or_default().trim().to_string(),
            };
            if let Err(e) = credentials.save(paths) {
                return fail(&format!("could not save the connection: {e}"));
            }
            println!("This machine is connected to {}.", connected_to(&credentials));
            if config.hub.is_some() {
                println!(
                    "Note: a hub in the settings or QUOTUM_HUB_URL/QUOTUM_HUB_TOKEN takes precedence over this connection."
                );
            }
            println!("Start measuring with `quotum run`.");
            return ExitCode::SUCCESS;
        }
        match body["error"].as_str() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval = (interval + 5).min(60),
            Some("access_denied") => return fail("the connection was declined"),
            Some("expired_token") => return fail("the code expired; run `quotum connect` again"),
            _ => {}
        }
    }
    fail("the code expired; run `quotum connect` again")
}

/// "<url> as <account>", or only the address when the hub did not name the account
/// (credentials of older versions).
fn connected_to(credentials: &Credentials) -> String {
    match credentials.account.as_str() {
        "" => credentials.url.clone(),
        account => format!("{} as {account}", credentials.url),
    }
}

fn show_config(config: &Config, paths: &Paths) -> ExitCode {
    println!(
        "config file   {}{}",
        paths.config.display(),
        if paths.config.exists() { "" } else { " (not created; defaults apply)" }
    );
    println!("state         {}", paths.state.display());
    let connected = Credentials::load(paths);
    if let (None, Some(c)) = (&config.hub, &connected) {
        println!("connected     {}", connected_to(c));
    }
    match &config.hub {
        Some(hub) => println!(
            "hub           {} (token …{})",
            hub.url,
            hub.token.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>()
        ),
        None if connected.is_some() => {}
        None => println!("hub           none: `quotum run` only logs; `quotum connect <url>` to connect"),
    }
    println!("eco mode      {}", if config.eco() { "on" } else { "off" });
    let home = quotum_core::config::home();
    for provider in Provider::ALL {
        let client =
            config.program(provider).map(|p| p.to_path_buf()).or_else(|| find_client(&*adapter(provider), &home));
        println!(
            "{:<13} {}, every {}s, client {}",
            provider.id(),
            if config.enabled(provider) { "on" } else { "off" },
            config.interval_ms(provider) / 1000,
            client.map(|p| p.display().to_string()).unwrap_or_else(|| "not found".into())
        );
    }
    ExitCode::SUCCESS
}

fn print_outcome(outcome: &Outcome, style: &Style) {
    match outcome {
        Ok(snapshot) => {
            let head = match &snapshot.plan {
                Some(plan) => format!("{} {}", snapshot.provider.name(), plan),
                None => snapshot.provider.name().to_string(),
            };
            for (i, w) in snapshot.windows.iter().enumerate() {
                let left = w.remaining();
                let resets = w.resets_at.map(|at| format!("in {}", until(at - now_ms()))).unwrap_or_default();
                let first = if i == 0 { format!("{head:<14}") } else { " ".repeat(14) };
                let first = if i == 0 { style.bold(&first) } else { first };
                println!(
                    "{first}{:<20}{}  {}",
                    window_name(w),
                    style.level(left, &format!("{:>4}%", fmt_percent(left))),
                    style.dim(&resets)
                );
            }
            if let Some(free) = snapshot.resets.as_ref().filter(|r| r.available > 0) {
                let expires =
                    free.expires_at.map(|at| format!("expires in {}", until(at - now_ms()))).unwrap_or_default();
                println!("{}{:<20}{:>4}   {}", " ".repeat(14), "free resets", free.available, style.dim(&expires));
            }
        }
        Err(failure) => {
            let text = match failure.error {
                ErrorKind::NotInstalled => failure.error.describe().to_string(),
                _ => format!(
                    "{}{}",
                    failure.error.describe(),
                    failure.detail.as_ref().map(|d| format!(": {d}")).unwrap_or_default()
                ),
            };
            println!("{}{}", style.bold(&format!("{:<14}", failure.provider.name())), style.dim(&text));
        }
    }
}

/// The coding agents running on this machine, and which of them work.
fn print_sessions(sessions: &[Session], style: &Style) {
    if sessions.is_empty() {
        return;
    }
    // Working or idle is known only when the look before measuring was long enough ago.
    let known = sessions.iter().all(|s| s.working.is_some());
    let working = sessions.iter().filter(|s| s.working == Some(true)).count();
    let head = if known {
        format!("running here: {} · {working} working", sessions.len())
    } else {
        format!("running here: {}", sessions.len())
    };
    println!("\n{}", style.dim(&head));
    for session in sessions {
        let state = match session.working {
            Some(true) => style.bold("working"),
            Some(false) => style.dim("idle   "),
            None => " ".repeat(7),
        };
        let project = session.project.as_deref().unwrap_or("");
        let origin = match session.origin {
            Origin::Terminal => String::new(),
            other => format!(" · {}", other.id()),
        };
        let started = style.dim(&format!("started {} ago{origin}", until(now_ms() - session.started_at)));
        println!("{:<14}{project:<20}{state}  {started}", session.provider.name());
    }
}

fn window_name(w: &Window) -> String {
    let kind = match w.kind {
        Kind::Session => "5 hours".to_string(),
        Kind::Weekly => "weekly".to_string(),
        Kind::Other => w.minutes.map(|m| format!("{m} min")).unwrap_or_else(|| "window".into()),
    };
    match &w.label {
        Some(label) => format!("{label} {kind}"),
        None => kind,
    }
}

fn fmt_percent(value: f64) -> String {
    if (value - value.round()).abs() < 0.05 { format!("{value:.0}") } else { format!("{value:.1}") }
}

/// "3m", "1h 49m", "5d 11h".
fn until(ms: Millis) -> String {
    let minutes = (ms.max(0) + 59_999) / 60_000;
    match minutes {
        0..=59 => format!("{minutes}m"),
        60..=1439 => format!("{}h {}m", minutes / 60, minutes % 60),
        _ => format!("{}d {}h", minutes / 1440, minutes % 1440 / 60),
    }
}

/// Log timestamps: UTC, RFC 3339, to the second.
fn clock(ms: Millis) -> String {
    quotum_core::model::ts::format(ms - ms.rem_euclid(1000))
}

struct Style {
    color: bool,
}

impl Style {
    fn detect() -> Style {
        Style { color: std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none() }
    }

    fn paint(&self, code: &str, text: &str) -> String {
        if self.color { format!("\x1b[{code}m{text}\x1b[0m") } else { text.to_string() }
    }

    fn bold(&self, text: &str) -> String {
        self.paint("1", text)
    }

    fn dim(&self, text: &str) -> String {
        self.paint("2", text)
    }

    /// Canonical status colours: under 10% critical, 30% and below a warning.
    fn level(&self, left: f64, text: &str) -> String {
        let code = if left < 10.0 {
            "31"
        } else if left <= 30.0 {
            "33"
        } else {
            "32"
        };
        self.paint(code, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_are_short_and_round_up() {
        assert_eq!(until(1), "1m");
        assert_eq!(until(109 * 60_000), "1h 49m");
        assert_eq!(until((5 * 1440 + 11 * 60) * 60_000), "5d 11h");
        assert_eq!(fmt_percent(96.28), "96.3");
        assert_eq!(fmt_percent(8.0), "8");
    }
}
