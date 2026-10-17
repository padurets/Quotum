//! Native ACL and opened-file checks for the hook namespace; no credential access.
use super::{ErrorCode, Result};
use std::fs::File;
use std::os::windows::{
    ffi::OsStrExt,
    fs::MetadataExt,
    io::{AsRawHandle, FromRawHandle},
};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, GENERIC_ALL, GENERIC_READ, GENERIC_WRITE,
        GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    },
    Security::{
        ACCESS_ALLOWED_ACE, ACL,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
            SE_FILE_OBJECT,
        },
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetTokenInformation, INHERIT_ONLY_ACE, IsWellKnownSid,
        LookupAccountNameW, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    },
    Storage::FileSystem::{
        CREATE_NEW, CreateDirectoryW, CreateFileW, DELETE, FILE_APPEND_DATA, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_DATA, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, OPEN_EXISTING,
        READ_CONTROL, WRITE_DAC, WRITE_OWNER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};
unsafe fn read_wide(pointer: *const u16) -> Result<String> {
    if pointer.is_null() {
        return Err(ErrorCode::UnsafePath);
    }
    let mut length = 0;
    while length < 32768 && unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    if length == 32768 {
        return Err(ErrorCode::UnsafePath);
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, length) }).map_err(|_| ErrorCode::UnsafePath)
}
fn wide(path: &Path) -> Result<Vec<u16>> {
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(ErrorCode::UnsafePath);
    }
    value.push(0);
    Ok(value)
}
struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
struct User {
    data: Vec<usize>,
}
impl User {
    fn new() -> Result<Self> {
        Self::of_process(unsafe { GetCurrentProcess() })
    }
    fn of_process(process: HANDLE) -> Result<Self> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(ErrorCode::NoAccess);
        }
        let mut length = 0;
        unsafe {
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut length);
        }
        let mut data = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        let result = unsafe { GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), length, &mut length) };
        unsafe {
            CloseHandle(token);
        }
        if result == 0 || data.len() * std::mem::size_of::<usize>() < std::mem::size_of::<TOKEN_USER>() {
            return Err(ErrorCode::NoAccess);
        }
        Ok(Self { data })
    }
    fn sid(&self) -> PSID {
        unsafe { (*(self.data.as_ptr().cast::<TOKEN_USER>())).User.Sid }
    }
    fn descriptor(&self) -> Result<Descriptor> {
        let mut value = null_mut();
        if unsafe { ConvertSidToStringSidW(self.sid(), &mut value) } == 0 {
            return Err(ErrorCode::NoAccess);
        }
        let result = unsafe { read_wide(value) };
        unsafe {
            LocalFree(value.cast());
        }
        let sid = result?;
        let sddl: Vec<u16> = format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{sid})\0").encode_utf16().collect();
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, null_mut())
        } == 0
        {
            return Err(ErrorCode::UnsafePath);
        }
        Ok(Descriptor(descriptor))
    }
}
fn trusted(sid: PSID, user: &User) -> bool {
    !sid.is_null()
        && unsafe {
            EqualSid(sid, user.sid()) != 0
                || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
                || IsWellKnownSid(sid, WinLocalSystemSid) != 0
        }
}
fn trusted_ancestor(sid: PSID, user: &User) -> bool {
    if sid.is_null() {
        return false;
    }
    if trusted(sid, user) {
        return true;
    }
    // Windows owns parts of the system drive as this privileged servicing account.
    // It may own an ancestor, but never broadens access to our private namespace.
    let account: Vec<u16> = "NT SERVICE\\TrustedInstaller\0".encode_utf16().collect();
    let mut sid_size = 0;
    let mut domain_size = 0;
    let mut kind = 0;
    unsafe {
        LookupAccountNameW(
            null(),
            account.as_ptr(),
            null_mut(),
            &mut sid_size,
            null_mut(),
            &mut domain_size,
            &mut kind,
        );
    }
    if sid_size == 0 || sid_size > 1024 || domain_size > 1024 {
        return false;
    }
    let mut buffer = vec![0usize; (sid_size as usize).div_ceil(std::mem::size_of::<usize>())];
    let mut domain = vec![0u16; domain_size as usize];
    unsafe {
        LookupAccountNameW(
            null(),
            account.as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut sid_size,
            domain.as_mut_ptr(),
            &mut domain_size,
            &mut kind,
        ) != 0
            && EqualSid(sid, buffer.as_mut_ptr().cast()) != 0
    }
}
fn check_handle(file: &File, private: bool) -> Result<()> {
    if file.metadata().map_err(|_| ErrorCode::UnsafePath)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(ErrorCode::UnsafePath);
    }
    let user = User::new()?;
    let mut owner: PSID = null_mut();
    let mut acl: *mut ACL = null_mut();
    let mut sd = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle().cast(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut sd,
        )
    };
    if status != 0 {
        return Err(ErrorCode::UnsafePath);
    }
    let _descriptor = Descriptor(sd);
    let allowed_principal = |sid| if private { trusted(sid, &user) } else { trusted_ancestor(sid, &user) };
    if acl.is_null() || !allowed_principal(owner) {
        return Err(ErrorCode::UnsafePath);
    }
    // Ancestors may allow creating a new child, but never changing or replacing a protected one.
    let mutation = GENERIC_ALL
        | GENERIC_WRITE
        | DELETE
        | WRITE_DAC
        | WRITE_OWNER
        | FILE_DELETE_CHILD
        | FILE_WRITE_EA
        | FILE_WRITE_ATTRIBUTES
        | if file.metadata().map_err(|_| ErrorCode::UnsafePath)?.is_file() {
            FILE_WRITE_DATA | FILE_APPEND_DATA
        } else {
            0
        };
    let forbidden =
        if private { mutation | GENERIC_READ | FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA } else { mutation };
    for i in 0..unsafe { (*acl).AceCount } {
        let mut ace = null_mut();
        if unsafe { GetAce(acl, u32::from(i), &mut ace) } == 0 || ace.is_null() {
            return Err(ErrorCode::UnsafePath);
        }
        let allowed = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
        if allowed.Header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 || allowed.Header.AceType == 1 {
            continue;
        }
        if allowed.Header.AceType != 0 {
            return Err(ErrorCode::UnsafePath);
        }
        let sid = (&allowed.SidStart as *const u32).cast_mut().cast();
        if allowed.Mask & forbidden != 0 && !allowed_principal(sid) {
            return Err(ErrorCode::UnsafePath);
        }
    }
    Ok(())
}
#[derive(Clone, Copy)]
enum Mode {
    Read,
    Create,
    ReadWrite,
}
fn handle(path: &Path, mode: Mode, descriptor: Option<&Descriptor>) -> Result<File> {
    let name = wide(path)?;
    let create = matches!(mode, Mode::Create);
    let access = match mode {
        Mode::Read => GENERIC_READ,
        Mode::Create => GENERIC_WRITE,
        Mode::ReadWrite => GENERIC_READ | GENERIC_WRITE,
    };
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.map(|d| d.0).unwrap_or(null_mut()),
        bInheritHandle: 0,
    };
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            if create { &mut attributes } else { null() },
            if create { CREATE_NEW } else { OPEN_EXISTING },
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
            ErrorCode::NoEntry
        } else {
            ErrorCode::FileFailure
        });
    }
    Ok(unsafe { File::from_raw_handle(handle.cast()) })
}
pub fn check_chain(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        let file = handle(ancestor, Mode::Read, None)?;
        if !file.metadata().map_err(|_| ErrorCode::UnsafePath)?.is_dir() {
            return Err(ErrorCode::UnsafePath);
        }
        check_handle(&file, false)?;
    }
    Ok(())
}
pub fn private_directory(path: &Path) -> Result<()> {
    check_chain(path.parent().ok_or(ErrorCode::UnsafePath)?)?;
    let descriptor = User::new()?.descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(path)?.as_ptr(), &attributes) } == 0
        && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS
    {
        return Err(ErrorCode::FileFailure);
    }
    let file = handle(path, Mode::Read, None)?;
    if !file.metadata().map_err(|_| ErrorCode::UnsafePath)?.is_dir() {
        return Err(ErrorCode::UnsafePath);
    }
    check_handle(&file, true)
}

pub fn open_checked(path: &Path, write: bool, create: bool, private: bool) -> Result<File> {
    let descriptor = if create { Some(User::new()?.descriptor()?) } else { None };
    let file = handle(
        path,
        if create {
            Mode::Create
        } else if write {
            Mode::ReadWrite
        } else {
            Mode::Read
        },
        descriptor.as_ref(),
    )?;
    check_regular(&file, private)?;
    Ok(file)
}
pub fn check_regular(file: &File, private: bool) -> Result<()> {
    if !file.metadata().map_err(|_| ErrorCode::UnsafePath)?.is_file() {
        return Err(ErrorCode::UnsafePath);
    }
    check_handle(file, private)
}
pub fn check_private_directory(path: &Path) -> Result<()> {
    let file = handle(path, Mode::Read, None)?;
    if !file.metadata().map_err(|_| ErrorCode::UnsafePath)?.is_dir() {
        return Err(ErrorCode::UnsafePath);
    }
    check_handle(&file, true)
}
pub fn identity(file: &File) -> Result<(u64, u64)> {
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 || info.nNumberOfLinks != 1 {
        return Err(ErrorCode::UnsafePath);
    }
    Ok((u64::from(info.dwVolumeSerialNumber), (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)))
}
pub fn same_name(file: &File, path: &Path) -> Result<()> {
    let current = handle(path, Mode::Read, None)?;
    if identity(file)? != identity(&current)? {
        return Err(ErrorCode::Conflict);
    }
    check_regular(&current, false)
}
pub fn lock(file: &File) -> Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx};
    let mut overlapped = unsafe { std::mem::zeroed() };
    if unsafe {
        LockFileEx(
            file.as_raw_handle().cast(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        )
    } == 0
    {
        return Err(ErrorCode::Busy);
    }
    Ok(())
}
pub fn unlock(file: &File) {
    use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
    let mut overlapped = unsafe { std::mem::zeroed() };
    unsafe { UnlockFileEx(file.as_raw_handle().cast(), 0, 1, 0, &mut overlapped) };
}
pub fn retire_lock(locked: &File, path: &Path) -> Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX,
        FILE_READ_ATTRIBUTES, FileDispositionInfoEx, SetFileInformationByHandle,
    };
    let name = wide(path)?;
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(ErrorCode::RemovePending);
    }
    let file = unsafe { File::from_raw_handle(raw.cast()) };
    check_regular(&file, true)?;
    if identity(&file)? != identity(locked)? {
        return Err(ErrorCode::Conflict);
    }
    let info = FILE_DISPOSITION_INFO_EX { Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS };
    // POSIX unlink retires the name even while an old, sharing waiter still holds it.
    // Unsupported filesystems report pending; ordinary delete-on-close is not a pass.
    if unsafe {
        SetFileInformationByHandle(
            raw,
            FileDispositionInfoEx,
            (&info as *const FILE_DISPOSITION_INFO_EX).cast(),
            std::mem::size_of_val(&info) as u32,
        )
    } == 0
    {
        return Err(ErrorCode::RemovePending);
    }
    Ok(())
}
pub fn replace(next: &Path, target: &Path) -> Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW};
    if unsafe {
        MoveFileExW(wide(next)?.as_ptr(), wide(target)?.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
    } == 0
    {
        return Err(ErrorCode::FileFailure);
    }
    Ok(())
}
pub fn publish_record(next: &Path, target: &Path) -> Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
    if unsafe { MoveFileExW(wide(next)?.as_ptr(), wide(target)?.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(ErrorCode::FileFailure);
    }
    Ok(())
}
pub fn local_app_data() -> Result<PathBuf> {
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath},
    };
    let mut path = null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, null_mut(), &mut path) } < 0 {
        return Err(ErrorCode::UnsafePath);
    }
    let result = unsafe { read_wide(path) }.map(PathBuf::from);
    unsafe { CoTaskMemFree(path.cast()) };
    result
}
pub fn silence() -> bool {
    use windows_sys::Win32::{
        Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
        System::Console::{STD_ERROR_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle},
    };
    let file = unsafe {
        CreateFileW(
            wide(Path::new("NUL")).unwrap_or_default().as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if file == INVALID_HANDLE_VALUE {
        return false;
    }
    unsafe { SetStdHandle(STD_OUTPUT_HANDLE, file) != 0 && SetStdHandle(STD_ERROR_HANDLE, file) != 0 }
}

use std::io;
fn file_dacl(target: &Path) -> io::Result<Option<Vec<usize>>> {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, GetFileSecurityW};

    let target = wide(target).map_err(|_| io::Error::other("unsafe path"))?;
    let mut size = 0;
    // SAFETY: the first call only asks for the required buffer size; the path is terminated.
    unsafe { GetFileSecurityW(target.as_ptr(), DACL_SECURITY_INFORMATION, std::ptr::null_mut(), 0, &mut size) };
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::NotFound {
        return Ok(None);
    }
    if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
        return Err(error);
    }
    // A security descriptor requires aligned storage, even though its length is in bytes.
    let mut descriptor = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    let ptr = descriptor.as_mut_ptr().cast();
    // SAFETY: ptr has at least size bytes of aligned storage and outlives the call.
    if unsafe { GetFileSecurityW(target.as_ptr(), DACL_SECURITY_INFORMATION, ptr, size, &mut size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(descriptor))
}

pub fn preserve_dacl(next: &Path, target: &Path) -> Result<()> {
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, PROTECTED_DACL_SECURITY_INFORMATION,
        SE_DACL_PROTECTED, SetFileSecurityW, UNPROTECTED_DACL_SECURITY_INFORMATION,
    };
    let Some(mut sd) = file_dacl(target).map_err(|_| ErrorCode::UnsafePath)? else { return Ok(()) };
    let (mut control, mut revision) = (0, 0);
    let ptr = sd.as_mut_ptr().cast();
    if unsafe { GetSecurityDescriptorControl(ptr, &mut control, &mut revision) } == 0 {
        return Err(ErrorCode::UnsafePath);
    }
    let flag = if control & SE_DACL_PROTECTED != 0 {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    if unsafe { SetFileSecurityW(wide(next)?.as_ptr(), DACL_SECURITY_INFORMATION | flag, ptr) } == 0 {
        return Err(ErrorCode::UnsafePath);
    }
    Ok(())
}

pub fn profile() -> Result<PathBuf> {
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_Profile, SHGetKnownFolderPath},
    };
    let mut path = null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_Profile, 0, null_mut(), &mut path) } < 0 {
        return Err(ErrorCode::UnsafePath);
    }
    let result = unsafe { read_wide(path) }.map(PathBuf::from);
    unsafe { CoTaskMemFree(path.cast()) };
    result
}
pub fn same_process_user(pid: u32) -> bool {
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let Ok(current) = User::new() else { return false };
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return false;
    }
    let candidate = User::of_process(process);
    unsafe { CloseHandle(process) };
    candidate.is_ok_and(|candidate| unsafe { EqualSid(current.sid(), candidate.sid()) } != 0)
}
