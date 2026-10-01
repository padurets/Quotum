//! Trusted hub keys. Secret bytes never implement Debug, Display or Serialize.
#![deny(clippy::unwrap_used, clippy::expect_used)]

mod controller;
mod files;
mod store;
#[cfg(windows)]
mod windows;

pub use controller::{Control, Manager};
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    NoEntry,
    Unavailable,
    NoAccess,
    Timeout,
    Ambiguous,
    InvalidBytes,
    UnsafePath,
    FileFailure,
    StoreFailure,
    MetadataInvalid,
    Overflow,
    StaleReport,
}
impl ErrorCode {
    pub fn code(self) -> &'static str {
        match self {
            Self::NoEntry => "secret_key_no_entry",
            Self::Unavailable => "secret_key_store_unavailable",
            Self::NoAccess => "secret_key_store_no_access",
            Self::Timeout => "secret_key_store_timeout",
            Self::Ambiguous => "secret_key_store_ambiguous",
            Self::InvalidBytes => "secret_key_invalid_bytes",
            Self::UnsafePath => "secret_key_unsafe_path",
            Self::FileFailure => "secret_key_file_failed",
            Self::StoreFailure => "secret_key_store_failed",
            Self::MetadataInvalid => "secret_key_metadata_invalid",
            Self::Overflow => "secret_key_generation_overflow",
            Self::StaleReport => "secret_key_stale_report",
        }
    }
}

pub struct Kek {
    bytes: [u8; 32],
    fingerprint: String,
}
impl Kek {
    pub fn parse(encoded: &[u8]) -> Result<Self, ErrorCode> {
        if encoded.len() != 43 {
            return Err(ErrorCode::InvalidBytes);
        }
        let mut bytes = [0u8; 32];
        let (mut bits, mut acc, mut index) = (0u32, 0u32, 0usize);
        for byte in encoded {
            let value = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'-' => 62,
                b'_' => 63,
                _ => return Err(ErrorCode::InvalidBytes),
            };
            acc = (acc << 6) | u32::from(value);
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                let Some(output) = bytes.get_mut(index) else { return Err(ErrorCode::InvalidBytes) };
                *output = (acc >> bits) as u8;
                index += 1;
                acc &= (1 << bits) - 1;
            }
        }
        if index != 32 || acc != 0 {
            return Err(ErrorCode::InvalidBytes);
        }
        Self::from_bytes(bytes)
    }
    fn from_bytes(mut bytes: [u8; 32]) -> Result<Self, ErrorCode> {
        let mut check = [0u8; 32];
        if Hkdf::<Sha256>::new(Some(b"quotum/kek/v1"), &bytes).expand(b"check", &mut check).is_err() {
            bytes.fill(0);
            return Err(ErrorCode::InvalidBytes);
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&check).map_err(|_| ErrorCode::InvalidBytes)?;
        check.fill(0);
        mac.update(b"quotum/kek-check/v1");
        let value = mac.finalize().into_bytes();
        let fingerprint = value[..8].iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self { bytes, fingerprint })
    }
    pub fn random() -> Result<Self, ErrorCode> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| ErrorCode::StoreFailure)?;
        Self::from_bytes(bytes)
    }
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    /// Only the executor hands this to the hub's own environment or private storage.
    fn encoded(&self) -> String {
        crate::hub::base64url(&self.bytes)
    }
}
impl Drop for Kek {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Keystore,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyRef {
    pub kind: Kind,
    pub name: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Rotation,
    Reset,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Previous {
    pub r#ref: KeyRef,
    pub reason: Reason,
    pub from: String,
    pub to: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Marker {
    pub version: u8,
    pub current: KeyRef,
    pub next: Option<KeyRef>,
    pub previous: Vec<Previous>,
    pub was_file: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Created,
    Ok,
    Rotated,
    Mismatch,
    Missing,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub outcome: Outcome,
    pub stored: Option<String>,
    pub current: Option<String>,
    pub credentials: u64,
    pub unreadable: u64,
}
impl Report {
    pub fn valid(&self) -> bool {
        let fp = |value: &Option<String>| {
            value
                .as_ref()
                .is_none_or(|s| s.len() == 16 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        };
        fp(&self.stored)
            && fp(&self.current)
            && self.credentials <= 9_007_199_254_740_991
            && self.unreadable <= self.credentials
            && match self.outcome {
                Outcome::Missing => self.current.is_none(),
                Outcome::Mismatch => self.current.is_some(),
                _ => self.current.is_some() && self.current == self.stored,
            }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Keystore,
    File,
    Waiting,
    Missing,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicState {
    pub state: State,
    pub outcome: Option<Outcome>,
    pub was_file: bool,
    pub retained_file: bool,
    pub reset_available: bool,
    pub busy: bool,
}
impl Default for PublicState {
    fn default() -> Self {
        Self {
            state: State::Waiting,
            outcome: None,
            was_file: false,
            retained_file: false,
            reset_available: false,
            busy: false,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    #[test]
    fn fingerprint_is_the_hubs_vector_and_bytes_are_strict() {
        let k = Kek::parse(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        assert_eq!(k.fingerprint(), "fb5238eccc6095ae");
        assert_eq!(k.encoded(), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        for value in
            [vec![255; 43], b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB".to_vec(), vec![0; 43], b"short".to_vec()]
        {
            assert!(matches!(Kek::parse(&value), Err(ErrorCode::InvalidBytes)));
        }
    }
    #[test]
    fn reports_have_bounded_counters_and_exact_fingerprints() {
        let report = Report {
            outcome: Outcome::Ok,
            stored: Some("fb5238eccc6095ae".into()),
            current: Some("fb5238eccc6095ae".into()),
            credentials: 1,
            unreadable: 0,
        };
        assert!(report.valid());
        for invalid in [
            Report { current: None, ..report.clone() },
            Report { unreadable: 2, ..report.clone() },
            Report { credentials: u64::MAX, ..report.clone() },
            Report { stored: Some("FB5238eccc6095ae".into()), ..report },
        ] {
            assert!(!invalid.valid());
        }
    }
}
