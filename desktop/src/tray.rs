//! The icon in the tray: "Open Quotum" and "Quit" in the system's language; on Windows a
//! left click opens the window too (on Linux the icon passes no clicks, only its menu).
//! Its handlers only hand the work to other threads. Levels, a panel and notifications
//! are for later.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use tauri::AppHandle;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::shell::{self, Shell};
use crate::window;

/// The menu's words in the system's language (Russian or English).
pub fn words(locale: Option<&str>) -> (&'static str, &'static str) {
    match locale.map(|l| l.to_ascii_lowercase()) {
        Some(l) if l.starts_with("ru") => ("Открыть Quotum", "Выйти"),
        _ => ("Open Quotum", "Quit"),
    }
}

/// Creates the icon. Without it the app works on: the window opens when the app is started
/// again, and it quits from the settings. libappindicator panics when its library cannot
/// be loaded; the panic is caught here, in the thread that builds the icon.
pub fn create(app: &AppHandle, shell: &Arc<Shell>) {
    match catch_unwind(AssertUnwindSafe(|| build(app, shell))) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => shell.hub_log.line(&format!("app: no tray icon: {e}")),
        Err(_) => shell.hub_log.line("app: no tray icon: its library could not be loaded"),
    }
}

fn build(app: &AppHandle, shell: &Arc<Shell>) -> tauri::Result<()> {
    let (open, quit) = words(sys_locale::get_locale().as_deref());
    let open = MenuItem::with_id(app, "open", open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let (on_menu, on_click) = (shell.clone(), shell.clone());
    let mut tray = TrayIconBuilder::with_id("quotum")
        .tooltip("Quotum")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |_, event| match event.id().as_ref() {
            "open" => window::open(&on_menu),
            "quit" => shell::quit(&on_menu),
            _ => {}
        })
        .on_tray_icon_event(move |_, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                window::open(&on_click);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_speaks_the_systems_language() {
        assert_eq!(words(Some("ru-RU")), ("Открыть Quotum", "Выйти"));
        assert_eq!(words(Some("en-US")).1, "Quit");
        assert_eq!(words(None).0, "Open Quotum");
    }
}
