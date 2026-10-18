//! A persisted opt-out barrier applies before any namespace can resume delivery.

use super::outbox::{atomic, directory, read_json};
use crate::clients::ClientId;
use crate::config::Paths;
use serde::{Deserialize, Serialize};
use std::io;

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
    directory(&paths.state)?;
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
}
