//! Fixed, opt-in numeric observations. Workers have no native publisher.
use std::{
    cell::Cell,
    marker::PhantomData,
    rc::Rc,
    sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
};

pub const LANES: usize = 7;
pub const ACTIVATIONS: usize = 8;
pub const ROWS: usize = LANES + ACTIVATIONS;
pub const FIELDS: usize = 10;
const MAX: u64 = i64::MAX as u64 - 2;
pub const OVERLAP: u64 = 1;
pub const PROPERTY_FAILURE: u64 = 2;
pub const OVERFLOW: u64 = 4;
pub const CALLBACK_OVERLAP: u64 = 8;
pub const PARTIAL: u64 = 16;
pub const CAPTURE_OVERLAP: u64 = 32;
pub const LIFE_SEEN: u64 = 1;
pub const CLOSE_CALL: u64 = 2;
pub const CLOSE_QUEUED: u64 = 4;
pub const CLOSE_FAILED: u64 = 8;
pub const DESTROY_CALL: u64 = 16;
pub const DESTROY_QUEUED: u64 = 32;
pub const DESTROY_FAILED: u64 = 64;
pub const CLOSE_EVENT: u64 = 128;
pub const DESTROYED_EVENT: u64 = 256;
pub const BROWSER_UNKNOWN: u64 = 512;
pub const ASSOCIATION_UNKNOWN: u64 = 1024;

struct Entry {
    busy: AtomicBool,
    sequence: AtomicU64,
    epoch: AtomicU64,
    values: [AtomicU64; FIELDS],
}
pub struct Records {
    pub enabled: bool,
    epoch: AtomicU64,
    errors: AtomicU64,
    callbacks: AtomicU64,
    callback_thread: AtomicU64,
    active_callback: AtomicU64,
    activations: AtomicU64,
    lock_owner: AtomicU64,
    entries: [Entry; ROWS],
}
#[derive(Clone, Copy, Default)]
pub struct Row {
    pub sequence: u64,
    pub epoch: u64,
    pub values: [u64; FIELDS],
}
pub struct Snapshot {
    pub epoch: u64,
    pub errors: u64,
    pub callbacks: u64,
    pub activations: u64,
    pub rows: [Row; ROWS],
}
impl Records {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            epoch: Default::default(),
            errors: Default::default(),
            callbacks: Default::default(),
            callback_thread: Default::default(),
            active_callback: Default::default(),
            activations: Default::default(),
            lock_owner: Default::default(),
            entries: std::array::from_fn(|_| Entry {
                busy: Default::default(),
                sequence: Default::default(),
                epoch: Default::default(),
                values: std::array::from_fn(|_| AtomicU64::new(0)),
            }),
        }
    }
    fn fail(&self, flag: u64) {
        self.errors.fetch_or(flag, SeqCst);
    }
    fn next(&self, counter: &AtomicU64) -> u64 {
        let previous = counter.load(SeqCst);
        if previous >= MAX {
            self.fail(OVERFLOW);
            return 0;
        }
        if counter.compare_exchange(previous, previous + 1, SeqCst, SeqCst).is_err() {
            self.fail(OVERLAP);
            return 0;
        }
        previous + 1
    }
    fn write(&self, lane: usize, values: &[u64]) {
        if !self.enabled {
            return;
        }
        let row = &self.entries[lane];
        if row.busy.compare_exchange(false, true, SeqCst, SeqCst).is_err() {
            self.fail(OVERLAP);
            return;
        }
        let sequence = row.sequence.load(SeqCst);
        if sequence >= MAX || values.iter().any(|value| *value > MAX) {
            self.fail(OVERFLOW);
            row.busy.store(false, SeqCst);
            return;
        }
        row.sequence.store(sequence + 1, SeqCst);
        for (index, (to, value)) in
            row.values.iter().zip(values.iter().copied().chain(std::iter::repeat(0))).enumerate()
        {
            if index < values.len() || !(2..=5).contains(&lane) || index < 7 {
                to.store(value, SeqCst);
            }
        }
        row.epoch.store(self.next(&self.epoch), SeqCst);
        row.sequence.store(sequence + 2, SeqCst);
        row.busy.store(false, SeqCst);
    }
    pub fn mark(&self, lane: usize, request: u64, thread: u32, stage: u64, subject: u64, details: [u64; 2]) {
        self.write(lane, &[request, 0, u64::from(thread), stage, subject, details[0], details[1]]);
    }
    // Tails of rows 2/4 hold the last main/compact (request, HWND, browser PID).
    // Rows 3/5 independently hold (request, HWND, lifecycle flags), not COM Close.
    // A reserved head marks only numeric initialization, never loaded or shown.
    fn tail(&self, lane: usize, request: u64, thread: u32, window: u64, value: u64, merge: bool) -> bool {
        if !self.enabled || request == 0 || thread == 0 || window == 0 {
            return false;
        }
        let row = &self.entries[lane];
        if row.busy.compare_exchange(false, true, SeqCst, SeqCst).is_err() {
            self.fail(OVERLAP);
            return false;
        }
        let sequence = row.sequence.load(SeqCst);
        if sequence >= MAX || [request, window, value].iter().any(|n| *n > MAX) {
            self.fail(OVERFLOW);
            row.busy.store(false, SeqCst);
            return false;
        }
        let old = std::array::from_fn::<_, 3, _>(|i| row.values[i + 7].load(SeqCst));
        let same = old[..2] == [request, window];
        let life = lane == 3 || lane == 5;
        let accepted = if merge { same } else { same || request > old[0] };
        let next = if accepted {
            [request, window, if merge || life && same { old[2] | value } else { value }]
        } else if !merge && life && request == old[0] && window != old[1] {
            [old[0], old[1], old[2] | ASSOCIATION_UNKNOWN]
        } else {
            row.busy.store(false, SeqCst);
            return false;
        };
        if next.iter().any(|n| *n > MAX) {
            self.fail(OVERFLOW);
            row.busy.store(false, SeqCst);
            return false;
        }
        if next != old {
            row.sequence.store(sequence + 1, SeqCst);
            if sequence == 0 {
                for (to, n) in
                    row.values.iter().zip([request, 0, u64::from(thread), 100, window, u64::from(lane >= 4), 0])
                {
                    to.store(n, SeqCst);
                }
            }
            for (to, n) in row.values[7..].iter().zip(next) {
                to.store(n, SeqCst);
            }
            row.epoch.store(self.next(&self.epoch), SeqCst);
            row.sequence.store(sequence + 2, SeqCst);
        }
        row.busy.store(false, SeqCst);
        accepted
    }
    pub fn lifecycle_begin(&self, compact: bool, request: u64, thread: u32, window: u64) -> bool {
        self.tail(if compact { 5 } else { 3 }, request, thread, window, LIFE_SEEN, false)
    }
    pub fn lifecycle(&self, compact: bool, request: u64, thread: u32, window: u64, flags: u64) {
        self.tail(if compact { 5 } else { 3 }, request, thread, window, flags, true);
    }
    pub fn browser_binding(&self, compact: bool, request: u64, thread: u32, window: u64, pid: u32) {
        if pid != 0 && self.lifecycle_begin(compact, request, thread, window) {
            self.tail(if compact { 4 } else { 2 }, request, thread, window, u64::from(pid), false);
        }
    }
    pub fn callback(&self, thread: u32) -> Callback<'_> {
        if !self.enabled {
            return Callback { records: self, ordinal: 0 };
        }
        let ordinal = self.next(&self.callbacks);
        if ordinal == 0 {
            return Callback { records: self, ordinal };
        }
        if self.active_callback.compare_exchange(0, ordinal, SeqCst, SeqCst).is_err() {
            self.fail(CALLBACK_OVERLAP);
            return Callback { records: self, ordinal: 0 };
        }
        self.callback_thread.store(u64::from(thread), SeqCst);
        self.write(0, &[0, ordinal, u64::from(thread), 1]);
        Callback { records: self, ordinal }
    }
    pub fn accepted(&self, request: u64, thread: u32, compact: bool) {
        if !self.enabled {
            return;
        }
        let callback =
            if self.callback_thread.load(SeqCst) == u64::from(thread) { self.active_callback.load(SeqCst) } else { 0 };
        self.write(0, &[request, callback, u64::from(thread), if compact { 2 } else { 3 }, 0, u64::from(compact)]);
    }
    pub fn waiting(&self, request: u64, thread: u32, compact: bool) {
        self.mark(1, request, thread, 2, 0, [u64::from(compact), self.lock_owner.load(SeqCst)]);
    }
    pub fn acquired(&self, request: u64, thread: u32, compact: bool) -> WindowLock<'_> {
        if self.enabled {
            self.lock_owner.store(request, SeqCst);
        }
        self.mark(1, request, thread, 3, 0, [u64::from(compact), request]);
        WindowLock { records: self, request }
    }
    pub fn activation(&self, request: u64, thread: u32, window: u64, w: u64, l: u64, visible: bool) -> Activation<'_> {
        let ordinal = if self.enabled { self.next(&self.activations) } else { 0 };
        let observation = Activation {
            records: self,
            ordinal,
            values: [request, ordinal, u64::from(thread), 1, window, w, l, 0, 0, u64::from(visible)],
        };
        observation.publish();
        observation
    }
    pub fn snapshot(&self) -> Snapshot {
        let before = self.epoch.load(SeqCst);
        let mut snapshot = Snapshot {
            epoch: before,
            errors: self.errors.load(SeqCst),
            callbacks: self.callbacks.load(SeqCst),
            activations: self.activations.load(SeqCst),
            rows: [Row::default(); ROWS],
        };
        for (to, from) in snapshot.rows.iter_mut().zip(&self.entries) {
            let sequence = from.sequence.load(SeqCst);
            let row = Row {
                sequence,
                epoch: from.epoch.load(SeqCst),
                values: std::array::from_fn(|i| from.values[i].load(SeqCst)),
            };
            if sequence & 1 != 0 || sequence != from.sequence.load(SeqCst) || from.busy.load(SeqCst) {
                snapshot.errors |= PARTIAL;
            }
            *to = row;
        }
        if before != self.epoch.load(SeqCst) {
            snapshot.errors |= CAPTURE_OVERLAP;
        }
        snapshot.errors |= self.errors.load(SeqCst);
        snapshot
    }
}
pub struct Callback<'a> {
    records: &'a Records,
    ordinal: u64,
}
impl Drop for Callback<'_> {
    fn drop(&mut self) {
        if self.ordinal != 0 {
            let _ = self.records.active_callback.compare_exchange(self.ordinal, 0, SeqCst, SeqCst);
        }
    }
}
pub struct WindowLock<'a> {
    records: &'a Records,
    request: u64,
}
impl Drop for WindowLock<'_> {
    fn drop(&mut self) {
        if self.records.enabled {
            let _ = self.records.lock_owner.compare_exchange(self.request, 0, SeqCst, SeqCst);
        }
    }
}
pub struct Activation<'a> {
    records: &'a Records,
    ordinal: u64,
    values: [u64; FIELDS],
}
impl Activation<'_> {
    fn publish(&self) {
        if self.ordinal != 0 {
            self.records.write(LANES + (self.ordinal - 1) as usize % ACTIVATIONS, &self.values);
        }
    }
    pub fn ready(&mut self, ready: u64) {
        self.values[7] = ready;
        self.values[9] |= 2;
    }
    pub fn foreground(&mut self, foreground: u64) {
        self.values[8] = foreground;
        self.values[9] |= 4;
    }
    pub fn decision(&mut self, handoff: bool) {
        self.values[3] = 2;
        self.values[9] |= if handoff { 8 } else { 16 };
        self.publish();
    }
}
impl Drop for Activation<'_> {
    fn drop(&mut self) {
        self.values[3] = 3;
        self.publish();
    }
}

// Property coordinates are fixed: header row 15; row field 0 is sequence,
// fields 1..10 are numeric values and field 11 is their memory update epoch.
pub trait Properties {
    fn set(&self, row: usize, field: usize, value: u64) -> bool;
    fn remove(&self, row: usize, field: usize);
}
pub struct NativePublisher<P: Properties> {
    properties: P,
    control: u64,
    thread: u32,
    loader: Cell<u64>,
    lifetime: u64,
    alive: Cell<bool>,
    busy: Cell<bool>,
    sequence: Cell<u64>,
    // The native capability cannot be put into a worker's Arc<Shell>.
    owner_thread_only: PhantomData<Rc<()>>,
}
pub struct OwnerToken<'a, P: Properties> {
    publisher: &'a NativePublisher<P>,
    window: u64,
    kind: u64,
}
impl<P: Properties> NativePublisher<P> {
    pub fn new(properties: P, control: u64, thread: u32, lifetime: u64) -> Self {
        Self {
            properties,
            control,
            thread,
            lifetime,
            loader: Cell::new(0),
            alive: Cell::new(true),
            busy: Cell::new(false),
            sequence: Cell::new(0),
            owner_thread_only: PhantomData,
        }
    }
    pub fn bind_loader(&self, window: u64) {
        self.loader.set(window);
    }
    pub fn owner(&self, thread: u32, callback_window: u64) -> Option<OwnerToken<'_, P>> {
        if !self.alive.get() || self.control == 0 || self.thread == 0 || self.lifetime == 0 || thread != self.thread {
            return None;
        }
        let kind = if callback_window == self.control {
            1
        } else if callback_window != 0 && callback_window == self.loader.get() {
            2
        } else {
            return None;
        };
        Some(OwnerToken { publisher: self, window: callback_window, kind })
    }
    pub fn close(&self) {
        self.alive.set(false);
        // Only the original owner thread calls this, before DestroyWindow.
        for row in 0..=ROWS {
            for field in 0..12 {
                self.properties.remove(row, field);
            }
        }
    }
}
impl<P: Properties> OwnerToken<'_, P> {
    pub fn publish(&self, records: &Records, event: u64) -> bool {
        let p = self.publisher;
        if !records.enabled || !p.alive.get() {
            return false;
        }
        if p.busy.replace(true) {
            records.fail(OVERLAP);
            return false;
        }
        let sequence = p.sequence.get();
        if sequence >= MAX || event == 0 || event > MAX || self.window > MAX || p.control > MAX || p.lifetime > MAX {
            records.fail(OVERFLOW);
            p.busy.set(false);
            return false;
        }
        let mut snapshot = records.snapshot();
        // Opening the publication first makes partial writes explicitly unreadable.
        if !p.properties.set(ROWS, 0, sequence + 1) {
            records.fail(PROPERTY_FAILURE);
            p.busy.set(false);
            return false;
        }
        p.sequence.set(sequence + 2);
        let mut complete = true;
        for (field, value) in [
            1,
            p.lifetime,
            snapshot.epoch,
            1,
            event,
            self.window,
            self.kind,
            u64::from(p.thread),
            snapshot.callbacks,
            snapshot.activations,
            snapshot.errors,
        ]
        .iter()
        .enumerate()
        {
            complete &= p.properties.set(ROWS, field + 1, value + 1);
        }
        for (index, row) in snapshot.rows.iter().enumerate() {
            complete &= p.properties.set(index, 0, row.sequence + 1);
            for (field, value) in row.values.iter().enumerate() {
                complete &= p.properties.set(index, field + 1, value + 1);
            }
            complete &= p.properties.set(index, 11, row.epoch + 1);
        }
        snapshot.errors |= records.errors.load(SeqCst);
        complete &= p.properties.set(ROWS, 11, snapshot.errors + 1);
        if complete {
            complete &= p.properties.set(ROWS, 0, sequence + 2);
        }
        if !complete {
            records.fail(PROPERTY_FAILURE);
        }
        p.busy.set(false);
        complete
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::BTreeMap};
    #[derive(Default)]
    struct Sink {
        values: RefCell<BTreeMap<(usize, usize), u64>>,
        calls: Cell<usize>,
        fail_at: Cell<usize>,
    }
    impl Properties for Rc<Sink> {
        fn set(&self, row: usize, field: usize, value: u64) -> bool {
            let call = self.calls.get() + 1;
            self.calls.set(call);
            if call == self.fail_at.get() {
                return false;
            }
            self.values.borrow_mut().insert((row, field), value);
            true
        }
        fn remove(&self, row: usize, field: usize) {
            self.values.borrow_mut().remove(&(row, field));
        }
    }
    fn source() -> (Records, Rc<Sink>, NativePublisher<Rc<Sink>>) {
        let sink = Rc::new(Sink::default());
        let native = NativePublisher::new(sink.clone(), 400, 21, 1);
        (Records::new(true), sink, native)
    }
    #[test]
    fn actual_revision_is_bound_to_the_callback_thread_only() {
        let (records, _, _) = source();
        let _callback = records.callback(21);
        records.accepted(7, 44, true);
        assert_eq!(records.snapshot().rows[0].values[1], 0);
        records.accepted(8, 21, true);
        assert_eq!(&records.snapshot().rows[0].values[..6], &[8, 1, 21, 2, 0, 1]);
    }
    #[test]
    fn worker_updates_never_write_properties_or_relabel_the_last_natural_snapshot() {
        let (records, sink, native) = source();
        let callback = records.callback(21);
        records.accepted(7, 21, true);
        drop(callback);
        assert_eq!(sink.calls.get(), 0);
        assert!(native.owner(21, 400).unwrap().publish(&records, 1));
        let before = sink.values.borrow().clone();
        records.mark(1, 7, 44, 2, 0, [1, 0]);
        assert_eq!(*sink.values.borrow(), before);
        assert!(records.snapshot().epoch > before[&(ROWS, 3)] - 1);
    }
    #[test]
    fn foreign_hwnd_thread_and_closed_lifetime_cannot_publish() {
        let (records, sink, native) = source();
        assert!(native.owner(21, 999).is_none());
        assert!(native.owner(44, 400).is_none());
        native.bind_loader(500);
        assert!(native.owner(21, 500).is_some());
        let held = native.owner(21, 400).unwrap();
        native.close();
        assert!(!held.publish(&records, 1));
        assert!(native.owner(21, 400).is_none());
        assert_eq!(sink.calls.get(), 0);
    }
    #[test]
    fn partial_property_writes_never_close_the_publication() {
        for fail_at in [1, 2, 12, 40, 100, 194] {
            let (records, sink, native) = source();
            sink.fail_at.set(fail_at);
            let published = native.owner(21, 400).unwrap().publish(&records, 1);
            assert!(!published, "failure {fail_at} was ignored");
            let sequence = sink.values.borrow().get(&(ROWS, 0)).copied().unwrap_or(0);
            assert!(sequence == 0 || sequence & 1 == 1);
            assert_ne!(records.snapshot().errors & PROPERTY_FAILURE, 0);
        }
    }
    #[test]
    fn native_overlap_and_memory_partial_are_explicit() {
        let (records, sink, native) = source();
        native.busy.set(true);
        assert!(!native.owner(21, 400).unwrap().publish(&records, 1));
        assert_eq!(sink.calls.get(), 0);
        assert_ne!(records.snapshot().errors & OVERLAP, 0);
        let other = Records::new(true);
        other.entries[1].sequence.store(1, SeqCst);
        assert_ne!(other.snapshot().errors & PARTIAL, 0);
    }
    #[test]
    fn memory_overlap_counter_overflow_and_nested_callback_are_unknown() {
        let records = Records::new(true);
        records.entries[1].busy.store(true, SeqCst);
        records.mark(1, 7, 44, 2, 0, [1, 0]);
        assert_ne!(records.snapshot().errors & OVERLAP, 0);
        let overflow = Records::new(true);
        overflow.callbacks.store(MAX, SeqCst);
        let _callback = overflow.callback(21);
        assert_ne!(overflow.snapshot().errors & OVERFLOW, 0);
        let nested = Records::new(true);
        let _outer = nested.callback(21);
        let _inner = nested.callback(21);
        assert_ne!(nested.snapshot().errors & CALLBACK_OVERLAP, 0);
    }
    #[test]
    fn activation_rows_keep_real_values_and_last_eight_ordinals() {
        let records = Records::new(true);
        for _ in 0..10 {
            let mut row = records.activation(7, 21, 500, 0, 400, true);
            row.ready(600);
            row.foreground(600);
            row.decision(true);
        }
        let snapshot = records.snapshot();
        assert_eq!(snapshot.activations, 10);
        let mut ordinals: Vec<_> = snapshot.rows[7..].iter().map(|row| row.values[1]).collect();
        ordinals.sort();
        assert_eq!(ordinals, (3..=10).collect::<Vec<_>>());
        assert_eq!(&snapshot.rows[7].values[3..], &[3, 500, 0, 400, 600, 600, 15]);
    }
    #[test]
    fn before_lock_record_does_not_mix_with_another_request() {
        let records = Records::new(true);
        let owner = records.acquired(6, 30, false);
        records.waiting(7, 44, true);
        assert_eq!(&records.snapshot().rows[1].values[..7], &[7, 0, 44, 2, 0, 1, 6]);
        drop(owner);
        records.waiting(8, 45, true);
        assert_eq!(records.snapshot().rows[1].values[6], 0);
    }
    #[test]
    fn cleanup_removes_all_properties_and_prevents_late_writer() {
        let (records, sink, native) = source();
        assert!(native.owner(21, 400).unwrap().publish(&records, 1));
        native.close();
        assert!(sink.values.borrow().is_empty());
        records.mark(1, 7, 44, 2, 0, [1, 0]);
        assert!(native.owner(21, 400).is_none());
        assert!(sink.values.borrow().is_empty());
    }
    #[test]
    fn binding_tails_survive_generic_marks_without_fabricating_compact_milestones() {
        let r = Records::new(true);
        r.browser_binding(true, 9, 21, 500, 5356);
        let first = r.snapshot();
        assert_eq!(&first.rows[4].values[7..], &[9, 500, 5356]);
        assert_eq!(&first.rows[4].values[2..4], &[21, 100]);
        assert_eq!(&first.rows[5].values[2..4], &[21, 100]);
        r.mark(4, 10, 22, 1, 0, [1, 0]);
        assert_eq!(&r.snapshot().rows[4].values[7..], &[9, 500, 5356]);
        assert_eq!(r.snapshot().rows[4].values[3], 1);
    }
    #[test]
    fn old_lifecycle_and_binding_callbacks_cannot_relabel_a_new_window() {
        let r = Records::new(true);
        r.browser_binding(false, 7, 21, 400, 5356);
        r.browser_binding(false, 8, 21, 500, 6000);
        r.lifecycle(false, 7, 21, 400, DESTROYED_EVENT);
        r.browser_binding(false, 7, 21, 400, 5356);
        let s = r.snapshot();
        assert_eq!(&s.rows[2].values[7..], &[8, 500, 6000]);
        assert_eq!(&s.rows[3].values[7..], &[8, 500, LIFE_SEEN]);
        r.lifecycle(false, 8, 21, 500, CLOSE_CALL | CLOSE_QUEUED);
        r.lifecycle(false, 8, 21, 500, CLOSE_EVENT | DESTROYED_EVENT);
        assert_eq!(
            r.snapshot().rows[3].values[9],
            LIFE_SEEN | CLOSE_CALL | CLOSE_QUEUED | CLOSE_EVENT | DESTROYED_EVENT
        );
    }
    #[test]
    fn equal_request_different_hwnd_is_association_unknown_not_global_failure() {
        let r = Records::new(true);
        r.browser_binding(false, 8, 21, 400, 5356);
        r.browser_binding(false, 8, 21, 500, 6000);
        assert_eq!(&r.snapshot().rows[2].values[7..], &[8, 400, 5356]);
        assert_ne!(r.snapshot().rows[3].values[9] & ASSOCIATION_UNKNOWN, 0);
        assert_eq!(r.snapshot().errors, 0);
    }
    #[test]
    fn queued_calls_and_failed_observation_never_imply_destroyed_or_com_close() {
        let r = Records::new(true);
        r.lifecycle_begin(false, 7, 21, 400);
        r.lifecycle(false, 7, 21, 400, DESTROY_CALL | DESTROY_QUEUED);
        assert_eq!(r.snapshot().rows[3].values[9], LIFE_SEEN | DESTROY_CALL | DESTROY_QUEUED);
        assert_eq!(r.snapshot().rows[3].values[9] & DESTROYED_EVENT, 0);
        r.browser_binding(true, 8, 21, 500, 6000);
        r.lifecycle(true, 8, 21, 500, BROWSER_UNKNOWN | CLOSE_CALL | CLOSE_FAILED | DESTROY_CALL | DESTROY_FAILED);
        let flags = r.snapshot().rows[5].values[9];
        assert_ne!(flags & BROWSER_UNKNOWN, 0);
        assert_eq!(flags & (CLOSE_QUEUED | DESTROY_QUEUED | DESTROYED_EVENT), 0);
        assert_eq!(&r.snapshot().rows[4].values[7..], &[8, 500, 6000]);
        assert_eq!(&r.snapshot().rows[5].values[7..9], &[8, 500]);
        assert_eq!(r.snapshot().errors, 0);
    }
    #[test]
    fn tail_overlap_and_overflow_use_the_existing_atomic_unknown_protocol() {
        let r = Records::new(true);
        r.entries[3].busy.store(true, SeqCst);
        assert!(!r.lifecycle_begin(false, 8, 21, 400));
        assert_ne!(r.snapshot().errors & OVERLAP, 0);
        let r = Records::new(true);
        assert!(!r.lifecycle_begin(false, MAX + 1, 21, 400));
        assert_ne!(r.snapshot().errors & OVERFLOW, 0);
        let r = Records::new(false);
        r.browser_binding(true, 8, 21, 400, 5356);
        assert_eq!(r.snapshot().epoch, 0);
    }
    #[test]
    fn disabled_records_have_no_native_effect() {
        let (_, sink, native) = source();
        let records = Records::new(false);
        let _callback = records.callback(21);
        records.accepted(7, 21, true);
        records.mark(1, 7, 44, 2, 0, [1, 0]);
        assert!(!native.owner(21, 400).unwrap().publish(&records, 1));
        assert_eq!(sink.calls.get(), 0);
        assert_eq!(records.snapshot().epoch, 0);
    }
}
