use super::{ErrorCode, Manifest, Result, Stage, files, valid_uuid};
use crate::route::{ClaudeFlags, Route};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;

const INPUT_LIMIT: usize = 64 * 1024;
pub(super) const RECORD_LIMIT: usize = 2048;
pub(super) const MAX_RECORDS: usize = 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    schema_version: u8,
    installation_generation: String,
    parent_pid: u32,
    native_birth: Vec<u8>,
    session_id: Option<String>,
    flags: ClaudeFlags,
}

/// Silence is established before even argv or environment are inspected.
pub fn run() {
    silently(|| {
        let mut args = std::env::args_os().skip(1);
        if args.next().as_deref() != Some(std::ffi::OsStr::new("--generation")) {
            return;
        }
        let Some(generation) = args.next().and_then(|v| v.into_string().ok()).filter(|v| valid_uuid(v)) else { return };
        if args.next().is_some() {
            return;
        }
        let Ok(root) = super::root() else {
            return;
        };
        let _ = capture(&root, &generation, std::io::stdin().lock());
    });
}
fn silently(observe: impl FnOnce() + std::panic::UnwindSafe) {
    if !silence() {
        return;
    }
    std::panic::set_hook(Box::new(|_| {}));
    let _ = std::panic::catch_unwind(observe);
}

fn capture(root: &Path, generation: &str, input: impl Read) -> Result<()> {
    capture_with(root, generation, input, || capture_flags(|name| std::env::var_os(name)), crate::activity::hook_parent)
}

fn capture_with(
    root: &Path,
    generation: &str,
    input: impl Read,
    flags: impl FnOnce() -> ClaudeFlags,
    mut parent: impl FnMut() -> Option<crate::activity::HookParent>,
) -> Result<()> {
    let mut bytes = Vec::new();
    input.take(INPUT_LIMIT as u64 + 1).read_to_end(&mut bytes).map_err(|_| ErrorCode::FileFailure)?;
    if bytes.len() > INPUT_LIMIT {
        return Err(ErrorCode::FileFailure);
    }
    let event: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ErrorCode::InvalidManifest)?;
    if event.get("hook_event_name").and_then(|v| v.as_str()) != Some("SessionStart") {
        return Ok(());
    }
    let session_id = event.get("session_id").and_then(|v| v.as_str()).filter(|v| valid_uuid(v)).map(str::to_owned);
    let lock = files::Lock::acquire(&root.join("lock"), false)?;
    let manifest = super::Lifecycle { root: root.to_owned() }.manifest()?.ok_or(ErrorCode::InvalidManifest)?;
    if manifest.schema_version != 1
        || !matches!(manifest.stage, Stage::Enabled)
        || manifest.next_payload.is_some()
        || manifest.installation_generation != generation
        || !super::settings::contains(&manifest.settings_target, &manifest.entry)?
    {
        return Ok(());
    }
    files::private_dir_existing(&root.join("records"))?;
    // No cleanup based on age: a slow or unknown process still owns its record.
    if std::fs::read_dir(root.join("records")).map_err(|_| ErrorCode::FileFailure)?.take(MAX_RECORDS + 1).count()
        >= MAX_RECORDS
    {
        return Ok(());
    }
    let before = parent().ok_or(ErrorCode::NoAccess)?;
    let flags = flags();
    if parent().as_ref() != Some(&before) {
        return Ok(());
    }
    let record = Record {
        schema_version: 1,
        installation_generation: generation.to_owned(),
        parent_pid: before.pid,
        native_birth: before.birth,
        session_id,
        flags,
    };
    let bytes = serde_json::to_vec(&record).map_err(|_| ErrorCode::FileFailure)?;
    if bytes.len() > RECORD_LIMIT {
        return Err(ErrorCode::FileFailure);
    }
    lock.validate()?;
    let target = root.join("records").join(format!("{}.json", super::uuid()?));
    let mut temp = files::Temporary::new(&target)?;
    let file = temp.file.as_mut().ok_or(ErrorCode::FileFailure)?;
    use std::io::Write;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| ErrorCode::FileFailure)?;
    // Publish an exclusive final name, so no existing file can be replaced.
    files::same_name(file, &temp.path)?;
    temp.file.take();
    files::publish_record(&temp.path, &target)?;
    drop(temp);
    files::sync_parent(&target)
}

fn capture_flags(mut env: impl FnMut(&str) -> Option<std::ffi::OsString>) -> ClaudeFlags {
    let base = env("ANTHROPIC_BASE_URL");
    let (host, invalid_base) = match base.filter(|v| !v.is_empty()) {
        None => (None, false),
        Some(value) => match value.to_str().and_then(base_host) {
            Some(host) => (Some(host), false),
            None => (None, true),
        },
    };
    let mut present = |name| env(name).is_some_and(|v| !v.is_empty());
    let mut flags = ClaudeFlags {
        host,
        invalid_base,
        bedrock: present("CLAUDE_CODE_USE_BEDROCK"),
        vertex: present("CLAUDE_CODE_USE_VERTEX"),
        foundry: present("CLAUDE_CODE_USE_FOUNDRY"),
        api_key: present("ANTHROPIC_API_KEY"),
        auth_token: present("ANTHROPIC_AUTH_TOKEN"),
        oauth_token: present("CLAUDE_CODE_OAUTH_TOKEN"),
        scrubbed: false,
    };
    flags.scrubbed = env("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB").as_deref() == Some(std::ffi::OsStr::new("1"));
    if flags.scrubbed {
        flags.bedrock = false;
        flags.vertex = false;
        flags.foundry = false;
        flags.api_key = false;
        flags.auth_token = false;
        flags.oauth_token = false;
    }
    flags
}

fn base_host(value: &str) -> Option<String> {
    if !value.get(..7).is_some_and(|v| v.eq_ignore_ascii_case("http://"))
        && !value.get(..8).is_some_and(|v| v.eq_ignore_ascii_case("https://"))
    {
        return None;
    }
    if value.bytes().any(|b| b.is_ascii_control()) {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let url::Host::Domain(host) = url.host()? else { return None };
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    valid_host(&host).then_some(host)
}
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// The caller holds the shared lock. Unknown liveness never authorizes deletion.
pub(super) fn prune(root: &Path, manifest: &Manifest) -> Result<()> {
    prune_with(root, manifest, crate::activity::hook_record_dead)
}
fn prune_with(root: &Path, manifest: &Manifest, mut dead: impl FnMut(u32, &[u8]) -> bool) -> Result<()> {
    let entries = std::fs::read_dir(root.join("records")).map_err(|_| ErrorCode::FileFailure)?;
    for entry in entries.take(MAX_RECORDS) {
        let entry = entry.map_err(|_| ErrorCode::FileFailure)?;
        let path = entry.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json")
            || !path.file_stem().and_then(|v| v.to_str()).is_some_and(valid_uuid)
        {
            continue;
        }
        let Ok(file) = files::open(&path, false, false, true) else { continue };
        let Ok(raw) = files::read_file(&file, RECORD_LIMIT) else { continue };
        let Ok(record) = serde_json::from_slice::<Record>(&raw) else { continue };
        if record.schema_version != 1
            || record.installation_generation != manifest.installation_generation
            || record.parent_pid == 0
            || record.native_birth.is_empty()
            || record.native_birth.len() > 128
            || !dead(record.parent_pid, &record.native_birth)
        {
            continue;
        }
        files::same_name(&file, &path)?;
        std::fs::remove_file(&path).map_err(|_| ErrorCode::FileFailure)?;
    }
    Ok(())
}

pub(super) fn routes(
    root: &Path,
    manifest: &Manifest,
    sessions: &[crate::activity::Session],
) -> Result<std::collections::BTreeMap<(u32, Vec<u8>), Route>> {
    routes_with(root, manifest, sessions, crate::activity::matches_hook_parent)
}
fn routes_with(
    root: &Path,
    manifest: &Manifest,
    sessions: &[crate::activity::Session],
    mut current_parent: impl FnMut(u32, &[u8]) -> bool,
) -> Result<std::collections::BTreeMap<(u32, Vec<u8>), Route>> {
    let mut result = std::collections::BTreeMap::new();
    let entries = std::fs::read_dir(root.join("records")).map_err(|_| ErrorCode::FileFailure)?;
    for entry in entries.take(MAX_RECORDS) {
        let entry = entry.map_err(|_| ErrorCode::FileFailure)?;
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|v| v.to_str()) else { continue };
        if path.extension().and_then(|v| v.to_str()) != Some("json") || !valid_uuid(stem) {
            continue;
        }
        let Ok(raw) = files::read(&path, RECORD_LIMIT, true) else { continue };
        let Ok(record) = serde_json::from_slice::<Record>(&raw) else { continue };
        if record.schema_version != 1
            || record.installation_generation != manifest.installation_generation
            || record.native_birth.len() > 128
            || record.flags.host.as_ref().is_some_and(|v| !valid_host(v))
        {
            continue;
        }
        let matched = sessions.iter().any(|s| {
            s.client == crate::clients::ClientId::Claude
                && s.pid == record.parent_pid
                && s.native_birth.as_ref() == Some(&record.native_birth)
        });
        if !matched {
            continue;
        }
        if !current_parent(record.parent_pid, &record.native_birth) {
            continue;
        }
        let key = (record.parent_pid, record.native_birth);
        let route = crate::route::claude_hook(&record.flags);
        result
            .entry(key)
            .and_modify(|before: &mut Route| *before = before.clone().merge(route.clone()))
            .or_insert(route);
    }
    Ok(result)
}

#[cfg(unix)]
fn silence() -> bool {
    // SAFETY: fixed null device; dup2 redirects both inherited output descriptors.
    unsafe {
        let fd = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
        if fd < 0 {
            return false;
        }
        let ok = libc::dup2(fd, 1) >= 0 && libc::dup2(fd, 2) >= 0;
        if fd > 2 {
            libc::close(fd);
        }
        ok
    }
}
#[cfg(windows)]
fn silence() -> bool {
    super::windows::silence()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn both_frontend_status_and_agent_reads_reclaim_finished_standin_records() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "hook::capture::tests::silence_child"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(child.wait().unwrap().success());
        drop(child);
        let f = crate::hook::tests::Fixture::new();
        f.enable().unwrap();
        let record = Record {
            schema_version: 1,
            installation_generation: f.generation(),
            parent_pid: pid,
            native_birth: vec![1],
            session_id: None,
            flags: ClaudeFlags::default(),
        };
        let path = f.service.root.join("records").join(format!("{}.json", super::super::uuid().unwrap()));
        let raw = serde_json::to_vec(&record).unwrap();
        files::atomic(&path, &raw, false).unwrap();
        assert_eq!(f.service.status(), super::super::Status::EnabledNoRecords);
        assert!(!path.exists(), "both frontends reclaim a positively dead record through shared status");
        files::atomic(&path, &raw, false).unwrap();
        assert!(f.service.routes(&[]).unwrap().is_empty());
        assert!(!path.exists(), "the agent reclaims it even when no current session matches");
    }
    #[test]
    fn pruning_reclaims_only_checked_records_with_positive_native_death_proof() {
        let f = crate::hook::tests::Fixture::new();
        f.enable().unwrap();
        let manifest = f.service.manifest().unwrap().unwrap();
        let save = |pid, birth: Vec<u8>, generation| {
            let path = f.service.root.join("records").join(format!("{}.json", super::super::uuid().unwrap()));
            let record = Record {
                schema_version: 1,
                installation_generation: generation,
                parent_pid: pid,
                native_birth: birth,
                session_id: None,
                flags: ClaudeFlags::default(),
            };
            files::atomic(&path, &serde_json::to_vec(&record).unwrap(), false).unwrap();
            path
        };
        let dead = save(41, vec![1], manifest.installation_generation.clone());
        let replaced = save(42, vec![2], manifest.installation_generation.clone());
        let live = save(43, vec![3], manifest.installation_generation.clone());
        let unknown = save(44, vec![4], manifest.installation_generation.clone());
        let retired = save(45, vec![5], super::super::uuid().unwrap());
        let invalid = save(46, vec![], manifest.installation_generation.clone());
        let linked = save(47, vec![7], manifest.installation_generation.clone());
        let foreign = f.base.join("foreign.json");
        std::fs::hard_link(&linked, &foreign).unwrap();
        let lock = files::Lock::acquire(&f.service.root.join("lock"), true).unwrap();
        prune_with(&f.service.root, &manifest, |pid, birth| {
            assert!(!birth.is_empty());
            assert!(![45, 46, 47].contains(&pid), "untrusted or foreign records never authorize a native query");
            matches!(pid, 41 | 42)
        })
        .unwrap();
        assert!(!dead.exists() && !replaced.exists());
        for path in [&live, &unknown, &retired, &invalid, &linked, &foreign] {
            assert!(path.exists());
        }
        drop(lock);
    }
    #[test]
    fn panic_and_accidental_output_are_silent_in_an_isolated_process() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "hook::capture::tests::silence_child", "--nocapture"])
            .env("QUOTUM_TEST_HOOK_PANIC", "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "running 1 test");
        assert!(output.stderr.is_empty());
    }
    #[test]
    fn silence_child() {
        if std::env::var_os("QUOTUM_TEST_HOOK_PANIC").is_none() {
            return;
        }
        silently(|| {
            println!("stdout-secret-canary");
            eprintln!("stderr-secret-canary");
            panic!("panic-secret-canary");
        });
    }
    #[test]
    fn readers_match_only_the_current_root_birth_and_merge_conflicting_records() {
        let f = crate::hook::tests::Fixture::new();
        f.enable().unwrap();
        let manifest = f.service.manifest().unwrap().unwrap();
        let mut session = crate::activity::attribution::corrected_sessions()[0].clone();
        session.client = crate::clients::ClientId::Claude;
        session.pid = 42;
        session.native_birth = Some(vec![1, 2, 3]);
        let save = |pid, birth, generation, flags| {
            let record = Record {
                schema_version: 1,
                installation_generation: generation,
                parent_pid: pid,
                native_birth: birth,
                session_id: None,
                flags,
            };
            files::atomic(
                &f.service.root.join("records").join(format!("{}.json", super::super::uuid().unwrap())),
                &serde_json::to_vec(&record).unwrap(),
                false,
            )
            .unwrap();
        };
        // A folded descendant, reused PID and retired installation are never evidence for this root.
        for (pid, birth, generation) in [
            (43, vec![1, 2, 3], manifest.installation_generation.clone()),
            (42, vec![9], manifest.installation_generation.clone()),
            (42, vec![1, 2, 3], super::super::uuid().unwrap()),
        ] {
            save(pid, birth, generation, ClaudeFlags { api_key: true, ..Default::default() });
        }
        assert!(
            routes_with(&f.service.root, &manifest, &[session.clone()], |_, _| panic!(
                "unmatched record must not inspect native processes"
            ))
            .unwrap()
            .is_empty()
        );
        save(
            42,
            vec![1, 2, 3],
            manifest.installation_generation.clone(),
            ClaudeFlags { api_key: true, ..Default::default() },
        );
        assert!(
            routes_with(&f.service.root, &manifest, &[session.clone()], |_, _| false).unwrap().is_empty(),
            "a dead or replaced native process is rejected"
        );
        for _ in 0..2 {
            let routes = routes_with(&f.service.root, &manifest, &[session.clone()], |pid, birth| {
                pid == 42 && birth == [1, 2, 3]
            })
            .unwrap();
            assert_eq!(routes[&(42, vec![1, 2, 3])].class, crate::route::Class::Api);
        }
        save(42, vec![1, 2, 3], manifest.installation_generation.clone(), ClaudeFlags::default());
        let routes = routes_with(&f.service.root, &manifest, &[session], |_, _| true).unwrap();
        assert_eq!(routes[&(42, vec![1, 2, 3])].class, crate::route::Class::Unknown);
        f.service.set_enabled(false).unwrap();
    }
    #[test]
    fn url_capture_keeps_only_dns_host() {
        for raw in ["https://secret:password@OpenRouter.AI:8443/private?key=secret#secret", "https://OPENROUTER.AI./"] {
            assert_eq!(base_host(raw).as_deref(), Some("openrouter.ai"));
        }
        for raw in [
            "http://127.0.0.1",
            "http://[::1]",
            "ftp://example.com",
            "example.com",
            "https://bad_host/",
            "https://host\n/",
            "",
            "https://-host/",
            "https:api.anthropic.com",
        ] {
            assert!(base_host(raw).is_none());
        }
    }
    #[test]
    fn capture_whitelist_never_retains_token_values_or_secret_url_components() {
        let flags = capture_flags(|name| match name {
            "ANTHROPIC_BASE_URL" => Some(
                "https://user-canary:password-canary@openrouter.ai/path-canary?query-canary#fragment-canary".into(),
            ),
            "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | "CLAUDE_CODE_OAUTH_TOKEN" => Some("token-canary".into()),
            _ => None,
        });
        let json = serde_json::to_string(&flags).unwrap();
        assert!(!json.contains("canary"));
        assert!(flags.api_key && flags.auth_token && flags.oauth_token);
        assert_eq!(crate::route::claude_hook(&flags).host.as_deref(), Some("openrouter.ai"));
        let flags = capture_flags(|name| match name {
            "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" => Some("1".into()),
            "ANTHROPIC_API_KEY" => Some("secret".into()),
            _ => None,
        });
        assert!(flags.scrubbed && !flags.api_key);
        assert_eq!(crate::route::claude_hook(&flags).class, crate::route::Class::Unknown);
    }

    #[test]
    fn bounded_capture_and_generation_fence_never_create_a_channel() {
        let f = crate::hook::tests::Fixture::new();
        let generation = super::super::uuid().unwrap();
        let input = br#"{"hook_event_name":"SessionStart"}"#;
        assert!(capture_with(&f.service.root, &generation, &input[..], || panic!("no consent"), || None).is_err());
        assert!(!f.service.root.exists());
        f.enable().unwrap();
        let generation = f.generation();
        let parent = || Some(crate::activity::HookParent::fixture());
        let mut input = input.to_vec();
        input.resize(INPUT_LIMIT + 1, b' ');
        assert!(capture_with(&f.service.root, &generation, &input[..], || panic!("oversize"), parent).is_err());
        f.service.set_enabled(false).unwrap();
        f.enable().unwrap();
        assert!(
            capture_with(
                &f.service.root,
                &generation,
                &br#"{"hook_event_name":"SessionStart"}"#[..],
                || panic!("stale generation"),
                parent
            )
            .is_ok()
        );
        assert_eq!(std::fs::read_dir(f.service.root.join("records")).unwrap().count(), 0);
    }

    #[test]
    fn capture_publishes_only_complete_whitelisted_records_and_off_waits_for_writer() {
        let f = crate::hook::tests::Fixture::new();
        f.enable().unwrap();
        let generation = f.generation();
        let root = f.service.root.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let helper = std::thread::spawn(move || {
            capture_with(
                &root,
                &generation,
                &br#"{"hook_event_name":"SessionStart","cwd":"secret-path","transcript_path":"secret-file"}"#[..],
                || {
                    ready_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                    capture_flags(|name| {
                        match name {
                "ANTHROPIC_BASE_URL"=>Some("https://secret-user:secret-password@openrouter.ai/secret-path?secret-query#secret-fragment".into()),
                "ANTHROPIC_API_KEY"=>Some("secret-token".into()),_=>None,
            }
                    })
                },
                || Some(crate::activity::HookParent::fixture()),
            )
        });
        ready_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(f.service.set_enabled(false), Err(ErrorCode::Busy));
        resume_tx.send(()).unwrap();
        helper.join().unwrap().unwrap();
        let records =
            std::fs::read_dir(f.service.root.join("records")).unwrap().collect::<std::io::Result<Vec<_>>>().unwrap();
        assert_eq!(records.len(), 1);
        let raw = files::read(&records[0].path(), RECORD_LIMIT, true).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("secret-"));
        let record: Record = serde_json::from_slice(&raw).unwrap();
        assert!(record.flags.api_key);
        f.service.set_enabled(false).unwrap();
        assert!(!f.service.root.exists());
    }

    #[test]
    fn paused_before_lock_cannot_publish_after_off_on_or_relocation() {
        struct Paused {
            ready: Option<std::sync::mpsc::Sender<()>>,
            resume: std::sync::mpsc::Receiver<()>,
            input: std::io::Cursor<Vec<u8>>,
        }
        impl Read for Paused {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                if let Some(ready) = self.ready.take() {
                    ready.send(()).unwrap();
                    self.resume.recv().unwrap();
                }
                self.input.read(bytes)
            }
        }
        for mode in [0, 1, 2] {
            let f = crate::hook::tests::Fixture::new();
            f.enable().unwrap();
            let root = f.service.root.clone();
            let generation = f.generation();
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let (resume_tx, resume_rx) = std::sync::mpsc::channel();
            let helper = std::thread::spawn(move || {
                capture_with(
                    &root,
                    &generation,
                    Paused {
                        ready: Some(ready_tx),
                        resume: resume_rx,
                        input: std::io::Cursor::new(br#"{"hook_event_name":"SessionStart"}"#.to_vec()),
                    },
                    || panic!("retired generation must not capture environment"),
                    || Some(crate::activity::HookParent::fixture()),
                )
            });
            ready_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            if mode < 2 {
                f.service.set_enabled(false).unwrap();
            }
            if mode == 1 {
                f.enable().unwrap();
            }
            if mode == 2 {
                f.service.enable(&f.payload, f.base.join("relocated.json")).unwrap();
            }
            resume_tx.send(()).unwrap();
            let _ = helper.join().unwrap();
            if mode == 0 {
                assert!(!f.service.root.exists());
            } else {
                assert_eq!(std::fs::read_dir(f.service.root.join("records")).unwrap().count(), 0);
                f.service.set_enabled(false).unwrap();
            }
            assert!(!f.service.root.exists());
        }
    }
}
