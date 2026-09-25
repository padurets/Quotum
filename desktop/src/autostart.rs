//! Start at login: on by default from the day the app first measures, after that as the
//! person sets it. On Linux only for an app no one else can change: start at login would
//! otherwise run whatever another user of the machine put in its place.

use std::sync::Arc;

use crate::host;

use crate::shell::Shell;

pub fn is_enabled(shell: &Shell) -> bool {
    host::autostart_enabled(shell)
}

/// Turned on or off in the settings; from then on the app leaves it as the person set it.
pub fn set(shell: &Arc<Shell>, on: bool) -> Result<(), String> {
    if cfg!(debug_assertions) || shell.smoke.is_some() {
        return Err("a development build does not start at login".into());
    }
    let done =
        if on { safe().and_then(|_| host::set_autostart(shell, true)) } else { host::set_autostart(shell, false) };
    shell.mark_autostart_defaulted();
    done
}

/// The first time the app measures (or holds the machine with every provider off).
pub fn by_default(shell: &Arc<Shell>) {
    if cfg!(debug_assertions) || shell.smoke.is_some() || shell.autostart_defaulted() {
        return;
    }
    match safe().and_then(|_| host::set_autostart(shell, true)) {
        Ok(()) => {
            shell.mark_autostart_defaulted();
            shell.agent_log.line("app: starts at login from now on (the settings turn it off)");
        }
        Err(e) => shell.agent_log.line(&format!("app: does not start at login: {e}")),
    }
}

/// Whether the app may be started at login from where it is.
fn safe() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let path = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from).map_or_else(std::env::current_exe, Ok);
        let path = path.and_then(|p| p.canonicalize()).map_err(|e| e.to_string())?;
        // SAFETY: getuid(2) has no preconditions and cannot fail.
        let me = unsafe { libc::getuid() };
        if let Err(dir) = changeable_by_others(&path, me, personal_group(me)) {
            return Err(format!(
                "the app is in {}, where other users of this machine can change it; move it (for example to ~/Applications) to start it at login",
                dir.display()
            ));
        }
    }
    Ok(())
}

/// Whether a file owned by `owner` and `group` with `mode` is this user's alone to change
/// (root's too): no one else may write to it, the user's personal group aside.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn only_mine(owner: u32, group: u32, mode: u32, me: u32, personal: Option<u32>) -> bool {
    (owner == me || owner == 0) && mode & 0o002 == 0 && (mode & 0o020 == 0 || personal == Some(group))
}

/// The first of `path` and the directories above it that someone else could change.
#[cfg(unix)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn changeable_by_others(path: &std::path::Path, me: u32, personal: Option<u32>) -> Result<(), std::path::PathBuf> {
    use std::os::unix::fs::MetadataExt;
    for place in path.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        let meta = std::fs::metadata(place).map_err(|_| place.to_path_buf())?;
        if !only_mine(meta.uid(), meta.gid(), meta.mode(), me, personal) {
            return Err(place.to_path_buf());
        }
    }
    Ok(())
}

/// The user's own group, as Ubuntu, Debian and Fedora make one for every user (its name is
/// the user's): its members may write where the user's umask of 002 lets them.
#[cfg(target_os = "linux")]
fn personal_group(me: u32) -> Option<u32> {
    use std::ffi::CStr;
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: getpwuid_r and getgrgid_r write into the structs and the buffer given, whose
    // sizes are passed along; the names read are within the buffer, which outlives them.
    unsafe {
        let mut user: libc::passwd = std::mem::zeroed();
        let mut found = std::ptr::null_mut();
        if libc::getpwuid_r(me, &mut user, buffer.as_mut_ptr(), buffer.len(), &mut found) != 0 || found.is_null() {
            return None;
        }
        let name = CStr::from_ptr(user.pw_name).to_owned();
        let gid = user.pw_gid;
        let mut group: libc::group = std::mem::zeroed();
        let mut found = std::ptr::null_mut();
        if libc::getgrgid_r(gid, &mut group, buffer.as_mut_ptr(), buffer.len(), &mut found) != 0 || found.is_null() {
            return None;
        }
        (CStr::from_ptr(group.gr_name) == name.as_c_str()).then_some(gid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_no_one_else_can_change_starts_at_login() {
        let (me, mine) = (1000, Some(1000));
        assert!(only_mine(1000, 1000, 0o755, me, mine));
        assert!(only_mine(0, 0, 0o755, me, mine), "root's");
        assert!(only_mine(1000, 1000, 0o775, me, mine), "the user's personal group (umask 002)");
        assert!(!only_mine(1000, 100, 0o775, me, mine), "a group of several users");
        assert!(!only_mine(1000, 1000, 0o777, me, mine), "anyone may write");
        assert!(!only_mine(0, 0, 0o1777, me, mine), "/tmp");
        assert!(!only_mine(1001, 1001, 0o755, me, mine), "another user's");
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_anyone_may_write_to_is_named() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("quotum-autostart-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("apps")).unwrap();
        let app = dir.join("apps/Quotum.AppImage");
        std::fs::write(&app, "").unwrap();
        std::fs::set_permissions(dir.join("apps"), std::fs::Permissions::from_mode(0o777)).unwrap();
        // SAFETY: getuid(2) has no preconditions.
        let me = unsafe { libc::getuid() };
        let found = changeable_by_others(&app, me, None);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(found.is_err(), "the temporary directory or apps/ under it");
    }
}
