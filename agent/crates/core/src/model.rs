//! The data the agent produces: one [`Snapshot`] per successful measurement, one
//! [`Failure`] per failed one, sent to a hub in a [`Batch`]. This is the ingest
//! format v1 described in `spec/ingest-v1.md`.

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const INGEST_VERSION: u32 = 1;

/// Milliseconds since the Unix epoch.
pub type Millis = i64;

pub fn now_ms() -> Millis {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as Millis).unwrap_or_default()
}

/// Parses an RFC 3339 timestamp ("2026-09-22T20:20:00.77+00:00").
pub fn parse_time(value: &str) -> Option<Millis> {
    value.parse::<jiff::Timestamp>().ok().map(|t| t.as_millisecond())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Antigravity,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Antigravity];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Antigravity => "antigravity",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
            Provider::Antigravity => "Antigravity",
        }
    }

    pub fn parse(value: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|p| p.id() == value)
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// What a window is, independent of how the provider names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Session,
    Weekly,
    Other,
}

pub const SESSION_MINUTES: u32 = 300;
pub const WEEK_MINUTES: u32 = 10_080;

impl Kind {
    pub fn of_minutes(minutes: Option<u32>) -> Kind {
        match minutes {
            Some(SESSION_MINUTES) => Kind::Session,
            Some(WEEK_MINUTES) => Kind::Weekly,
            _ => Kind::Other,
        }
    }

    /// The id segment of a window of this kind: `session`, `weekly` or `window-<minutes>`.
    pub fn slug(self, minutes: Option<u32>) -> String {
        match (self, minutes) {
            (Kind::Session, _) => "session".into(),
            (Kind::Weekly, _) => "weekly".into(),
            (Kind::Other, Some(m)) => format!("window-{m}"),
            (Kind::Other, None) => "window".into(),
        }
    }
}

/// One quota window at the moment of measurement.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// Stable within a provider: `session`, `weekly`, `weekly:fable`, `gemini:session`.
    pub id: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
    /// The provider's name for the scope of the window ("Fable", "Gemini"), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Share of the window already used, 0–100.
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "ts::option")]
    pub resets_at: Option<Millis>,
}

impl Window {
    pub fn new(
        id: impl Into<String>,
        minutes: Option<u32>,
        label: Option<String>,
        used: f64,
        resets_at: Option<Millis>,
    ) -> Window {
        Window {
            id: id.into(),
            kind: Kind::of_minutes(minutes),
            minutes,
            label,
            used_percent: (used.clamp(0.0, 100.0) * 100.0).round() / 100.0,
            resets_at,
        }
    }

    pub fn remaining(&self) -> f64 {
        100.0 - self.used_percent
    }
}

/// A successful measurement of one provider account on one machine.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub provider: Provider,
    /// Pseudonym of the account ([`pseudonym`]); absent when the client does not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// The owner's name for a subscription the client does not identify (configured).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(with = "ts")]
    pub observed_at: Millis,
    /// How the value was obtained, e.g. `codex/app-server`.
    pub via: String,
    /// Version of the client that answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// How long this measurement stays representative: the next one is due before then.
    pub stale_after_ms: u64,
    pub windows: Vec<Window>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The agent's command-line client is not installed on this machine.
    NotInstalled,
    /// The client is installed but not signed in.
    NotLoggedIn,
    /// The client cannot report plan limits (too old, API-key login, …).
    Unsupported,
    Timeout,
    InvalidOutput,
    Failed,
}

impl ErrorKind {
    pub fn describe(self) -> &'static str {
        match self {
            ErrorKind::NotInstalled => "not installed",
            ErrorKind::NotLoggedIn => "not signed in",
            ErrorKind::Unsupported => "limits not available",
            ErrorKind::Timeout => "timed out",
            ErrorKind::InvalidOutput => "unexpected output",
            ErrorKind::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub provider: Provider,
    #[serde(with = "ts")]
    pub observed_at: Millis,
    pub error: ErrorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Failure {
    pub fn new(provider: Provider, error: ErrorKind, detail: impl Into<String>) -> Failure {
        let detail: String = detail.into();
        Failure {
            provider,
            observed_at: now_ms(),
            error,
            detail: (!detail.is_empty()).then(|| detail.chars().take(200).collect()),
        }
    }
}

pub type Outcome = Result<Snapshot, Failure>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    /// Random, generated once per installation.
    pub id: String,
    pub name: String,
    pub os: String,
    pub arch: String,
}

/// Whom a machine measures for, when it joins a board with a board token: the name
/// the person running the agent configured. Without it the hub attributes the machine
/// to whoever created the token.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Owner {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Owner {
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
    }
}

/// One request to a hub.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub version: u32,
    /// `agent-limits/<version>`.
    pub agent: String,
    pub machine: Machine,
    #[serde(default, skip_serializing_if = "Owner::is_empty")]
    pub owner: Owner,
    #[serde(with = "ts")]
    pub sent_at: Millis,
    #[serde(default)]
    pub snapshots: Vec<Snapshot>,
    #[serde(default)]
    pub failures: Vec<Failure>,
}

/// A stable pseudonym of a provider account. The account id itself never leaves the
/// machine; the same account measured on two machines gets the same pseudonym, so a
/// hub can tell they are one account.
pub fn pseudonym(provider: Provider, stable_id: &str) -> String {
    let digest =
        Sha256::digest(format!("agent-limits/account/v1\n{}\n{}", provider.id(), stable_id.trim().to_lowercase()));
    digest[..12].iter().map(|b| format!("{b:02x}")).collect()
}

/// RFC 3339 (de)serialization of [`Millis`].
pub mod ts {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    use super::Millis;

    pub fn format(ms: Millis) -> String {
        jiff::Timestamp::from_millisecond(ms).map(|t| t.to_string()).unwrap_or_default()
    }

    pub fn serialize<S: Serializer>(ms: &Millis, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format(*ms))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Millis, D::Error> {
        let value = String::deserialize(d)?;
        super::parse_time(&value).ok_or_else(|| D::Error::custom("invalid timestamp"))
    }

    pub mod option {
        use serde::{Deserialize, Deserializer, Serializer};

        use super::super::Millis;

        pub fn serialize<S: Serializer>(ms: &Option<Millis>, s: S) -> Result<S::Ok, S::Error> {
            match ms {
                Some(ms) => super::serialize(ms, s),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Millis>, D::Error> {
            let value = Option::<String>::deserialize(d)?;
            Ok(value.and_then(|v| super::super::parse_time(&v)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pseudonyms_are_stable_and_provider_bound() {
        let a = pseudonym(Provider::Claude, " User@Example.com ");
        assert_eq!(a, pseudonym(Provider::Claude, "user@example.com"));
        assert_ne!(a, pseudonym(Provider::Codex, "user@example.com"));
        assert_eq!(a.len(), 24);
    }

    #[test]
    fn windows_round_and_clamp_usage() {
        let w = Window::new("weekly", Some(WEEK_MINUTES), None, 12.3456, None);
        assert_eq!((w.kind, w.used_percent), (Kind::Weekly, 12.35));
        assert_eq!(Window::new("x", Some(60), None, 140.0, None).used_percent, 100.0);
        assert_eq!(Kind::Other.slug(Some(60)), "window-60");
    }

    #[test]
    fn timestamps_round_trip_as_rfc3339() {
        let ms = parse_time("2026-09-22T20:20:00.770584+00:00").unwrap();
        assert_eq!(ts::format(ms), "2026-09-22T20:20:00.77Z");
        let snapshot = Snapshot {
            provider: Provider::Codex,
            account: None,
            account_name: None,
            plan: Some("pro".into()),
            observed_at: ms,
            via: "codex/app-server".into(),
            client: None,
            stale_after_ms: 300_000,
            windows: vec![Window::new("weekly", Some(WEEK_MINUTES), None, 8.0, Some(ms))],
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["observedAt"], "2026-09-22T20:20:00.77Z");
        assert_eq!(json["windows"][0]["usedPercent"], 8.0);
        assert_eq!(serde_json::from_value::<Snapshot>(json).unwrap(), snapshot);
    }
}
