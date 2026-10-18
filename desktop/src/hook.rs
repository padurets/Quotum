//! Cache safe UI state; smoke and unit hosts select their fake before any OS-root lookup.
use quotum_core::hook::{ErrorCode, Lifecycle, Status};
use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Serialize)]
pub struct PublicState {
    pub status: Status,
    pub error: Option<ErrorCode>,
}
pub struct Control {
    service: Option<Lifecycle>,
    state: Mutex<PublicState>,
    ops: Mutex<()>,
}
impl Control {
    pub fn new(smoke: bool) -> Self {
        Self::with_factory(cfg!(test) || smoke, Lifecycle::for_user)
    }
    fn with_factory(fake: bool, factory: impl FnOnce() -> Result<Lifecycle, ErrorCode>) -> Self {
        let (service, status) = if fake {
            (None, Status::Off)
        } else {
            match factory() {
                Ok(service) => {
                    let status = service.status();
                    (Some(service), status)
                }
                Err(code) => (None, Status::Error { code }),
            }
        };
        Self { service, ops: Mutex::new(()), state: Mutex::new(PublicState { status, error: None }) }
    }
    pub fn state(&self) -> PublicState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn startup(&self) {
        let _ops = self.ops.lock().unwrap_or_else(|e| e.into_inner());
        let Some(service) = &self.service else { return };
        self.accept(service.reconcile_existing_consent());
    }
    pub fn set(&self, on: bool) {
        let _ops = self.ops.lock().unwrap_or_else(|e| e.into_inner());
        self.accept(self.service.as_ref().ok_or(ErrorCode::NoAccess).and_then(|service| service.set_enabled(on)));
    }
    fn accept(&self, result: Result<Status, ErrorCode>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match result {
            Ok(status) => {
                state.status = status;
                state.error = None;
            }
            Err(code) => {
                if let Some(service) = &self.service {
                    state.status = service.status();
                }
                state.error = Some(code);
            }
        }
    }
    pub fn refresh(&self) {
        let _ops = self.ops.lock().unwrap_or_else(|e| e.into_inner());
        let Some(service) = &self.service else { return };
        self.state.lock().unwrap_or_else(|e| e.into_inner()).status = service.status();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fake_host_performs_no_user_root_lookup_or_startup_mutation() {
        let control = Control::with_factory(true, || panic!("the host must inject its fake before root lookup"));
        control.startup();
        control.set(true);
        control.set(false);
        assert_eq!(control.state().status, Status::Off);
        assert_eq!(control.state().error, Some(ErrorCode::NoAccess));
    }
}
