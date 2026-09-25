//! The settings the app changes: in the agent's own `config.toml`, the one file `quotum`
//! reads too, so what is set here holds for the command-line agent after the app quits.
//! Only the keys asked are changed; the person's comments, order and other keys stay, and
//! so do the file's permissions and a symbolic link in its place.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use quotum_core::config::Config;
use quotum_core::model::Provider;
use serde::Deserialize;
use toml_edit::{DocumentMut, Item, Table, value};

/// What the board may change: nothing else (not a client's path, not a hub).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    #[serde(default)]
    pub providers: BTreeMap<Provider, ProviderPatch>,
    pub sessions: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProviderPatch {
    pub enabled: Option<bool>,
    pub interval_s: Option<u64>,
    /// The name of the subscription (Antigravity); empty removes it.
    pub account: Option<String>,
}

/// `text` with the patch applied, checked as the agent checks the file when it reads it.
pub fn apply(text: &str, patch: &Patch) -> Result<String, String> {
    let mut doc: DocumentMut = text.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    if let Some(sessions) = patch.sessions {
        doc["sessions"] = value(sessions);
    }
    for (provider, change) in &patch.providers {
        if *change == ProviderPatch::default() {
            continue;
        }
        if doc.get("providers").is_none() {
            // Shown as [providers.<id>] tables, not as an empty [providers].
            let mut providers = Table::new();
            providers.set_implicit(true);
            doc.insert("providers", Item::Table(providers));
        }
        let providers = &mut doc["providers"];
        if providers.get(provider.id()).is_none() {
            providers[provider.id()] = Item::Table(Table::new());
        }
        let table = &mut providers[provider.id()];
        if let Some(enabled) = change.enabled {
            table["enabled"] = value(enabled);
        }
        if let Some(seconds) = change.interval_s {
            table["interval"] = value(i64::try_from(seconds).map_err(|_| "the interval is too long".to_string())?);
        }
        match change.account.as_deref().map(str::trim) {
            Some("") => {
                if let Some(table) = table.as_table_like_mut() {
                    table.remove("account");
                }
            }
            Some(name) => table["account"] = value(name),
            None => {}
        }
    }
    let text = doc.to_string();
    Config::parse(&text)?;
    Ok(text)
}

/// Changes the settings file at `path` (created, with its directory, if there is none).
pub fn save(path: &Path, patch: &Patch) -> Result<(), String> {
    let at = |e: io::Error, file: &Path| format!("{}: {e}", file.display());
    // A link stays a link: what it points to is written.
    let target = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path).map_err(|e| at(e, path))?,
        _ => path.to_path_buf(),
    };
    let text = match fs::read_to_string(&target) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(at(e, &target)),
    };
    let text = apply(&text, patch).map_err(|e| format!("{}: {e}", target.display()))?;
    if let Some(dir) = target.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir).map_err(|e| at(e, dir))?;
    }
    write_replacing(&target, &text).map_err(|e| at(e, &target))
}

/// Writes a new file next to `target` and puts it in its place, with the old one's
/// permissions. A new file is private on Unix and inherits its folder's ACL on Windows.
fn write_replacing(target: &Path, text: &str) -> io::Result<()> {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let next: PathBuf = target.with_file_name(format!(".{name}.quotum-app.new"));
    fs::write(&next, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(target).map(|m| m.permissions().mode() & 0o7777).unwrap_or(0o600);
        fs::set_permissions(&next, fs::Permissions::from_mode(mode))?;
    }
    replace(&next, target).inspect_err(|_| {
        // ReplaceFile can fail after removing the old name. Keep the new data then.
        if target.exists() {
            let _ = fs::remove_file(&next);
        }
    })
}

#[cfg(not(windows))]
fn replace(next: &Path, target: &Path) -> io::Result<()> {
    fs::rename(next, target)
}

#[cfg(windows)]
fn replace(next: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !target.try_exists()? {
        return fs::rename(next, target);
    }
    let wide = |path: &Path| path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let (next, target) = (wide(next), wide(target));
    // Rename replaces the file's ACL with the temporary file's inherited ACL.
    // ReplaceFile preserves it; do not ignore an error merging those permissions.
    let replaced = unsafe {
        ReplaceFileW(target.as_ptr(), next.as_ptr(), std::ptr::null(), 0, std::ptr::null(), std::ptr::null())
    };
    if replaced == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(json: &str) -> Patch {
        serde_json::from_str(json).unwrap()
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quotum-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_the_keys_asked_change_and_the_persons_comments_stay() {
        let text = "# mine\ninterval = 300 # five minutes\n\n[hub]\nurl = \"https://q.example\"\ntoken = \"t\"\n\n[providers.codex]\n# keep\nenabled = true\npath = \"/opt/codex\"\n";
        let changed = apply(
            text,
            &patch(r#"{"sessions":false,"providers":{"codex":{"enabled":false,"intervalS":600},"antigravity":{"account":"work"}}}"#),
        )
        .unwrap();
        assert!(changed.starts_with("# mine\ninterval = 300 # five minutes\n"), "{changed}");
        assert!(changed.contains("# keep\nenabled = false\npath = \"/opt/codex\"\ninterval = 600"), "{changed}");
        assert!(changed.contains("[providers.antigravity]\naccount = \"work\""), "{changed}");
        let config = Config::parse(&changed).unwrap();
        assert!(!config.sessions() && !config.enabled(Provider::Codex));
        assert_eq!(config.hub.unwrap().url, "https://q.example");
        let cleared = apply(&changed, &patch(r#"{"providers":{"antigravity":{"account":" "}}}"#)).unwrap();
        assert_eq!(Config::parse(&cleared).unwrap().account_name(Provider::Antigravity), None);
    }

    #[test]
    fn what_the_agent_would_refuse_is_not_written() {
        assert!(apply("", &patch(r#"{"providers":{"claude":{"intervalS":30}}}"#)).unwrap_err().contains("interval"));
        assert!(serde_json::from_str::<Patch>(r#"{"providers":{"claude":{"path":"/tmp/x"}}}"#).is_err(), "no path");
        assert!(serde_json::from_str::<Patch>(r#"{"hub":{"url":"x"}}"#).is_err(), "no hub");
        assert!(serde_json::from_str::<Patch>(r#"{"providers":{"cursor":{"enabled":true}}}"#).is_err());
    }

    #[test]
    fn an_inline_table_of_providers_is_changed_in_place() {
        let changed = apply(
            "providers = { claude = { enabled = true } }\n",
            &patch(r#"{"providers":{"claude":{"enabled":false}}}"#),
        )
        .unwrap();
        assert!(!Config::parse(&changed).unwrap().enabled(Provider::Claude), "{changed}");
    }

    #[test]
    fn a_missing_file_and_directory_are_created_with_the_keys_asked_only() {
        let dir = temp("new");
        let file = dir.join("quotum/config.toml");
        save(&file, &patch(r#"{"sessions":true,"providers":{"claude":{"enabled":false}}}"#)).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text, "sessions = true\n\n[providers.claude]\nenabled = false\n");
        assert!(Config::parse(&text).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn permissions_and_a_link_in_place_of_the_file_stay() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("unix");
        let real = dir.join("dotfiles-config.toml");
        fs::write(&real, "sessions = true\n").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("config.toml");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        save(&link, &patch(r#"{"sessions":false}"#)).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "still a link");
        assert_eq!(fs::read_to_string(&real).unwrap(), "sessions = false\n");
        assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_files_explicit_acl_stays_when_settings_change() {
        let dir = temp("windows-acl");
        let file = dir.join("config.toml");
        fs::write(&file, "# keep\nsessions = true\n").unwrap();
        let acl = |protect: bool| {
            let script = if protect {
                "$a=[IO.File]::GetAccessControl($env:QUOTUM_TEST_FILE); $a.SetAccessRuleProtection($true,$true); [IO.File]::SetAccessControl($env:QUOTUM_TEST_FILE,$a); [IO.File]::GetAccessControl($env:QUOTUM_TEST_FILE).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)"
            } else {
                "[IO.File]::GetAccessControl($env:QUOTUM_TEST_FILE).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)"
            };
            let output = std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &format!("$ErrorActionPreference='Stop'; {script}"),
                ])
                .env("QUOTUM_TEST_FILE", &file)
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            output.stdout
        };
        let before = acl(true);
        save(&file, &patch(r#"{"sessions":false}"#)).unwrap();
        assert_eq!(acl(false), before, "the protected ACL must survive replacement");
        assert_eq!(fs::read_to_string(&file).unwrap(), "# keep\nsessions = false\n");
        fs::remove_dir_all(dir).unwrap();
    }
}
