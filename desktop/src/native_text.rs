//! Native strings are generated from the UI catalogs by prepare-text.mjs.
use crate::{
    attention::{Candidate, Quality, Status},
    desktop_settings::Locale,
};
use chrono::{Datelike, Local, TimeZone, Timelike};
use serde_json::Value;
use std::sync::OnceLock;
fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/desktop-i18n.json")))
            .expect("prepared native catalogs")
    })
}
pub fn text(locale: Locale, key: &str) -> &'static str {
    catalog()[locale.key()][key].as_str().unwrap_or("")
}
pub fn fill(locale: Locale, key: &str, parameter: &str, value: &str) -> String {
    text(locale, key).replace(&format!("{{{parameter}}}"), value)
}
pub fn stamp(locale: Locale, time: i64) -> String {
    let Some(time) = Local.timestamp_millis_opt(time).single() else {
        return String::new();
    };
    let month = text(locale, "desktop.months").split('|').nth(time.month0() as usize).unwrap_or("");
    format!("{} {month} {:02}:{:02}", time.day(), time.hour(), time.minute())
}
pub fn clean(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect()
}
pub fn tooltip(locale: Locale, status: &Status) -> String {
    let mut parts = vec!["Quotum".into()];
    if let Some(minimum) = status.state.as_ref().and_then(|s| s.minimum.as_ref()) {
        parts.push(fill(locale, "desktop.remaining", "remaining", &format!("{:.0}", minimum.remaining)));
    }
    if !status.connected {
        parts.push(text(locale, "desktop.disconnected").into());
    } else if status.state.as_ref().is_none_or(|s| s.quality == Quality::Unavailable) {
        parts.push(text(locale, "desktop.unavailable").into());
    } else if status.state.as_ref().is_some_and(|s| s.quality == Quality::Partial) {
        parts.push(text(locale, "desktop.partial").into());
    }
    parts.join("\n")
}
pub fn notification(locale: Locale, candidate: &Candidate) -> (String, String) {
    match candidate {
        Candidate::Quota(q) => {
            let kind = match q.window.kind.as_str() {
                "session" => text(locale, "kind.title.session"),
                "weekly" => text(locale, "kind.title.weekly"),
                _ => "",
            };
            let minutes = q.window.minutes.map(|m| format!("{m}m")).unwrap_or_default();
            let kind = if q.window.kind == "other" { &minutes } else { kind };
            let label = q.window.label.as_deref().unwrap_or("");
            let title =
                [q.name.as_str(), label, kind].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
            let reset = q
                .reset_at
                .map(|at| fill(locale, "desktop.resetAt", "at", &stamp(locale, at)))
                .unwrap_or_else(|| text(locale, "desktop.resetUnknown").into());
            let prefix =
                if q.kind == "reset" { format!("{}\n", text(locale, "desktop.resetTitle")) } else { String::new() };
            (
                clean(&title, 128),
                format!(
                    "{prefix}{}\n{reset}",
                    fill(locale, "desktop.remaining", "remaining", &format!("{:.0}", q.remaining))
                ),
            )
        }
        Candidate::Announcement(a) => {
            let title = format!(
                "{}\n{}",
                a.provider,
                text(
                    locale,
                    if a.reset_kind.as_deref() == Some("banked") {
                        "desktop.bankedTitle"
                    } else {
                        "desktop.announcementTitle"
                    }
                )
            );
            let date = a
                .scheduled_for
                .map(|at| format!("{}\n", fill(locale, "desktop.scheduledFor", "at", &stamp(locale, at))))
                .unwrap_or_default();
            (
                clean(&title, 128),
                clean(&format!("{date}{}", fill(locale, "desktop.credit", "name", &a.credit.name)), 512),
            )
        }
    }
}
