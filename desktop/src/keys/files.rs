//! A separate, private namespace. Every file is checked through its opened handle.
use super::{ErrorCode, Kek, KeyRef, Kind, Marker};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Files {
    pub hash: String,
    pub root: PathBuf,
}
pub trait FilePort: Send + Sync {
    fn hash(&self) -> &str;
    fn number(&self, name: &str) -> Option<u64>;
    fn name(&self, number: u64) -> Result<String, ErrorCode>;
    fn marker(&self) -> Result<Option<Marker>, ErrorCode>;
    fn save(&self, marker: &Marker) -> Result<(), ErrorCode>;
    fn names(&self) -> Result<Vec<String>, ErrorCode>;
    fn read(&self, name: &str) -> Result<Kek, ErrorCode>;
    fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode>;
    fn reserve(&self, name: &str) -> Result<(), ErrorCode>;
    fn remove(&self, value: &KeyRef) -> Result<(), ErrorCode>;
}
impl FilePort for Files {
    fn hash(&self) -> &str {
        &self.hash
    }
    fn number(&self, name: &str) -> Option<u64> {
        self.number(name)
    }
    fn name(&self, number: u64) -> Result<String, ErrorCode> {
        self.name(number)
    }
    fn marker(&self) -> Result<Option<Marker>, ErrorCode> {
        self.marker()
    }
    fn save(&self, marker: &Marker) -> Result<(), ErrorCode> {
        self.save(marker)
    }
    fn names(&self) -> Result<Vec<String>, ErrorCode> {
        self.names()
    }
    fn read(&self, name: &str) -> Result<Kek, ErrorCode> {
        self.read(name)
    }
    fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode> {
        self.create(name, key)
    }
    fn reserve(&self, name: &str) -> Result<(), ErrorCode> {
        self.reserve(name)
    }
    fn remove(&self, value: &KeyRef) -> Result<(), ErrorCode> {
        self.remove(value)
    }
}
impl Files {
    pub fn new(app: &Path) -> Result<Self, ErrorCode> {
        let canonical = fs::canonicalize(app).map_err(|_| ErrorCode::UnsafePath)?;
        #[cfg(unix)]
        let representation = {
            use std::os::unix::ffi::OsStrExt;
            canonical.as_os_str().as_bytes().to_vec()
        };
        #[cfg(windows)]
        let representation = {
            use std::os::windows::ffi::OsStrExt;
            canonical.as_os_str().encode_wide().flat_map(u16::to_le_bytes).collect::<Vec<_>>()
        };
        let hash: String = Sha256::digest(&representation).iter().map(|byte| format!("{byte:02x}")).collect();
        let parent = canonical.parent().ok_or(ErrorCode::UnsafePath)?;
        let base = parent.join("com.padurets.quotum-keys");
        private_directory(&base)?;
        let root = base.join(&hash);
        private_directory(&root)?;
        Ok(Self { hash, root })
    }
    pub fn number(&self, name: &str) -> Option<u64> {
        let number = name.strip_prefix(&format!("hub-secret-key@{}#", self.hash))?;
        if number.starts_with('0') || number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        number.parse::<u64>().ok().filter(|n| *n > 0)
    }
    pub fn name(&self, number: u64) -> Result<String, ErrorCode> {
        if number == 0 {
            return Err(ErrorCode::Overflow);
        }
        Ok(format!("hub-secret-key@{}#{number}", self.hash))
    }
    pub fn validate_ref(&self, value: &KeyRef) -> Result<(), ErrorCode> {
        self.number(&value.name).map(|_| ()).ok_or(ErrorCode::MetadataInvalid)
    }
    pub fn marker(&self) -> Result<Option<Marker>, ErrorCode> {
        let mut file = match open(&self.root.join("marker.json"), false) {
            Err(ErrorCode::NoEntry) => return Ok(None),
            other => other?,
        };
        let mut bytes = Vec::new();
        Read::by_ref(&mut file).take(32 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| ErrorCode::FileFailure)?;
        if bytes.len() > 32 * 1024 {
            return Err(ErrorCode::MetadataInvalid);
        }
        let marker: Marker = serde_json::from_slice(&bytes).map_err(|_| ErrorCode::MetadataInvalid)?;
        if marker.version != 1 || marker.previous.len() > 128 {
            return Err(ErrorCode::MetadataInvalid);
        }
        for value in
            std::iter::once(&marker.current).chain(marker.next.iter()).chain(marker.previous.iter().map(|p| &p.r#ref))
        {
            self.validate_ref(value)?;
        }
        for previous in &marker.previous {
            if [&previous.from, &previous.to]
                .iter()
                .any(|fp| fp.len() != 16 || !fp.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
                || previous.from == previous.to
            {
                return Err(ErrorCode::MetadataInvalid);
            }
        }
        Ok(Some(marker))
    }
    pub fn save(&self, marker: &Marker) -> Result<(), ErrorCode> {
        let temporary = self.root.join(format!(
            "marker-{}.new",
            crate::hub::base64url(&getrandom::u64().map_err(|_| ErrorCode::FileFailure)?.to_le_bytes())
        ));
        let mut file = open(&temporary, true)?;
        let bytes = serde_json::to_vec(marker).map_err(|_| ErrorCode::MetadataInvalid)?;
        let result = (|| {
            file.write_all(&bytes).map_err(|_| ErrorCode::FileFailure)?;
            file.sync_all().map_err(|_| ErrorCode::FileFailure)?;
            drop(file);
            fs::rename(&temporary, self.root.join("marker.json")).map_err(|_| ErrorCode::FileFailure)?;
            sync_directory(&self.root)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
    pub fn names(&self) -> Result<Vec<String>, ErrorCode> {
        check_chain(&self.root)?;
        let mut names = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|_| ErrorCode::FileFailure)? {
            let entry = entry.map_err(|_| ErrorCode::FileFailure)?;
            if let Some(name) = entry.file_name().to_str() {
                let name = name.strip_suffix(".reserved").unwrap_or(name);
                if self.number(name).is_some() {
                    names.push(name.to_owned());
                }
            }
        }
        Ok(names)
    }
    pub fn read(&self, name: &str) -> Result<Kek, ErrorCode> {
        if self.number(name).is_none() {
            return Err(ErrorCode::MetadataInvalid);
        }
        let file = open(&self.root.join(name), false)?;
        let mut bytes = Vec::new();
        file.take(44).read_to_end(&mut bytes).map_err(|_| ErrorCode::FileFailure)?;
        let key = Kek::parse(&bytes);
        bytes.fill(0);
        key
    }
    pub fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode> {
        if self.number(name).is_none() {
            return Err(ErrorCode::MetadataInvalid);
        }
        let mut file = open(&self.root.join(name), true)?;
        let mut bytes = key.encoded().into_bytes();
        let written = file.write_all(&bytes);
        bytes.fill(0);
        written.map_err(|_| ErrorCode::FileFailure)?;
        file.sync_all().map_err(|_| ErrorCode::FileFailure)?;
        sync_directory(&self.root)
    }
    /// An empty marker books the name before a system-store call can outlive this process.
    pub fn reserve(&self, name: &str) -> Result<(), ErrorCode> {
        if self.number(name).is_none() {
            return Err(ErrorCode::MetadataInvalid);
        }
        open(&self.root.join(format!("{name}.reserved")), true)?.sync_all().map_err(|_| ErrorCode::FileFailure)?;
        sync_directory(&self.root)
    }
    pub fn remove(&self, value: &KeyRef) -> Result<(), ErrorCode> {
        self.validate_ref(value)?;
        if value.kind != Kind::File {
            return Err(ErrorCode::MetadataInvalid);
        }
        let _checked = open(&self.root.join(&value.name), false)?;
        fs::remove_file(self.root.join(&value.name)).map_err(|_| ErrorCode::FileFailure)?;
        sync_directory(&self.root)
    }
}

#[cfg(unix)]
fn check_chain(path: &Path) -> Result<(), ErrorCode> {
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
#[cfg(unix)]
fn private_directory(path: &Path) -> Result<(), ErrorCode> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    check_chain(path.parent().ok_or(ErrorCode::UnsafePath)?)?;
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(ErrorCode::FileFailure),
    }
    let meta = fs::symlink_metadata(path).map_err(|_| ErrorCode::UnsafePath)?;
    if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(ErrorCode::UnsafePath);
    }
    check_chain(path)
}
#[cfg(unix)]
fn open(path: &Path, create: bool) -> Result<File, ErrorCode> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    check_chain(path.parent().ok_or(ErrorCode::UnsafePath)?)?;
    let file = OpenOptions::new()
        .read(!create)
        .write(create)
        .create_new(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(
            |e| if e.kind() == std::io::ErrorKind::NotFound { ErrorCode::NoEntry } else { ErrorCode::FileFailure },
        )?;
    let meta = file.metadata().map_err(|_| ErrorCode::FileFailure)?;
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(ErrorCode::UnsafePath);
    }
    Ok(file)
}
#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), ErrorCode> {
    File::open(path).and_then(|file| file.sync_all()).map_err(|_| ErrorCode::FileFailure)
}
#[cfg(windows)]
fn check_chain(path: &Path) -> Result<(), ErrorCode> {
    super::windows::check_chain(path)
}
#[cfg(windows)]
fn private_directory(path: &Path) -> Result<(), ErrorCode> {
    super::windows::private_directory(path)
}
#[cfg(windows)]
fn open(path: &Path, create: bool) -> Result<File, ErrorCode> {
    super::windows::open(path, create)
}
#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), ErrorCode> {
    Ok(())
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt, symlink};
    fn root() -> PathBuf {
        let parent = std::env::var_os("QUOTUM_TEST_PRIVATE_DIR").map(PathBuf::from).unwrap_or_else(|| {
            // Docker's unprivileged build user may have no writable home directory.
            std::env::var_os("CARGO_HOME").map(PathBuf::from).unwrap_or_else(|| {
                std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join(".cache")
            })
        });
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&parent).unwrap();
        let root = parent.join(format!("keys-files-{}-{}", std::process::id(), getrandom::u64().unwrap()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        root
    }
    #[test]
    fn identity_uses_canonical_path_and_files_are_private_and_never_overwritten() {
        let root = root();
        let app = root.join("app");
        fs::DirBuilder::new().mode(0o700).create(&app).unwrap();
        let files = Files::new(&app).unwrap();
        let alias = root.join("alias");
        symlink(&app, &alias).unwrap();
        assert_eq!(Files::new(&alias).unwrap().hash, files.hash);
        assert!(!files.root.starts_with(&app));
        assert_eq!(fs::metadata(&files.root).unwrap().mode() & 0o777, 0o700);
        let key = Kek::parse(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        let name = files.name(1).unwrap();
        files.create(&name, &key).unwrap();
        assert_eq!(fs::metadata(files.root.join(&name)).unwrap().mode() & 0o777, 0o600);
        assert!(files.create(&name, &key).is_err());
        assert_eq!(files.read(&name).unwrap().fingerprint(), key.fingerprint());
        fs::set_permissions(files.root.join(&name), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(files.read(&name), Err(ErrorCode::UnsafePath)));
        fs::set_permissions(files.root.join(&name), fs::Permissions::from_mode(0o600)).unwrap();
        let link = files.name(2).unwrap();
        symlink(files.root.join(&name), files.root.join(&link)).unwrap();
        assert!(files.read(&link).is_err());
        assert!(files.create(&link, &key).is_err());
        assert!(files.read("../outside").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn marker_has_no_key_and_discovery_keeps_invalid_bytes_as_a_safe_error() {
        let root = root();
        let app = root.join("app");
        fs::DirBuilder::new().mode(0o700).create(&app).unwrap();
        let files = Files::new(&app).unwrap();
        let name = files.name(1).unwrap();
        let key = Kek::parse(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        files.create(&name, &key).unwrap();
        let marker = Marker {
            version: 1,
            current: KeyRef { kind: Kind::File, name: name.clone() },
            next: None,
            previous: Vec::new(),
            was_file: true,
        };
        files.save(&marker).unwrap();
        assert!(
            !fs::read(files.root.join("marker.json"))
                .unwrap()
                .windows(43)
                .any(|bytes| bytes == key.encoded().as_bytes())
        );
        assert_eq!(files.marker().unwrap().unwrap().current, marker.current);
        fs::write(files.root.join(&name), [255, 0, 255]).unwrap();
        assert!(matches!(files.read(&name), Err(ErrorCode::InvalidBytes)));
        assert!(files.names().unwrap().contains(&name));
        fs::remove_dir_all(root).unwrap();
    }
}
