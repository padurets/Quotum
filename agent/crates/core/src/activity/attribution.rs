//! Deterministic observations of the production collector; no provider clients run.
use super::*;
use std::time::Duration;

const WALL: Millis = 1_790_000_000_000;

fn proc(pid: u32, parent: u32, name: &str, role: Role) -> Proc {
    Proc {
        pid,
        parent,
        name: name.into(),
        role,
        sid: Some(1),
        image: None,
        times: Some(Times { started: WALL - 3_600_000, own: 0, reaped: 0 }),
        native_birth: Some(pid.to_be_bytes().to_vec()),
    }
}

fn rows() -> Vec<Proc> {
    vec![
        proc(10, 1, "codex", Role::Unknown),
        proc(11, 10, "codex", Role::Service),
        proc(12, 11, "codex", Role::Runtime),
        proc(13, 12, "bash", Role::Unknown),
        proc(20, 1, "codex", Role::Unknown),
    ]
}

fn activity() -> Activity {
    Activity::new("/fixture-home".into(), true)
}

fn cpu(rows: &mut [Proc], pid: u32, own: u64, reaped: u64) {
    let p = rows.iter_mut().find(|p| p.pid == pid).unwrap();
    p.times.as_mut().unwrap().own = own;
    p.times.as_mut().unwrap().reaped = reaped;
}

fn sample(activity: &mut Activity, rows: &[Proc], start: Instant, secs: u64) -> Vec<Session> {
    activity.observe(
        rows,
        900,
        start + Duration::from_secs(secs),
        WALL + secs as Millis * 1000,
        &|p| Some(p.clone()),
        &|pid| {
            assert_ne!(pid, 12, "shared runtime's inherited cwd must never be read");
            Some(PathBuf::from(if pid == 20 { "/fixture-home/project-b" } else { "/fixture-home/project-a" }))
        },
        &|_| None,
        &|_| true,
    )
}

fn session(sessions: &[Session], pid: u32) -> &Session {
    sessions.iter().find(|s| s.pid == pid).expect("session still visible")
}

pub(crate) fn corrected_sessions() -> Vec<Session> {
    let mut a = activity();
    let mut rows = rows();
    let start = Instant::now();
    sample(&mut a, &rows, start, 0);
    cpu(&mut rows, 12, 600, 0);
    cpu(&mut rows, 13, 900, 0);
    sample(&mut a, &rows, start, 15)
}

#[test]
fn foreign_cpu_has_an_unknown_project_and_leaves_both_clients_idle() {
    let sessions = corrected_sessions();
    assert_eq!(sessions.len(), 3);
    for pid in [10, 20] {
        assert_eq!(session(&sessions, pid).working, Some(false));
    }
    assert_eq!(session(&sessions, 10).project.as_deref(), Some("project-a"));
    assert_eq!(session(&sessions, 20).project.as_deref(), Some("project-b"));
    let runtime = session(&sessions, 12);
    assert_eq!(runtime.working, Some(true));
    assert_eq!((&runtime.project, &runtime.folder), (&None, &None));
}

#[test]
fn private_runtimes_and_detached_owned_tools_keep_their_cpu() {
    for role in [Role::Unknown, Role::Runtime] {
        let mut a = activity();
        let start = Instant::now();
        let mut rows =
            vec![proc(10, 1, "codex", Role::Unknown), proc(14, 10, "codex", role), proc(15, 14, "bash", Role::Unknown)];
        rows[2].sid = Some(15); // Detaching a generic tool proves no shared boundary.
        assert_eq!(sample(&mut a, &rows, start, 0).len(), 1);
        cpu(&mut rows, 15, 1500, 0);
        let sessions = sample(&mut a, &rows, start, 15);
        assert_eq!(session(&sessions, 10).working, Some(true));
        assert_eq!(session(&sessions, 10).project.as_deref(), Some("project-a"));
    }
}

#[test]
fn runtime_role_and_a_distinct_sid_together_separate_the_branch() {
    let mut rows = rows();
    rows.retain(|p| p.pid != 11);
    rows.iter_mut().find(|p| p.pid == 12).unwrap().parent = 10;
    rows.iter_mut().find(|p| p.pid == 12).unwrap().sid = Some(12);
    let found = sessions(&rows, 900, &|_| None);
    assert_eq!(found.iter().find(|f| f.pid == 10).unwrap().tree, vec![10]);
    assert!(found.iter().find(|f| f.pid == 12).unwrap().shared);
}

#[test]
fn orphan_and_remote_only_runtime_remain_visible_without_cwd_authority() {
    let rows = [proc(12, 1, "codex", Role::Runtime)];
    let mut a = activity();
    let start = Instant::now();
    assert_eq!(sample(&mut a, &rows, start, 0).len(), 1);
    let sessions = sample(&mut a, &rows, start, 15);
    assert_eq!(session(&sessions, 12).working, Some(false));
    assert_eq!(session(&sessions, 12).project, None);
}

#[test]
fn editor_and_app_private_runtimes_retain_window_placement() {
    for (name, origin) in [("code", Origin::Editor), ("ChatGPT", Origin::App)] {
        let rows = [proc(40, 1, name, Role::Unknown), proc(41, 40, "codex", Role::Runtime)];
        let mut a = activity();
        let sessions = sample(&mut a, &rows, Instant::now(), 0);
        let window = session(&sessions, 41);
        assert_eq!(window.origin, origin);
        assert_eq!(window.project.as_deref(), Some("project-a"));
    }
}

#[test]
fn measurement_ancestry_crosses_service_and_shared_boundaries() {
    let mut rows = rows();
    rows.push(proc(900, 1, "quotum", Role::Unknown));
    rows[0].parent = 900;
    rows.retain(|p| p.pid != 20);
    assert!(sessions(&rows, 900, &|_| None).is_empty());
}

#[test]
fn a_boundary_resets_false_hold_and_delayed_reaping_stays_excluded() {
    let mut a = activity();
    let mut rows = rows();
    rows[1].role = Role::Unknown;
    let start = Instant::now();
    sample(&mut a, &rows, start, 0);
    cpu(&mut rows, 13, 1500, 0);
    assert_eq!(session(&sample(&mut a, &rows, start, 15), 10).working, Some(true));
    rows[1].role = Role::Service;
    assert_eq!(session(&sample(&mut a, &rows, start, 30), 10).working, None, "new basis forgets false hold");
    assert_eq!(session(&sample(&mut a, &rows, start, 45), 10).working, Some(false));
    rows.retain(|p| [10, 20].contains(&p.pid));
    cpu(&mut rows, 10, 0, 3000);
    let sessions = sample(&mut a, &rows, start, 60);
    assert_eq!(session(&sessions, 10).working, Some(false));
    assert_eq!(session(&sessions, 10).last_worked, None);
    // This ambiguous total can also contain a short owned tool between looks: the
    // conservative loss is intentional, rather than a guessed ownership split.
    cpu(&mut rows, 10, 0, 4500);
    assert_eq!(session(&sample(&mut a, &rows, start, 75), 10).working, Some(false));
    cpu(&mut rows, 10, 500, 4500);
    assert_eq!(session(&sample(&mut a, &rows, start, 90), 10).working, Some(true));
}

#[test]
fn live_owned_tools_survive_the_boundary_and_clean_reaped_tools_still_count() {
    for tainted in [false, true] {
        let mut rows = if tainted { rows() } else { vec![proc(10, 1, "codex", Role::Unknown)] };
        rows.push(proc(14, 10, "bash", Role::Unknown));
        let mut a = activity();
        let start = Instant::now();
        sample(&mut a, &rows, start, 0);
        cpu(&mut rows, 14, 1500, 0);
        assert_eq!(session(&sample(&mut a, &rows, start, 15), 10).working, Some(true));
    }
    let mut a = activity();
    let start = Instant::now();
    let mut rows = vec![proc(10, 1, "codex", Role::Unknown)];
    sample(&mut a, &rows, start, 0);
    cpu(&mut rows, 10, 0, 1500);
    assert_eq!(session(&sample(&mut a, &rows, start, 15), 10).working, Some(true));
}

#[test]
fn unsafe_reaping_crosses_nested_provider_roots_and_wrappers() {
    for wrapper in [false, true] {
        let mut rows = rows();
        rows[0].name = "claude".into();
        rows[0].parent = if wrapper { 6 } else { 5 };
        rows.push(proc(5, 1, "codex", Role::Unknown));
        if wrapper {
            rows.push(proc(6, 5, "bash", Role::Unknown));
        }
        let mut a = activity();
        let start = Instant::now();
        sample(&mut a, &rows, start, 0);
        cpu(&mut rows, 10, 0, 1500);
        assert_eq!(session(&sample(&mut a, &rows, start, 15), 10).working, Some(false));
        rows.retain(|p| [5, 6, 20].contains(&p.pid));
        cpu(&mut rows, if wrapper { 6 } else { 5 }, 0, 3000);
        assert_eq!(session(&sample(&mut a, &rows, start, 30), 5).working, Some(false));
    }
    let mut rows = vec![proc(5, 1, "codex", Role::Unknown), proc(10, 5, "claude", Role::Unknown)];
    let mut a = activity();
    let start = Instant::now();
    sample(&mut a, &rows, start, 0);
    rows.pop();
    cpu(&mut rows, 5, 0, 1500);
    assert_eq!(
        session(&sample(&mut a, &rows, start, 15), 5).working,
        Some(true),
        "clean nested provider is not tainted"
    );
}

#[test]
fn shared_provenance_survives_reparenting_missing_metadata_and_short_absence() {
    let mut rows = rows();
    let mut a = activity();
    let start = Instant::now();
    sample(&mut a, &rows, start, 0);
    rows.retain(|p| p.pid != 11);
    let runtime = rows.iter_mut().find(|p| p.pid == 12).unwrap();
    runtime.parent = 40;
    runtime.role = Role::Unavailable;
    rows.push(proc(40, 1, "code", Role::Unknown));
    let sessions = sample(&mut a, &rows, start, 15);
    assert_eq!(session(&sessions, 12).origin, Origin::Editor);
    assert_eq!(session(&sessions, 12).project, None);
    let retained = rows.iter().find(|p| p.pid == 12).unwrap().clone();
    rows.retain(|p| ![10, 12, 13].contains(&p.pid));
    sample(&mut a, &rows, start, 30);
    rows.push(retained);
    assert_eq!(session(&sample(&mut a, &rows, start, 45), 12).project, None);
    rows.push(proc(10, 1, "codex", Role::Unknown));
    cpu(&mut rows, 10, 0, 3000);
    sample(&mut a, &rows, start, 60);
    cpu(&mut rows, 10, 0, 4500);
    assert_eq!(session(&sample(&mut a, &rows, start, 75), 10).working, Some(false));
}

#[test]
fn exec_invalidates_authority_but_does_not_clean_reaped_cpu() {
    let mut rows = rows();
    let mut a = activity();
    let start = Instant::now();
    sample(&mut a, &rows, start, 0);
    rows.retain(|p| p.pid == 10);
    rows[0].name = "agy".into();
    rows[0].image = Some((1, 2));
    cpu(&mut rows, 10, 0, 3000);
    assert_eq!(session(&sample(&mut a, &rows, start, 15), 10).working, None);
    cpu(&mut rows, 10, 0, 4500);
    assert_eq!(session(&sample(&mut a, &rows, start, 30), 10).working, Some(false));
    // A genuinely different birth starts a clean lifetime, even with the same PID.
    rows[0].native_birth = Some(vec![99]);
    cpu(&mut rows, 10, 0, 0);
    sample(&mut a, &rows, start, 45);
    cpu(&mut rows, 10, 0, 1500);
    assert_eq!(session(&sample(&mut a, &rows, start, 60), 10).working, Some(true));
}

#[test]
fn a_confirmed_role_change_invalidates_shared_placement_and_resets_cpu() {
    let mut rows = vec![proc(41, 1, "codex", Role::Runtime)];
    let mut a = activity();
    let start = Instant::now();
    assert_eq!(session(&sample(&mut a, &rows, start, 0), 41).project, None);
    rows[0].role = Role::Unknown;
    cpu(&mut rows, 41, 5000, 0);
    let sessions = sample(&mut a, &rows, start, 15);
    assert_eq!(session(&sessions, 41).project.as_deref(), Some("project-a"));
    assert_eq!(session(&sessions, 41).working, None);
}

#[test]
fn changed_or_unreadable_contributor_never_supplies_busy_evidence() {
    use std::cell::Cell;
    for reused in [false, true] {
        let mut rows = vec![proc(10, 1, "codex", Role::Unknown), proc(14, 10, "bash", Role::Unknown)];
        let mut a = activity();
        let start = Instant::now();
        sample(&mut a, &rows, start, 0);
        cpu(&mut rows, 14, 0, 0);
        let reads = Cell::new(0);
        let sessions = a.observe(
            &rows,
            900,
            start + Duration::from_secs(15),
            WALL + 15_000,
            &|p| {
                let mut current = p.clone();
                if p.pid == 14 {
                    reads.set(reads.get() + 1);
                    if reads.get() > 1 {
                        if !reused {
                            return None;
                        }
                        current.native_birth = Some(vec![99]);
                        current.times.as_mut().unwrap().own = 5000;
                    }
                }
                Some(current)
            },
            &|_| None,
            &|_| None,
            &|_| true,
        );
        assert_eq!(session(&sessions, 10).working, None);
    }
}

#[test]
fn project_opt_out_and_another_users_clients_read_no_folders() {
    let mut a = Activity::new("/fixture-home".into(), false);
    let rows = rows();
    let sessions = a.observe(
        &rows,
        900,
        Instant::now(),
        WALL,
        &|p| Some(p.clone()),
        &|_| panic!("opt-out read cwd"),
        &|_| None,
        &|pid| pid != 20,
    );
    assert!(!sessions.iter().any(|s| s.pid == 20));
    assert!(sessions.iter().all(|s| s.project.is_none() && s.folder.is_none()));
}

#[test]
fn role_reads_stop_at_runtime_prefix_before_any_option_value() {
    use std::io::Cursor;
    for bytes in [b"codex\0app-server\0".as_slice(), b"codex\0app-server\0--listen\0secret-canary\0"] {
        let mut input = Cursor::new(bytes);
        assert_eq!(codex_role(&mut input), Role::Runtime);
        assert!(input.position() <= b"codex\0app-server\0-".len() as u64);
    }
    assert_eq!(codex_role(b"codex\0app-server\0da".as_slice()), Role::Unavailable);
}

#[cfg(target_os = "linux")]
#[test]
fn linux_process_metadata_brackets_a_real_stand_in_role_read() {
    use std::process::{Command, Stdio};
    struct StandIn {
        child: std::process::Child,
        dir: PathBuf,
    }
    impl Drop for StandIn {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            fs::remove_dir_all(&self.dir).unwrap();
        }
    }
    for (args, role) in [
        (vec!["daemon", "pid-update-loop", "--synthetic", "secret-canary"], Role::Service),
        (vec!["--listen", "secret-canary"], Role::Runtime),
    ] {
        let dir = std::env::temp_dir().join(format!("quotum-role-{}-{}", std::process::id(), crate::model::now_ms()));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("app-server"), "read ignored\n").unwrap();
        let mut command = Command::new("/bin/sh");
        command.current_dir(&dir).arg("app-server").args(&args).stdin(Stdio::piped());
        crate::process::detach(&mut command);
        let stand = StandIn { child: command.spawn().unwrap(), dir };
        let pid = stand.child.id();
        let listed = sys::processes().into_iter().find(|p| p.pid == pid).unwrap();
        assert_eq!(listed.sid, Some(pid), "the OS session comes from stat, not argv");
        assert!(listed.native_birth.is_some());
        let before = sys::verified(&listed).unwrap();
        let invocation = fs::File::open(format!("/proc/{pid}/cmdline")).unwrap();
        assert_eq!(codex_role(invocation), role);
        let after = sys::verified(&before).unwrap();
        assert!(before.same_process(&after));
        drop(stand);
        assert!(sys::gone(pid));
        assert!(sys::verified(&listed).is_none(), "exited birth cannot provide CPU");
    }
}

#[test]
fn a_contributor_denied_at_validation_leaves_the_observation_unknown() {
    let rows = [proc(10, 1, "codex", Role::Unknown), proc(14, 10, "bash", Role::Unknown)];
    let mut a = activity();
    let start = Instant::now();
    sample(&mut a, &rows, start, 0);
    let sessions = a.observe(
        &rows,
        900,
        start + Duration::from_secs(15),
        WALL + 15_000,
        &|p| (p.pid != 14).then(|| p.clone()),
        &|_| None,
        &|_| None,
        &|_| true,
    );
    assert_eq!(session(&sessions, 10).working, None, "unknown contributor is not an idle measurement");
}

#[test]
fn an_excluded_branch_exiting_during_validation_cannot_leak_reaped_cpu() {
    let rows = rows();
    let mut a = activity();
    let start = Instant::now();
    // The first snapshot proves the service, but it exits before the additional read.
    let sessions = a.observe(
        &rows,
        900,
        start,
        WALL,
        &|p| {
            if [11, 12, 13].contains(&p.pid) {
                return None;
            }
            let mut current = p.clone();
            if p.pid == 10 {
                current.times.as_mut().unwrap().reaped = 1500;
            }
            Some(current)
        },
        &|_| None,
        &|_| None,
        &|_| true,
    );
    assert_eq!(session(&sessions, 10).working, None);
    let mut later: Vec<_> = rows.into_iter().filter(|p| [10, 20].contains(&p.pid)).collect();
    cpu(&mut later, 10, 0, 3000);
    assert_eq!(session(&sample(&mut a, &later, start, 15), 10).working, Some(false));
}

#[test]
fn a_replaced_executable_cannot_keep_an_unreadable_old_role() {
    let mut rows = vec![proc(41, 1, "codex", Role::Runtime)];
    let mut a = activity();
    let start = Instant::now();
    sample(&mut a, &rows, start, 0);
    rows[0].image = Some((2, 3));
    rows[0].role = Role::Unavailable;
    let sessions = sample(&mut a, &rows, start, 15);
    assert_eq!(session(&sessions, 41).project.as_deref(), Some("project-a"));
    assert_eq!(session(&sessions, 41).working, None);
}

#[test]
fn an_unreadable_service_does_not_lose_its_proven_boundary() {
    let rows = rows();
    let mut a = activity();
    let start = Instant::now();
    for secs in [0, 15] {
        let sessions = a.observe(
            &rows,
            900,
            start + Duration::from_secs(secs),
            WALL + secs as Millis * 1000,
            &|p| {
                let mut current = p.clone();
                if p.pid == 11 {
                    current.role = Role::Unavailable;
                }
                Some(current)
            },
            &|_| None,
            &|_| None,
            &|_| true,
        );
        assert!(!sessions.iter().any(|s| s.pid == 11), "maintenance never becomes a client when its role read fails");
        if secs != 0 {
            assert_eq!(session(&sessions, 10).working, Some(false));
        }
    }
}
