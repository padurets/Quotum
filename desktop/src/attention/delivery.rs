//! The last check happens at the native sink, after its bounded queue.
use super::{Candidate, Intent};
use crate::{native_text, shell::Shell};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
};
#[cfg(target_os = "linux")]
use std::thread::JoinHandle;
use std::time::Duration;

#[derive(Default)]
pub struct Board {
    cards: BTreeMap<String, Value>,
    lineup: Vec<String>,
    view: Value,
}
impl Board {
    pub fn snapshot(&mut self, snapshot: Value) {
        self.cards.clear();
        self.lineup.clear();
        self.view = snapshot["view"].clone();
        if let Some(cards) = snapshot["sources"].as_array() {
            for card in cards {
                if let Some(id) = card["id"].as_str() {
                    self.lineup.push(id.into());
                    self.cards.insert(id.into(), card.clone());
                }
            }
        }
    }
    pub fn apply(&mut self, kind: &str, value: Value) {
        match kind {
            "view" => self.view = value["view"].clone(),
            "lineup" => {
                self.lineup = value["sources"]
                    .as_array()
                    .map(|v| v.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                    .unwrap_or_default();
                self.cards.retain(|id, _| self.lineup.contains(id));
            }
            "card" => {
                if let Some(id) = value["id"].as_str() {
                    self.cards.insert(id.into(), value);
                }
            }
            _ => {}
        }
    }
    fn hidden(&self, key: &str, id: &str) -> bool {
        self.view[key].as_array().is_some_and(|a| a.iter().any(|v| v == id))
    }
    fn visible(&self, id: &str, window: Option<&str>) -> bool {
        if !self.lineup.iter().any(|v| v == id) || self.hidden("hidden", &format!("source:{id}")) {
            return false;
        }
        self.cards.get(id).and_then(|c| c["windows"].as_array()).is_some_and(|windows| {
            windows.iter().any(|w| {
                w["id"].as_str().is_some_and(|w| {
                    window.is_none_or(|expected| expected == w) && !self.hidden("windows", &format!("{id}/{w}"))
                })
            })
        })
    }
    pub fn resolve(&self, candidate: &mut Candidate) -> bool {
        match candidate {
            Candidate::Quota(q) => {
                if !self.visible(&q.source_id, Some(&q.window_id)) {
                    return false;
                }
                if let Some(name) = self.view["names"][&q.source_id].as_str() {
                    q.name = name.into();
                } else {
                    let Some(card) = self.cards.get(&q.source_id) else {
                        return false;
                    };
                    let provider = card["provider"].as_str().unwrap_or("");
                    if provider != q.provider {
                        return false;
                    }
                    let number = self
                        .lineup
                        .iter()
                        .take_while(|id| *id != &q.source_id)
                        .filter(|id| self.cards.get(*id).is_some_and(|c| c["provider"] == provider))
                        .count()
                        + 1;
                    let provider = match provider {
                        "codex" => "Codex",
                        "claude" => "Claude",
                        "antigravity" => "Antigravity",
                        other => other,
                    };
                    q.name = if number == 1 { provider.into() } else { format!("{provider} {number}") };
                }
                true
            }
            Candidate::Announcement(a) => self
                .lineup
                .iter()
                .any(|id| self.cards.get(id).is_some_and(|c| c["provider"] == a.provider) && self.visible(id, None)),
        }
    }
}

#[derive(Default)]
pub struct Delivery {
    capability: Mutex<&'static str>,
    #[cfg(target_os = "linux")]
    queue: Mutex<Option<SyncSender<Intent>>>,
    #[cfg(target_os = "linux")]
    worker: Mutex<Option<JoinHandle<()>>>,
    #[cfg(target_os = "linux")]
    stop: Arc<AtomicBool>,
}
impl Delivery {
    pub fn capability(&self) -> &'static str {
        let c = *self.capability.lock().unwrap_or_else(|e| e.into_inner());
        if c.is_empty() { "unknown" } else { c }
    }
    pub fn report(&self, shell: &Shell, available: bool) {
        *self.capability.lock().unwrap_or_else(|e| e.into_inner()) =
            if available { "available" } else { "unavailable" };
        shell.wake();
    }
    pub fn start(&self, shell: &Arc<Shell>) {
        #[cfg(target_os = "linux")]
        {
            let (sender, receiver) = mpsc::sync_channel(32);
            *self.queue.lock().unwrap_or_else(|e| e.into_inner()) = Some(sender);
            let weak = Arc::downgrade(shell);
            let stop = self.stop.clone();
            *self.worker.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::thread::spawn(move || {
                let mut client = None;
                while !stop.load(Ordering::SeqCst) {
                    if let Ok(intent) = receiver.recv_timeout(Duration::from_millis(200)) {
                        let Some(shell) = weak.upgrade() else {
                            return;
                        };
                        super::linux::send(&shell, intent, &mut client);
                    }
                }
            }));
        }
        #[cfg(not(target_os = "linux"))]
        let _ = shell;
    }
    pub fn send(&self, shell: &Arc<Shell>, intent: Intent) {
        #[cfg(target_os = "linux")]
        {
            let _ = shell;
            if let Some(queue) = self.queue.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                let _ = queue.try_send(intent);
            }
        }
        #[cfg(windows)]
        if let Some(tray) = shell.host.tray.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            tray.send(crate::tray::Command::Notify(intent));
        }
    }
    pub fn stop(&self) {
        #[cfg(target_os = "linux")]
        {
            self.stop.store(true, Ordering::SeqCst);
            self.queue.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = worker.join();
            }
        }
    }
}

pub fn attempt(shell: &Arc<Shell>, mut intent: Intent, call: impl FnOnce(String, String) -> bool) {
    if shell.exiting()
        || shell.generation() != intent.generation
        || intent.queued.elapsed() > Duration::from_secs(5)
        || !shell.attention.gate.allows(intent.epoch)
    {
        return;
    }
    let age =
        intent.hub_now.saturating_add(intent.queued.elapsed().as_millis() as i64).saturating_sub(intent.candidate.at());
    if !(0..=60_000).contains(&age) {
        return;
    }
    if let Candidate::Quota(q) = &intent.candidate {
        if !["low", "critical", "reset"].contains(&q.kind.as_str())
            || q.observed_from < intent.baseline
            || q.observed_at <= q.observed_from
            || !q.remaining.is_finite()
        {
            return;
        }
    } else if intent.candidate.kind() != "announcement" {
        return;
    }
    let _settings = shell.settings_ops.lock().unwrap_or_else(|e| e.into_inner());
    if !shell.desktop_settings().0.enabled(intent.candidate.kind()) {
        return;
    }
    if !shell.attention.board.lock().unwrap_or_else(|e| e.into_inner()).resolve(&mut intent.candidate) {
        return;
    }
    let (title, body) = native_text::notification(shell.locale(), &intent.candidate);
    if !shell.attention.gate.allows(intent.epoch) || shell.generation() != intent.generation {
        return;
    }
    shell.attention.delivery.report(shell, call(title, body));
}
