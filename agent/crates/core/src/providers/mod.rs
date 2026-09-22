//! One adapter per coding agent. Each measures limits through the agent's own
//! command-line client and its machine-readable interface: no tokens are read, no
//! provider endpoints are called directly, no model requests are made.

mod antigravity;
mod claude;
mod codex;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

pub use antigravity::Antigravity;
pub use claude::Claude;
pub use codex::Codex;

use crate::model::{ErrorKind, Failure, Outcome, Provider};
use crate::process::{Client, ProcError, find_program};

/// Everything an adapter needs from the agent for one measurement.
pub struct Context<'a> {
    pub home: &'a Path,
    /// Neutral working directory for client processes, so no project files are loaded.
    pub work_dir: &'a Path,
    /// Directory for files the agent owns (client logs).
    pub state_dir: &'a Path,
    /// A configured client path that replaces the lookup.
    pub program: Option<&'a Path>,
    pub timeout: Duration,
}

pub trait Adapter: Send {
    fn provider(&self) -> Provider;
    /// Executable name of the client.
    fn program(&self) -> &'static str;
    /// Usual install locations besides PATH.
    fn install_dirs(&self, home: &Path) -> Vec<PathBuf>;
    fn measure(&mut self, ctx: &Context) -> Outcome;
    /// Files and directories that change when someone uses the agent on this machine.
    fn activity_paths(&self, home: &Path) -> Vec<PathBuf>;
    /// Whether the client names the account it is signed in to (else the subscription is the owner's).
    fn identifies_account(&self) -> bool {
        true
    }
    /// The account pseudonym, when it can be read locally without starting the client.
    fn local_account(&self, _home: &Path) -> Option<String> {
        None
    }
    /// Files that change when the client signs in to another account (metadata only is read).
    fn identity_paths(&self, _home: &Path) -> Vec<PathBuf> {
        Vec::new()
    }
}

pub fn adapter(provider: Provider) -> Box<dyn Adapter> {
    match provider {
        Provider::Claude => Box::new(Claude::default()),
        Provider::Codex => Box::new(Codex),
        Provider::Antigravity => Box::new(Antigravity::default()),
    }
}

pub(crate) fn locate(adapter: &dyn Adapter, ctx: &Context) -> Result<PathBuf, Failure> {
    if let Some(path) = ctx.program {
        return Ok(path.to_path_buf());
    }
    find_program(adapter.program(), &adapter.install_dirs(ctx.home)).ok_or_else(|| {
        Failure::new(adapter.provider(), ErrorKind::NotInstalled, format!("`{}` is not on PATH", adapter.program()))
    })
}

pub(crate) fn process_failure(provider: Provider, error: ProcError) -> Failure {
    match error {
        ProcError::NotFound => Failure::new(provider, ErrorKind::NotInstalled, ""),
        ProcError::Timeout => Failure::new(provider, ErrorKind::Timeout, ""),
        ProcError::Stopped => Failure::new(provider, ErrorKind::Failed, "the agent is stopping"),
        ProcError::Closed => Failure::new(provider, ErrorKind::Failed, "the client exited before answering"),
        ProcError::Io(e) => Failure::new(provider, ErrorKind::Failed, e.to_string()),
    }
}

/// The first dotted version number in `text` ("2.1.280 (Claude Code)" → "2.1.280").
pub(crate) fn version_in(text: &str) -> Option<String> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|part| part.contains('.') && part.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|v| v.trim_end_matches('.').to_string())
}

/// `major.minor.patch` as a comparable tuple; missing parts count as 0.
pub(crate) fn version_tuple(version: &str) -> (u32, u32, u32) {
    let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// A client's `--version`, asked at most every six hours.
#[derive(Default)]
pub(crate) struct VersionCache {
    value: Option<(PathBuf, String, Instant)>,
}

impl VersionCache {
    const TTL: Duration = Duration::from_secs(6 * 3600);

    pub fn get(&mut self, program: &Path, ctx: &Context) -> Option<String> {
        if let Some((path, version, at)) = &self.value {
            if path == program && at.elapsed() < Self::TTL {
                return Some(version.clone());
            }
        }
        let mut client = Client::spawn(program, &["--version"], &[], ctx.work_dir, Duration::from_secs(15)).ok()?;
        let version = version_in(&client.output().ok()?)?;
        self.value = Some((program.to_path_buf(), version.clone(), Instant::now()));
        Some(version)
    }
}

/// Latest modification time among `paths` (for a directory, among its direct entries).
pub fn last_activity(paths: &[PathBuf]) -> Option<SystemTime> {
    let modified = |path: &Path| path.metadata().and_then(|m| m.modified()).ok();
    paths
        .iter()
        .filter_map(|path| {
            if path.is_dir() {
                let entries = fs::read_dir(path).ok()?;
                entries.filter_map(|e| e.ok()).filter_map(|e| modified(&e.path())).chain(modified(path)).max()
            } else {
                modified(path)
            }
        })
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_found_in_client_output() {
        assert_eq!(version_in("2.1.280 (Claude Code)").as_deref(), Some("2.1.280"));
        assert_eq!(version_in("agent/0.154.0 (Ubuntu 24.4.0; x86_64)").as_deref(), Some("0.154.0"));
        assert_eq!(version_in("no version"), None);
        assert!(version_tuple("1.2.4") >= version_tuple("1.1.11"));
        assert!(version_tuple("1.1") < version_tuple("1.1.11"));
    }
}
