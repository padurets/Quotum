//! Private installation salt and opaque coding-process identity. Failure leaves the
//! optional capability unavailable; no temporary identity or metadata is reported.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::config::Paths;
use crate::model::Provider;

fn field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
    out.extend_from_slice(bytes);
}

pub(crate) fn birth(boot: &[u8], pid: u32, start: u64) -> Vec<u8> {
    let mut out = Vec::new();
    for bytes in [boot, &pid.to_be_bytes(), &start.to_be_bytes()] {
        field(&mut out, bytes);
    }
    out
}

pub(crate) fn identify(salt: &str, provider: Provider, native: &[u8]) -> String {
    let mut encoded = Vec::new();
    for bytes in [
        b"quotum/session/v1".as_slice(),
        salt.as_bytes(),
        std::env::consts::OS.as_bytes(),
        provider.id().as_bytes(),
        native,
    ] {
        field(&mut encoded, bytes);
    }
    Sha256::digest(encoded)[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// No pipe waits, no links followed at the end, and validation on the opened handle.
fn plain(path: &Path, lock: bool, create: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(lock).create(create).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open a reparse point itself; never traverse it to a different target.
        options.share_mode(0).custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_DISK, GetFileType};
        if file.metadata()?.file_attributes() & 0x400 != 0
            // SAFETY: the file owns this handle and remains open.
            || unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
    #[cfg(unix)]
    if lock {
        use std::os::unix::io::AsRawFd;
        // Validate BEFORE flock: even opening a FIFO for write must never wait.
        // SAFETY: file owns the descriptor and outlives the lock.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(file)
}

fn read(path: &Path) -> io::Result<String> {
    let mut bytes = Vec::new();
    plain(path, false, false)?.take(33).read_to_end(&mut bytes)?;
    if bytes.len() != 32 || !bytes.iter().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    String::from_utf8(bytes).map_err(|_| io::ErrorKind::InvalidData.into())
}

pub(crate) fn salt(paths: &Paths) -> Option<String> {
    let path = paths.state.join("session-salt");
    let state = fs::symlink_metadata(&paths.state).ok()?;
    if !state.is_dir() || state.file_type().is_symlink() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if state.file_attributes() & 0x400 != 0 {
            return None;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&paths.state, fs::Permissions::from_mode(0o700)).ok()?;
    }
    let _lock = plain(&paths.state.join("session-salt.lock"), true, true).ok()?;
    match read(&path) {
        Ok(salt) => return Some(salt),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    let salt = crate::config::random_hex();
    let temp = paths.state.join(format!("session-salt-{salt}.tmp"));
    let mut created = false;
    let mut publish = || -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        created = true;
        file.write_all(salt.as_bytes())?;
        file.sync_all()?;
        // Atomic, and never overwrites a target that appeared while we wrote.
        fs::hard_link(&temp, &path)?;
        #[cfg(unix)]
        File::open(&paths.state)?.sync_all()?;
        Ok(())
    };
    let done = publish().is_ok();
    if created {
        let _ = fs::remove_file(temp);
    }
    done.then(|| read(&path).ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    struct Stand(Paths);
    impl Stand {
        fn new() -> Self {
            let state = std::env::temp_dir().join(format!("quotum-session-{}", crate::config::random_hex()));
            fs::create_dir(&state).unwrap();
            Stand(Paths { config: state.join("config"), work: state.join("work"), state })
        }
    }
    impl Drop for Stand {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0.state);
        }
    }

    fn reusable(paths: &Paths) -> String {
        // Other parallel process tests may fork while a writer holds flock. The child
        // inherits that open description until exec: this is real lock contention,
        // for which production deliberately omits identity rather than waiting.
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(value) = salt(paths) {
                return value;
            }
            assert!(Instant::now() < until, "published salt did not become reusable");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn persisted_identity_survives_restart_and_process_context_changes() {
        let stand = Stand::new();
        let first = salt(&stand.0).unwrap();
        assert!(reusable(&stand.0) == first);
        let native = birth(b"boot-a", 7, 123);
        let id = identify(&first, Provider::Codex, &native);
        assert_eq!(id.len(), 32);
        assert_eq!(identify(&reusable(&stand.0), Provider::Codex, &native), id);
        for token in [birth(b"boot-a", 8, 123), birth(b"boot-a", 7, 124), birth(b"boot-b", 7, 123)] {
            assert_ne!(identify(&first, Provider::Codex, &token), id);
        }
        assert_ne!(identify(&first, Provider::Claude, &native), id);
        assert_ne!(identify(&"0".repeat(32), Provider::Codex, &native), id);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(stand.0.state.join("session-salt")).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(&stand.0.state).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn corrupt_salt_and_contended_writer_are_untouched_and_do_not_wait() {
        let stand = Stand::new();
        let path = stand.0.state.join("session-salt");
        fs::write(&path, b"broken").unwrap();
        assert_eq!(salt(&stand.0), None);
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_file(&path).unwrap();
        let lock = plain(&stand.0.state.join("session-salt.lock"), true, true).unwrap();
        let at = Instant::now();
        assert_eq!(salt(&stand.0), None);
        assert!(at.elapsed() < Duration::from_secs(1));
        assert!(!path.exists());
        drop(lock);
        assert_eq!(reusable(&stand.0).len(), 32);
    }

    #[test]
    fn concurrent_writers_publish_only_one_reusable_salt() {
        let stand = Stand::new();
        let values = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8).map(|_| scope.spawn(|| salt(&stand.0))).collect();
            handles.into_iter().filter_map(|handle| handle.join().unwrap()).collect::<Vec<_>>()
        });
        let persisted = reusable(&stand.0);
        assert!(!values.is_empty());
        assert!(values.iter().all(|value| value == &persisted));
    }

    #[cfg(unix)]
    #[test]
    fn a_forked_handle_keeps_the_nonblocking_writer_busy_until_the_child_exits() {
        use std::os::unix::io::FromRawFd;
        let stand = Stand::new();
        let lock = plain(&stand.0.state.join("session-salt.lock"), true, true).unwrap();
        let mut pipe = [0; 2];
        // SAFETY: pipe writes two descriptors, each closed by its owning process below.
        assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
        // SAFETY: the child invokes only async-signal-safe calls before _exit; it never
        // accesses Rust state or a client. The parent reaps only this fixture's child.
        let child = unsafe { libc::fork() };
        assert!(child >= 0);
        if child == 0 {
            unsafe {
                libc::close(pipe[1]);
                let mut byte = 0u8;
                libc::read(pipe[0], (&raw mut byte).cast(), 1);
                libc::_exit(0);
            }
        }
        // SAFETY: each descriptor is owned here; the writer's File closes on all exits.
        unsafe {
            libc::close(pipe[0]);
        }
        let mut release = unsafe { File::from_raw_fd(pipe[1]) };
        drop(lock);
        let at = Instant::now();
        let busy = salt(&stand.0);
        let elapsed = at.elapsed();
        release.write_all(&[1]).unwrap();
        drop(release);
        // SAFETY: child is the PID just returned by fork, and status is not requested.
        assert_eq!(unsafe { libc::waitpid(child, std::ptr::null_mut(), 0) }, child);
        assert!(busy.is_none());
        assert!(elapsed < Duration::from_secs(1));
        assert_eq!(reusable(&stand.0).len(), 32);
    }

    #[cfg(unix)]
    #[test]
    fn salt_and_lock_links_and_pipes_never_wait_or_touch_their_targets() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;
        for leaf in ["session-salt", "session-salt.lock"] {
            for pipe in [false, true] {
                let stand = Stand::new();
                let path = stand.0.state.join(leaf);
                let target = stand.0.state.join("untouched");
                fs::write(&target, b"untouched").unwrap();
                if pipe {
                    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                    // SAFETY: valid NUL-terminated path, creates only this fixture's pipe.
                    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
                } else {
                    symlink(&target, &path).unwrap();
                }
                let at = Instant::now();
                assert_eq!(salt(&stand.0), None);
                assert!(at.elapsed() < Duration::from_secs(1));
                assert_eq!(fs::read(&target).unwrap(), b"untouched");
                assert!(fs::symlink_metadata(&path).is_ok());
            }
        }
    }
}
