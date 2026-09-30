//! The last check happens at the native sink, after its bounded queue.
use super::{Candidate, Intent, Invalidation};
use crate::{native_text, shell::Shell};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::sync::{
    atomic::AtomicBool,
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
    baselines: BTreeMap<String, BTreeMap<String, i64>>,
}
impl Board {
    pub fn snapshot(&mut self, snapshot: Value) {
        self.cards.clear();
        self.lineup.clear();
        self.baselines.clear();
        self.view = snapshot["view"].clone();
        if let Some(cards) = snapshot["sources"].as_array() {
            for card in cards {
                if let Some(id) = card["id"].as_str() {
                    self.lineup.push(id.into());
                    self.card(card.clone());
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
                self.baselines.retain(|id, _| self.lineup.contains(id));
            }
            "card" => {
                self.card(value);
            }
            _ => {}
        }
    }
    fn card(&mut self, card: Value) {
        let Some(id) = card["id"].as_str() else { return };
        let old = self.cards.get(id);
        let baselines = self.baselines.entry(id.into()).or_default();
        let windows = card["windows"].as_array().map(Vec::as_slice).unwrap_or_default();
        baselines.retain(|id, _| windows.iter().any(|w| w["id"] == *id));
        for window in windows {
            let Some(id) = window["id"].as_str() else { continue };
            let previous =
                old.and_then(|c| c["windows"].as_array()).and_then(|windows| windows.iter().find(|w| w["id"] == id));
            if previous.is_none_or(|p| ["kind", "label", "minutes"].iter().any(|key| p[key] != window[key])) {
                // Keep the boundary even if the old label is restored before a
                // queued notification reaches the native sink.
                baselines.insert(id.into(), card["successAt"].as_i64().unwrap_or(i64::MAX));
            }
        }
        self.cards.insert(id.into(), card);
    }
    pub fn invalidate(&mut self, boundaries: &[Invalidation]) {
        for boundary in boundaries {
            if let Some(at) =
                self.baselines.get_mut(&boundary.source_id).and_then(|windows| windows.get_mut(&boundary.window_id))
            {
                *at = (*at).max(boundary.at);
            }
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
                let Some(card) = self.cards.get(&q.source_id) else { return false };
                let current =
                    card["windows"].as_array().and_then(|windows| windows.iter().find(|w| w["id"] == q.window_id));
                let baseline = self.baselines.get(&q.source_id).and_then(|b| b.get(&q.window_id));
                if card["provider"] != q.provider
                    || baseline.is_none_or(|at| q.observed_at < *at)
                    || current.is_none_or(|w| {
                        w["kind"].as_str() != Some(q.window.kind.as_str())
                            || w["label"].as_str() != q.window.label.as_deref()
                            || w["minutes"].as_i64() != q.window.minutes
                    })
                {
                    return false;
                }
                if let Some(name) = self.view["names"][&q.source_id].as_str() {
                    q.name = name.into();
                } else {
                    let provider = card["provider"].as_str().unwrap_or("");
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
                while let Ok(intent) = receiver.recv() {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let Some(shell) = weak.upgrade() else {
                        return;
                    };
                    super::linux::send(&shell, intent, &mut client);
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
            tray.send(crate::tray::Command::Notify(Box::new(intent)));
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
        || shell.attention.serial.load(Ordering::SeqCst) != intent.serial
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
    if !shell.attention.gate.allows(intent.epoch)
        || shell.generation() != intent.generation
        || shell.attention.serial.load(Ordering::SeqCst) != intent.serial
        || intent.queued.elapsed() > Duration::from_secs(5)
    {
        return;
    }
    shell.attention.delivery.report(shell, call(title, body));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn producer_barriers_revoke_emitted_intents_even_when_cards_coalesce() {
        let card = |id: &str, at: i64| json!({"id":id,"provider":"codex","successAt":at,"windows":[{"id":"week","kind":"weekly","label":"Old pool","minutes":10080}]});
        let mut board = Board::default();
        board.snapshot(json!({"view":{"hidden":[],"windows":[],"names":{}},"sources":[card("one", 1),card("two", 1)]}));
        let mut candidate: Candidate = serde_json::from_value(json!({"id":"event","kind":"low","at":10,"observedFrom":1,"observedAt":2,"sourceId":"one","windowId":"week","provider":"codex","name":"","window":{"kind":"weekly","label":"Old pool","minutes":10080},"remaining":29,"resetAt":null})).unwrap();
        let mut unrelated = candidate.clone();
        if let Candidate::Quota(q) = &mut unrelated {
            q.source_id = "two".into();
        }
        assert!(board.resolve(&mut candidate));
        board.invalidate(&[Invalidation { source_id: "one".into(), window_id: "week".into(), at: 4 }]);
        assert!(!board.resolve(&mut candidate), "revoked before the new card arrives");
        board.apply("card", card("one", 4));
        assert!(!board.resolve(&mut candidate), "the coalesced card has the same metadata");
        assert!(board.resolve(&mut unrelated), "other windows keep their queued events");
        if let Candidate::Quota(q) = &mut candidate {
            q.observed_at = 5;
        }
        assert!(board.resolve(&mut candidate));
    }

    #[test]
    fn queued_candidates_do_not_survive_a_replaced_window() {
        let card = |label: &str, at: i64| json!({"id":"one","provider":"codex","successAt":at,"windows":[{"id":"week","kind":"weekly","label":label,"minutes":10080}]});
        let mut board = Board::default();
        board.snapshot(json!({"view":{"hidden":[],"windows":[],"names":{}},"sources":[card("Old pool", 1)]}));
        let mut candidate: Candidate = serde_json::from_value(json!({"id":"event","kind":"low","at":10,"observedFrom":1,"observedAt":2,"sourceId":"one","windowId":"week","provider":"codex","name":"","window":{"kind":"weekly","label":"Old pool","minutes":10080},"remaining":29,"resetAt":null})).unwrap();
        assert!(board.resolve(&mut candidate));
        board.apply("card", card("New pool", 3));
        assert!(!board.resolve(&mut candidate));
        board.apply("card", card("Old pool", 4));
        assert!(!board.resolve(&mut candidate), "restoring the label cannot revive the queued event");
        if let Candidate::Quota(q) = &mut candidate {
            q.observed_at = 5;
        }
        assert!(board.resolve(&mut candidate), "new observations of the current window still notify");
        board.apply("card", json!({"id":"one","provider":"codex","successAt":6,"windows":[]}));
        board.apply("card", card("Old pool", 7));
        assert!(!board.resolve(&mut candidate), "a removed window starts a fresh observation boundary");
    }

    #[test]
    fn queued_candidates_follow_latest_names_and_visibility() {
        let mut board = Board::default();
        board.snapshot(json!({"view":{"hidden":[],"windows":[],"names":{}},"sources":[{"id":"one","provider":"codex","successAt":1,"windows":[{"id":"week","kind":"weekly","label":null,"minutes":10080}]},{"id":"two","provider":"codex","successAt":1,"windows":[{"id":"week","kind":"weekly","label":null,"minutes":10080}]}]}));
        let mut candidate: Candidate = serde_json::from_value(json!({"id":"event","kind":"low","at":10,"observedFrom":1,"observedAt":2,"sourceId":"two","windowId":"week","provider":"codex","name":"old name","window":{"kind":"weekly","label":null,"minutes":10080},"remaining":29,"resetAt":null})).unwrap();
        assert!(board.resolve(&mut candidate));
        assert!(matches!(&candidate, Candidate::Quota(q) if q.name == "Codex 2"));
        board.apply("view", json!({"view":{"hidden":[],"windows":[],"names":{"two":"New name"}}}));
        assert!(board.resolve(&mut candidate));
        assert!(matches!(&candidate, Candidate::Quota(q) if q.name == "New name"));
        board.apply("view", json!({"view":{"hidden":[],"windows":["two/week"],"names":{}}}));
        assert!(!board.resolve(&mut candidate));
        board.apply("lineup", json!({"sources":["one"]}));
        board.apply("view", json!({"view":{"hidden":[],"windows":[],"names":{}}}));
        assert!(!board.resolve(&mut candidate));
    }
}
