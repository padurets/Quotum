//! One background subscription, independent of every window and tray watcher.
mod clock;
pub mod delivery;
#[cfg(target_os = "linux")]
mod linux;
mod sse;
mod transport;
use crate::{host, hub::HubState, shell::Shell};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub board_id: String,
    pub level: Option<Level>,
    pub quality: Quality,
    pub minimum: Option<Minimum>,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Warn,
    Crit,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Current,
    Partial,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Minimum {
    pub source_id: String,
    pub window_id: String,
    pub remaining: f64,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: Option<State>,
    pub connected: bool,
}

#[derive(Deserialize)]
struct Frame {
    seq: u64,
    now: i64,
    baseline: bool,
    state: State,
    notifications: Vec<Candidate>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum Candidate {
    Quota(Quota),
    Announcement(Announcement),
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub id: String,
    pub kind: String,
    pub at: i64,
    pub observed_from: i64,
    pub observed_at: i64,
    pub source_id: String,
    pub window_id: String,
    pub provider: String,
    pub name: String,
    pub window: QuotaWindow,
    pub remaining: f64,
    pub reset_at: Option<i64>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct QuotaWindow {
    pub kind: String,
    pub label: Option<String>,
    pub minutes: Option<i64>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    pub id: String,
    pub kind: String,
    pub at: i64,
    pub provider: String,
    pub scheduled_for: Option<i64>,
    pub reset_kind: Option<String>,
    pub credit: Credit,
    #[serde(rename = "url")]
    pub _url: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Credit {
    pub name: String,
    #[serde(rename = "url")]
    pub _url: String,
}
impl Candidate {
    pub fn kind(&self) -> &str {
        match self {
            Self::Quota(q) => &q.kind,
            Self::Announcement(a) => &a.kind,
        }
    }
    pub fn at(&self) -> i64 {
        match self {
            Self::Quota(q) => q.at,
            Self::Announcement(a) => a.at,
        }
    }
    pub fn id(&self) -> &str {
        match self {
            Self::Quota(q) => &q.id,
            Self::Announcement(a) => &a.id,
        }
    }
}
#[derive(Clone)]
pub struct Intent {
    pub candidate: Candidate,
    pub generation: u64,
    pub epoch: u64,
    pub baseline: i64,
    pub hub_now: i64,
    pub queued: Instant,
}

pub struct Attention {
    status: Mutex<Status>,
    cancel: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
    pub gate: Arc<clock::Gate>,
    board: Mutex<delivery::Board>,
    pub delivery: delivery::Delivery,
}
impl Default for Attention {
    fn default() -> Self {
        Self {
            status: Mutex::new(Status::default()),
            cancel: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
            gate: Arc::new(clock::Gate::default()),
            board: Mutex::default(),
            delivery: delivery::Delivery::default(),
        }
    }
}
impl Status {
    pub fn icon(&self) -> String {
        let level = match self.state.as_ref().and_then(|s| s.level) {
            Some(Level::Ok) => "ok",
            Some(Level::Warn) => "warn",
            Some(Level::Crit) => "crit",
            None => "neutral",
        };
        let partial = !self.connected || self.state.as_ref().is_none_or(|s| s.quality != Quality::Current);
        format!("{level}{}", if partial { "-partial" } else { "" })
    }
}

impl Attention {
    pub fn status(&self) -> Status {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn set(&self, shell: &Arc<Shell>, state: Option<State>, connected: bool) {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        let next = Status { state: state.or_else(|| status.state.clone()), connected };
        if *status == next {
            return;
        }
        *status = next.clone();
        drop(status);
        host::attention_changed(shell, &next);
        if let Some(smoke) = &shell.smoke {
            smoke.attention_seen(shell, &next);
        }
        shell.wake();
    }
    pub fn start(&self, shell: &Arc<Shell>) {
        let mut worker = self.worker.lock().unwrap_or_else(|e| e.into_inner());
        if worker.is_some() || self.cancel.load(Ordering::SeqCst) {
            return;
        }
        self.delivery.start(shell);
        let weak = Arc::downgrade(shell);
        *worker = Some(thread::spawn(move || run(weak)));
    }
    pub fn stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.gate.invalidate();
        self.delivery.stop();
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = worker.join();
        }
    }
}

pub struct Context {
    current: Box<dyn Fn() -> bool + Send + Sync>,
    generation: u64,
    epoch: Option<u64>,
    cancel: Arc<AtomicBool>,
    gate: Arc<clock::Gate>,
}
impl fmt::Debug for Context {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AttentionContext")
    }
}
impl Context {
    fn check(&self) -> io::Result<()> {
        if self.cancel.load(Ordering::SeqCst) || !(self.current)() || self.gate.check(true) != self.epoch {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "attention observation ended"));
        }
        Ok(())
    }
}

fn run(weak: Weak<Shell>) {
    let mut generation = u64::MAX;
    let mut cookie: Option<String> = None;
    let mut retries = 0_usize;
    while let Some(shell) = weak.upgrade() {
        if shell.exiting() || shell.attention.cancel.load(Ordering::SeqCst) {
            break;
        }
        let (hub, current) = shell.hub();
        if current != generation {
            generation = current;
            cookie = None;
            retries = 0;
            shell.attention.gate.invalidate();
            shell.attention.set(&shell, None, false);
        }
        let HubState::Ready(ready) = hub else {
            thread::sleep(Duration::from_millis(200));
            continue;
        };
        shell.attention.gate.invalidate();
        let epoch = shell.attention.gate.check(true);
        if epoch.is_none() {
            shell.attention.delivery.report(&shell, false);
        }
        let current_shell = weak.clone();
        let context = Arc::new(Context {
            current: Box::new(move || {
                current_shell.upgrade().is_some_and(|s| !s.exiting() && s.generation() == generation)
            }),
            generation,
            epoch,
            cancel: shell.attention.cancel.clone(),
            gate: shell.attention.gate.clone(),
        });
        let config = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_recv_response(Some(Duration::from_secs(10)))
            .build();
        let agent = ureq::Agent::with_parts(
            config,
            transport::LocalConnector(context.clone(), ready.port),
            ureq::unversioned::resolver::DefaultResolver::default(),
        );
        let result = stream(&shell, &context, &agent, &ready, &mut cookie);
        shell.attention.gate.invalidate();
        shell.attention.set(&shell, None, false);
        let limited = matches!(result, Err("attention limited"));
        if let Err(code) = result {
            shell.hub_log.line(&format!("app: {code}"));
        }
        let seconds = if limited { 30 } else { [1, 2, 5, 10, 30][retries.min(4)] };
        retries += 1;
        let mut random = [0_u8];
        let _ = getrandom::fill(&mut random);
        for _ in 0..(seconds * 10 + u64::from(random[0] % 6)) {
            if shell.exiting() || shell.generation() != generation || shell.attention.cancel.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

fn login(agent: &ureq::Agent, ready: &crate::hub::Ready) -> Result<String, &'static str> {
    let response = agent
        .get(format!("{}/local?key={}", ready.origin(), ready.key))
        .call()
        .map_err(|_| "attention login failed")?;
    if response.status().as_u16() != 303
        || response.headers().get("location").and_then(|v| v.to_str().ok()) != Some("/")
    {
        return Err("attention login refused");
    }
    response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .filter(|v| v.starts_with("quotum_session="))
        .map(str::to_owned)
        .ok_or("attention session missing")
}

fn stream(
    shell: &Arc<Shell>,
    context: &Arc<Context>,
    agent: &ureq::Agent,
    ready: &crate::hub::Ready,
    cookie: &mut Option<String>,
) -> Result<(), &'static str> {
    if cookie.is_none() {
        *cookie = Some(login(agent, ready)?);
    }
    let request = |cookie: &str| {
        agent
            .get(format!("{}/api/events?desktop=1", ready.origin()))
            .header("Cookie", cookie)
            .header("Quotum-Stream", "1")
            .call()
    };
    let mut response = request(cookie.as_deref().unwrap()).map_err(|_| "attention connection failed")?;
    if response.status().as_u16() == 401 {
        *cookie = Some(login(agent, ready)?);
        response = request(cookie.as_deref().unwrap()).map_err(|_| "attention connection failed")?;
    }
    if response.status().as_u16() == 429 {
        return Err("attention limited");
    }
    if response.status().as_u16() != 200 {
        return Err("attention stream refused");
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.starts_with("text/event-stream"))
    {
        return Err("attention format unavailable");
    }
    let mut decoder = sse::Decoder::default();
    let mut reader = response.body_mut().as_reader();
    let mut bytes = [0_u8; 8192];
    let mut seen = std::collections::HashSet::new();
    let (mut hello, mut snapshot, mut seq, mut baseline) = (false, false, 0, None);
    loop {
        context.check().map_err(|_| "attention observation ended")?;
        let n = reader.read(&mut bytes).map_err(|_| "attention connection ended")?;
        if n == 0 {
            return Err("attention connection ended");
        }
        context.check().map_err(|_| "attention observation ended")?;
        for (kind, data) in decoder.feed(&bytes[..n])? {
            context.check().map_err(|_| "attention observation ended")?;
            match kind.as_str() {
                "hello" => {
                    let v: Value = serde_json::from_str(&data).map_err(|_| "attention invalid hello")?;
                    if v["epoch"].as_str().is_none() || v["heartbeatMs"].as_u64() != Some(25_000) {
                        return Err("attention incompatible stream");
                    }
                    hello = true;
                }
                "snapshot" if hello => {
                    let value = serde_json::from_str(&data).map_err(|_| "attention invalid snapshot")?;
                    shell.attention.board.lock().unwrap_or_else(|e| e.into_inner()).snapshot(value);
                    snapshot = true;
                }
                "view" | "lineup" | "card" if snapshot => {
                    let value = serde_json::from_str(&data).map_err(|_| "attention invalid board change")?;
                    shell.attention.board.lock().unwrap_or_else(|e| e.into_inner()).apply(&kind, value);
                }
                "attention" if snapshot => {
                    let frame: Frame = serde_json::from_str(&data).map_err(|_| "attention invalid state")?;
                    if frame.seq <= seq {
                        continue;
                    }
                    seq = frame.seq;
                    if frame.baseline {
                        if !frame.notifications.is_empty()
                            || context.epoch.is_some_and(|epoch| !context.gate.baseline(epoch))
                        {
                            return Err("attention invalid baseline");
                        }
                        baseline = Some(frame.now);
                    }
                    if baseline.is_none() {
                        return Err("attention baseline missing");
                    }
                    shell.attention.set(shell, Some(frame.state), true);
                    for candidate in frame.notifications {
                        if seen.len() >= 4096 {
                            return Err("attention observation full");
                        }
                        if !seen.insert(candidate.id().to_owned()) {
                            continue;
                        }
                        let Some(epoch) = context.epoch else {
                            continue;
                        };
                        shell.attention.delivery.send(
                            shell,
                            Intent {
                                candidate,
                                generation: context.generation,
                                epoch,
                                baseline: baseline.unwrap(),
                                hub_now: frame.now,
                                queued: Instant::now(),
                            },
                        );
                    }
                }
                "bye" => {
                    let v: Value = serde_json::from_str(&data).map_err(|_| "attention invalid bye")?;
                    return Err(if v["reason"] == "limit" { "attention limited" } else { "attention stream ended" });
                }
                _ => {}
            }
        }
    }
}
