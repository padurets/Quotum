//! Store access runs on the serialized worker, never on a UI or async-runtime thread.
use super::{ErrorCode, Kek, KeyRef, Kind};
#[cfg(windows)]
use keyring_core::{Entry, api::CredentialStoreApi};
#[cfg(windows)]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod linux;

pub struct Store {
    #[cfg(windows)]
    service: String,
    prefix: String,
    #[cfg(target_os = "linux")]
    inner: linux::Native,
    #[cfg(windows)]
    inner: std::sync::Arc<windows_native_keyring_store::Store>,
}
pub trait StorePort: Send {
    fn writable(&self) -> Result<(), ErrorCode> {
        Ok(())
    }
    fn read(&self, name: &str) -> Result<Kek, ErrorCode>;
    fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode>;
    fn names(&self) -> Result<Vec<String>, ErrorCode>;
    fn remove(&self, value: &KeyRef) -> Result<(), ErrorCode>;
}
impl StorePort for Store {
    fn writable(&self) -> Result<(), ErrorCode> {
        self.writable()
    }
    fn read(&self, name: &str) -> Result<Kek, ErrorCode> {
        self.read(name)
    }
    fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode> {
        self.create(name, key)
    }
    fn names(&self) -> Result<Vec<String>, ErrorCode> {
        self.names()
    }
    fn remove(&self, value: &KeyRef) -> Result<(), ErrorCode> {
        self.remove(value)
    }
}
impl Store {
    fn writable(&self) -> Result<(), ErrorCode> {
        #[cfg(target_os = "linux")]
        {
            self.inner.writable()
        }
        #[cfg(windows)]
        {
            Ok(())
        }
    }
    pub fn new(hash: &str) -> Result<Self, ErrorCode> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(ErrorCode::MetadataInvalid);
        }
        #[cfg(target_os = "linux")]
        let inner = linux::Native::new(hash)?;
        #[cfg(windows)]
        let inner = windows_native_keyring_store::Store::new().map_err(classify)?;
        Ok(Self {
            #[cfg(windows)]
            service: format!("quotum-kek@{hash}"),
            prefix: format!("hub-secret-key@{hash}#"),
            inner,
        })
    }
    #[cfg(windows)]
    fn entry(&self, name: &str) -> Result<Entry, ErrorCode> {
        if number(&self.prefix, name).is_none() {
            return Err(ErrorCode::MetadataInvalid);
        }
        #[cfg(windows)]
        let entry =
            self.inner.build(&self.service, name, Some(&HashMap::from([("target", name), ("persistence", "Local")])));
        entry.map_err(classify)
    }
    pub fn read(&self, name: &str) -> Result<Kek, ErrorCode> {
        if number(&self.prefix, name).is_none() {
            return Err(ErrorCode::MetadataInvalid);
        }
        #[cfg(target_os = "linux")]
        {
            self.inner.read(name)
        }
        #[cfg(windows)]
        {
            let mut bytes = self.entry(name)?.get_secret().map_err(classify)?;
            let result = Kek::parse(&bytes);
            bytes.fill(0);
            result
        }
    }
    pub fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode> {
        if number(&self.prefix, name).is_none() {
            return Err(ErrorCode::MetadataInvalid);
        }
        #[cfg(target_os = "linux")]
        {
            self.inner.create(name, key)
        }
        #[cfg(windows)]
        {
            self.writable()?;
            let entry = self.entry(name)?;
            match entry.get_secret() {
                Err(keyring_core::Error::NoEntry) => {}
                Ok(mut bytes) => {
                    bytes.fill(0);
                    return Err(ErrorCode::MetadataInvalid);
                }
                Err(error) => return Err(classify(error)),
            }
            let mut bytes = key.encoded().into_bytes();
            let written = entry.set_secret(&bytes);
            bytes.fill(0);
            written.map_err(classify)?;
            let read = self.read(name)?;
            if read.bytes != key.bytes {
                return Err(ErrorCode::StoreFailure);
            }
            Ok(())
        }
    }
    pub fn names(&self) -> Result<Vec<String>, ErrorCode> {
        #[cfg(target_os = "linux")]
        {
            self.inner.names(&self.prefix)
        }
        #[cfg(windows)]
        {
            super::windows::names(&self.prefix)
        }
    }
    pub fn remove(&self, value: &KeyRef) -> Result<(), ErrorCode> {
        if value.kind != Kind::Keystore || number(&self.prefix, &value.name).is_none() {
            return Err(ErrorCode::MetadataInvalid);
        }
        #[cfg(target_os = "linux")]
        {
            self.inner.remove(&value.name)
        }
        #[cfg(windows)]
        {
            match self.entry(&value.name)?.delete_credential() {
                Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
                Err(error) => Err(classify(error)),
            }
        }
    }
}

pub fn number(prefix: &str, name: &str) -> Option<u64> {
    let value = name.strip_prefix(prefix)?;
    if value.is_empty() || value.starts_with('0') || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|n| *n > 0)
}

#[cfg(any(windows, test))]
fn classify(error: keyring_core::Error) -> ErrorCode {
    match error {
        keyring_core::Error::NoEntry => ErrorCode::NoEntry,
        keyring_core::Error::NoStorageAccess(_) => ErrorCode::NoAccess,
        keyring_core::Error::Ambiguous(_) => ErrorCode::Ambiguous,
        keyring_core::Error::NoDefaultStore | keyring_core::Error::NotSupportedByStore(_) => ErrorCode::Unavailable,
        keyring_core::Error::BadEncoding(mut bytes) | keyring_core::Error::BadDataFormat(mut bytes, _) => {
            bytes.fill(0);
            ErrorCode::InvalidBytes
        }
        _ => ErrorCode::StoreFailure,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use sha2::Digest;
    #[test]
    fn byte_bearing_errors_and_namespace_failures_are_only_codes() {
        assert_eq!(classify(keyring_core::Error::BadEncoding(vec![255, 0])), ErrorCode::InvalidBytes);
        assert_eq!(classify(keyring_core::Error::NoEntry), ErrorCode::NoEntry);
        assert_eq!(number("own#", "own#1"), Some(1));
        for invalid in ["foreign#1", "own#01", "own#0", "own#-1", "own#18446744073709551616"] {
            assert_eq!(number("own#", invalid), None);
        }
    }
    /// Explicit isolated namespace only, never part of ordinary tests or a user's store.
    #[test]
    #[ignore = "requires an explicitly initialized native test store"]
    fn native_store_is_local_scoped_byte_safe_and_recovers_without_pointer() {
        assert_eq!(std::env::var("QUOTUM_KEYRING_SMOKE").ok().as_deref(), Some("1"));
        let hash: String =
            sha2::Sha256::digest(format!("quotum-native-test-{}-{}", std::process::id(), getrandom::u64().unwrap()))
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
        let other_hash: String =
            sha2::Sha256::digest(format!("{hash}other")).iter().map(|b| format!("{b:02x}")).collect();
        let store = Store::new(&hash).unwrap();
        let other = Store::new(&other_hash).unwrap();
        let name = format!("hub-secret-key@{hash}#1");
        let second = format!("hub-secret-key@{other_hash}#1");
        assert!(matches!(store.read(&name), Err(ErrorCode::NoEntry)));
        let key = Kek::parse(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        store.create(&name, &key).unwrap();
        other.create(&second, &key).unwrap();
        assert_eq!(store.read(&name).unwrap().fingerprint(), key.fingerprint());
        assert_eq!(store.names().unwrap(), vec![name.clone()]);
        assert_eq!(other.names().unwrap(), vec![second.clone()]);
        #[cfg(windows)]
        {
            assert!(
                store
                    .entry(&name)
                    .unwrap()
                    .get_attributes()
                    .unwrap()
                    .get("persistence")
                    .is_some_and(|p| p.eq_ignore_ascii_case("Local"))
            );
            assert!(
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["keys::store::tests::native_windows_reads_in_a_new_process", "--ignored", "--exact"])
                    .env("QUOTUM_TEST_KEY_HASH", &hash)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        #[cfg(windows)]
        store.entry(&name).unwrap().set_secret(&[255, 0, 255]).unwrap();
        #[cfg(target_os = "linux")]
        store.inner.set_for_test(&name, &[255, 0, 255]).unwrap();
        assert!(matches!(store.read(&name), Err(ErrorCode::InvalidBytes)));
        store.remove(&KeyRef { kind: Kind::Keystore, name: name.clone() }).unwrap();
        other.remove(&KeyRef { kind: Kind::Keystore, name: second }).unwrap();
        assert!(matches!(store.read(&name), Err(ErrorCode::NoEntry)));
        assert!(store.names().unwrap().is_empty());
    }
    #[test]
    #[cfg(windows)]
    #[ignore = "called by the isolated store smoke with its own namespace"]
    fn native_windows_reads_in_a_new_process() {
        assert_eq!(std::env::var("QUOTUM_KEYRING_SMOKE").ok().as_deref(), Some("1"));
        let hash = std::env::var("QUOTUM_TEST_KEY_HASH").unwrap();
        let store = Store::new(&hash).unwrap();
        let name = format!("hub-secret-key@{hash}#1");
        assert_eq!(store.read(&name).unwrap().fingerprint(), "fb5238eccc6095ae");
        assert_eq!(store.names().unwrap(), vec![name]);
    }
    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "requires an isolated closed native store"]
    fn native_store_waits_for_a_closed_or_absent_default_collection() {
        assert_eq!(std::env::var("QUOTUM_KEYRING_SMOKE").ok().as_deref(), Some("1"));
        let hash: String =
            sha2::Sha256::digest(format!("quotum-closed-store-{}-{}", std::process::id(), getrandom::u64().unwrap()))
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
        match Store::new(&hash) {
            Ok(store) => {
                assert_eq!(store.writable(), Err(ErrorCode::NoAccess));
                let name = format!("hub-secret-key@{hash}#1");
                let key = Kek::parse(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
                assert_eq!(store.create(&name, &key), Err(ErrorCode::NoAccess));
            }
            Err(ErrorCode::NoAccess | ErrorCode::StoreFailure) => {}
            _ => panic!("a closed or absent default must not look writable"),
        }
    }
}
