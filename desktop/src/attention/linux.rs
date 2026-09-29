//! Freedesktop delivery and one cancellable action listener, independent of the tray.
use super::{Intent, delivery};
use crate::{native_text, shell::Shell, window};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::Value,
};

pub struct Client {
    connection: Connection,
    ids: Arc<Mutex<VecDeque<u32>>>,
    actions: Option<JoinHandle<()>>,
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.connection.clone().close();
        if let Some(thread) = self.actions.take() {
            let _ = thread.join();
        }
    }
}
impl Client {
    fn connect(shell: &Arc<Shell>) -> zbus::Result<Self> {
        let connection = connect_bus(zbus::connection::Builder::session()?)?;
        let proxy = Proxy::new(
            &connection,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )?;
        let signals = proxy.receive_signal("ActionInvoked")?;
        let ids = Arc::new(Mutex::new(VecDeque::new()));
        let accepted = ids.clone();
        let weak = Arc::downgrade(shell);
        let actions = std::thread::spawn(move || {
            for signal in signals {
                let Ok((id, action)) = signal.body().deserialize::<(u32, String)>() else {
                    continue;
                };
                if action != "default" {
                    continue;
                }
                let mut ids = accepted.lock().unwrap_or_else(|e| e.into_inner());
                let Some(at) = ids.iter().position(|known| *known == id) else {
                    continue;
                };
                ids.remove(at);
                drop(ids);
                if let Some(shell) = weak.upgrade().filter(|s| !s.exiting()) {
                    window::open(&shell, "a notification");
                }
            }
        });
        Ok(Self { connection, ids, actions: Some(actions) })
    }
}

fn connect_bus(builder: zbus::connection::Builder<'_>) -> zbus::Result<Connection> {
    // method_timeout starts after authentication. Dropping the losing build future
    // closes its socket too, so a stalled session bus cannot hold the Quit join.
    // Use the pinned zbus blocking API's runtime; another runtime would add idle threads.
    zbus::block_on(async {
        tokio::time::timeout(Duration::from_secs(1), builder.method_timeout(Duration::from_secs(1)).build())
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "notification bus handshake timed out"))?
            .map(Connection::from)
    })
}

pub fn send(shell: &Arc<Shell>, intent: Intent, client: &mut Option<Client>) {
    if client.is_none() {
        match Client::connect(shell) {
            Ok(connected) => *client = Some(connected),
            Err(_) => {
                shell.attention.delivery.report(shell, false);
                return;
            }
        }
    }
    let connected = client.as_ref().unwrap();
    let proxy = Proxy::new(
        &connected.connection,
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
    )
    .expect("static D-Bus names");
    let capabilities: Result<Vec<String>, _> = proxy.call("GetCapabilities", &());
    let Ok(capabilities) = capabilities else {
        shell.attention.delivery.report(shell, false);
        client.take();
        return;
    };
    let markup = capabilities.iter().any(|c| c == "body-markup");
    let actions = capabilities.iter().any(|c| c == "actions");
    let mut failed = false;
    delivery::attempt(shell, intent, |title, body| {
        let body = if markup { body.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;") } else { body };
        let mut hints = HashMap::<&str, Value<'_>>::new();
        hints.insert("suppress-sound", Value::from(true));
        hints.insert("desktop-entry", Value::from("quotum"));
        hints.insert("urgency", Value::from(1_u8));
        let actions = if actions { vec!["default", native_text::text(shell.locale(), "desktop.open")] } else { vec![] };
        let result: Result<u32, _> =
            proxy.call("Notify", &("Quotum", 0_u32, "quotum", title, body, actions, hints, -1_i32));
        match result {
            Ok(id) => {
                let mut ids = connected.ids.lock().unwrap_or_else(|e| e.into_inner());
                if ids.len() >= 64 {
                    ids.pop_front();
                }
                ids.push_back(id);
                true
            }
            Err(_) => {
                failed = true;
                false
            }
        }
    });
    if failed {
        client.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, os::unix::net::UnixListener, sync::mpsc, time::Instant};

    #[test]
    fn a_silent_bus_cannot_hold_the_delivery_worker_during_authentication() {
        let path = std::env::temp_dir().join(format!("quotum-notify-test-{}.sock", std::process::id()));
        let listener = UnixListener::bind(&path).unwrap();
        let (finish, finished) = mpsc::channel();
        let peer = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut auth = [0; 128];
            assert!(socket.read(&mut auth).unwrap() > 0);
            let _ = finished.recv_timeout(Duration::from_secs(3));
        });
        let start = Instant::now();
        let result =
            connect_bus(zbus::connection::Builder::address(format!("unix:path={}", path.display()).as_str()).unwrap());
        let elapsed = start.elapsed();
        let _ = finish.send(());
        peer.join().unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(result.is_err());
        assert!(elapsed < Duration::from_secs(2), "authentication took {elapsed:?}");
    }
}
