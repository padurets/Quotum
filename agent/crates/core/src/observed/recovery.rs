//! Bounded, path-free failure evidence and retry pacing shared by capture and policy updates.

use std::io;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub operation: &'static str,
    pub kind: io::ErrorKind,
    pub os_code: Option<i32>,
    pub retryable: bool,
}

impl Failure {
    pub(crate) fn new(operation: &'static str, error: &io::Error) -> Self {
        if let Some(failure) = error.get_ref().and_then(|error| error.downcast_ref::<Self>()) {
            return *failure;
        }
        let retryable = !matches!(error.kind(), io::ErrorKind::InvalidInput | io::ErrorKind::Unsupported)
            && (error.kind() != io::ErrorKind::InvalidData
                || error.raw_os_error().is_some()
                || error.get_ref().is_some_and(|error| error.is::<super::outbox::StorageIo>()));
        #[cfg(unix)]
        let retryable = retryable && error.raw_os_error() != Some(libc::ELOOP);
        Self { operation, kind: error.kind(), os_code: error.raw_os_error(), retryable }
    }

    pub(crate) fn into_io(self) -> io::Error {
        io::Error::new(self.kind, self)
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("activity storage unavailable")
    }
}
impl std::error::Error for Failure {}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Health {
    pub generation: u64,
    pub first: Option<Failure>,
    pub last: Option<Failure>,
    pub failures: u64,
    pub recoveries: u64,
    pub unavailable: bool,
    pub terminal: bool,
}

impl Health {
    pub(crate) fn fail(&mut self, failure: Failure) {
        if !self.unavailable {
            self.first = Some(failure);
        }
        self.last = Some(failure);
        self.failures = self.failures.saturating_add(1);
        self.unavailable = true;
        self.terminal = !failure.retryable;
    }

    pub(crate) fn observed(&mut self) {
        self.terminal = false;
        if self.unavailable {
            self.recoveries = self.recoveries.saturating_add(1);
            self.unavailable = false;
        }
    }
}

#[derive(Default)]
pub(crate) struct Retry(usize);
impl Retry {
    pub fn failed(&mut self) -> Duration {
        let seconds = [1, 2, 5, 15, 30, 60][self.0.min(5)];
        self.0 = self.0.saturating_add(1);
        Duration::from_secs(seconds)
    }
    pub fn reset(&mut self) {
        self.0 = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_and_evidence_stay_bounded_without_retaining_error_contents() {
        let error = io::Error::other("private path, credentials and captured metadata");
        let failure = Failure::new("append", &error);
        let mut health = Health::default();
        let mut retry = Retry::default();
        for index in 0..1000 {
            health.fail(failure);
            assert_eq!(retry.failed().as_secs(), [1, 2, 5, 15, 30, 60][index.min(5)]);
        }
        assert_eq!(health.failures, 1000);
        assert!(!format!("{health:?}").contains("private"));
        health.observed();
        assert_eq!(health.recoveries, 1);
        assert!(!health.unavailable);
        retry.reset();
        assert_eq!(retry.failed(), Duration::from_secs(1));
        assert!(!Failure::new("binding", &io::ErrorKind::InvalidData.into()).retryable);
        let read =
            Failure { operation: "privacy-read", kind: io::ErrorKind::InvalidData, os_code: None, retryable: true };
        assert_eq!(
            Failure::new("control", &read.into_io()),
            read,
            "control delivery preserves verified I/O provenance"
        );
    }
}
