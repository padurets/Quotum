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
        let connection =
            zbus::blocking::connection::Builder::session()?.method_timeout(Duration::from_secs(1)).build()?;
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
