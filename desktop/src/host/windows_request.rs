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
        for (to, value) in row.values.iter().zip(values.iter().copied().chain(std::iter::repeat(0))) {
            to.store(value, SeqCst);
        }
        row.epoch.store(self.next(&self.epoch), SeqCst);
        row.sequence.store(sequence + 2, SeqCst);
        row.busy.store(false, SeqCst);
    }
    pub fn mark(&self, lane: usize, request: u64, thread: u32, stage: u64, subject: u64, details: [u64; 2]) {
        self.write(lane, &[request, 0, u64::from(thread), stage, subject, details[0], details[1]]);
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
