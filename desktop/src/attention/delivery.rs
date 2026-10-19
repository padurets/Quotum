//! The last check happens at the native sink, after its bounded queue.
use super::{Candidate, Intent, Invalidation};
use crate::{native_text, shell::Shell};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
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
    providers: Value,
    baselines: BTreeMap<String, BTreeMap<String, i64>>,
    mask: Option<Mask>,
    filters_revision: Option<u64>,
    filters_authority: Option<String>,
    awaiting_mask: bool,
}

#[derive(PartialEq, Eq)]
struct Rule<T> {
    include: bool,
    values: BTreeSet<T>,
}
impl<T: Ord> Rule<T> {
    fn admits(&self, value: &T) -> bool {
        self.values.contains(value) == self.include
    }
}
#[derive(PartialEq, Eq)]
struct Mask {
    sources: Rule<String>,
    windows: Rule<(String, String)>,
}
fn identifier(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| {
        !id.is_empty() && id.len() <= 120 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
    })
}
fn window_identifier(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| !id.is_empty() && id.chars().count() <= 120)
}
fn rule<T: Ord>(value: &Value, reference: impl Fn(&Value) -> Option<Option<T>>) -> Option<Rule<T>> {
    let object = value.as_object()?;
    if object.len() != 2 || !object.contains_key("mode") || !object.contains_key("values") {
        return None;
    }
    let include = match value["mode"].as_str()? {
        "include" => true,
        "exclude" => false,
        _ => return None,
    };
    let mut values = BTreeSet::new();
    for value in value["values"].as_array()? {
        if let Some(value) = reference(value)? {
            values.insert(value);
        }
    }
    Some(Rule { include, values })
}
fn mask(value: &Value) -> Option<Mask> {
    if value["version"].as_u64()? != 1 {
        return None;
    }
    let sources = rule(&value["sources"], |value| {
        let object = value.as_object()?;
        if object.len() != 1 {
            return None;
        }
        if let Some(source) = object.get("source") {
            return Some(Some(identifier(source)?.into()));
        }
        match value["status"].as_str()? {
            "unknown" | "notProvided" => Some(None),
            _ => None,
        }
    })?;
    let windows = rule(&value["windows"], |value| {
        let values = value.as_array()?;
        if values.len() != 2 {
            return None;
        }
        Some(Some((identifier(&values[0])?.into(), window_identifier(&values[1])?.into())))
    })?;
    Some(Mask { sources, windows })
}
impl Board {
    pub fn snapshot(&mut self, snapshot: Value) {
        self.cards.clear();
        self.lineup.clear();
        self.baselines.clear();
        self.mask = None;
        self.awaiting_mask = true;
        self.filters_revision = snapshot["filtersRevision"].as_u64();
        self.filters_authority = snapshot["filtersAuthority"].as_str().map(str::to_owned);
        self.view = snapshot["view"].clone();
        self.providers = snapshot["providers"].clone();
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
            "filters" => self.filters(value),
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
    fn filters(&mut self, value: Value) {
        let revision = value["revision"].as_u64();
        if revision.is_some_and(|revision| self.filters_revision.is_some_and(|current| revision < current)) {
            return;
        }
        let authority = value["authority"].as_str().filter(|key| (16..=120).contains(&key.len()));
        if self.awaiting_mask && (revision != self.filters_revision || authority != self.filters_authority.as_deref()) {
            return;
        }
        self.mask = if revision.is_some() && authority.is_some() { mask(&value["filters"]) } else { None };
        self.filters_revision = revision;
        self.filters_authority = authority.map(str::to_owned);
        self.awaiting_mask = false;
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
        let Some(mask) = &self.mask else {
            return false;
        };
        if !mask.sources.admits(&id.to_owned()) {
            return false;
        }
        if !self.lineup.iter().any(|v| v == id) || self.hidden("hidden", &format!("source:{id}")) {
            return false;
        }
        self.cards.get(id).and_then(|c| c["windows"].as_array()).is_some_and(|windows| {
            windows.iter().any(|w| {
                w["id"].as_str().is_some_and(|w| {
                    window.is_none_or(|expected| expected == w) && mask.windows.admits(&(id.to_owned(), w.to_owned()))
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
                    let provider = self
                        .providers
                        .as_array()
                        .and_then(|entries| entries.iter().find(|entry| entry["id"] == provider))
                        .and_then(|entry| entry["name"].as_str())
                        .unwrap_or(provider);
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
    fn configuration(revision: u64, sources: Value, windows: Value) -> Value {
        json!({"revision":revision,"authority":"filter-authority-test","filters":{"version":1,"sources":sources,"windows":windows}})
    }
    fn ready_snapshot(board: &mut Board, mut snapshot: Value) {
        snapshot["filtersRevision"] = json!(0);
        snapshot["filtersAuthority"] = json!("filter-authority-test");
        board.snapshot(snapshot);
        board.apply(
            "filters",
            configuration(0, json!({"mode":"exclude","values":[]}), json!({"mode":"exclude","values":[]})),
        );
    }
    #[test]
    fn producer_barriers_revoke_emitted_intents_even_when_cards_coalesce() {
        let card = |id: &str, at: i64| json!({"id":id,"provider":"codex","successAt":at,"windows":[{"id":"week","kind":"weekly","label":"Old pool","minutes":10080}]});
        let mut board = Board::default();
        ready_snapshot(
            &mut board,
            json!({"view":{"hidden":[],"windows":[],"names":{}},"sources":[card("one", 1),card("two", 1)]}),
        );
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
        ready_snapshot(
            &mut board,
            json!({"view":{"hidden":[],"windows":[],"names":{}},"sources":[card("Old pool", 1)]}),
        );
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
        ready_snapshot(
            &mut board,
            json!({"providers":[{"id":"codex","name":"Codex"}],"view":{"hidden":[],"windows":[],"names":{}},"sources":[{"id":"one","provider":"codex","successAt":1,"windows":[{"id":"week","kind":"weekly","label":null,"minutes":10080}]},{"id":"two","provider":"codex","successAt":1,"windows":[{"id":"week","kind":"weekly","label":null,"minutes":10080}]}]}),
        );
        let mut candidate: Candidate = serde_json::from_value(json!({"id":"event","kind":"low","at":10,"observedFrom":1,"observedAt":2,"sourceId":"two","windowId":"week","provider":"codex","name":"old name","window":{"kind":"weekly","label":null,"minutes":10080},"remaining":29,"resetAt":null})).unwrap();
        assert!(board.resolve(&mut candidate));
        assert!(matches!(&candidate, Candidate::Quota(q) if q.name == "Codex 2"));
        board.apply("view", json!({"view":{"hidden":[],"windows":[],"names":{"two":"New name"}}}));
        assert!(board.resolve(&mut candidate));
        assert!(matches!(&candidate, Candidate::Quota(q) if q.name == "New name"));
        board.apply(
            "filters",
            configuration(
                1,
                json!({"mode":"exclude","values":[]}),
                json!({"mode":"exclude","values":[["two","week"]]}),
            ),
        );
        assert!(!board.resolve(&mut candidate));
        board.apply("lineup", json!({"sources":["one"]}));
        board.apply("view", json!({"view":{"hidden":[],"windows":[],"names":{}}}));
        assert!(!board.resolve(&mut candidate));
    }

    #[test]
    fn saved_masks_gate_queued_nonminimum_windows_and_announcements() {
        let mut board = Board::default();
        ready_snapshot(
            &mut board,
            json!({"providers":[{"id":"codex","name":"Codex"}],"view":{"version":5,"hidden":[],"windows":[],"names":{}},"sources":[{"id":"one","provider":"codex","successAt":1,"windows":[{"id":"week","kind":"weekly","label":null,"minutes":10080},{"id":"session","kind":"session","label":null,"minutes":300}]}]}),
        );
        let mut queued: Candidate = serde_json::from_value(json!({"id":"queued","kind":"low","at":10,"observedFrom":1,"observedAt":2,"sourceId":"one","windowId":"week","provider":"codex","name":"","window":{"kind":"weekly","label":null,"minutes":10080},"remaining":29,"resetAt":null})).unwrap();
        let mut announcement: Candidate = serde_json::from_value(json!({"id":"announcement","kind":"announcement","at":10,"provider":"codex","scheduledFor":null,"resetKind":null,"credit":{"name":"Fixture","url":"https://example.test"},"url":"https://example.test"})).unwrap();
        assert!(board.resolve(&mut queued));
        assert!(board.resolve(&mut announcement));
        board.apply(
            "filters",
            configuration(
                1,
                json!({"mode":"exclude","values":[]}),
                json!({"mode":"exclude","values":[["one","week"]]}),
            ),
        );
        assert!(
            !board.resolve(&mut queued),
            "the final sink checks a nonminimum window without another attention frame"
        );
        board.apply(
            "filters",
            configuration(0, json!({"mode":"exclude","values":[]}), json!({"mode":"exclude","values":[]})),
        );
        assert!(!board.resolve(&mut queued), "stale saves cannot restore permission");
        board.apply(
            "filters",
            configuration(2, json!({"mode":"include","values":[]}), json!({"mode":"exclude","values":[]})),
        );
        assert!(!board.resolve(&mut queued), "source selection is checked independently of windows");
        assert!(!board.resolve(&mut announcement), "queued announcements also obey the saved source mask");
        board.apply(
            "filters",
            configuration(3, json!({"mode":"exclude","values":[]}), json!({"mode":"exclude","values":[]})),
        );
        assert!(board.resolve(&mut queued));
        assert!(board.resolve(&mut announcement));
        let mut same = configuration(4, json!({"mode":"exclude","values":[]}), json!({"mode":"exclude","values":[]}));
        same["filters"]["projects"] = json!({"mode":"include","values":[]});
        board.apply("filters", same);
        assert!(board.resolve(&mut queued), "a project-only save does not reset a valid queued intent");
        board.apply("filters",json!({"revision":5,"authority":"filter-authority-test","filters":{"version":1,"sources":{"mode":"exclude","values":[]},"windows":{"mode":"include","values":["invalid"]}}}));
        assert!(!board.resolve(&mut queued), "malformed applicable masks fail closed");
    }

    #[test]
    fn saved_masks_accept_released_window_text_without_blocking_other_windows() {
        let mut board = Board::default();
        ready_snapshot(
            &mut board,
            json!({"view":{"version":5,"hidden":[],"windows":[]},"sources":[{"id":"one","provider":"codex","successAt":1,"windows":[{"id":"week","kind":"weekly","label":null,"minutes":10080}]}]}),
        );
        for (index, window) in ["gemini-2.5:session".to_string(), "週".repeat(120), "🪟".repeat(120)].iter().enumerate()
        {
            board.apply(
                "filters",
                configuration(
                    index as u64 + 1,
                    json!({"mode":"exclude","values":[]}),
                    json!({"mode":"exclude","values":[["one",window]]}),
                ),
            );
            assert!(board.visible("one", Some("week")), "a valid exclusion must not invalidate the whole mask");
            assert!(!board.mask.as_ref().unwrap().windows.admits(&("one".into(), window.clone())));
        }
        assert!(window_identifier(&json!("週".repeat(121))).is_none());
        assert!(window_identifier(&json!("")).is_none());
        assert!(identifier(&json!("bad.source")).is_none());
    }

    #[test]
    fn snapshots_wait_for_their_matching_configuration() {
        let mut board = Board::default();
        board.snapshot(json!({"filtersRevision":3,"filtersAuthority":"new-authority-test","view":{"version":5,"hidden":[],"windows":[]},"sources":[{"id":"one","provider":"codex","successAt":1,"windows":[{"id":"week","kind":"weekly","label":null,"minutes":10080}]}]}));
        assert!(!board.visible("one", Some("week")));
        board.apply(
            "filters",
            configuration(3, json!({"mode":"exclude","values":[]}), json!({"mode":"exclude","values":[]})),
        );
        assert!(!board.visible("one", Some("week")), "another authority's configuration cannot finish this snapshot");
        let mut matching =
            configuration(3, json!({"mode":"exclude","values":[]}), json!({"mode":"exclude","values":[]}));
        matching["authority"] = json!("new-authority-test");
        board.apply("filters", matching);
        assert!(board.visible("one", Some("week")));
    }
}
