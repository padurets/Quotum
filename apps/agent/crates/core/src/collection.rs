//! Local account outcomes, independent of delivery and native client identity evidence.
use crate::model::{Failure, Millis, Provider, Snapshot, ts};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AccountRef {
    Supplier {
        account: String,
    },
    Declared {
        #[serde(rename = "accountName")]
        account_name: Option<String>,
    },
}
impl AccountRef {
    pub fn of(snapshot: &Snapshot) -> Option<Self> {
        snapshot.account.clone().map(|account| Self::Supplier { account }).or_else(|| {
            (snapshot.provider == Provider::Antigravity).then(|| Self::Declared {
                account_name: snapshot.account_name.as_ref().map(|name| name.trim().to_lowercase()),
            })
        })
    }
    pub fn account(&self) -> Option<&str> {
        match self {
            Self::Supplier { account } => Some(account),
            _ => None,
        }
    }
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Declared { account_name } => account_name.as_deref(),
            _ => None,
        }
    }
}
/// A local label contains only the pseudonym or the explicitly configured account name.
pub fn account_label(account: Option<&AccountRef>) -> String {
    match account {
        Some(AccountRef::Supplier { account }) => account.chars().take(8).collect(),
        Some(AccountRef::Declared { account_name }) => account_name.clone().unwrap_or_else(|| "default".into()),
        None => "unknown account".into(),
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum CollectionOutcome {
    Observed(Snapshot),
    NoNewData,
    Failed(Failure),
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionResult {
    pub version: u8,
    pub provider: Provider,
    pub account: Option<AccountRef>,
    pub attempt_id: String,
    pub stage: &'static str,
    #[serde(with = "ts")]
    pub completed_at: Millis,
    pub outcome: CollectionOutcome,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub provider: Provider,
    pub outcome: CompletionOutcome,
    #[serde(with = "ts")]
    pub completed_at: Millis,
    pub attempt_context: crate::measurement_policy::AttemptContext,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionOutcome {
    NoNewData,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_declared_references_match_the_collectors_canonical_names() {
        let value = Snapshot {
            provider: Provider::Antigravity,
            account: None,
            account_name: Some(" Work ".into()),
            plan: None,
            observed_at: 0,
            via: "fixture".into(),
            client: None,
            stale_after_ms: 60000,
            windows: vec![],
            resets: None,
            resource_status: None,
            balances: None,
        };
        assert_eq!(AccountRef::of(&value), Some(AccountRef::Declared { account_name: Some("work".into()) }));
    }
}
