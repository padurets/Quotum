//! Store access runs on the serialized worker, never on a UI or async-runtime thread.
use super::{ErrorCode, Kek, KeyRef, Kind};
use keyring_core::Entry;
use keyring_core::api::CredentialStoreApi;
use std::collections::HashMap;

pub struct Store {
    service: String,
    prefix: String,
    #[cfg(target_os = "linux")]
    inner: std::sync::Arc<zbus_secret_service_keyring_store::Store>,
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
            let connection = zbus::blocking::Connection::session().map_err(|_| ErrorCode::NoAccess)?;
            let service = zbus::blocking::Proxy::new(
                &connection,
                "org.freedesktop.secrets",
                "/org/freedesktop/secrets",
                "org.freedesktop.Secret.Service",
            )
            .map_err(|_| ErrorCode::NoAccess)?;
            let path: zbus::zvariant::OwnedObjectPath =
                service.call("ReadAlias", &("default",)).map_err(|_| ErrorCode::NoAccess)?;
            if path.as_str() == "/" {
                return Err(ErrorCode::NoAccess);
            }
            let collection = zbus::blocking::Proxy::new(
                &connection,
                "org.freedesktop.secrets",
                path.as_str(),
                "org.freedesktop.Secret.Collection",
            )
            .map_err(|_| ErrorCode::NoAccess)?;
            if collection.get_property::<bool>("Locked").map_err(|_| ErrorCode::NoAccess)? {
                return Err(ErrorCode::NoAccess);
            }
        }
        Ok(())
    }
    pub fn new(hash: &str) -> Result<Self, ErrorCode> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(ErrorCode::MetadataInvalid);
        }
        #[cfg(target_os = "linux")]
        let inner = {
            preflight()?;
            zbus_secret_service_keyring_store::Store::new().map_err(classify)?
        };
        #[cfg(windows)]
        let inner = windows_native_keyring_store::Store::new().map_err(classify)?;
        Ok(Self { service: format!("quotum-kek@{hash}"), prefix: format!("hub-secret-key@{hash}#"), inner })
    }
    fn entry(&self, name: &str) -> Result<Entry, ErrorCode> {
        if number(&self.prefix, name).is_none() {
            return Err(ErrorCode::MetadataInvalid);
        }
        #[cfg(windows)]
        let entry =
            self.inner.build(&self.service, name, Some(&HashMap::from([("target", name), ("persistence", "Local")])));
        #[cfg(target_os = "linux")]
        let entry = self.inner.build(&self.service, name, None);
        entry.map_err(classify)
    }
    pub fn read(&self, name: &str) -> Result<Kek, ErrorCode> {
        let mut bytes = self.entry(name)?.get_secret().map_err(classify)?;
        let result = Kek::parse(&bytes);
        bytes.fill(0);
        result
    }
    pub fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode> {
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
    pub fn names(&self) -> Result<Vec<String>, ErrorCode> {
        #[cfg(target_os = "linux")]
        {
            let entries = self.inner.search(&HashMap::from([("service", self.service.as_str())])).map_err(classify)?;
            let mut names = Vec::new();
            for entry in entries {
                let attrs = entry.get_attributes().map_err(classify)?;
                if attrs.get("service") != Some(&self.service) {
                    return Err(ErrorCode::StoreFailure);
                }
                if let Some(name) = attrs.get("username").filter(|name| number(&self.prefix, name).is_some()) {
                    names.push(name.clone());
                }
            }
            Ok(names)
        }
        #[cfg(windows)]
        {
            super::windows::names(&self.prefix)
        }
    }
    pub fn remove(&self, value: &KeyRef) -> Result<(), ErrorCode> {
        if value.kind != Kind::Keystore {
            return Err(ErrorCode::MetadataInvalid);
        }
        match self.entry(&value.name)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(classify(error)),
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

#[cfg(target_os = "linux")]
fn preflight() -> Result<(), ErrorCode> {
    use std::time::Duration;
    use zbus::blocking::fdo::DBusProxy;
    // Authoritative absence is the only error that permits a first-run file fallback.
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        return Err(ErrorCode::Unavailable);
    }
    let builder = zbus::connection::Builder::session().map_err(|_| ErrorCode::StoreFailure)?;
    let connection = zbus::block_on(async {
        tokio::time::timeout(Duration::from_secs(5), builder.method_timeout(Duration::from_secs(5)).build()).await
    })
    .map_err(|_| ErrorCode::Timeout)?
    .map_err(|_| ErrorCode::StoreFailure)?;
    let connection = zbus::blocking::Connection::from(connection);
    let proxy = DBusProxy::new(&connection).map_err(|_| ErrorCode::StoreFailure)?;
    let owned = proxy
        .name_has_owner(zbus::names::BusName::try_from("org.freedesktop.secrets").map_err(|_| ErrorCode::StoreFailure)?)
        .map_err(|_| ErrorCode::StoreFailure)?;
    let activatable = proxy
        .list_activatable_names()
        .map_err(|_| ErrorCode::StoreFailure)?
        .iter()
        .any(|name| name.as_str() == "org.freedesktop.secrets");
    if owned || activatable { Ok(()) } else { Err(ErrorCode::Unavailable) }
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
        store.entry(&name).unwrap().set_secret(&[255, 0, 255]).unwrap();
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
