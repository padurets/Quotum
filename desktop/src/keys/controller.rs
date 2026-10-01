//! Decisions use fingerprints. One worker owns all system-store calls and late results.
use super::{
    ErrorCode, Kek, KeyRef, Kind, Marker, Outcome, Previous, PublicState, Reason, Report, State,
    files::{FilePort, Files},
    store::{Store, StorePort},
};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, Sender},
};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Control {
    state: Mutex<PublicState>,
    reset: AtomicBool,
}
impl Control {
    pub fn state(&self) -> PublicState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn unavailable(&self) {
        self.publish(PublicState { state: State::Waiting, ..PublicState::default() });
    }
    pub fn request_reset(&self) -> Result<(), &'static str> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.busy {
            return Ok(());
        }
        if !state.reset_available {
            return Err("secret_key_reset_unavailable");
        }
        state.busy = true;
        self.reset.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn publish(&self, state: PublicState) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = state;
    }
}

struct Candidate {
    reference: KeyRef,
    key: Kek,
}
#[derive(Clone, Debug)]
struct CandidateInfo {
    reference: KeyRef,
    fingerprint: String,
    number: u64,
}
struct Scan {
    candidates: Vec<Candidate>,
    complete: bool,
    available: bool,
    absent: bool,
    code: Option<ErrorCode>,
    names: Vec<String>,
}
enum Job {
    Scan(Vec<KeyRef>),
    Create(KeyRef, Kek),
    Delete(Vec<(KeyRef, String)>, String),
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum JobKind {
    Scan,
    Create,
    Rotate,
    Delete,
}
enum Work {
    Scan(Scan),
    Created(KeyRef, Kek),
    Deleted(Vec<KeyRef>),
}
struct Worker {
    send: Sender<(u64, Job)>,
    received: Receiver<(u64, Result<Work, ErrorCode>)>,
}
impl Worker {
    fn new(files: Arc<dyn FilePort>, mut factory: StoreFactory) -> Self {
        let (send, jobs) = mpsc::channel::<(u64, Job)>();
        let (results, received) = mpsc::channel();
        thread::spawn(move || {
            let mut store: Option<Box<dyn StorePort>> = None;
            while let Ok((token, job)) = jobs.recv() {
                let work = match job {
                    Job::Scan(refs) => Ok(Work::Scan(scan(files.as_ref(), &mut store, &mut factory, refs))),
                    Job::Create(reference, key) => (|| {
                        let store = store.as_ref().ok_or(ErrorCode::Unavailable)?;
                        store.create(&reference.name, &key)?;
                        Ok(Work::Created(reference, key))
                    })(),
                    Job::Delete(refs, protected) => (|| {
                        let mut deleted = Vec::new();
                        for (reference, expected) in refs {
                            let read = match reference.kind {
                                Kind::File => files.read(&reference.name),
                                Kind::Keystore => store.as_ref().ok_or(ErrorCode::Unavailable)?.read(&reference.name),
                            };
                            match read {
                                Err(ErrorCode::NoEntry) => {
                                    deleted.push(reference);
                                    continue;
                                }
                                Ok(key) if key.fingerprint() == expected && key.fingerprint() != protected => {}
                                Ok(_) => return Err(ErrorCode::StaleReport),
                                Err(error) => return Err(error),
                            }
                            match reference.kind {
                                Kind::File => files.remove(&reference)?,
                                Kind::Keystore => store.as_ref().ok_or(ErrorCode::Unavailable)?.remove(&reference)?,
                            }
                            deleted.push(reference);
                        }
                        Ok(Work::Deleted(deleted))
                    })(),
                };
                if work.as_ref().is_err_and(|error| stale_store(*error)) {
                    store = None;
                }
                if results.send((token, work)).is_err() {
                    return;
                }
            }
        });
        Self { send, received }
    }
}
type StoreFactory = Box<dyn FnMut(&str) -> Result<Box<dyn StorePort>, ErrorCode> + Send>;
fn stale_store(error: ErrorCode) -> bool {
    matches!(error, ErrorCode::Unavailable | ErrorCode::StoreFailure)
}
fn scan(
    files: &dyn FilePort,
    store: &mut Option<Box<dyn StorePort>>,
    factory: &mut StoreFactory,
    refs: Vec<KeyRef>,
) -> Scan {
    let mut scan =
        Scan { candidates: Vec::new(), complete: true, available: false, absent: false, code: None, names: Vec::new() };
    let mut refs: HashSet<KeyRef> = refs.into_iter().collect();
    let mut store_search_failed = false;
    let mut store_stale = false;
    match files.names() {
        Ok(names) => {
            scan.names.extend(names.clone());
            refs.extend(names.into_iter().map(|name| KeyRef { kind: Kind::File, name }));
        }
        Err(error) => {
            scan.complete = false;
            scan.code = Some(error);
        }
    }
    if store.is_none() {
        match factory(files.hash()) {
            Ok(new) => *store = Some(new),
            Err(ErrorCode::Unavailable) => scan.absent = true,
            Err(error) => {
                scan.complete = false;
                scan.code = Some(error);
                store_stale |= stale_store(error);
            }
        }
    }
    if let Some(store) = store {
        match store.writable() {
            Ok(()) => scan.available = true,
            Err(error) => {
                scan.complete = false;
                scan.code = Some(error);
                store_stale |= stale_store(error);
            }
        }
        match store.names() {
            Ok(names) => {
                // Some services report a cancelled unlock as an empty search result.
                // Do not follow it with a second prompt for the marker's target.
                if names.is_empty() && store.writable().is_err() {
                    store_search_failed = true;
                    scan.complete = false;
                    scan.code = Some(ErrorCode::NoAccess);
                }
                scan.names.extend(names.clone());
                refs.extend(names.into_iter().map(|name| KeyRef { kind: Kind::Keystore, name }));
            }
            Err(error) => {
                scan.complete = false;
                scan.code = Some(error);
                store_search_failed = true;
                store_stale |= stale_store(error);
            }
        }
    }
    for reference in refs {
        // A cancelled search must not immediately ask for another unlock of a known item.
        if (store_search_failed || store_stale) && reference.kind == Kind::Keystore {
            scan.names.push(reference.name);
            continue;
        }
        let result = match reference.kind {
            Kind::File => files.read(&reference.name),
            Kind::Keystore => store.as_ref().map(|s| s.read(&reference.name)).unwrap_or(Err(ErrorCode::Unavailable)),
        };
        scan.names.push(reference.name.clone());
        match result {
            Ok(key) => scan.candidates.push(Candidate { reference, key }),
            Err(ErrorCode::NoEntry | ErrorCode::InvalidBytes) => {}
            Err(ErrorCode::Unavailable) if scan.absent => {}
            Err(error) => {
                scan.complete = false;
                scan.code = Some(error);
                store_stale |= reference.kind == Kind::Keystore && stale_store(error);
            }
        }
    }
    // A completed transport failure can leave an owner-specific session unusable.
    // Reconnect on the next job, never alongside a pending native prompt.
    if store_stale {
        *store = None;
    }
    scan
}

#[derive(Clone, Debug, PartialEq)]
enum Action {
    Keep,
    Search,
    Probe(KeyRef),
    CreateFirst(Kind),
    StageRotation,
    Cleanup(Vec<KeyRef>),
    Waiting,
    Missing,
}
struct Decision<'a> {
    report: &'a Report,
    supplied: Option<&'a str>,
    marker: Option<&'a Marker>,
    marker_exists: bool,
    candidates: &'a [CandidateInfo],
    scan_ready: bool,
    complete: bool,
    store_available: bool,
    store_absent: bool,
    attempted: &'a HashSet<(Option<String>, KeyRef)>,
    restarts: usize,
    created_first: bool,
    in_flight: bool,
    names_seen: bool,
    file_exposed: bool,
}
fn decide(input: Decision<'_>) -> Action {
    let r = input.report;
    if !r.valid() || r.current.as_deref() != input.supplied {
        return Action::Waiting;
    }
    let accepted = matches!(r.outcome, Outcome::Created | Outcome::Ok | Outcome::Rotated) && r.current == r.stored;
    if accepted {
        if input.complete
            && !input.in_flight
            && r.unreadable == 0
            && let Some(marker) = input.marker
        {
            let cleanup: Vec<_> = marker
                .previous
                .iter()
                .filter(|old| {
                    old.to == r.current.as_deref().unwrap_or("")
                        && old.from != old.to
                        && old.r#ref != marker.current
                        && match old.reason {
                            Reason::Rotation => matches!(r.outcome, Outcome::Ok | Outcome::Rotated),
                            Reason::Reset => matches!(r.outcome, Outcome::Created | Outcome::Ok),
                        }
                })
                .filter(|old| {
                    input.candidates.iter().any(|c| {
                        c.reference == old.r#ref
                            && c.fingerprint == old.from
                            && Some(c.fingerprint.as_str()) != input.supplied
                    })
                })
                .map(|old| old.r#ref.clone())
                .collect();
            if !cleanup.is_empty() {
                return Action::Cleanup(cleanup);
            }
            if r.outcome == Outcome::Ok
                && (marker.current.kind == Kind::File || input.file_exposed)
                && marker.next.is_none()
                && input.store_available
            {
                return Action::StageRotation;
            }
        }
        return Action::Keep;
    }
    if !input.scan_ready {
        return if input.in_flight { Action::Waiting } else { Action::Search };
    }
    if input.restarts >= input.candidates.len() + 2 {
        return if input.complete && !input.in_flight { Action::Missing } else { Action::Waiting };
    }
    if let Some(stored) = &r.stored
        && let Some(candidate) = input
            .candidates
            .iter()
            .find(|c| &c.fingerprint == stored && !input.attempted.contains(&(r.stored.clone(), c.reference.clone())))
    {
        return Action::Probe(candidate.reference.clone());
    }
    if r.stored.is_none()
        && r.credentials > 0
        && let Some(candidate) =
            input.candidates.iter().find(|c| !input.attempted.contains(&(None, c.reference.clone())))
    {
        return Action::Probe(candidate.reference.clone());
    }
    if !input.complete {
        return Action::Waiting;
    }
    if r.credentials == 0 {
        let mut candidates = input.candidates.to_vec();
        candidates.sort_by_key(|c| {
            (c.number, input.marker.is_some_and(|m| m.current == c.reference), c.reference.kind == Kind::Keystore)
        });
        if let Some(candidate) =
            candidates.iter().rev().find(|c| !input.attempted.contains(&(r.stored.clone(), c.reference.clone())))
        {
            return Action::Probe(candidate.reference.clone());
        }
        if candidates.is_empty() && !input.names_seen && !input.marker_exists && !input.created_first {
            if input.store_available {
                return Action::CreateFirst(Kind::Keystore);
            }
            if input.store_absent {
                return Action::CreateFirst(Kind::File);
            }
        }
    }
    Action::Missing
}

pub struct Manager {
    files: Arc<dyn FilePort>,
    worker: Worker,
    marker: Option<Marker>,
    marker_exists: bool,
    next_on_open: bool,
    candidates: Vec<Candidate>,
    scan: Option<(bool, bool, bool)>,
    report: Option<Report>,
    current: Option<KeyRef>,
    previous: Option<KeyRef>,
    reset_intent: Option<String>,
    generation: u64,
    token: u64,
    in_flight: Option<(u64, u64, Instant, JobKind)>,
    attempted: HashSet<(Option<String>, KeyRef)>,
    restarts: usize,
    maximum: u64,
    created_first: bool,
    rotation_staged: bool,
    rotation_failures: u8,
    reset_pending: bool,
    retry_at: Instant,
    retry_delay: u64,
    code: Option<ErrorCode>,
    names_seen: bool,
}
impl Manager {
    pub fn new(app: &Path) -> Result<Self, ErrorCode> {
        Self::with_ports(Arc::new(Files::new(app)?), Box::new(|hash| Ok(Box::new(Store::new(hash)?))))
    }
    fn with_ports(files: Arc<dyn FilePort>, factory: StoreFactory) -> Result<Self, ErrorCode> {
        let read = files.marker();
        let marker_exists = !matches!(read, Ok(None));
        let marker = read.ok().flatten();
        let next_on_open = marker.as_ref().is_some_and(|m| m.next.is_some());
        let maximum = marker
            .as_ref()
            .map(|m| {
                std::iter::once(&m.current)
                    .chain(m.next.iter())
                    .chain(m.previous.iter().map(|p| &p.r#ref))
                    .filter_map(|r| files.number(&r.name))
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        Ok(Self {
            worker: Worker::new(files.clone(), factory),
            files,
            marker,
            marker_exists,
            next_on_open,
            candidates: Vec::new(),
            scan: None,
            report: None,
            current: None,
            previous: None,
            reset_intent: None,
            generation: 0,
            token: 0,
            in_flight: None,
            attempted: HashSet::new(),
            restarts: 0,
            maximum,
            created_first: false,
            rotation_staged: false,
            rotation_failures: 0,
            reset_pending: false,
            retry_at: Instant::now(),
            retry_delay: 2,
            code: None,
            names_seen: false,
        })
    }
    fn key(&self, reference: &KeyRef) -> Option<&Kek> {
        self.candidates.iter().find(|c| &c.reference == reference).map(|c| &c.key)
    }
    fn supplied(&self) -> Option<&str> {
        self.current.as_ref().and_then(|r| self.key(r)).map(Kek::fingerprint)
    }
    fn reserve(&mut self, kind: Kind) -> Result<KeyRef, ErrorCode> {
        // The native scan can still be waiting for unlock. Its local reservations
        // already exist on disk and must not wait for that aggregate result.
        for name in self.files.names()? {
            self.maximum = self.maximum.max(self.files.number(&name).unwrap_or(0));
        }
        self.maximum = self.maximum.checked_add(1).ok_or(ErrorCode::Overflow)?;
        let name = self.files.name(self.maximum)?;
        self.files.reserve(&name)?;
        self.names_seen = true;
        Ok(KeyRef { kind, name })
    }
    fn file_exposed(&self) -> bool {
        self.supplied().is_some_and(|fp| {
            self.candidates.iter().any(|c| c.reference.kind == Kind::File && c.key.fingerprint() == fp)
        })
    }
    fn job(&mut self, job: Job) -> Result<(), ErrorCode> {
        if self.in_flight.is_some() {
            return Err(ErrorCode::Timeout);
        }
        self.token = self.token.checked_add(1).ok_or(ErrorCode::Overflow)?;
        let kind = match &job {
            Job::Scan(_) => JobKind::Scan,
            Job::Create(_, _) if self.rotation_staged => JobKind::Rotate,
            Job::Create(_, _) => JobKind::Create,
            Job::Delete(_, _) => JobKind::Delete,
        };
        self.worker.send.send((self.token, job)).map_err(|_| ErrorCode::StoreFailure)?;
        self.in_flight = Some((self.token, self.generation, Instant::now(), kind));
        Ok(())
    }
    fn search(&mut self) -> Result<(), ErrorCode> {
        let refs = self
            .marker
            .as_ref()
            .map(|m| {
                std::iter::once(&m.current)
                    .chain(m.next.iter())
                    .chain(m.previous.iter().map(|p| &p.r#ref))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        self.job(Job::Scan(refs))
    }
    /// Captured per spawn. The one-shot intent is consumed even when no start report arrives.
    pub fn environment(&mut self) -> Vec<(String, String)> {
        self.generation += 1;
        self.report = None;
        let mut own = vec![(
            "QUOTUM_SECRET_KEY_STATE".into(),
            match (
                if self.file_exposed() { Some(Kind::File) } else { self.current.as_ref().map(|r| r.kind) },
                self.marker.as_ref().is_some_and(|m| m.was_file),
            ) {
                (Some(Kind::Keystore), true) => "keystore_was_file",
                (Some(Kind::Keystore), false) => "keystore",
                (Some(Kind::File), _) => "file",
                _ => "waiting",
            }
            .into(),
        )];
        if let Some(key) = self.current.as_ref().and_then(|r| self.key(r)) {
            own.push(("QUOTUM_SECRET_KEY".into(), key.encoded()));
        }
        if let Some(key) = self.previous.as_ref().and_then(|r| self.key(r)) {
            own.push(("QUOTUM_SECRET_KEY_PREVIOUS".into(), key.encoded()));
        }
        if let Some(intent) = self.reset_intent.take() {
            own.push(("QUOTUM_SECRET_KEY_RESET".into(), intent));
        }
        own
    }
    pub fn report(&mut self, report: Report) -> bool {
        if self.report.is_some() || !report.valid() || report.current.as_deref() != self.supplied() {
            self.code = Some(ErrorCode::StaleReport);
            return false;
        }
        self.report = Some(report);
        true
    }
    pub fn startup_failure(&mut self) -> bool {
        if self.previous.is_none() || self.rotation_failures >= 2 {
            return false;
        }
        self.rotation_failures += 1;
        self.restarts += 1;
        if self.rotation_failures == 2 {
            self.current = self.previous.take();
        }
        true
    }
    /// An input consumed by a failed spawn must not keep later explicit resets busy.
    pub fn attempt_ended(&mut self, control: &Control) -> bool {
        if self.reset_pending && self.reset_intent.is_none() && self.report.is_none() {
            self.reset_pending = false;
            control.publish(PublicState { busy: false, ..control.state() });
            true
        } else {
            false
        }
    }
    pub fn tick(&mut self, control: &Control) -> bool {
        let result = self.advance(control);
        let restart = match result {
            Ok(restart) => restart,
            Err(error) => {
                self.code = Some(error);
                self.retry_at = Instant::now() + Duration::from_secs(self.retry_delay);
                self.retry_delay = (self.retry_delay * 2).min(60);
                false
            }
        };
        let accepted = self
            .report
            .as_ref()
            .is_some_and(|r| matches!(r.outcome, Outcome::Created | Outcome::Ok | Outcome::Rotated));
        let complete = self.scan.is_some_and(|s| s.0);
        let waiting = !complete || self.in_flight.is_some() || self.code.is_some() || self.report.is_none();
        let state = if accepted {
            match if self.file_exposed() { Some(Kind::File) } else { self.current.as_ref().map(|r| r.kind) } {
                Some(Kind::File) => State::File,
                Some(Kind::Keystore) => State::Keystore,
                _ => State::Waiting,
            }
        } else if waiting {
            State::Waiting
        } else {
            State::Missing
        };
        control.publish(PublicState {
            state,
            outcome: self.report.as_ref().map(|r| r.outcome),
            was_file: self.marker.as_ref().is_some_and(|m| m.was_file)
                || self.candidates.iter().any(|c| c.reference.kind == Kind::File),
            retained_file: self
                .candidates
                .iter()
                .any(|c| c.reference.kind == Kind::File && Some(&c.reference) != self.current.as_ref()),
            reset_available: !accepted && self.report.is_some(),
            busy: self.reset_pending,
        });
        restart
    }
    fn advance(&mut self, control: &Control) -> Result<bool, ErrorCode> {
        if let Ok((token, work)) = self.worker.received.try_recv() {
            let Some((expected, generation, _, kind)) = self.in_flight.take() else {
                return Err(ErrorCode::StaleReport);
            };
            if token != expected {
                return Err(ErrorCode::StaleReport);
            }
            if generation == self.generation {
                let work = match work {
                    Ok(work) => work,
                    Err(error) => {
                        if kind == JobKind::Rotate {
                            self.rotation_staged = false;
                            self.scan = None;
                        }
                        return Err(error);
                    }
                };
                match work {
                    Work::Scan(scan) => {
                        self.names_seen |= !scan.names.is_empty();
                        for name in &scan.names {
                            self.maximum = self.maximum.max(self.files.number(name).unwrap_or(0));
                        }
                        // Accepted/current keys survive an incomplete rescan.
                        for candidate in scan.candidates {
                            if !self.candidates.iter().any(|c| c.reference == candidate.reference) {
                                self.candidates.push(candidate);
                            }
                        }
                        self.scan = Some((scan.complete, scan.available, scan.absent));
                        self.code = scan.code;
                        self.retry_at = Instant::now() + Duration::from_secs(self.retry_delay);
                        self.retry_delay = (self.retry_delay * 2).min(60);
                    }
                    Work::Created(reference, key) => {
                        if self.rotation_staged {
                            let mut marker = self.marker.clone().ok_or(ErrorCode::MetadataInvalid)?;
                            marker.next = Some(reference.clone());
                            marker.was_file = true;
                            self.files.save(&marker)?;
                            self.marker = Some(marker);
                        } else {
                            let marker = Marker {
                                version: 1,
                                current: reference.clone(),
                                next: None,
                                previous: Vec::new(),
                                was_file: reference.kind == Kind::File,
                            };
                            self.files.save(&marker)?;
                            self.marker = Some(marker);
                            self.marker_exists = true;
                            self.current = Some(reference.clone());
                        }
                        self.candidates.push(Candidate { reference, key });
                        if !self.rotation_staged {
                            self.restarts += 1;
                            return Ok(true);
                        }
                    }
                    Work::Deleted(refs) => {
                        self.candidates.retain(|c| !refs.contains(&c.reference));
                        if let Some(marker) = &mut self.marker {
                            marker.previous.retain(|p| !refs.contains(&p.r#ref));
                            self.files.save(marker)?;
                        }
                        self.previous = None;
                    }
                }
            } // A late cancelled create is an orphan, found by the next scoped scan.
        }
        if control.reset.swap(false, Ordering::SeqCst) {
            return self.reset();
        }
        if self.in_flight.is_some_and(|(_, _, started, _)| started.elapsed() >= Duration::from_secs(60)) {
            self.code = Some(ErrorCode::Timeout);
        }
        let Some(report) = self.report.clone() else { return Ok(false) };
        if self.reset_pending && matches!(report.outcome, Outcome::Created | Outcome::Ok) {
            self.reset_pending = false;
        }
        if self.scan.is_none() && self.in_flight.is_none() && (self.code.is_none() || Instant::now() >= self.retry_at) {
            self.search()?;
        }
        if self.next_on_open && self.scan.is_some() && self.in_flight.is_none() {
            self.next_on_open = false;
            if let Some(marker) = self.marker.clone()
                && let (Some(next), Some(old)) = (marker.next.clone(), self.key(&marker.current))
            {
                if let Some(new) = self.key(&next) {
                    if report.stored.as_deref() == Some(old.fingerprint()) {
                        let mut changed = marker.clone();
                        changed.current = next.clone();
                        changed.next = None;
                        changed.was_file = true;
                        changed.previous.push(Previous {
                            r#ref: marker.current.clone(),
                            reason: Reason::Rotation,
                            from: old.fingerprint().into(),
                            to: new.fingerprint().into(),
                        });
                        self.files.save(&changed)?;
                        self.marker = Some(changed);
                        self.current = Some(next);
                        self.previous = Some(marker.current);
                        self.restarts += 1;
                        return Ok(true);
                    }
                } else if self.scan.is_some_and(|s| s.0) {
                    let mut changed = marker;
                    changed.next = None;
                    self.files.save(&changed)?;
                    self.marker = Some(changed);
                }
            }
        }
        let infos: Vec<_> = self
            .candidates
            .iter()
            .map(|c| CandidateInfo {
                reference: c.reference.clone(),
                fingerprint: c.key.fingerprint().into(),
                number: self.files.number(&c.reference.name).unwrap_or(0),
            })
            .collect();
        let (complete, available, absent) = self.scan.unwrap_or((false, false, false));
        let action = decide(Decision {
            report: &report,
            supplied: self.supplied(),
            marker: self.marker.as_ref(),
            marker_exists: self.marker_exists,
            candidates: &infos,
            scan_ready: self.scan.is_some(),
            complete,
            store_available: available,
            store_absent: absent,
            attempted: &self.attempted,
            restarts: self.restarts,
            created_first: self.created_first,
            in_flight: self.in_flight.is_some() || self.code.is_some() && Instant::now() < self.retry_at,
            names_seen: self.names_seen,
            file_exposed: self.file_exposed(),
        });
        match action {
            Action::Search => self.search()?,
            Action::Probe(reference) => {
                self.attempted.insert((report.stored, reference.clone()));
                let was_file = self.marker.as_ref().is_some_and(|m| m.was_file)
                    || self.candidates.iter().any(|c| c.reference.kind == Kind::File);
                let mut marker = self.marker.clone().unwrap_or(Marker {
                    version: 1,
                    current: reference.clone(),
                    next: None,
                    previous: Vec::new(),
                    was_file,
                });
                if marker.current != reference {
                    marker.previous.clear();
                    marker.next = None;
                }
                if report.credentials == 0 {
                    // An empty replacement proves no rotation. Detach its old cleanup authority
                    // before a new `created` report can become `ok` on a later start.
                    marker.previous.retain(|old| old.reason == Reason::Reset);
                    marker.next = None;
                }
                marker.current = reference.clone();
                marker.was_file |= was_file;
                self.files.save(&marker)?;
                self.marker = Some(marker);
                self.marker_exists = true;
                self.current = Some(reference);
                self.previous = None;
                self.restarts += 1;
                self.code = None;
                return Ok(true);
            }
            Action::CreateFirst(kind) => {
                self.created_first = true;
                let reference = self.reserve(kind)?;
                let key = Kek::random()?;
                if kind == Kind::Keystore {
                    self.job(Job::Create(reference, key))?;
                } else {
                    self.files.create(&reference.name, &key)?;
                    let marker = Marker {
                        version: 1,
                        current: reference.clone(),
                        next: None,
                        previous: Vec::new(),
                        was_file: true,
                    };
                    self.files.save(&marker)?;
                    self.marker = Some(marker);
                    self.marker_exists = true;
                    self.current = Some(reference.clone());
                    self.candidates.push(Candidate { reference, key });
                    self.restarts += 1;
                    return Ok(true);
                }
            }
            Action::StageRotation if !self.rotation_staged => {
                self.rotation_staged = true;
                let reference = self.reserve(Kind::Keystore)?;
                self.job(Job::Create(reference, Kek::random()?))?;
            }
            Action::Cleanup(refs) => {
                let marker = self.marker.as_ref().ok_or(ErrorCode::MetadataInvalid)?;
                let expected = refs
                    .into_iter()
                    .filter_map(|r| marker.previous.iter().find(|p| p.r#ref == r).map(|p| (r, p.from.clone())))
                    .collect();
                self.job(Job::Delete(expected, self.supplied().ok_or(ErrorCode::StaleReport)?.into()))?;
            }
            Action::Missing | Action::Waiting => {
                if action == Action::Missing && self.current.is_some() && self.restarts < infos.len() + 2 {
                    self.current = None;
                    self.previous = None;
                    self.restarts += 1;
                    return Ok(true);
                }
                if self.in_flight.is_none() && Instant::now() >= self.retry_at {
                    self.attempted.clear();
                    self.restarts = 0;
                    self.search()?;
                }
            }
            Action::Keep
                if (self.current.as_ref().is_some_and(|r| r.kind == Kind::File) || !complete)
                    && !self.rotation_staged
                    && self.in_flight.is_none()
                    && Instant::now() >= self.retry_at =>
            {
                self.search()?;
            }
            Action::Keep | Action::StageRotation => {}
        }
        Ok(false)
    }
    fn reset(&mut self) -> Result<bool, ErrorCode> {
        let report = self.report.as_ref().ok_or(ErrorCode::StaleReport)?;
        if matches!(report.outcome, Outcome::Created | Outcome::Ok | Outcome::Rotated) {
            return Err(ErrorCode::StaleReport);
        }
        let from = report.stored.clone();
        let reference = self.reserve(Kind::File)?;
        let key = Kek::random()?;
        self.files.create(&reference.name, &key)?;
        let previous = self
            .candidates
            .iter()
            .filter(|c| Some(c.key.fingerprint()) == from.as_deref())
            .map(|c| Previous {
                r#ref: c.reference.clone(),
                reason: Reason::Reset,
                from: c.key.fingerprint().into(),
                to: key.fingerprint().into(),
            })
            .collect();
        let marker = Marker { version: 1, current: reference.clone(), next: None, previous, was_file: true };
        self.files.save(&marker)?;
        self.reset_intent = Some(format!("{}:{}", from.as_deref().unwrap_or("none"), key.fingerprint()));
        self.marker = Some(marker);
        self.marker_exists = true;
        self.current = Some(reference.clone());
        self.previous = None;
        self.candidates.push(Candidate { reference, key });
        self.reset_pending = true;
        self.rotation_staged = false;
        self.scan = None;
        self.code = None;
        self.restarts += 1;
        Ok(true)
    }
    pub fn code(&self) -> Option<&'static str> {
        self.code.map(ErrorCode::code)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn reference(n: u64, kind: Kind) -> KeyRef {
        KeyRef { kind, name: format!("hub-secret-key@test#{n}") }
    }
    fn key(byte: u8) -> Kek {
        Kek::from_bytes([byte; 32]).unwrap()
    }
    fn info(n: u64, kind: Kind, byte: u8) -> CandidateInfo {
        CandidateInfo { reference: reference(n, kind), fingerprint: key(byte).fingerprint().into(), number: n }
    }
    fn report(outcome: Outcome, credentials: u64) -> Report {
        Report {
            outcome,
            stored: Some(
                key(if matches!(outcome, Outcome::Created | Outcome::Ok | Outcome::Rotated) { 1 } else { 0 })
                    .fingerprint()
                    .into(),
            ),
            current: if outcome == Outcome::Missing { None } else { Some(key(1).fingerprint().into()) },
            credentials,
            unreadable: 0,
        }
    }
    fn input<'a>(
        report: &'a Report,
        candidates: &'a [CandidateInfo],
        attempted: &'a HashSet<(Option<String>, KeyRef)>,
    ) -> Decision<'a> {
        Decision {
            report,
            supplied: report.current.as_deref(),
            marker: None,
            marker_exists: false,
            candidates,
            scan_ready: true,
            complete: true,
            store_available: false,
            store_absent: true,
            attempted,
            restarts: 0,
            created_first: false,
            in_flight: false,
            names_seen: !candidates.is_empty(),
            file_exposed: false,
        }
    }
    #[test]
    fn creation_requires_authoritative_empty_database_complete_search_and_backend_absence() {
        let r = Report { stored: None, ..report(Outcome::Missing, 0) };
        let attempted = HashSet::new();
        assert_eq!(decide(input(&r, &[], &attempted)), Action::CreateFirst(Kind::File));
        assert_eq!(
            decide(Decision { store_available: true, ..input(&r, &[], &attempted) }),
            Action::CreateFirst(Kind::Keystore)
        );
        for decision in [
            Decision { complete: false, ..input(&r, &[], &attempted) },
            Decision { in_flight: true, scan_ready: false, ..input(&r, &[], &attempted) },
            Decision { marker_exists: true, ..input(&r, &[], &attempted) },
            Decision { created_first: true, ..input(&r, &[], &attempted) },
            Decision { store_absent: false, ..input(&r, &[], &attempted) },
        ] {
            assert!(!matches!(decide(decision), Action::CreateFirst(_)));
        }
        let nonempty = report(Outcome::Missing, 1);
        assert_eq!(decide(input(&nonempty, &[], &attempted)), Action::Missing);
    }
    #[test]
    fn fingerprint_recovery_ignores_pointer_and_can_use_a_match_from_incomplete_search() {
        let r = report(Outcome::Missing, 3);
        let attempted = HashSet::new();
        let candidates = [info(1, Kind::File, 1), info(2, Kind::Keystore, 0)];
        let marker = Marker {
            version: 1,
            current: candidates[0].reference.clone(),
            next: None,
            previous: Vec::new(),
            was_file: true,
        };
        assert_eq!(
            decide(Decision { marker: Some(&marker), complete: false, ..input(&r, &candidates, &attempted) }),
            Action::Probe(candidates[1].reference.clone())
        );
        let bad = Report { current: Some(key(1).fingerprint().into()), ..r };
        assert_eq!(decide(Decision { supplied: None, ..input(&bad, &candidates, &attempted) }), Action::Waiting);
    }
    #[test]
    fn empty_database_reuses_highest_existing_generation_without_creating_or_deleting() {
        let r = Report { stored: None, ..report(Outcome::Missing, 0) };
        let attempted = HashSet::new();
        let candidates = [info(1, Kind::Keystore, 1), info(3, Kind::File, 0), info(3, Kind::Keystore, 0)];
        assert_eq!(decide(input(&r, &candidates, &attempted)), Action::Probe(candidates[2].reference.clone()));
        let marker = Marker {
            version: 1,
            current: candidates[1].reference.clone(),
            next: None,
            previous: Vec::new(),
            was_file: true,
        };
        assert_eq!(
            decide(Decision { marker: Some(&marker), ..input(&r, &candidates, &attempted) }),
            Action::Probe(candidates[1].reference.clone())
        );
    }
    #[test]
    fn legacy_candidate_probes_and_restart_budget_are_bounded() {
        let candidates: Vec<_> = (1..=8).map(|n| info(n, Kind::Keystore, n as u8)).collect();
        let mut attempted = HashSet::new();
        let mut r = Report { stored: None, ..report(Outcome::Missing, 2) };
        let mut restarts = 0;
        loop {
            match decide(Decision { restarts, ..input(&r, &candidates, &attempted) }) {
                Action::Probe(reference) => {
                    assert!(attempted.insert((None, reference.clone())));
                    restarts += 1;
                    r.current = candidates.iter().find(|c| c.reference == reference).map(|c| c.fingerprint.clone());
                    r.outcome = Outcome::Mismatch;
                }
                Action::Missing => break,
                _ => panic!("unexpected bounded recovery action"),
            }
        }
        assert_eq!(restarts, candidates.len());
        assert_eq!(
            decide(Decision { restarts: candidates.len() + 2, ..input(&r, &candidates, &HashSet::new()) }),
            Action::Missing
        );
    }
    #[test]
    fn cleanup_needs_matching_authority_reason_and_no_unreadable_records() {
        let old = info(1, Kind::File, 0);
        let current = info(2, Kind::Keystore, 1);
        let found = info(3, Kind::File, 2);
        let candidates = [old.clone(), current.clone(), found.clone()];
        let attempted = HashSet::new();
        let marker = Marker {
            version: 1,
            current: current.reference.clone(),
            next: None,
            previous: vec![Previous {
                r#ref: old.reference.clone(),
                reason: Reason::Rotation,
                from: old.fingerprint.clone(),
                to: current.fingerprint.clone(),
            }],
            was_file: true,
        };
        for outcome in [Outcome::Created, Outcome::Ok, Outcome::Rotated] {
            let r = report(outcome, 2);
            let action = decide(Decision { marker: Some(&marker), ..input(&r, &candidates, &attempted) });
            assert_eq!(
                action,
                if outcome == Outcome::Created { Action::Keep } else { Action::Cleanup(vec![old.reference.clone()]) }
            );
            for altered in [
                Decision { complete: false, marker: Some(&marker), ..input(&r, &candidates, &attempted) },
                Decision { in_flight: true, marker: Some(&marker), ..input(&r, &candidates, &attempted) },
            ] {
                assert_eq!(decide(altered), Action::Keep);
            }
            let unreadable = Report { unreadable: 1, ..r };
            assert_eq!(
                decide(Decision { marker: Some(&marker), ..input(&unreadable, &candidates, &attempted) }),
                Action::Keep
            );
        }
        let mut reset = marker;
        reset.previous[0].reason = Reason::Reset;
        let r = report(Outcome::Created, 0);
        assert_eq!(
            decide(Decision { marker: Some(&reset), ..input(&r, &candidates, &attempted) }),
            Action::Cleanup(vec![old.reference])
        );
    }
    #[test]
    fn decision_sequences_preserve_current_stored_and_discovered_keys() {
        let candidates = [info(1, Kind::File, 0), info(2, Kind::Keystore, 1), info(3, Kind::File, 2)];
        let attempted = HashSet::new();
        for outcome in [Outcome::Created, Outcome::Ok, Outcome::Rotated, Outcome::Mismatch, Outcome::Missing] {
            for credentials in [0, 1, 3] {
                for complete in [false, true] {
                    for in_flight in [false, true] {
                        for unreadable in 0..=credentials {
                            let r = Report { unreadable, ..report(outcome, credentials) };
                            let marker = Marker {
                                version: 1,
                                current: candidates[1].reference.clone(),
                                next: None,
                                previous: vec![Previous {
                                    r#ref: candidates[0].reference.clone(),
                                    reason: Reason::Rotation,
                                    from: candidates[0].fingerprint.clone(),
                                    to: candidates[1].fingerprint.clone(),
                                }],
                                was_file: true,
                            };
                            let action = decide(Decision {
                                marker: Some(&marker),
                                complete,
                                in_flight,
                                ..input(&r, &candidates, &attempted)
                            });
                            if let Action::Cleanup(refs) = action {
                                for reference in refs {
                                    assert_ne!(reference, candidates[1].reference);
                                    assert_ne!(reference, candidates[2].reference);
                                    assert!(complete && !in_flight && unreadable == 0);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[derive(Default)]
    struct Disk {
        marker: Option<Marker>,
        bad_marker: bool,
        keys: BTreeMap<String, Vec<u8>>,
        fail_save: bool,
        reserved: Vec<String>,
    }
    #[derive(Default)]
    struct FakeFiles {
        data: Mutex<Disk>,
    }
    impl FilePort for FakeFiles {
        fn hash(&self) -> &str {
            "test"
        }
        fn number(&self, name: &str) -> Option<u64> {
            super::super::store::number("hub-secret-key@test#", name)
        }
        fn name(&self, n: u64) -> Result<String, ErrorCode> {
            Ok(reference(n, Kind::File).name)
        }
        fn marker(&self) -> Result<Option<Marker>, ErrorCode> {
            let disk = self.data.lock().unwrap();
            if disk.bad_marker { Err(ErrorCode::MetadataInvalid) } else { Ok(disk.marker.clone()) }
        }
        fn save(&self, marker: &Marker) -> Result<(), ErrorCode> {
            let mut disk = self.data.lock().unwrap();
            if disk.fail_save {
                return Err(ErrorCode::FileFailure);
            }
            disk.marker = Some(marker.clone());
            Ok(())
        }
        fn names(&self) -> Result<Vec<String>, ErrorCode> {
            let disk = self.data.lock().unwrap();
            Ok(disk.keys.keys().cloned().chain(disk.reserved.iter().cloned()).collect())
        }
        fn read(&self, name: &str) -> Result<Kek, ErrorCode> {
            let disk = self.data.lock().unwrap();
            Kek::parse(disk.keys.get(name).ok_or(ErrorCode::NoEntry)?)
        }
        fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode> {
            let mut disk = self.data.lock().unwrap();
            if disk.keys.contains_key(name) {
                return Err(ErrorCode::FileFailure);
            }
            disk.keys.insert(name.into(), key.encoded().into_bytes());
            Ok(())
        }
        fn reserve(&self, name: &str) -> Result<(), ErrorCode> {
            let mut disk = self.data.lock().unwrap();
            if disk.reserved.iter().any(|old| old == name) {
                return Err(ErrorCode::MetadataInvalid);
            }
            disk.reserved.push(name.into());
            Ok(())
        }
        fn remove(&self, reference: &KeyRef) -> Result<(), ErrorCode> {
            self.data.lock().unwrap().keys.remove(&reference.name);
            Ok(())
        }
    }
    #[derive(Default)]
    struct StoreData {
        keys: BTreeMap<String, Vec<u8>>,
        locked: bool,
        blocked_create: Option<Arc<Block>>,
    }
    struct Block {
        entered: Sender<()>,
        released: Mutex<Receiver<()>>,
    }
    struct FakeStore(Arc<Mutex<StoreData>>);
    #[test]
    fn a_cancelled_empty_store_search_does_not_prompt_again_for_the_marker() {
        struct Cancelled(std::sync::Arc<std::sync::atomic::AtomicUsize>);
        impl StorePort for Cancelled {
            fn writable(&self) -> Result<(), ErrorCode> {
                Err(ErrorCode::NoAccess)
            }
            fn names(&self) -> Result<Vec<String>, ErrorCode> {
                Ok(vec![])
            }
            fn read(&self, _: &str) -> Result<Kek, ErrorCode> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(ErrorCode::NoAccess)
            }
            fn create(&self, _: &str, _: &Kek) -> Result<(), ErrorCode> {
                panic!("must not create")
            }
            fn remove(&self, _: &KeyRef) -> Result<(), ErrorCode> {
                panic!("must not remove")
            }
        }
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut store: Option<Box<dyn StorePort>> = Some(Box::new(Cancelled(reads.clone())));
        let mut factory: StoreFactory = Box::new(|_| panic!("store already exists"));
        let result = scan(&FakeFiles::default(), &mut store, &mut factory, vec![reference(1, Kind::Keystore)]);
        assert!(!result.complete);
        assert!(result.candidates.is_empty());
        assert_eq!(reads.load(Ordering::SeqCst), 0);
    }
    impl StorePort for FakeStore {
        fn read(&self, name: &str) -> Result<Kek, ErrorCode> {
            let store = self.0.lock().unwrap();
            if store.locked {
                return Err(ErrorCode::NoAccess);
            }
            Kek::parse(store.keys.get(name).ok_or(ErrorCode::NoEntry)?)
        }
        fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode> {
            let block = self.0.lock().unwrap().blocked_create.take();
            if let Some(block) = block {
                block.entered.send(()).unwrap();
                block.released.lock().unwrap().recv().unwrap();
            }
            let mut store = self.0.lock().unwrap();
            if store.locked {
                return Err(ErrorCode::NoAccess);
            }
            if store.keys.contains_key(name) {
                return Err(ErrorCode::MetadataInvalid);
            }
            store.keys.insert(name.into(), key.encoded().into_bytes());
            Ok(())
        }
        fn names(&self) -> Result<Vec<String>, ErrorCode> {
            let store = self.0.lock().unwrap();
            if store.locked { Err(ErrorCode::NoAccess) } else { Ok(store.keys.keys().cloned().collect()) }
        }
        fn remove(&self, reference: &KeyRef) -> Result<(), ErrorCode> {
            self.0.lock().unwrap().keys.remove(&reference.name);
            Ok(())
        }
    }
    fn manager(files: Arc<FakeFiles>, store: Option<Arc<Mutex<StoreData>>>) -> Manager {
        Manager::with_ports(
            files,
            Box::new(move |_| match &store {
                Some(store) => Ok(Box::new(FakeStore(store.clone()))),
                None => Err(ErrorCode::Unavailable),
            }),
        )
        .unwrap()
    }
    fn started(manager: &mut Manager, stored: Option<&str>, outcome: Outcome, credentials: u64, unreadable: u64) {
        let _private_env = manager.environment();
        assert!(manager.report(Report {
            outcome,
            stored: stored.map(str::to_owned),
            current: manager.supplied().map(str::to_owned),
            credentials,
            unreadable
        }));
    }
    fn until(manager: &mut Manager, control: &Control, satisfied: impl Fn(&Manager) -> bool) -> bool {
        for _ in 0..2000 {
            let restart = manager.tick(control);
            if satisfied(manager) {
                return restart;
            }
            thread::sleep(Duration::from_millis(1));
        }
        panic!("the isolated controller did not settle");
    }
    #[test]
    fn lost_pointer_and_locked_store_never_create_a_key_then_unlock_recovers_by_fingerprint() {
        let files = Arc::new(FakeFiles::default());
        let store = Arc::new(Mutex::new(StoreData { locked: true, ..Default::default() }));
        store.lock().unwrap().keys.insert(reference(8, Kind::Keystore).name.clone(), key(0).encoded().into_bytes());
        let mut manager = manager(files.clone(), Some(store.clone()));
        let control = Control::default();
        started(&mut manager, Some(key(0).fingerprint()), Outcome::Missing, 2, 0);
        until(&mut manager, &control, |m| m.scan.is_some() && m.in_flight.is_none());
        assert_eq!(control.state().state, State::Waiting);
        assert!(files.data.lock().unwrap().keys.is_empty());
        store.lock().unwrap().locked = false;
        manager.retry_at = Instant::now();
        assert!(until(&mut manager, &control, |m| m.current.is_some()));
        assert_eq!(manager.supplied(), Some(key(0).fingerprint()));
        assert!(manager.marker.as_ref().unwrap().previous.is_empty());
        assert_eq!(store.lock().unwrap().keys.len(), 1);
    }
    #[test]
    fn recovery_reconnects_a_stale_session_but_keeps_a_locked_one() {
        use std::sync::atomic::AtomicUsize;
        struct Session {
            owner: usize,
            current_owner: Arc<AtomicUsize>,
            unlocked: Arc<AtomicBool>,
        }
        impl StorePort for Session {
            fn names(&self) -> Result<Vec<String>, ErrorCode> {
                Ok(vec![reference(8, Kind::Keystore).name])
            }
            fn read(&self, _: &str) -> Result<Kek, ErrorCode> {
                if self.owner != self.current_owner.load(Ordering::SeqCst) {
                    Err(ErrorCode::StoreFailure)
                } else if !self.unlocked.load(Ordering::SeqCst) {
                    Err(ErrorCode::NoAccess)
                } else {
                    Ok(key(0))
                }
            }
            fn create(&self, _: &str, _: &Kek) -> Result<(), ErrorCode> {
                panic!("recovery must not replace the key")
            }
            fn remove(&self, _: &KeyRef) -> Result<(), ErrorCode> {
                panic!("recovery must preserve keys")
            }
        }
        let files = Arc::new(FakeFiles::default());
        let owner = Arc::new(AtomicUsize::new(1));
        let unlocked = Arc::new(AtomicBool::new(false));
        let builds = Arc::new(AtomicUsize::new(0));
        let (current_owner, readable, constructed) = (owner.clone(), unlocked.clone(), builds.clone());
        let mut manager = Manager::with_ports(
            files.clone(),
            Box::new(move |_| {
                constructed.fetch_add(1, Ordering::SeqCst);
                Ok(Box::new(Session {
                    owner: current_owner.load(Ordering::SeqCst),
                    current_owner: current_owner.clone(),
                    unlocked: readable.clone(),
                }))
            }),
        )
        .unwrap();
        let control = Control::default();
        started(&mut manager, Some(key(0).fingerprint()), Outcome::Missing, 2, 0);
        until(&mut manager, &control, |m| m.scan.is_some() && m.in_flight.is_none());
        assert_eq!(builds.load(Ordering::SeqCst), 1);
        manager.retry_at = Instant::now();
        manager.tick(&control);
        until(&mut manager, &control, |m| m.in_flight.is_none());
        assert_eq!(builds.load(Ordering::SeqCst), 1, "a locked session can still finish after unlock");
        owner.store(2, Ordering::SeqCst);
        unlocked.store(true, Ordering::SeqCst);
        manager.retry_at = Instant::now();
        manager.tick(&control);
        until(&mut manager, &control, |m| m.in_flight.is_none());
        assert_eq!(manager.code, Some(ErrorCode::StoreFailure));
        assert_eq!(builds.load(Ordering::SeqCst), 1, "the failed job must finish before recreation");
        assert!(manager.current.is_none());
        assert!(files.data.lock().unwrap().keys.is_empty());
        manager.retry_at = Instant::now();
        assert!(until(&mut manager, &control, |m| m.current.is_some()));
        assert_eq!(builds.load(Ordering::SeqCst), 2);
        assert_eq!(manager.current, Some(reference(8, Kind::Keystore)));
        assert_eq!(manager.supplied(), Some(key(0).fingerprint()));
        assert!(manager.marker.as_ref().unwrap().previous.is_empty());
        assert!(files.data.lock().unwrap().keys.is_empty());
    }
    #[test]
    fn a_soft_deadline_never_reconnects_alongside_the_pending_store_job() {
        use std::sync::atomic::AtomicUsize;
        struct Lost {
            entered: Sender<()>,
            released: Mutex<Receiver<()>>,
        }
        impl StorePort for Lost {
            fn names(&self) -> Result<Vec<String>, ErrorCode> {
                self.entered.send(()).unwrap();
                self.released.lock().unwrap().recv().unwrap();
                Err(ErrorCode::StoreFailure)
            }
            fn read(&self, _: &str) -> Result<Kek, ErrorCode> {
                panic!("a failed search must not immediately read again")
            }
            fn create(&self, _: &str, _: &Kek) -> Result<(), ErrorCode> {
                panic!("recovery must not create a key")
            }
            fn remove(&self, _: &KeyRef) -> Result<(), ErrorCode> {
                panic!("recovery must preserve keys")
            }
        }
        let (entered, blocked) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let mut lost = Some(Lost { entered, released: Mutex::new(released) });
        let store = Arc::new(Mutex::new(StoreData::default()));
        store.lock().unwrap().keys.insert(reference(8, Kind::Keystore).name, key(0).encoded().into_bytes());
        let builds = Arc::new(AtomicUsize::new(0));
        let constructed = builds.clone();
        let mut manager = Manager::with_ports(
            Arc::new(FakeFiles::default()),
            Box::new(move |_| {
                constructed.fetch_add(1, Ordering::SeqCst);
                if let Some(lost) = lost.take() { Ok(Box::new(lost)) } else { Ok(Box::new(FakeStore(store.clone()))) }
            }),
        )
        .unwrap();
        let control = Control::default();
        started(&mut manager, Some(key(0).fingerprint()), Outcome::Missing, 2, 0);
        manager.tick(&control);
        blocked.recv_timeout(Duration::from_secs(2)).unwrap();
        let token = manager.in_flight.as_ref().unwrap().0;
        manager.in_flight.as_mut().unwrap().2 = Instant::now() - Duration::from_secs(61);
        for _ in 0..10 {
            manager.retry_at = Instant::now();
            manager.tick(&control);
            assert_eq!(builds.load(Ordering::SeqCst), 1);
            assert_eq!(manager.in_flight.as_ref().unwrap().0, token);
        }
        assert_eq!(control.state().state, State::Waiting);
        release.send(()).unwrap();
        until(&mut manager, &control, |m| m.in_flight.is_none());
        assert_eq!(builds.load(Ordering::SeqCst), 1);
        manager.retry_at = Instant::now();
        assert!(until(&mut manager, &control, |m| m.current.is_some()));
        assert_eq!(builds.load(Ordering::SeqCst), 2);
        assert_eq!(manager.current, Some(reference(8, Kind::Keystore)));
    }
    #[test]
    fn a_stale_rotation_create_rechecks_the_store_and_preserves_its_orphan() {
        use std::sync::atomic::AtomicUsize;
        struct Session {
            owner: usize,
            current_owner: Arc<AtomicUsize>,
            store: Arc<Mutex<StoreData>>,
            block: Arc<Mutex<Option<Block>>>,
            write_succeeded: bool,
        }
        impl StorePort for Session {
            fn names(&self) -> Result<Vec<String>, ErrorCode> {
                if self.owner != self.current_owner.load(Ordering::SeqCst) {
                    Err(ErrorCode::StoreFailure)
                } else {
                    FakeStore(self.store.clone()).names()
                }
            }
            fn read(&self, name: &str) -> Result<Kek, ErrorCode> {
                if self.owner != self.current_owner.load(Ordering::SeqCst) {
                    Err(ErrorCode::StoreFailure)
                } else {
                    FakeStore(self.store.clone()).read(name)
                }
            }
            fn create(&self, name: &str, value: &Kek) -> Result<(), ErrorCode> {
                let block = self.block.lock().unwrap().take();
                if let Some(block) = block {
                    if self.write_succeeded {
                        FakeStore(self.store.clone()).create(name, value)?;
                    }
                    block.entered.send(()).unwrap();
                    block.released.lock().unwrap().recv().unwrap();
                    self.read(name).map(|_| ())
                } else {
                    FakeStore(self.store.clone()).create(name, value)?;
                    self.read(name).map(|_| ())
                }
            }
            fn remove(&self, _: &KeyRef) -> Result<(), ErrorCode> {
                panic!("a failed staging operation cannot authorize deletion")
            }
        }
        for write_succeeded in [false, true] {
            let files = Arc::new(FakeFiles::default());
            let old = reference(1, Kind::File);
            let old_fp = key(0).fingerprint().to_owned();
            {
                let mut disk = files.data.lock().unwrap();
                disk.keys.insert(old.name.clone(), key(0).encoded().into_bytes());
                disk.marker =
                    Some(Marker { version: 1, current: old.clone(), next: None, previous: Vec::new(), was_file: true });
            }
            let (entered, blocked) = mpsc::channel();
            let (release, released) = mpsc::channel();
            let block = Arc::new(Mutex::new(Some(Block { entered, released: Mutex::new(released) })));
            let store = Arc::new(Mutex::new(StoreData::default()));
            let owner = Arc::new(AtomicUsize::new(1));
            let builds = Arc::new(AtomicUsize::new(0));
            let (current_owner, backing, pending, constructed) =
                (owner.clone(), store.clone(), block.clone(), builds.clone());
            let mut manager = Manager::with_ports(
                files.clone(),
                Box::new(move |_| {
                    constructed.fetch_add(1, Ordering::SeqCst);
                    Ok(Box::new(Session {
                        owner: current_owner.load(Ordering::SeqCst),
                        current_owner: current_owner.clone(),
                        store: backing.clone(),
                        block: pending.clone(),
                        write_succeeded,
                    }))
                }),
            )
            .unwrap();
            let control = Control::default();
            started(&mut manager, Some(&old_fp), Outcome::Missing, 1, 0);
            until(&mut manager, &control, |m| m.current.is_some());
            started(&mut manager, Some(&old_fp), Outcome::Ok, 1, 0);
            manager.tick(&control);
            blocked.recv_timeout(Duration::from_secs(2)).unwrap();
            let token = manager.in_flight.as_ref().unwrap().0;
            manager.in_flight.as_mut().unwrap().2 = Instant::now() - Duration::from_secs(61);
            manager.retry_at = Instant::now();
            manager.tick(&control);
            assert_eq!(manager.in_flight.as_ref().unwrap().0, token);
            assert_eq!(builds.load(Ordering::SeqCst), 1);
            assert_eq!(manager.current, Some(old.clone()));
            owner.store(2, Ordering::SeqCst);
            release.send(()).unwrap();
            until(&mut manager, &control, |m| m.in_flight.is_none());
            assert_eq!(manager.code, Some(ErrorCode::StoreFailure));
            assert!(!manager.rotation_staged);
            assert!(manager.scan.is_none(), "the prior writable/complete facts are obsolete");
            assert!(manager.marker.as_ref().unwrap().next.is_none());
            for _ in 0..10 {
                manager.tick(&control);
                assert!(manager.in_flight.is_none(), "backoff precedes the fresh scan");
                assert_eq!(builds.load(Ordering::SeqCst), 1);
            }
            manager.retry_at = Instant::now();
            assert!(!until(&mut manager, &control, |m| m.marker.as_ref().unwrap().next.is_some()));
            assert_eq!(builds.load(Ordering::SeqCst), 2);
            assert_eq!(manager.marker.as_ref().unwrap().next, Some(reference(3, Kind::Keystore)));
            assert_eq!(manager.current, Some(old.clone()));
            assert_eq!(manager.supplied(), Some(old_fp.as_str()));
            assert!(manager.marker.as_ref().unwrap().previous.is_empty());
            assert_eq!(store.lock().unwrap().keys.contains_key(&reference(2, Kind::Keystore).name), write_succeeded);
            assert!(files.data.lock().unwrap().reserved.contains(&reference(2, Kind::Keystore).name));
            assert!(files.data.lock().unwrap().keys.contains_key(&old.name));
        }
    }
    #[test]
    fn complete_no_entry_updates_waiting_to_missing_without_restarting_hub() {
        let mut manager = manager(Arc::new(FakeFiles::default()), Some(Arc::new(Mutex::new(StoreData::default()))));
        let control = Control::default();
        started(&mut manager, Some(key(0).fingerprint()), Outcome::Missing, 1, 0);
        let generation = manager.generation;
        assert!(!until(&mut manager, &control, |m| m.scan.is_some() && m.in_flight.is_none()));
        assert_eq!(control.state().state, State::Missing);
        assert_eq!(manager.generation, generation);
        assert!(control.state().reset_available);
    }
    #[test]
    fn corrupt_marker_is_not_proof_of_first_run_even_when_database_is_empty() {
        let files = Arc::new(FakeFiles::default());
        files.data.lock().unwrap().bad_marker = true;
        let mut manager = manager(files.clone(), None);
        let control = Control::default();
        started(&mut manager, None, Outcome::Missing, 0, 0);
        until(&mut manager, &control, |m| m.scan.is_some() && m.in_flight.is_none());
        assert!(files.data.lock().unwrap().keys.is_empty());
        assert!(manager.current.is_none());
    }
    #[test]
    fn first_file_creation_is_durable_before_spawn_and_marker_failure_preserves_orphan() {
        for fail_save in [false, true] {
            let files = Arc::new(FakeFiles::default());
            files.data.lock().unwrap().fail_save = fail_save;
            let mut manager = manager(files.clone(), None);
            let control = Control::default();
            started(&mut manager, None, Outcome::Missing, 0, 0);
            until(&mut manager, &control, |m| m.created_first);
            let disk = files.data.lock().unwrap();
            assert_eq!(disk.keys.len(), 1);
            assert_eq!(manager.current.is_some(), !fail_save);
            assert_eq!(disk.marker.is_some(), !fail_save);
        }
    }
    #[test]
    fn file_to_store_is_staged_and_only_next_outer_start_can_rotate_and_cleanup() {
        let files = Arc::new(FakeFiles::default());
        let old = reference(1, Kind::File);
        let old_fp = key(0).fingerprint().to_owned();
        {
            let mut disk = files.data.lock().unwrap();
            disk.keys.insert(old.name.clone(), key(0).encoded().into_bytes());
            disk.marker =
                Some(Marker { version: 1, current: old.clone(), next: None, previous: Vec::new(), was_file: true });
        }
        let store = Arc::new(Mutex::new(StoreData::default()));
        let mut first = manager(files.clone(), Some(store.clone()));
        let control = Control::default();
        started(&mut first, Some(&old_fp), Outcome::Missing, 1, 0);
        until(&mut first, &control, |m| m.current.is_some());
        started(&mut first, Some(&old_fp), Outcome::Ok, 1, 0);
        until(&mut first, &control, |m| m.marker.as_ref().is_some_and(|m| m.next.is_some()));
        assert_eq!(first.current.as_ref(), Some(&old));
        assert!(files.data.lock().unwrap().keys.contains_key(&old.name));
        drop(first);
        let mut second = manager(files.clone(), Some(store.clone()));
        started(&mut second, Some(&old_fp), Outcome::Missing, 1, 0);
        until(&mut second, &control, |m| m.previous.is_some());
        let target = second.supplied().unwrap().to_owned();
        started(&mut second, Some(&target), Outcome::Rotated, 2, 1);
        second.tick(&control);
        assert!(files.data.lock().unwrap().keys.contains_key(&old.name));
        second.report.as_mut().unwrap().unreadable = 0;
        second.tick(&control);
        until(&mut second, &control, |m| m.marker.as_ref().is_some_and(|m| m.previous.is_empty()));
        assert!(!files.data.lock().unwrap().keys.contains_key(&old.name));
        assert_eq!(store.lock().unwrap().keys.len(), 1);
    }
    #[test]
    fn double_reset_joins_one_intent_and_intent_is_consumed_once() {
        let files = Arc::new(FakeFiles::default());
        let mut manager = manager(files.clone(), None);
        let control = Control::default();
        started(&mut manager, Some(key(0).fingerprint()), Outcome::Missing, 2, 0);
        until(&mut manager, &control, |m| m.scan.is_some() && m.in_flight.is_none());
        control.request_reset().unwrap();
        control.request_reset().unwrap();
        assert!(manager.tick(&control));
        assert_eq!(files.data.lock().unwrap().keys.len(), 1);
        let target = manager.supplied().unwrap().to_owned();
        let environment = manager.environment();
        assert!(environment.iter().any(|(name, _)| name == "QUOTUM_SECRET_KEY_RESET"));
        assert!(!manager.environment().iter().any(|(name, _)| name == "QUOTUM_SECRET_KEY_RESET"));
        assert_eq!(manager.supplied(), Some(target.as_str()));
        assert!(manager.marker.as_ref().unwrap().previous.is_empty());
    }
    #[test]
    fn a_lost_reset_attempt_finishes_busy_without_replaying_its_input() {
        let files = Arc::new(FakeFiles::default());
        let mut manager = manager(files.clone(), None);
        let control = Control::default();
        let old = key(0).fingerprint().to_owned();
        started(&mut manager, Some(&old), Outcome::Missing, 2, 0);
        until(&mut manager, &control, |m| m.scan.is_some() && m.in_flight.is_none());
        control.request_reset().unwrap();
        assert!(manager.tick(&control));
        assert!(control.state().busy);
        assert!(!manager.attempt_ended(&control), "the planned restart still has an unconsumed input");
        assert!(manager.environment().iter().any(|(name, _)| name == "QUOTUM_SECRET_KEY_RESET"));
        assert!(manager.attempt_ended(&control), "every no-report ending finishes the consumed action");
        assert!(!control.state().busy);
        assert!(!manager.reset_pending);
        assert_eq!(files.data.lock().unwrap().keys.len(), 1);
        let new = manager.supplied().unwrap().to_owned();
        let ordinary = manager.environment();
        assert!(!ordinary.iter().any(|(name, _)| name == "QUOTUM_SECRET_KEY_RESET"));
        assert!(manager.report(Report {
            outcome: Outcome::Mismatch,
            stored: Some(old.clone()),
            current: Some(new),
            credentials: 2,
            unreadable: 0,
        }));
        assert!(until(&mut manager, &control, |m| m.current.is_none()));
        started(&mut manager, Some(&old), Outcome::Missing, 2, 0);
        until(&mut manager, &control, |m| m.scan.is_some() && m.in_flight.is_none());
        assert!(control.state().reset_available);
        assert!(!control.state().busy);
        control.request_reset().unwrap();
        assert!(manager.tick(&control), "a fresh explicit action can recover again");
        assert_eq!(files.data.lock().unwrap().keys.len(), 2, "the first key was preserved");
    }
    fn private_test_directory(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        #[cfg(windows)]
        super::super::windows::private_directory(path).unwrap();
    }
    #[test]
    fn reset_reads_local_reservations_while_the_native_scan_is_pending() {
        struct Pending {
            name: String,
            entered: Sender<()>,
            released: Mutex<Receiver<()>>,
        }
        impl StorePort for Pending {
            fn names(&self) -> Result<Vec<String>, ErrorCode> {
                self.entered.send(()).unwrap();
                self.released.lock().unwrap().recv().unwrap();
                Ok(vec![self.name.clone()])
            }
            fn read(&self, _: &str) -> Result<Kek, ErrorCode> {
                Err(ErrorCode::NoAccess)
            }
            fn create(&self, _: &str, _: &Kek) -> Result<(), ErrorCode> {
                panic!("reset must not start another native operation")
            }
            fn remove(&self, _: &KeyRef) -> Result<(), ErrorCode> {
                panic!("reset must preserve old keys")
            }
        }
        let parent = std::env::var_os("QUOTUM_TEST_PRIVATE_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| {
            #[cfg(unix)]
            let parent = std::env::var_os("CARGO_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".cache"));
            #[cfg(windows)]
            let parent = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap());
            parent
        });
        let root = parent.join(format!("pending-reservations-{}-{}", std::process::id(), getrandom::u64().unwrap()));
        private_test_directory(&root);
        let app = root.join("app");
        private_test_directory(&app);
        let files = Arc::new(Files::new(&app).unwrap());
        for number in [1, 2, 9] {
            files.reserve(&files.name(number).unwrap()).unwrap();
        }
        let (entered, blocked) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let mut pending = Some(Pending { name: files.name(9).unwrap(), entered, released: Mutex::new(released) });
        let mut manager =
            Manager::with_ports(files.clone(), Box::new(move |_| Ok(Box::new(pending.take().unwrap())))).unwrap();
        let control = Control::default();
        started(&mut manager, Some(key(0).fingerprint()), Outcome::Missing, 2, 0);
        manager.tick(&control);
        blocked.recv_timeout(Duration::from_secs(2)).unwrap();
        manager.in_flight.as_mut().unwrap().2 = Instant::now() - Duration::from_secs(61);
        manager.tick(&control);
        control.request_reset().unwrap();
        assert!(manager.tick(&control));
        assert_eq!(manager.current.as_ref().unwrap().name, files.name(10).unwrap());
        assert!(manager.reset_intent.is_some());
        assert!(files.root.join(files.name(10).unwrap()).exists());
        for number in [1, 2, 9] {
            assert!(files.root.join(format!("{}.reserved", files.name(number).unwrap())).exists());
        }
        release.send(()).unwrap();
        until(&mut manager, &control, |m| m.in_flight.is_none());
        drop(manager);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn late_store_creation_after_reset_remains_an_orphan_without_changing_current() {
        let files = Arc::new(FakeFiles::default());
        let (entered, started_create) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let store = Arc::new(Mutex::new(StoreData {
            blocked_create: Some(Arc::new(Block { entered, released: Mutex::new(released) })),
            ..Default::default()
        }));
        let mut manager = manager(files.clone(), Some(store.clone()));
        let control = Control::default();
        started(&mut manager, None, Outcome::Missing, 0, 0);
        until(&mut manager, &control, |m| m.created_first);
        started_create.recv_timeout(Duration::from_secs(2)).unwrap();
        manager.in_flight.as_mut().unwrap().2 = Instant::now() - Duration::from_secs(61);
        manager.tick(&control);
        assert_eq!(control.state().state, State::Waiting);
        control.request_reset().unwrap();
        control.request_reset().unwrap();
        assert!(manager.tick(&control));
        let current = manager.current.clone().unwrap();
        let target = manager.supplied().unwrap().to_owned();
        assert_eq!(current, reference(2, Kind::File), "in-flight name stays reserved");
        started(&mut manager, Some(&target), Outcome::Created, 0, 0);
        release.send(()).unwrap();
        until(&mut manager, &control, |m| m.scan.is_some() && m.in_flight.is_none());
        assert_eq!(manager.current, Some(current.clone()));
        assert_eq!(manager.supplied(), Some(target.as_str()));
        assert_eq!(files.data.lock().unwrap().marker.as_ref().unwrap().current, current);
        assert!(
            store.lock().unwrap().keys.contains_key(&reference(1, Kind::Keystore).name),
            "late orphan is never automatically deleted"
        );
        assert!(!control.state().busy);
    }
    #[test]
    fn reserved_names_survive_lost_pointer_and_store_absence_without_reuse() {
        let files = Arc::new(FakeFiles::default());
        {
            let mut disk = files.data.lock().unwrap();
            disk.reserved.push(reference(20, Kind::Keystore).name);
            disk.keys.insert(reference(1, Kind::File).name, key(0).encoded().into_bytes());
        }
        let store = Arc::new(Mutex::new(StoreData::default()));
        let mut manager = manager(files.clone(), Some(store));
        let control = Control::default();
        let fp = key(0).fingerprint().to_owned();
        started(&mut manager, Some(&fp), Outcome::Missing, 1, 0);
        until(&mut manager, &control, |m| m.current.is_some());
        started(&mut manager, Some(&fp), Outcome::Ok, 1, 0);
        until(&mut manager, &control, |m| m.marker.as_ref().is_some_and(|m| m.next.is_some()));
        assert_eq!(manager.marker.as_ref().unwrap().next, Some(reference(21, Kind::Keystore)));
        assert!(files.data.lock().unwrap().reserved.contains(&reference(20, Kind::Keystore).name));
    }
    #[test]
    fn an_empty_replacement_never_cleans_old_rotation_keys_on_a_later_ok_start() {
        let files = Arc::new(FakeFiles::default());
        let store = Arc::new(Mutex::new(StoreData::default()));
        let old = reference(1, Kind::File);
        let current = reference(2, Kind::Keystore);
        let fp = key(1).fingerprint().to_owned();
        store.lock().unwrap().keys.insert(current.name.clone(), key(1).encoded().into_bytes());
        {
            let mut disk = files.data.lock().unwrap();
            disk.keys.insert(old.name.clone(), key(0).encoded().into_bytes());
            disk.marker = Some(Marker {
                version: 1,
                current: current.clone(),
                next: Some(current.clone()),
                was_file: true,
                previous: vec![Previous {
                    r#ref: old.clone(),
                    reason: Reason::Rotation,
                    from: key(0).fingerprint().into(),
                    to: fp.clone(),
                }],
            });
        }
        let control = Control::default();
        let mut first = manager(files.clone(), Some(store.clone()));
        started(&mut first, None, Outcome::Missing, 0, 0);
        until(&mut first, &control, |m| m.current.is_some());
        assert_eq!(first.current, Some(current.clone()));
        assert!(first.marker.as_ref().unwrap().previous.is_empty());
        assert!(first.marker.as_ref().unwrap().next.is_none());
        started(&mut first, Some(&fp), Outcome::Created, 0, 0);
        first.tick(&control);
        drop(first);
        let mut later = manager(files.clone(), Some(store));
        started(&mut later, Some(&fp), Outcome::Missing, 0, 0);
        until(&mut later, &control, |m| m.current.is_some());
        started(&mut later, Some(&fp), Outcome::Ok, 0, 0);
        for _ in 0..20 {
            later.tick(&control);
            std::thread::yield_now();
        }
        assert_eq!(later.current, Some(current));
        assert!(files.data.lock().unwrap().keys.contains_key(&old.name));
        assert!(control.state().retained_file);
    }
    #[test]
    fn a_file_copy_of_current_store_key_is_file_exposure_and_rotates_to_a_fresh_key() {
        let files = Arc::new(FakeFiles::default());
        files.data.lock().unwrap().keys.insert(reference(9, Kind::File).name, key(1).encoded().into_bytes());
        let store = Arc::new(Mutex::new(StoreData::default()));
        store.lock().unwrap().keys.insert(reference(2, Kind::Keystore).name, key(1).encoded().into_bytes());
        let mut manager = manager(files.clone(), Some(store));
        let control = Control::default();
        let fp = key(1).fingerprint().to_owned();
        started(&mut manager, Some(&fp), Outcome::Missing, 1, 0);
        until(&mut manager, &control, |m| m.current.is_some());
        manager.current = Some(reference(2, Kind::Keystore));
        manager.marker.as_mut().unwrap().current = reference(2, Kind::Keystore);
        started(&mut manager, Some(&fp), Outcome::Ok, 1, 0);
        until(&mut manager, &control, |m| m.marker.as_ref().is_some_and(|m| m.next.is_some()));
        assert_eq!(control.state().state, State::File);
        assert!(control.state().retained_file);
        assert!(manager.environment().iter().any(|(name, value)| name == "QUOTUM_SECRET_KEY_STATE" && value == "file"));
        assert!(files.data.lock().unwrap().keys.contains_key(&reference(9, Kind::File).name));
    }
    #[cfg(any(target_os = "linux", windows))]
    #[test]
    #[ignore = "requires an explicitly initialized native test store and private test directory"]
    fn native_controller_recovers_pointer_stages_rotation_and_preserves_foreign_keys() {
        assert_eq!(std::env::var("QUOTUM_KEYRING_SMOKE").ok().as_deref(), Some("1"));
        let parent = std::env::var_os("QUOTUM_TEST_PRIVATE_DIR").or({
            #[cfg(windows)]
            {
                std::env::var_os("LOCALAPPDATA")
            }
            #[cfg(not(windows))]
            {
                None
            }
        });
        let parent = std::path::PathBuf::from(parent.unwrap());
        let root = parent.join(format!("native-controller-{}-{}", std::process::id(), getrandom::u64().unwrap()));
        private_test_directory(&root);
        let app = root.join("app");
        private_test_directory(&app);
        let files = Files::new(&app).unwrap();
        let old = KeyRef { kind: Kind::File, name: files.name(1).unwrap() };
        let old_key = key(0);
        let old_fp = old_key.fingerprint().to_owned();
        files.create(&old.name, &old_key).unwrap();
        files
            .save(&Marker { version: 1, current: old.clone(), next: None, previous: Vec::new(), was_file: true })
            .unwrap();
        let store = Store::new(&files.hash).unwrap();
        let foreign = KeyRef { kind: Kind::Keystore, name: files.name(9).unwrap() };
        store.create(&foreign.name, &key(2)).unwrap();
        let control = Control::default();
        let mut first = Manager::new(&app).unwrap();
        started(&mut first, Some(&old_fp), Outcome::Missing, 1, 0);
        until(&mut first, &control, |m| m.current.is_some());
        started(&mut first, Some(&old_fp), Outcome::Ok, 1, 0);
        until(&mut first, &control, |m| m.marker.as_ref().is_some_and(|m| m.next.is_some()));
        let target = first.marker.as_ref().unwrap().next.clone().unwrap();
        assert_eq!(files.number(&target.name), Some(10));
        assert!(files.read(&old.name).is_ok());
        drop(first);
        let mut second = Manager::new(&app).unwrap();
        started(&mut second, Some(&old_fp), Outcome::Missing, 1, 0);
        until(&mut second, &control, |m| m.previous.is_some());
        let fp = second.supplied().unwrap().to_owned();
        started(&mut second, Some(&fp), Outcome::Rotated, 1, 0);
        until(&mut second, &control, |m| m.marker.as_ref().is_some_and(|m| m.previous.is_empty()));
        assert!(matches!(files.read(&old.name), Err(ErrorCode::NoEntry)));
        assert!(store.read(&foreign.name).is_ok());
        drop(second);
        std::fs::remove_file(files.root.join("marker.json")).unwrap();
        let mut third = Manager::new(&app).unwrap();
        started(&mut third, Some(&fp), Outcome::Missing, 1, 0);
        until(&mut third, &control, |m| m.current.is_some());
        assert_eq!(third.current, Some(target.clone()));
        assert!(third.marker.as_ref().unwrap().previous.is_empty());
        drop(third);
        store.remove(&target).unwrap();
        store.remove(&foreign).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires a real isolated store and GUI lock/unlock driver"]
    fn native_controller_keeps_one_pending_unlock_and_accepts_its_late_result() {
        use std::io::{BufRead, Write};
        use std::os::unix::fs::DirBuilderExt;
        assert_eq!(std::env::var("QUOTUM_KEYRING_SMOKE").ok().as_deref(), Some("1"));
        let cancel = std::env::var("QUOTUM_TEST_UNLOCK_CANCEL").ok().as_deref() == Some("1");
        let parent = std::path::PathBuf::from(std::env::var_os("QUOTUM_TEST_PRIVATE_DIR").unwrap());
        let root = parent.join(format!("native-unlock-{}-{}", std::process::id(), getrandom::u64().unwrap()));
        std::fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let app = root.join("app");
        std::fs::DirBuilder::new().mode(0o700).create(&app).unwrap();
        let files = Files::new(&app).unwrap();
        let current = KeyRef { kind: Kind::Keystore, name: files.name(1).unwrap() };
        let value = key(0);
        let fp = value.fingerprint().to_owned();
        let store = Store::new(&files.hash).unwrap();
        store.create(&current.name, &value).unwrap();
        files
            .save(&Marker { version: 1, current: current.clone(), next: None, previous: vec![], was_file: false })
            .unwrap();
        println!("Native fixture ready (cancel={cancel}): lock its default collection, then send a newline.");
        std::io::stdout().flush().unwrap();
        std::io::stdin().lock().read_line(&mut String::new()).unwrap();
        assert_eq!(store.writable(), Err(ErrorCode::NoAccess));
        let control = Control::default();
        let mut manager = Manager::new(&app).unwrap();
        started(&mut manager, Some(&fp), Outcome::Missing, 1, 0);
        manager.tick(&control);
        let pending = manager.in_flight.as_ref().unwrap().0;
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut waiting = false;
        while manager.current.is_none() && Instant::now() < deadline {
            manager.tick(&control);
            if manager.code == Some(ErrorCode::Timeout) && !waiting {
                assert_eq!(manager.in_flight.as_ref().unwrap().0, pending);
                assert_eq!(control.state().state, State::Waiting);
                waiting = true;
                println!("One unlock is still pending after 60 seconds; unlock or cancel it now.");
                std::io::stdout().flush().unwrap();
            }
            if cancel && manager.in_flight.is_none() {
                assert!(waiting);
                assert!(manager.code.is_some());
                assert_eq!(control.state().state, State::Waiting);
                assert_eq!(files.marker().unwrap().unwrap().current, current);
                // Keep the fixture for inspection: this isolated backend is discarded by the driver.
                return;
            }
            if let Some((token, _, _, _)) = &manager.in_flight {
                assert_eq!(*token, pending);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(waiting, "the driver must leave the first prompt open beyond the soft deadline");
        assert_eq!(manager.current, Some(current.clone()));
        assert!(manager.marker.as_ref().unwrap().previous.is_empty());
        store.remove(&current).unwrap();
        drop(manager);
        std::fs::remove_dir_all(root).unwrap();
    }
}
