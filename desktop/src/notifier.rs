//! The app's state goes to the board in its window whenever it changes, rather than when the
//! board asks (see ipc.rs). What changes it (the agent, its settings, start at login) only
//! wakes the ticker (`Wake`); the ticker and the board's commands put the state together
//! and send it (`Notifier`), one at a time: a state put together later always carries a
//! larger number and goes out after, so the board keeps the newest.

use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

use serde_json::Value;

/// The state sent last, and its number.
#[derive(Default)]
struct Sent {
    seq: u64,
    last: Option<Value>,
}

#[derive(Default)]
pub struct Notifier {
    sent: Mutex<Sent>,
}

impl Notifier {
    /// Puts the state together (`build`) and, when it differs from the last, numbers it
    /// anew and hands it to `push`. Returns it with its number (`seq`). Not on the main
    /// thread of the window's host, nor under a lock `build` takes: it reads the agent.
    pub fn publish(&self, build: impl FnOnce() -> Value, push: impl FnOnce(&Value)) -> Value {
        self.send(build, push, false)
    }

    /// The same for a board that starts watching: it gets the state at once, changed or not.
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub fn watch(&self, build: impl FnOnce() -> Value, push: impl FnOnce(&Value)) -> Value {
        self.send(build, push, true)
    }

    fn send(&self, build: impl FnOnce() -> Value, push: impl FnOnce(&Value), always: bool) -> Value {
        let mut sent = self.sent.lock().unwrap_or_else(|e| e.into_inner());
        let state = build();
        let changed = sent.last.as_ref() != Some(&state);
        if changed {
            sent.seq += 1;
        }
        let numbered = numbered(&state, sent.seq);
        if changed {
            sent.last = Some(state);
        }
        if changed || always {
            push(&numbered);
        }
        numbered
    }
}

fn numbered(state: &Value, seq: u64) -> Value {
    let mut state = state.clone();
    if let Value::Object(fields) = &mut state {
        fields.insert("seq".into(), seq.into());
    }
    state
}

/// Wakes the ticker, which then sends the app's state if it changed. It never blocks: one
/// wake-up waiting is enough for any number, so it is called under any lock and on any
/// thread, the ticker's own included.
pub struct Wake {
    sender: SyncSender<()>,
    receiver: Mutex<Receiver<()>>,
}

impl Wake {
    pub fn new() -> Wake {
        let (sender, receiver) = mpsc::sync_channel(1);
        Wake { sender, receiver: Mutex::new(receiver) }
    }

    pub fn wake(&self) {
        let _ = self.sender.try_send(());
    }

    /// Waits up to `limit` for a wake-up; whether one came.
    pub fn wait(&self, limit: Duration) -> bool {
        self.receiver.lock().unwrap_or_else(|e| e.into_inner()).recv_timeout(limit).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;

    #[test]
    fn a_state_goes_out_only_when_it_changed_and_then_with_a_new_number() {
        let notifier = Notifier::default();
        let mut pushed = Vec::new();
        let first = notifier.publish(|| json!({"agent": "starting"}), |state| pushed.push(state.clone()));
        assert_eq!(first, json!({"agent": "starting", "seq": 1}));
        let same = notifier.publish(|| json!({"agent": "starting"}), |state| pushed.push(state.clone()));
        assert_eq!(same["seq"], 1, "the same state keeps its number");
        notifier.publish(|| json!({"agent": "measuring"}), |state| pushed.push(state.clone()));
        assert_eq!(pushed, [json!({"agent": "starting", "seq": 1}), json!({"agent": "measuring", "seq": 2})]);
    }

    #[test]
    fn a_state_put_together_later_always_carries_a_larger_number_and_goes_out_after() {
        let notifier = Arc::new(Notifier::default());
        let written = Arc::new(AtomicU64::new(0));
        let pushed = Arc::new(Mutex::new(Vec::new()));
        let writers: Vec<_> = (0..2)
            .map(|_| {
                let (notifier, written, pushed) = (notifier.clone(), written.clone(), pushed.clone());
                thread::spawn(move || {
                    for _ in 0..200 {
                        written.fetch_add(1, Ordering::SeqCst);
                        notifier.publish(
                            || json!({"written": written.load(Ordering::SeqCst)}),
                            |state| pushed.lock().unwrap().push(state.clone()),
                        );
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let pushed = pushed.lock().unwrap();
        for pair in pushed.windows(2) {
            assert!(pair[0]["seq"].as_u64() < pair[1]["seq"].as_u64(), "in the order of their numbers");
            assert!(pair[0]["written"].as_u64() < pair[1]["written"].as_u64(), "the later, the newer");
        }
        assert_eq!(pushed.last().unwrap()["written"], 400, "the last write went out");
    }

    #[test]
    fn a_board_that_starts_watching_gets_the_state_at_once_even_unchanged() {
        let notifier = Notifier::default();
        notifier.publish(|| json!({"agent": "idle"}), |_| {});
        let mut first = None;
        let state = notifier.watch(|| json!({"agent": "idle"}), |state| first = Some(state.clone()));
        assert_eq!(first, Some(json!({"agent": "idle", "seq": 1})));
        assert_eq!(state["seq"], 1, "nothing changed: the same number");
        let mut pushed = 0;
        notifier.publish(|| json!({"agent": "idle"}), |_| pushed += 1);
        assert_eq!(pushed, 0, "and nothing goes out to the others");
    }

    #[test]
    fn waking_never_blocks_and_many_wakes_are_one() {
        let wake = Wake::new();
        let held = Mutex::new(());
        {
            let _agent = held.lock().unwrap();
            wake.wake();
            wake.wake();
            wake.wake();
        }
        assert!(wake.wait(Duration::ZERO));
        assert!(!wake.wait(Duration::ZERO), "one wake-up for all three");
        // On the ticker's own thread, between two waits: it does not wait on itself.
        wake.wake();
        assert!(wake.wait(Duration::from_secs(1)));
        let woken = Arc::new(Wake::new());
        let waking = woken.clone();
        let other = thread::spawn(move || waking.wake());
        assert!(woken.wait(Duration::from_secs(5)));
        other.join().unwrap();
    }
}
