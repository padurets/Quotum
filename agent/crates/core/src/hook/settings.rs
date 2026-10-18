//! Only the helper's exact handler is edited; other client configuration is opaque.
use super::{ErrorCode, Result, files};
use std::path::{Path, PathBuf};

pub(super) fn target() -> Result<PathBuf> {
    let directory = match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(value) => PathBuf::from(value),
        None => {
            #[cfg(unix)]
            {
                super::account_home()?.join(".claude")
            }
            #[cfg(windows)]
            {
                super::windows::profile()?.join(".claude")
            }
        }
    };
    if !directory.is_absolute() {
        return Err(ErrorCode::UnsafePath);
    }
    Ok(directory.join("settings.json"))
}
pub(super) fn canonical_target(path: &Path, create: bool) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(ErrorCode::UnsafePath);
    }
    let parent = path.parent().ok_or(ErrorCode::UnsafePath)?;
    if create {
        files::parents(parent)?;
    } else {
        files::chain(parent)?;
    }
    let target = if std::fs::symlink_metadata(path).is_ok() {
        std::fs::canonicalize(path).map_err(|_| ErrorCode::UnsafePath)?
    } else {
        let parent = path.parent().ok_or(ErrorCode::UnsafePath)?;
        if create {
            files::parents(parent)?;
        }
        files::chain(parent)?;
        std::fs::canonicalize(parent)
            .map_err(|_| ErrorCode::UnsafePath)?
            .join(path.file_name().ok_or(ErrorCode::UnsafePath)?)
    };
    files::chain(target.parent().ok_or(ErrorCode::UnsafePath)?)?;
    Ok(target)
}
fn read(path: &Path) -> Result<(Option<std::fs::File>, Vec<u8>, serde_json::Value)> {
    let file = match files::open(path, false, false, false) {
        Ok(file) => Some(file),
        Err(ErrorCode::NoEntry) => None,
        Err(e) => return Err(e),
    };
    let bytes = match &file {
        Some(file) => files::read_file(file, 1024 * 1024).map_err(|_| ErrorCode::InvalidSettings)?,
        None => Vec::new(),
    };
    let value = if file.is_none() {
        serde_json::json!({})
    } else {
        serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|_| ErrorCode::InvalidSettings)?
    };
    if !value.is_object() {
        return Err(ErrorCode::InvalidSettings);
    }
    Ok((file, bytes, value))
}
pub(super) fn contains(path: &Path, entry: &serde_json::Value) -> Result<bool> {
    if !path.try_exists().map_err(|_| ErrorCode::UnsafePath)? {
        return Ok(false);
    }
    let (_, _, value) = read(path)?;
    Ok(value.get("hooks").and_then(|v| v.get("SessionStart")).and_then(|v| v.as_array()).is_some_and(|groups| {
        groups
            .iter()
            .any(|group| group.get("hooks").and_then(|v| v.as_array()).is_some_and(|hooks| hooks.contains(entry)))
    }))
}
pub(super) fn edit(path: &Path, entry: &serde_json::Value, on: bool) -> Result<()> {
    if !on && !path.try_exists().map_err(|_| ErrorCode::UnsafePath)? {
        return Ok(());
    }
    let target = canonical_target(path, on)?;
    let (original, bytes, mut value) = read(&target)?;
    if !on && original.is_none() {
        return Ok(());
    }
    if on && value.get("hooks").is_none() {
        value["hooks"] = serde_json::json!({});
    }
    let Some(hooks) = value.get_mut("hooks") else { return Ok(()) };
    if !hooks.is_object() {
        return Err(ErrorCode::InvalidSettings);
    }
    if on && hooks.get("SessionStart").is_none() {
        hooks["SessionStart"] = serde_json::json!([]);
    }
    let Some(groups) = hooks.get_mut("SessionStart") else { return Ok(()) };
    let groups = groups.as_array_mut().ok_or(ErrorCode::InvalidSettings)?;
    let mut found = false;
    for group in groups.iter_mut() {
        let Some(handlers) = group.get_mut("hooks").and_then(|v| v.as_array_mut()) else { continue };
        if handlers.iter().any(|handler| handler.get("command") == entry.get("command") && handler != entry) {
            return Err(ErrorCode::Conflict);
        }
        if handlers.contains(entry) {
            found = true;
        }
        if !on {
            handlers.retain(|handler| handler != entry);
        }
    }
    if on && found || !on && !found {
        return Ok(());
    }
    if on {
        groups.push(serde_json::json!({"hooks":[entry]}));
    } else {
        groups.retain(|group| !group.get("hooks").and_then(|v| v.as_array()).is_some_and(|v| v.is_empty()));
        if groups.is_empty() {
            hooks.as_object_mut().unwrap().remove("SessionStart");
        }
        if hooks.as_object().is_some_and(|v| v.is_empty()) {
            value.as_object_mut().unwrap().remove("hooks");
        }
    }
    let output = serde_json::to_vec_pretty(&value).map_err(|_| ErrorCode::InvalidSettings)?;
    let mut temp = files::Temporary::new(&target)?;
    let file = temp.file.as_mut().ok_or(ErrorCode::FileFailure)?;
    use std::io::Write;
    file.write_all(&output).and_then(|_| file.sync_all()).map_err(|_| ErrorCode::FileFailure)?;
    #[cfg(unix)]
    if let Some(original) = &original {
        use std::os::{
            fd::AsRawFd,
            unix::fs::{MetadataExt, PermissionsExt},
        };
        let meta = original.metadata().map_err(|_| ErrorCode::FileFailure)?;
        if unsafe { libc::fchown(file.as_raw_fd(), meta.uid(), meta.gid()) } != 0 {
            return Err(ErrorCode::FileFailure);
        }
        file.set_permissions(std::fs::Permissions::from_mode(meta.mode() & 0o7777))
            .map_err(|_| ErrorCode::FileFailure)?;
    }
    #[cfg(windows)]
    super::windows::preserve_dacl(&temp.path, &target)?;
    if canonical_target(path, false)? != target {
        return Err(ErrorCode::Conflict);
    }
    match original {
        Some(original) => {
            files::same_name(&original, &target)?;
            if files::read(&target, 1024 * 1024, false)? != bytes {
                return Err(ErrorCode::Conflict);
            }
        }
        None => {
            if target.try_exists().map_err(|_| ErrorCode::FileFailure)? {
                return Err(ErrorCode::Conflict);
            }
        }
    }
    temp.file.take();
    files::replace(&temp.path, &target)?;
    files::sync_parent(&target)
}
