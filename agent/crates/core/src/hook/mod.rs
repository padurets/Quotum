//! The user's explicit, shared consent for Claude's silent SessionStart helper.

mod capture;
mod files;
mod lifecycle;
mod settings;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;

pub use capture::run;
pub use lifecycle::{Lifecycle, Payload, Status};
#[cfg(windows)]
pub(crate) fn same_process_user(pid: u32) -> bool {
    windows::same_process_user(pid)
}
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    UnsafePath,
    UntrustedPayload,
    InvalidManifest,
    InvalidSettings,
    Conflict,
    Busy,
    FileFailure,
    NoEntry,
    NoAccess,
    UpdatePending,
    RemovePending,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnsafePath => "unsafe_path",
            Self::UntrustedPayload => "untrusted_payload",
            Self::InvalidManifest => "invalid_manifest",
            Self::InvalidSettings => "invalid_settings",
            Self::Conflict => "conflict",
            Self::Busy => "busy",
            Self::FileFailure => "file_failure",
            Self::NoEntry => "no_entry",
            Self::NoAccess => "no_access",
            Self::UpdatePending => "update_pending",
            Self::RemovePending => "remove_pending",
        })
    }
}

type Result<T> = std::result::Result<T, ErrorCode>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Stage {
    Installing,
    Enabled,
    Removing,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    installation_generation: String,
    stage: Stage,
    payload: PayloadManifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_payload: Option<PayloadManifest>,
    settings_target: PathBuf,
    entry: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<(PathBuf, serde_json::Value)>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PayloadManifest {
    schema_version: u8,
    version: String,
    platform: String,
    target: String,
    sha256: String,
}

fn uuid() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| ErrorCode::FileFailure)?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(
            |(i, b)| {
                if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }
            },
        )
}

fn helper_name() -> &'static str {
    if cfg!(windows) { "quotum-hook.exe" } else { "quotum-hook" }
}

/// These roots come from the OS account, independently of frontend profile overrides.
fn root() -> Result<PathBuf> {
    #[cfg(unix)]
    {
        Ok(account_home()?.join(".local/share/quotum/hooks"))
    }
    #[cfg(windows)]
    {
        Ok(windows::local_app_data()?.join("Quotum/hooks"))
    }
}

#[cfg(unix)]
fn account_home() -> Result<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result = std::ptr::null_mut();
    let mut bytes = vec![0u8; 64 * 1024];
    // SAFETY: fixed bounded storage and a valid passwd out pointer; copied before release.
    let status =
        unsafe { libc::getpwuid_r(libc::geteuid(), &mut entry, bytes.as_mut_ptr().cast(), bytes.len(), &mut result) };
    if status != 0 || result.is_null() || entry.pw_dir.is_null() {
        return Err(ErrorCode::UnsafePath);
    }
    let home = unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) };
    let path = PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes()));
    if !path.is_absolute() {
        return Err(ErrorCode::UnsafePath);
    }
    Ok(path)
}
