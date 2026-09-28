//! App-only preferences, persisted independently of the machine's measuring settings.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    En,
    Ru,
}
impl Locale {
    pub fn system() -> Self {
        if sys_locale::get_locale().is_some_and(|s| s.to_ascii_lowercase().starts_with("ru")) {
            Self::Ru
        } else {
            Self::En
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Ru => "ru",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Notifications {
    pub low: bool,
    pub critical: bool,
    pub reset: bool,
    pub announcement: bool,
}
impl Default for Notifications {
    fn default() -> Self {
        Self { low: true, critical: true, reset: true, announcement: true }
    }
}
impl Notifications {
    pub fn enabled(&self, kind: &str) -> bool {
        match kind {
            "low" => self.low,
            "critical" => self.critical,
            "reset" => self.reset,
            "announcement" => self.announcement,
            _ => false,
        }
    }
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    pub notifications: Option<NotificationPatch>,
    pub locale: Option<Locale>,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationPatch {
    pub low: Option<bool>,
    pub critical: Option<bool>,
    pub reset: Option<bool>,
    pub announcement: Option<bool>,
}
impl Patch {
    pub fn apply(&self, json: &mut crate::files::AppJson) {
        if let Some(locale) = self.locale {
            json.locale = Some(locale);
        }
        if let Some(patch) = &self.notifications {
            let n = &mut json.notifications;
            if let Some(v) = patch.low {
                n.low = v;
            }
            if let Some(v) = patch.critical {
                n.critical = v;
            }
            if let Some(v) = patch.reset {
                n.reset = v;
            }
            if let Some(v) = patch.announcement {
                n.announcement = v;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_settings_default_to_all_events_and_unknown_fields_fail() {
        let old: crate::files::AppJson = serde_json::from_str(r#"{"port":23456,"takeOverConfirmed":true}"#).unwrap();
        assert_eq!(old.notifications, Notifications::default());
        assert_eq!(old.locale, None);
        assert!(serde_json::from_str::<Patch>(r#"{"locale":"fr"}"#).is_err());
        assert!(serde_json::from_str::<Patch>(r#"{"notifications":{"sounds":true}}"#).is_err());
        assert!(serde_json::from_str::<Patch>(r#"{"path":"file"}"#).is_err());
    }
}
