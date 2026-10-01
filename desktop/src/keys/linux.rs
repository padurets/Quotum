//! One owner-bound Secret Service session, cancellable when that owner goes away.
use super::super::{ErrorCode, Kek};
use futures_lite::{StreamExt, future};
use secret_service::{EncryptionType, Item, SecretService};
use std::{collections::HashMap, future::Future, time::Duration};
use zbus::{
    Connection,
    fdo::DBusProxy,
    names::{BusName, OwnedUniqueName, WellKnownName},
};

const SERVICE: &str = "org.freedesktop.secrets";

struct Bytes(Vec<u8>);
impl Drop for Bytes {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}
pub struct Native {
    connection: Connection,
    owner: OwnedUniqueName,
    inner: SecretService<'static>,
    service: String,
}
impl Native {
    pub fn new(hash: &str) -> Result<Self, ErrorCode> {
        let connection = connection()?;
        zbus::block_on(async {
            let dbus = DBusProxy::new(&connection).await.map_err(|_| ErrorCode::StoreFailure)?;
            let name = BusName::try_from(SERVICE).map_err(|_| ErrorCode::StoreFailure)?;
            let owner = dbus.get_name_owner(name).await.map_err(|_| ErrorCode::StoreFailure)?;
            let inner = guarded(&connection, &owner, async {
                SecretService::connect_with_existing_to(EncryptionType::Dh, connection.clone(), owner.clone())
                    .await
                    .map_err(classify)
            })
            .await?;
            Ok(Self { connection, owner, inner, service: format!("quotum-kek@{hash}") })
        })
    }
    fn run<T>(&self, operation: impl Future<Output = Result<T, ErrorCode>>) -> Result<T, ErrorCode> {
        zbus::block_on(guarded(&self.connection, &self.owner, operation))
    }
    async fn matches(&self, name: Option<&str>) -> Result<Vec<Item<'_>>, ErrorCode> {
        let mut attributes = HashMap::from([("service", self.service.as_str())]);
        if let Some(name) = name {
            attributes.insert("username", name);
        }
        let mut found = self.inner.search_items(attributes).await.map_err(classify)?;
        if !found.locked.is_empty() {
            let locked = found.locked.iter().collect::<Vec<_>>();
            self.inner.unlock_all(&locked).await.map_err(classify)?;
        }
        found.unlocked.extend(found.locked);
        Ok(found.unlocked)
    }
    async fn unique(&self, name: &str) -> Result<Item<'_>, ErrorCode> {
        let mut matches = self.matches(Some(name)).await?;
        match matches.len() {
            0 => Err(ErrorCode::NoEntry),
            1 => matches.pop().ok_or(ErrorCode::NoEntry),
            _ => Err(ErrorCode::Ambiguous),
        }
    }
    async fn read_inner(&self, name: &str) -> Result<Kek, ErrorCode> {
        let item = self.unique(name).await?;
        let bytes = Bytes(item.get_secret().await.map_err(classify)?);
        Kek::parse(&bytes.0)
    }
    pub fn read(&self, name: &str) -> Result<Kek, ErrorCode> {
        self.run(self.read_inner(name))
    }
    pub fn writable(&self) -> Result<(), ErrorCode> {
        self.run(async {
            let collection = self.inner.get_default_collection().await.map_err(classify)?;
            if collection.is_locked().await.map_err(classify)? { Err(ErrorCode::NoAccess) } else { Ok(()) }
        })
    }
    pub fn names(&self, prefix: &str) -> Result<Vec<String>, ErrorCode> {
        self.run(async {
            let mut names = Vec::new();
            for item in self.matches(None).await? {
                let attributes = item.get_attributes().await.map_err(classify)?;
                if attributes.get("service") != Some(&self.service) {
                    return Err(ErrorCode::StoreFailure);
                }
                if let Some(name) = attributes.get("username").filter(|name| super::number(prefix, name).is_some()) {
                    names.push(name.clone());
                }
            }
            Ok(names)
        })
    }
    pub fn create(&self, name: &str, key: &Kek) -> Result<(), ErrorCode> {
        self.run(async {
            let collection = self.inner.get_default_collection().await.map_err(classify)?;
            if collection.is_locked().await.map_err(classify)? {
                return Err(ErrorCode::NoAccess);
            }
            match self.unique(name).await {
                Err(ErrorCode::NoEntry) => {}
                Ok(item) => {
                    let _bytes = Bytes(item.get_secret().await.map_err(classify)?);
                    return Err(ErrorCode::MetadataInvalid);
                }
                Err(error) => return Err(error),
            }
            let bytes = Bytes(key.encoded().into_bytes());
            collection
                .create_item(
                    &format!("keyring:{name}@{}", self.service),
                    HashMap::from([("service", self.service.as_str()), ("username", name)]),
                    &bytes.0,
                    false,
                    "application/octet-stream",
                )
                .await
                .map_err(classify)?;
            let read = self.read_inner(name).await?;
            if read.bytes == key.bytes { Ok(()) } else { Err(ErrorCode::StoreFailure) }
        })
    }
    pub fn remove(&self, name: &str) -> Result<(), ErrorCode> {
        self.run(async {
            match self.unique(name).await {
                Ok(item) => item.delete().await.map_err(classify),
                Err(ErrorCode::NoEntry) => Ok(()),
                Err(error) => Err(error),
            }
        })
    }
    #[cfg(test)]
    pub fn set_for_test(&self, name: &str, bytes: &[u8]) -> Result<(), ErrorCode> {
        self.run(async {
            self.unique(name).await?.set_secret(bytes, "application/octet-stream").await.map_err(classify)
        })
    }
}
fn classify(error: secret_service::Error) -> ErrorCode {
    match error {
        secret_service::Error::Locked | secret_service::Error::NoResult | secret_service::Error::Prompt => {
            ErrorCode::NoAccess
        }
        secret_service::Error::Unavailable => ErrorCode::Unavailable,
        _ => ErrorCode::StoreFailure,
    }
}
async fn guarded<T>(
    connection: &Connection,
    owner: &OwnedUniqueName,
    operation: impl Future<Output = Result<T, ErrorCode>>,
) -> Result<T, ErrorCode> {
    let dbus = DBusProxy::new(connection).await.map_err(|_| ErrorCode::StoreFailure)?;
    let mut changes =
        dbus.receive_name_owner_changed_with_args(&[(0, SERVICE)]).await.map_err(|_| ErrorCode::StoreFailure)?;
    let name = BusName::try_from(SERVICE).map_err(|_| ErrorCode::StoreFailure)?;
    if dbus.get_name_owner(name.clone()).await.map_err(|_| ErrorCode::StoreFailure)? != *owner {
        let _ = connection.clone().close().await;
        return Err(ErrorCode::StoreFailure);
    }
    let (mut lost, mut result) = future::race(async { (false, operation.await) }, async {
        while let Some(signal) = changes.next().await {
            let Ok(args) = signal.args() else { break };
            if args.new_owner().as_ref().map(|name| name.as_str()) != Some(owner.as_str()) {
                break;
            }
        }
        (true, Err(ErrorCode::StoreFailure))
    })
    .await;
    if !lost && !dbus.get_name_owner(name).await.is_ok_and(|current| current == *owner) {
        lost = true;
        result = Err(ErrorCode::StoreFailure);
    }
    if lost {
        // The old future has been dropped before a later worker job can reconnect.
        let _ = connection.clone().close().await;
    }
    result
}
fn connection() -> Result<Connection, ErrorCode> {
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        return Err(ErrorCode::Unavailable);
    }
    let builder = zbus::connection::Builder::session().map_err(|_| ErrorCode::StoreFailure)?;
    let connection = zbus::block_on(async {
        tokio::time::timeout(Duration::from_secs(5), builder.method_timeout(Duration::from_secs(5)).build()).await
    })
    .map_err(|_| ErrorCode::Timeout)?
    .map_err(|_| ErrorCode::StoreFailure)?;
    let blocking = zbus::blocking::Connection::from(connection.clone());
    let dbus = zbus::blocking::fdo::DBusProxy::new(&blocking).map_err(|_| ErrorCode::StoreFailure)?;
    let name = BusName::try_from(SERVICE).map_err(|_| ErrorCode::StoreFailure)?;
    let owned = dbus.name_has_owner(name).map_err(|_| ErrorCode::StoreFailure)?;
    let activatable =
        dbus.list_activatable_names().map_err(|_| ErrorCode::StoreFailure)?.iter().any(|name| name.as_str() == SERVICE);
    if !owned {
        if !activatable {
            return Err(ErrorCode::Unavailable);
        }
        let name = WellKnownName::try_from(SERVICE).map_err(|_| ErrorCode::StoreFailure)?;
        dbus.start_service_by_name(name, 0).map_err(|_| ErrorCode::StoreFailure)?;
    }
    Ok(connection)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use zbus::object_server::SignalEmitter;
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

    const SERVICE_PATH: &str = "/org/freedesktop/secrets";
    const ITEM_PATH: &str = "/org/freedesktop/secrets/collection/fixture/7";
    const COLLECTION_PATH: &str = "/org/freedesktop/secrets/collection/fixture";
    const PROMPT_PATH: &str = "/org/freedesktop/secrets/prompt/fixture";
    #[derive(Default)]
    struct Calls {
        sessions: AtomicUsize,
        searches: AtomicUsize,
        collections: AtomicUsize,
        deletes: AtomicUsize,
        prompts: AtomicUsize,
    }
    struct Service(Arc<Calls>);
    #[zbus::interface(name = "org.freedesktop.Secret.Service")]
    impl Service {
        fn open_session(&self, _algorithm: &str, _input: Value<'_>) -> (OwnedValue, OwnedObjectPath) {
            self.0.sessions.fetch_add(1, Ordering::SeqCst);
            (OwnedValue::from(false), OwnedObjectPath::try_from("/org/freedesktop/secrets/session/fixture").unwrap())
        }
        fn search_items(&self, _attributes: HashMap<String, String>) -> (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) {
            self.0.searches.fetch_add(1, Ordering::SeqCst);
            (vec![OwnedObjectPath::try_from(ITEM_PATH).unwrap()], vec![])
        }
        fn read_alias(&self, _alias: &str) -> OwnedObjectPath {
            OwnedObjectPath::try_from(COLLECTION_PATH).unwrap()
        }
    }
    struct Record(Arc<Calls>);
    #[zbus::interface(name = "org.freedesktop.Secret.Item")]
    impl Record {
        #[zbus(property)]
        fn locked(&self) -> bool {
            false
        }
        fn delete(&self) -> OwnedObjectPath {
            self.0.deletes.fetch_add(1, Ordering::SeqCst);
            OwnedObjectPath::try_from(PROMPT_PATH).unwrap()
        }
    }
    struct Collection(Arc<Calls>);
    #[zbus::interface(name = "org.freedesktop.Secret.Collection")]
    impl Collection {
        #[zbus(property)]
        fn locked(&self) -> bool {
            false
        }
        fn delete(&self) -> OwnedObjectPath {
            self.0.collections.fetch_add(1, Ordering::SeqCst);
            OwnedObjectPath::try_from(PROMPT_PATH).unwrap()
        }
    }
    struct Prompt(Arc<Calls>);
    #[zbus::interface(name = "org.freedesktop.Secret.Prompt")]
    impl Prompt {
        async fn prompt(
            &self,
            _window_id: &str,
            #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
        ) -> zbus::fdo::Result<()> {
            self.0.prompts.fetch_add(1, Ordering::SeqCst);
            Self::completed(&emitter, false, Value::from(false))
                .await
                .map_err(|_| zbus::fdo::Error::Failed("fixture_signal_failed".into()))
        }
        #[zbus(signal)]
        async fn completed(emitter: &SignalEmitter<'_>, dismissed: bool, result: Value<'_>) -> zbus::Result<()>;
    }
    async fn backend(calls: Arc<Calls>) -> Connection {
        zbus::connection::Builder::session()
            .unwrap()
            .serve_at(SERVICE_PATH, Service(calls.clone()))
            .unwrap()
            .serve_at(ITEM_PATH, Record(calls.clone()))
            .unwrap()
            .serve_at(COLLECTION_PATH, Collection(calls.clone()))
            .unwrap()
            .serve_at(PROMPT_PATH, Prompt(calls))
            .unwrap()
            .build()
            .await
            .unwrap()
    }
    #[test]
    #[ignore = "requires a private D-Bus without a Secret Service owner"]
    fn an_old_item_path_never_deletes_the_replacement_owners_item() {
        assert_eq!(std::env::var("QUOTUM_TEST_DBUS_BINDING").ok().as_deref(), Some("1"));
        zbus::block_on(async {
            let connection = Connection::session().await.unwrap();
            let dbus = DBusProxy::new(&connection).await.unwrap();
            assert!(!dbus.name_has_owner(BusName::try_from(SERVICE).unwrap()).await.unwrap());
            let old_calls = Arc::new(Calls::default());
            let new_calls = Arc::new(Calls::default());
            let old = backend(old_calls.clone()).await;
            let new = backend(new_calls.clone()).await;
            old.request_name(SERVICE).await.unwrap();
            let session = SecretService::connect_with_existing_to(
                EncryptionType::Plain,
                connection.clone(),
                old.unique_name().unwrap().clone(),
            )
            .await
            .unwrap();
            let mut found = session.search_items(HashMap::from([("service", "quotum-owner-fixture")])).await.unwrap();
            let item = found.unlocked.pop().unwrap();
            old.release_name(SERVICE).await.unwrap();
            new.request_name(SERVICE).await.unwrap();
            // Deliberately omit the application's monitor: routing alone must be safe.
            let late_session = SecretService::connect_with_existing_to(
                EncryptionType::Plain,
                connection,
                old.unique_name().unwrap().clone(),
            )
            .await
            .unwrap();
            session.search_items(HashMap::from([("service", "quotum-owner-fixture")])).await.unwrap();
            let collection = late_session.get_default_collection().await.unwrap();
            collection.delete().await.unwrap();
            item.delete().await.unwrap();
            assert_eq!(old_calls.sessions.load(Ordering::SeqCst), 2);
            assert_eq!(old_calls.searches.load(Ordering::SeqCst), 2);
            assert_eq!(old_calls.collections.load(Ordering::SeqCst), 1);
            assert_eq!(old_calls.deletes.load(Ordering::SeqCst), 1);
            assert_eq!(old_calls.prompts.load(Ordering::SeqCst), 2);
            for count in [
                &new_calls.sessions,
                &new_calls.searches,
                &new_calls.collections,
                &new_calls.deletes,
                &new_calls.prompts,
            ] {
                assert_eq!(count.load(Ordering::SeqCst), 0);
            }
            old.close().await.unwrap();
            assert!(item.delete().await.is_err());
            assert!(collection.delete().await.is_err());
            assert!(session.search_items(HashMap::new()).await.is_err());
            assert_eq!(new_calls.deletes.load(Ordering::SeqCst), 0);
            assert_eq!(new_calls.collections.load(Ordering::SeqCst), 0);
            assert_eq!(new_calls.prompts.load(Ordering::SeqCst), 0);
            new.release_name(SERVICE).await.unwrap();
            new.close().await.unwrap();
        });
    }
    #[test]
    #[ignore = "requires a private D-Bus without a Secret Service owner"]
    fn owner_loss_finishes_a_pending_operation_without_waiting_for_its_result() {
        assert_eq!(std::env::var("QUOTUM_TEST_DBUS_BINDING").ok().as_deref(), Some("1"));
        zbus::block_on(async {
            let connection = Connection::session().await.unwrap();
            let dbus = DBusProxy::new(&connection).await.unwrap();
            assert!(!dbus.name_has_owner(BusName::try_from(SERVICE).unwrap()).await.unwrap());
            let old = backend(Arc::new(Calls::default())).await;
            old.request_name(SERVICE).await.unwrap();
            let owner = old.unique_name().unwrap().clone();
            let pending = guarded(&connection, &owner, async {
                old.release_name(SERVICE).await.unwrap();
                future::pending::<Result<(), ErrorCode>>().await
            });
            assert_eq!(pending.await, Err(ErrorCode::StoreFailure));
            assert!(
                DBusProxy::new(&connection).await.is_err()
                    || connection
                        .call_method(
                            Some("org.freedesktop.DBus"),
                            "/org/freedesktop/DBus",
                            Some("org.freedesktop.DBus"),
                            "GetId",
                            &()
                        )
                        .await
                        .is_err()
            );
        });
    }
}
