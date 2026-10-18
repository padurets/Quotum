//! Checked regular files and one lock shared by the helper and both frontends.
use super::{ErrorCode, Result};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(super) fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(unix)]
pub(super) fn chain(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    for ancestor in path.ancestors() {
        let meta = fs::symlink_metadata(ancestor).map_err(|_| ErrorCode::UnsafePath)?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || ![0, unsafe { libc::geteuid() }].contains(&meta.uid())
            || meta.mode() & 0o022 != 0
        {
            return Err(ErrorCode::UnsafePath);
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn chain(path: &Path) -> Result<()> {
    super::windows::check_chain(path)
}

pub(super) fn parents(path: &Path) -> Result<()> {
    if path.exists() {
        return chain(path);
    }
    parents(path.parent().ok_or(ErrorCode::UnsafePath)?)?;
    private_dir(path)
}

pub(super) fn private_dir(path: &Path) -> Result<()> {
    chain(path.parent().ok_or(ErrorCode::UnsafePath)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err(ErrorCode::FileFailure),
        }
        let meta = fs::symlink_metadata(path).map_err(|_| ErrorCode::UnsafePath)?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(ErrorCode::UnsafePath);
        }
        chain(path)
    }
    #[cfg(windows)]
    {
        super::windows::private_directory(path)
    }
}

pub(super) fn private_dir_existing(path: &Path) -> Result<()> {
    chain(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::symlink_metadata(path).map_err(|_| ErrorCode::UnsafePath)?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(ErrorCode::UnsafePath);
        }
    }
    #[cfg(windows)]
    super::windows::check_private_directory(path)?;
    Ok(())
}

#[cfg(unix)]
fn io_error(error: std::io::Error) -> ErrorCode {
    if error.kind() == std::io::ErrorKind::NotFound { ErrorCode::NoEntry } else { ErrorCode::FileFailure }
}

pub(super) fn open(path: &Path, write: bool, create: bool, private: bool) -> Result<File> {
    chain(path.parent().ok_or(ErrorCode::UnsafePath)?)?;
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .write(write)
            .create_new(create)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(io_error)?
    };
    #[cfg(windows)]
    let file = super::windows::open_checked(path, write, create, private)?;
    check(&file, private)?;
    same_name(&file, path)?;
    Ok(file)
}

#[cfg(unix)]
pub(super) fn check(file: &File, private: bool) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|_| ErrorCode::UnsafePath)?;
    if !meta.is_file()
        || ![0, unsafe { libc::geteuid() }].contains(&meta.uid())
        || meta.mode() & if private { 0o077 } else { 0o022 } != 0
        || meta.nlink() != 1
        || private && meta.uid() != unsafe { libc::geteuid() }
    {
        return Err(ErrorCode::UnsafePath);
    }
    Ok(())
}
#[cfg(windows)]
pub(super) fn check(file: &File, private: bool) -> Result<()> {
    super::windows::check_regular(file, private)
}

#[cfg(unix)]
pub(super) fn identity(file: &File) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|_| ErrorCode::FileFailure)?;
    Ok((meta.dev(), meta.ino()))
}

pub(super) fn same_name(file: &File, path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::symlink_metadata(path).map_err(|_| ErrorCode::Conflict)?;
        if !meta.is_file() || meta.file_type().is_symlink() || (meta.dev(), meta.ino()) != identity(file)? {
            return Err(ErrorCode::Conflict);
        }
    }
    #[cfg(windows)]
    {
        super::windows::same_name(file, path)?;
    }
    chain(path.parent().ok_or(ErrorCode::UnsafePath)?)
}

pub(super) fn read(path: &Path, limit: usize, private: bool) -> Result<Vec<u8>> {
    let file = open(path, false, false, private)?;
    read_file(&file, limit)
}
pub(super) fn read_file(mut file: &File, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    Read::by_ref(&mut file).take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|_| ErrorCode::FileFailure)?;
    if bytes.len() > limit {
        return Err(ErrorCode::FileFailure);
    }
    Ok(bytes)
}

pub(super) struct Temporary {
    pub path: PathBuf,
    pub file: Option<File>,
}
impl Temporary {
    pub fn new(target: &Path) -> Result<Self> {
        let path = target.with_file_name(format!(".quotum-{}.tmp", super::uuid()?));
        let file = open(&path, true, true, true)?;
        Ok(Self { path, file: Some(file) })
    }
    pub fn publish(mut self, target: &Path, bytes: &[u8], executable: bool) -> Result<()> {
        let file = self.file.as_mut().ok_or(ErrorCode::FileFailure)?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| ErrorCode::FileFailure)?;
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o700)).map_err(|_| ErrorCode::FileFailure)?;
        }
        #[cfg(windows)]
        let _ = executable;
        same_name(file, &self.path)?;
        self.file.take();
        replace(&self.path, target)?;
        sync_parent(target)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.path);
    }
}
pub(super) fn atomic(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    Temporary::new(path)?.publish(path, bytes, executable)
}

/// Holding the lifecycle lock proves no current helper/installer owns these names.
pub(super) fn clean_temps(directory: &Path) -> Result<()> {
    if !directory.try_exists().map_err(|_| ErrorCode::UnsafePath)? {
        return Ok(());
    }
    chain(directory)?;
    for entry in fs::read_dir(directory).map_err(|_| ErrorCode::FileFailure)? {
        let entry = entry.map_err(|_| ErrorCode::FileFailure)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.strip_prefix(".quotum-").and_then(|v| v.strip_suffix(".tmp")).is_some_and(super::valid_uuid) {
            continue;
        }
        let path = entry.path();
        let file = open(&path, false, false, false)?;
        same_name(&file, &path)?;
        fs::remove_file(&path).map_err(|_| ErrorCode::FileFailure)?;
    }
    Ok(())
}

pub(super) fn publish_record(next: &Path, target: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(next.as_os_str().as_bytes()).map_err(|_| ErrorCode::UnsafePath)?;
        let to = std::ffi::CString::new(target.as_os_str().as_bytes()).map_err(|_| ErrorCode::UnsafePath)?;
        #[cfg(target_os = "linux")]
        let status = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let status = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let status = -1;
        if status != 0 {
            return Err(ErrorCode::FileFailure);
        }
    }
    #[cfg(windows)]
    super::windows::publish_record(next, target)?;
    Ok(())
}
#[cfg(unix)]
pub(super) fn replace(next: &Path, target: &Path) -> Result<()> {
    fs::rename(next, target).map_err(|_| ErrorCode::FileFailure)
}
#[cfg(windows)]
pub(super) fn replace(next: &Path, target: &Path) -> Result<()> {
    super::windows::replace(next, target)
}
pub(super) fn sync_parent(_path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        File::open(_path.parent().ok_or(ErrorCode::UnsafePath)?)
            .and_then(|f| f.sync_all())
            .map_err(|_| ErrorCode::FileFailure)?;
    }
    Ok(())
}

pub(super) struct Lock {
    file: File,
    path: PathBuf,
}
impl Lock {
    /// Create is reserved for explicit consent. Helpers always open an existing name.
    pub fn acquire(path: &Path, create: bool) -> Result<Self> {
        let file = if create {
            match open(path, true, true, true) {
                Ok(f) => f,
                Err(_) if path.exists() => open(path, true, false, true)?,
                Err(e) => return Err(e),
            }
        } else {
            open(path, true, false, true)?
        };
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(ErrorCode::Busy);
            }
        }
        #[cfg(windows)]
        super::windows::lock(&file)?;
        same_name(&file, path)?;
        Ok(Self { file, path: path.to_owned() })
    }
    pub fn validate(&self) -> Result<()> {
        same_name(&self.file, &self.path)
    }
    pub fn retire(&self) -> Result<()> {
        self.validate()?;
        #[cfg(unix)]
        {
            fs::remove_file(&self.path).map_err(|_| ErrorCode::RemovePending)
        }
        #[cfg(windows)]
        {
            super::windows::retire_lock(&self.file, &self.path)
        }
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
        #[cfg(windows)]
        super::windows::unlock(&self.file);
    }
}
