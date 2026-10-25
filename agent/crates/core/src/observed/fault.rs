//! Scoped storage faults. The same plan can follow a production worker onto its thread.

use std::cell::RefCell;
use std::io;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(super) struct Plan(Arc<Mutex<Option<Fault>>>, Arc<Mutex<Option<bool>>>);

pub(super) struct EmptyCapture {
    plan: Plan,
    previous: Option<bool>,
}
impl Drop for EmptyCapture {
    fn drop(&mut self) {
        *self.plan.1.lock().unwrap() = self.previous;
    }
}
struct Fault {
    operation: &'static str,
    after: usize,
    remaining: usize,
    code: i32,
}

thread_local! { static PLAN: RefCell<Plan> = RefCell::new(Plan::default()); }

impl Plan {
    pub fn current() -> Self {
        PLAN.with(|plan| plan.borrow().clone())
    }
    pub fn enter(&self) {
        PLAN.with(|plan| *plan.borrow_mut() = self.clone());
    }
    pub fn arm(&self, operation: &'static str, after: usize, remaining: usize, code: i32) {
        *self.0.lock().unwrap() = Some(Fault { operation, after, remaining, code });
    }
    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
    pub fn empty_capture(&self, complete: bool) -> EmptyCapture {
        let previous = self.1.lock().unwrap().replace(complete);
        EmptyCapture { plan: self.clone(), previous }
    }
}

pub(super) fn empty_capture() -> Option<bool> {
    let plan = Plan::current();
    *plan.1.lock().unwrap()
}

pub(super) fn check(operation: &'static str) -> io::Result<()> {
    let plan = Plan::current();
    let mut fault = plan.0.lock().unwrap();
    if let Some(fault) = fault.as_mut().filter(|fault| fault.operation == operation && fault.remaining > 0) {
        if fault.after > 0 {
            fault.after -= 1;
        } else {
            fault.remaining -= 1;
            return Err(io::Error::from_raw_os_error(fault.code));
        }
    }
    Ok(())
}
