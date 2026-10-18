//! A persisted opt-out barrier applies before any namespace can resume delivery.

use super::outbox::{atomic, directory, plain, read_json};
use crate::clients::ClientId;
use crate::config::Paths;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io;

pub(crate) struct Guard {
    _file: File,
}
impl Drop for Guard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: this private regular file remains pinned while releasing its lock.
            unsafe {
                libc::flock(self._file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

fn lock(paths: &Paths) -> io::Result<Guard> {
    directory(&paths.state)?;
    let path = paths.state.join("activity-policy.lock");
    loop {
        let opened = match plain(&path, true, true) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => plain(&path, true, false),
            opened => opened,
        };
        match opened {
            Ok(file) => {
                #[cfg(unix)]
                {
                    use std::os::fd::AsRawFd;
                    // SAFETY: serialize policy acceptance with the start of delivery, never capture.
                    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                return Ok(Guard { _file: file });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
}

pub(crate) fn allow(paths: &Paths, revision: &str) -> io::Result<Option<Guard>> {
    let guard = lock(paths)?;
    let policy: Policy = read_json(&paths.state.join("activity-policy.json"), 4096)?;
    Ok((policy.version == 1 && policy.enabled && policy.revision == revision).then_some(guard))
}

#[derive(Serialize, Deserialize, PartialEq)]
struct Policy {
    version: u8,
    revision: String,
    enabled: bool,
    projects: bool,
    clients: Vec<String>,
    route_disabled: Vec<String>,
}

pub(crate) fn update(
    paths: &Paths,
    enabled: bool,
    projects: bool,
    clients: &[ClientId],
    route_disabled: &[ClientId],
) -> io::Result<String> {
    let _guard = lock(paths)?;
    let file = paths.state.join("activity-policy.json");
    let before = match read_json::<Policy>(&file, 4096) {
        Ok(p) if p.version == 1 && p.revision.len() == 32 => Some(p),
        Ok(_) => return Err(io::ErrorKind::InvalidData.into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let mut next = Policy {
        version: 1,
        revision: before.as_ref().map_or_else(crate::config::random_hex, |p| p.revision.clone()),
        enabled,
        projects,
        clients: clients.iter().map(|c| c.id().into()).collect(),
        route_disabled: route_disabled.iter().map(|c| c.id().into()).collect(),
    };
    next.clients.sort();
    next.route_disabled.sort();
    if let Some(old) = &before {
        if old.enabled && !next.enabled
            || old.projects && !next.projects
            || old.clients.iter().any(|c| !next.clients.contains(c))
            || next.route_disabled.iter().any(|c| !old.route_disabled.contains(c))
        {
            next.revision = crate::config::random_hex();
        }
    }
    if before.as_ref() != Some(&next) {
        atomic(&file, &next, 4096)?;
    }
    Ok(next.revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabling_and_reenabling_never_revives_pre_opt_out_records() {
        let root = std::env::temp_dir().join(format!("quotum-activity-policy-{}", crate::config::random_hex()));
        let paths = Paths { state: root.clone(), config: root.join("config"), work: root.join("work") };
        let before = update(&paths, true, true, &[ClientId::Codex], &[]).unwrap();
        let off = update(&paths, false, true, &[ClientId::Codex], &[]).unwrap();
        assert_ne!(before, off);
        assert_eq!(update(&paths, true, true, &[ClientId::Codex], &[]).unwrap(), off);
        let no_projects = update(&paths, true, false, &[ClientId::Codex], &[]).unwrap();
        assert_ne!(no_projects, off);
        assert_eq!(update(&paths, true, true, &[ClientId::Codex, ClientId::OpenCode], &[]).unwrap(), no_projects);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accepting_a_restriction_waits_for_an_inflight_delivery_and_fences_its_next_turn() {
        let root = std::env::temp_dir().join(format!("quotum-activity-gate-{}", crate::config::random_hex()));
        let paths = Paths { config: root.join("config"), state: root.clone(), work: root.join("work") };
        let revision = update(&paths, true, true, &[ClientId::Codex], &[]).unwrap();
        let inflight = allow(&paths, &revision).unwrap().unwrap();
        let (entered, starting) = std::sync::mpsc::channel();
        let (finished, done) = std::sync::mpsc::channel();
        let other = paths.clone();
        let writer = std::thread::spawn(move || {
            entered.send(()).unwrap();
            let next = update(&other, false, true, &[ClientId::Codex], &[]).unwrap();
            finished.send(next).unwrap();
        });
        starting.recv().unwrap();
        assert!(matches!(
            done.recv_timeout(std::time::Duration::from_millis(50)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        drop(inflight);
        let next = done.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        writer.join().unwrap();
        assert_ne!(next, revision);
        assert!(allow(&paths, &revision).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
