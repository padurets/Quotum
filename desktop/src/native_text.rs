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
        parts.push(fill(locale, "desktop.remaining", "remaining", &format!("{:.0}", minimum.remaining.round())));
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
fn duration(locale: Locale, minutes: i64) -> String {
    if minutes < 1 {
        return text(locale, "time.underMinute").into();
    }
    if minutes < 60 {
        return fill(locale, "time.minutes", "n", &minutes.to_string());
    }
    let hours = minutes / 60;
    if hours < 24 {
        if minutes % 60 == 0 {
            return fill(locale, "time.hours", "n", &hours.to_string());
        }
        return fill(locale, "time.hoursMinutes", "h", &hours.to_string()).replace("{m}", &(minutes % 60).to_string());
    }
    if hours % 24 == 0 {
        return fill(locale, "time.days", "n", &(hours / 24).to_string());
    }
    fill(locale, "time.daysHours", "d", &(hours / 24).to_string()).replace("{h}", &(hours % 24).to_string())
}
pub fn notification(locale: Locale, candidate: &Candidate) -> (String, String) {
    match candidate {
        Candidate::Quota(q) => {
            let kind = match q.window.kind.as_str() {
                "session" => text(locale, "kind.title.session"),
                "weekly" => text(locale, "kind.title.weekly"),
                _ => "",
            };
            let minutes = q.window.minutes.map(|m| duration(locale, m)).unwrap_or_default();
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
                    fill(locale, "desktop.remaining", "remaining", &format!("{:.0}", q.remaining.round()))
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates_follow_local_wall_time_and_both_catalogs() {
        for (hour, minute) in [(1, 30), (3, 30), (14, 0)] {
            let date = Local.with_ymd_and_hms(2026, 9, 26, hour, minute, 0).single().unwrap();
            assert_eq!(stamp(Locale::En, date.timestamp_millis()), format!("26 September {hour:02}:{minute:02}"));
            assert_eq!(stamp(Locale::Ru, date.timestamp_millis()), format!("26 сентября {hour:02}:{minute:02}"));
        }
        assert_eq!(duration(Locale::En, 1440), "1d");
        assert_eq!(duration(Locale::En, 90), "1h 30m");
        assert_eq!(clean("name\u{0}\u{1}\nnext", 30), "name\nnext");
    }
}
