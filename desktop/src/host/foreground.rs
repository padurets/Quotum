//! The controller accepts foreground intent before any browser worker can run.
use crate::window::{PanelToggle, Role};
use serde::Serialize;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Main,
    Compact,
    #[default]
    None,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Head {
    pub revision: u64,
    pub target: Target,
    pub anchor: Option<(i32, i32)>,
}
pub struct MainRequests {
    started: u64,
    opened: u64,
}
impl MainRequests {
    pub fn new(started: Head) -> Self {
        Self { started: started.revision, opened: 0 }
    }
    pub fn opened(&mut self, revision: u64) {
        self.opened = self.opened.max(revision);
    }
    pub fn pending(&self, head: Head) -> Option<Head> {
        (head.target == Target::Main && head.revision > self.started && head.revision > self.opened).then_some(head)
    }
}
#[derive(Default)]
pub struct Foreground {
    pub head: Head,
    panel: PanelToggle,
    unknown_blur: Option<Instant>,
}
impl Foreground {
    pub fn accept(&mut self, role: Role, anchor: Option<(i32, i32)>, toggle: bool, point: Option<(i32, i32)>) -> Head {
        let now = Instant::now();
        // Native Wayland may expose no pointer position. Preserve its previous
        // same-press pairing without inventing coordinates or changing Windows.
        let unknown_press = self
            .unknown_blur
            .take()
            .is_some_and(|at| now.saturating_duration_since(at) < std::time::Duration::from_millis(500));
        let target = match role {
            Role::Main => {
                self.panel.close();
                Target::Main
            }
            Role::Compact => {
                if toggle && unknown_press {
                    self.panel.close();
                } else if toggle {
                    self.panel.toggle(now, point);
                } else {
                    self.panel.show();
                }
                if self.panel.wanted() { Target::Compact } else { Target::None }
            }
        };
        self.head = Head { revision: self.head.revision + 1, target, anchor };
        self.head
    }
    pub fn cancel(&mut self, revision: u64, blur: bool, point: Option<(i32, i32)>) -> Option<Head> {
        if self.head.revision != revision || self.head.target != Target::Compact {
            return None;
        }
        self.unknown_blur = (blur && point.is_none()).then(Instant::now);
        if blur {
            self.panel.blur(Instant::now(), point);
        } else {
            self.panel.closed();
        }
        // A cancellation is terminal for this request; an old worker has its open ticket.
        self.head.target = Target::None;
        Some(self.head)
    }
    pub fn current(&self, head: Head) -> bool {
        self.head == head
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_unopened_main_survives_an_older_engine_without_replaying_closed_windows() {
        let mut foreground = Foreground::default();
        let panel = foreground.accept(Role::Compact, None, false, None);
        let mut engine = MainRequests::new(panel);
        let main = foreground.accept(Role::Main, None, false, None);
        assert_eq!(engine.pending(main), Some(main), "an exiting panel engine has not opened the new main");
        engine.opened(main.revision);
        assert!(engine.pending(main).is_none(), "closing a main that actually opened must not reopen it");
        let next = foreground.accept(Role::Main, None, false, None);
        assert_eq!(engine.pending(next), Some(next));
        engine.opened(next.revision);
        engine.opened(main.revision);
        assert!(engine.pending(next).is_none(), "an older surface callback cannot forget a fulfilled request");
    }
    #[test]
    fn a_new_engine_does_not_retry_its_initial_main_or_a_superseded_request() {
        let mut foreground = Foreground::default();
        let main = foreground.accept(Role::Main, None, false, None);
        let engine = MainRequests::new(main);
        assert!(engine.pending(main).is_none(), "starting a fresh engine already fulfills the launch attempt");
        let newer = foreground.accept(Role::Main, None, false, None);
        assert_eq!(engine.pending(newer), Some(newer));
        let panel = foreground.accept(Role::Compact, None, false, None);
        assert!(engine.pending(panel).is_none(), "a newer panel owns its existing recovery path");
        let cancelled = foreground.cancel(panel.revision, false, None).unwrap();
        assert!(engine.pending(cancelled).is_none(), "a cancellation must remain terminal");
    }
    #[test]
    fn workers_cannot_overtake_the_accepted_main_panel_or_cancellation() {
        let mut foreground = Foreground::default();
        let main = foreground.accept(Role::Main, None, false, None);
        let panel = foreground.accept(Role::Compact, Some((12, 34)), false, None);
        assert!(!foreground.current(main), "late main worker cannot start or send");
        assert!(foreground.current(panel));
        let cancelled = foreground.cancel(panel.revision, false, None).unwrap();
        assert!(!foreground.current(panel), "same request cancellation is terminal");
        assert_eq!(cancelled.revision, panel.revision);
        assert_eq!(cancelled.target, Target::None);
        let next = foreground.accept(Role::Compact, None, false, None);
        assert!(foreground.cancel(panel.revision, false, None).is_none());
        assert!(foreground.current(next));
    }
    #[test]
    fn fallback_toggles_reduce_before_publication_and_pair_the_blur_gesture() {
        for count in [2, 3, 4, 101] {
            let mut foreground = Foreground::default();
            for _ in 0..count {
                foreground.accept(Role::Compact, None, true, Some((10, 20)));
            }
            assert_eq!(foreground.head.target == Target::Compact, count % 2 == 1);
            assert_eq!(foreground.head.revision, count);
        }
        let mut foreground = Foreground::default();
        let panel = foreground.accept(Role::Compact, None, true, Some((10, 20)));
        foreground.cancel(panel.revision, true, Some((10, 20)));
        assert_eq!(foreground.accept(Role::Compact, None, true, Some((10, 20))).target, Target::None);
        assert_eq!(foreground.accept(Role::Compact, None, true, Some((10, 20))).target, Target::Compact);
        let panel = foreground.head;
        foreground.cancel(panel.revision, true, Some((100, 200)));
        assert_eq!(foreground.accept(Role::Compact, None, true, Some((10, 20))).target, Target::Compact);
    }
    #[test]
    fn a_new_main_revokes_a_compact_ticket_without_toggling_it_back() {
        let mut foreground = Foreground::default();
        let panel = foreground.accept(Role::Compact, None, false, None);
        let main = foreground.accept(Role::Main, None, false, None);
        assert!(!foreground.current(panel));
        assert!(foreground.cancel(panel.revision, false, None).is_none());
        assert!(foreground.current(main));
        assert_eq!(foreground.accept(Role::Compact, None, true, None).target, Target::Compact);
    }
    #[test]
    fn fallback_pairs_unknown_pointer_blur_once_and_explicit_actions_clear_it() {
        let mut foreground = Foreground::default();
        let panel = foreground.accept(Role::Compact, None, true, None);
        foreground.cancel(panel.revision, true, None);
        assert_eq!(foreground.accept(Role::Compact, None, true, Some((12, 34))).target, Target::None);
        assert_eq!(foreground.accept(Role::Compact, None, true, None).target, Target::Compact);
        foreground.cancel(foreground.head.revision, true, None);
        foreground.unknown_blur = Some(Instant::now() - std::time::Duration::from_millis(501));
        assert_eq!(foreground.accept(Role::Compact, None, true, None).target, Target::Compact);
        for role in [Role::Main, Role::Compact] {
            foreground.accept(Role::Compact, None, false, None);
            foreground.cancel(foreground.head.revision, true, None);
            foreground.accept(role, None, false, None);
            assert!(foreground.unknown_blur.is_none());
        }
    }
}
