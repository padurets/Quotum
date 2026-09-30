//! Notifications may be dropped under load; the latest native controls must survive.
use crate::attention::{Intent, Status};
use std::collections::VecDeque;

pub enum Command {
    Status(Status),
    Notify(Box<Intent>),
    Loading(bool),
    PanelReady(u64),
}

#[derive(Default)]
pub struct Commands {
    controls: VecDeque<Command>,
    notifications: VecDeque<Box<Intent>>,
}
impl Commands {
    /// Wake the native thread only when work first arrives. Creation also drains
    /// the queue, so commands sent before its HWND exists are not lost.
    pub fn push(&mut self, command: Command) -> bool {
        let wake = self.controls.is_empty() && self.notifications.is_empty();
        if let Command::Notify(intent) = command {
            if self.notifications.len() == 64 {
                return false;
            }
            self.notifications.push_back(intent);
        } else {
            let kind = std::mem::discriminant(&command);
            self.controls.retain(|old| std::mem::discriminant(old) != kind);
            self.controls.push_back(command);
        }
        wake
    }
    /// Controls precede the bounded notification backlog, in their latest order.
    pub fn pop(&mut self) -> Option<Command> {
        self.controls.pop_front().or_else(|| self.notifications.pop_front().map(Command::Notify))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn notification() -> Command {
        Command::Notify(Box::new(Intent {
            candidate: serde_json::from_value(serde_json::json!({"id":"one","kind":"announcement","at":1,"provider":"codex","scheduledFor":null,"resetKind":null,"credit":{"name":"Fixture","url":"https://example.test"},"url":"https://example.test"})).unwrap(),
            generation: 0, epoch: 0, baseline: 0, serial: 0, hub_now: 1, queued: Instant::now(),
        }))
    }

    #[test]
    fn overflow_keeps_latest_controls_and_never_exceeds_the_notification_limit() {
        let mut queue = Commands::default();
        assert!(queue.push(notification()));
        for _ in 0..100 {
            assert!(!queue.push(notification()));
        }
        queue.push(Command::Status(Status::default()));
        queue.push(Command::Loading(false));
        queue.push(Command::PanelReady(10));
        queue.push(Command::Loading(true));
        queue.push(Command::PanelReady(20));
        queue.push(Command::Status(Status { connected: true, ..Status::default() }));
        assert!(matches!(queue.pop(), Some(Command::Loading(true))));
        assert!(matches!(queue.pop(), Some(Command::PanelReady(20))));
        assert!(matches!(queue.pop(), Some(Command::Status(s)) if s.connected));
        for _ in 0..64 {
            assert!(matches!(queue.pop(), Some(Command::Notify(intent)) if intent.candidate.kind() == "announcement"));
        }
        assert!(queue.pop().is_none());
        assert!(queue.push(Command::Loading(false)), "a drained queue wakes for new controls");
    }
}
