//! Scoped native discovery and private file handles; never enumerate another namespace.
use super::{ErrorCode, store::number};
use std::fs::File;
use std::os::windows::{
    ffi::OsStrExt,
    fs::MetadataExt,
    io::{AsRawHandle, FromRawHandle},
};
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_NOT_FOUND, GetLastError, HANDLE,
        INVALID_HANDLE_VALUE, LocalFree,
    },
    Security::{
        ACCESS_ALLOWED_ACE, ACL,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
            SE_FILE_OBJECT,
        },
        Credentials::{CREDENTIALW, CredEnumerateW, CredFree},
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetTokenInformation, INHERIT_ONLY_ACE, IsWellKnownSid,
        LookupAccountNameW, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    },
    Storage::FileSystem::{
        CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

pub fn names(prefix: &str) -> Result<Vec<String>, ErrorCode> {
    let filter: Vec<u16> = format!("{prefix}*\0").encode_utf16().collect();
    let mut count = 0;
    let mut array: *mut *mut CREDENTIALW = null_mut();
    if unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut array) } == 0 {
        return if unsafe { GetLastError() } == ERROR_NOT_FOUND { Ok(Vec::new()) } else { Err(ErrorCode::NoAccess) };
    }
    struct Credentials {
        count: u32,
        array: *mut *mut CREDENTIALW,
    }
    impl Drop for Credentials {
        fn drop(&mut self) {
            if self.array.is_null() {
                return;
            }
            unsafe {
                for i in 0..self.count {
                    let credential = *self.array.add(i as usize);
                    if !credential.is_null() && !(*credential).CredentialBlob.is_null() {
                        std::ptr::write_bytes(
                            (*credential).CredentialBlob,
                            0,
                            (*credential).CredentialBlobSize as usize,
                        );
                    }
                }
                CredFree(self.array.cast());
            }
        }
    }
    let owned = Credentials { count, array };
    if count > 10_000 || array.is_null() {
        return Err(ErrorCode::StoreFailure);
    }
    let mut names = Vec::new();
    for i in 0..count {
        let credential = unsafe { *owned.array.add(i as usize) };
        if credential.is_null() {
            return Err(ErrorCode::StoreFailure);
        }
        let name = unsafe { read_wide((*credential).TargetName)? };
        if number(prefix, &name).is_some() {
            names.push(name);
        }
    }
    Ok(names)
}
unsafe fn read_wide(pointer: *const u16) -> Result<String, ErrorCode> {
    if pointer.is_null() {
        return Err(ErrorCode::StoreFailure);
    }
    let mut length = 0;
    while length < 1024 && unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    if length == 1024 {
        return Err(ErrorCode::StoreFailure);
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, length) }).map_err(|_| ErrorCode::StoreFailure)
}
fn wide(path: &Path) -> Result<Vec<u16>, ErrorCode> {
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
    fn new() -> Result<Self, ErrorCode> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
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
    fn descriptor(&self) -> Result<Descriptor, ErrorCode> {
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
fn check_handle(file: &File, private: bool) -> Result<(), ErrorCode> {
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
    // Ancestors may allow creating a new child, but never replacing a protected one.
    let forbidden = if private {
        0x1000_0000 | 0x8000_0000 | 0x4000_0000 | 0x000d_0000 | 0x0043
    } else {
        0x1000_0000 | 0x4000_0000 | 0x000d_0000 | 0x0040
    };
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
fn handle(path: &Path, create: bool, descriptor: Option<&Descriptor>) -> Result<File, ErrorCode> {
    let name = wide(path)?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.map(|d| d.0).unwrap_or(null_mut()),
        bInheritHandle: 0,
    };
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            if create { 0x4000_0000 | READ_CONTROL } else { 0x8000_0000 | READ_CONTROL },
            FILE_SHARE_READ | FILE_SHARE_WRITE,
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
pub fn check_chain(path: &Path) -> Result<(), ErrorCode> {
    for ancestor in path.ancestors() {
        let file = handle(ancestor, false, None)?;
        if !file.metadata().map_err(|_| ErrorCode::UnsafePath)?.is_dir() {
            return Err(ErrorCode::UnsafePath);
        }
        check_handle(&file, false)?;
    }
    Ok(())
}
pub fn private_directory(path: &Path) -> Result<(), ErrorCode> {
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
    let file = handle(path, false, None)?;
    if !file.metadata().map_err(|_| ErrorCode::UnsafePath)?.is_dir() {
        return Err(ErrorCode::UnsafePath);
    }
    check_handle(&file, true)
}
pub fn open(path: &Path, create: bool) -> Result<File, ErrorCode> {
    check_chain(path.parent().ok_or(ErrorCode::UnsafePath)?)?;
    let descriptor = if create { Some(User::new()?.descriptor()?) } else { None };
    let file = handle(path, create, descriptor.as_ref())?;
    if !file.metadata().map_err(|_| ErrorCode::UnsafePath)?.is_file() {
        return Err(ErrorCode::UnsafePath);
    }
    check_handle(&file, true)?;
    Ok(file)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::keys::{Kek, files::Files};
    use std::process::Command;

    #[test]
    fn native_files_have_private_acl_reject_public_reads_and_junctions() {
        let parent = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap());
        let root = parent.join(format!("quotum-key-test-{}-{}", std::process::id(), getrandom::u64().unwrap()));
        private_directory(&root).unwrap_or_else(|code| {
            // This runs before the test has generated or read any key.
            for ancestor in root.parent().unwrap().ancestors() {
                let _ = Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-Command",
                        "Get-Acl -LiteralPath $env:QUOTUM_TEST_PATH_DIAGNOSTIC | Format-List Path,Owner,AccessToString",
                    ])
                    .env("QUOTUM_TEST_PATH_DIAGNOSTIC", ancestor)
                    .status();
            }
            panic!("private test directory refused: {code:?}");
        });
        let app = root.join("app");
        private_directory(&app).unwrap();
        let files = Files::new(&app).unwrap();
        let name = files.name(1).unwrap();
        let key = Kek::parse(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        files.create(&name, &key).unwrap();
        assert_eq!(files.read(&name).unwrap().fingerprint(), key.fingerprint());
        assert!(files.create(&name, &key).is_err());
        let path = files.root.join(&name);
        assert!(Command::new("icacls").arg(&path).args(["/grant", "*S-1-1-0:(R)"]).status().unwrap().success());
        assert!(matches!(files.read(&name), Err(ErrorCode::UnsafePath)));
        assert!(Command::new("icacls").arg(&path).args(["/remove:g", "*S-1-1-0"]).status().unwrap().success());
        assert!(files.read(&name).is_ok());
        let junction = root.join("junction");
        assert!(
            Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&junction)
                .arg(&files.root)
                .status()
                .unwrap()
                .success()
        );
        assert!(matches!(check_chain(&junction), Err(ErrorCode::UnsafePath)));
        assert!(Command::new("cmd").args(["/c", "rmdir"]).arg(&junction).status().unwrap().success());
        std::fs::remove_dir_all(root).unwrap();
    }
}
