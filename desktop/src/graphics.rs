//! Compatibility belongs to the affected renderer, not the person's desktop settings.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use webkit2gtk::{SettingsExt, WebViewExt};

use crate::shell::Shell;

pub const OVERRIDES: &[&str] = &[
    "WEBKIT_FORCE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
    "WEBKIT_DMABUF_RENDERER_DISABLE_GBM",
    "WEBKIT_DMABUF_RENDERER_BUFFER_FORMAT",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "WEBKIT_FORCE_COMPOSITING_MODE",
    "WEBKIT_SKIA_GPU_PAINTING_THREADS",
    "WEBKIT_SKIA_CPU_PAINTING_THREADS",
    "WEBKIT_SKIA_ENABLE_CPU_RENDERING",
    "WEBKIT_SKIA_HYBRID_PAINTING_MODE_STRATEGY",
    "WEBKIT_SKIA_GPU_PAINTING_MIN_AREA",
    "WEBKIT_SKIA_GPU_MIN_FRACTION_OF_TASKS_IN_PERCENT",
    "WEBKIT_SKIA_USE_LINEAR_TILE_TEXTURES",
    "WEBKIT_SKIA_MSAA_SAMPLE_COUNT",
];

type Version = (u32, u32, u32);

/// A new engine needs a new check: Skia's worker selection changed between 2.50 and 2.52.
fn verified(version: Version) -> bool {
    matches!(version, (2, 50, 4 | 6) | (2, 52, 5))
}

fn defaults(
    version: Version,
    nvidia: bool,
    software: bool,
    x11_available: bool,
    wayland_available: bool,
    backend: Option<&str>,
    existing: &BTreeSet<&str>,
) -> Vec<(&'static str, &'static str)> {
    if software {
        return vec![("WEBKIT_DISABLE_COMPOSITING_MODE", "1")];
    }
    if !nvidia || !verified(version) || OVERRIDES.iter().any(|name| existing.contains(name)) {
        return Vec::new();
    }
    let mut settings = Vec::new();
    // XWayland's presentation avoids the affected GTK/NVIDIA explicit-sync path.
    // An explicitly selected backend wins, including Wayland-only sessions.
    if backend.is_none() && x11_available {
        settings.push(("GDK_BACKEND", "x11"));
    } else if wayland_available && backend != Some("x11") && !existing.contains("__NV_DISABLE_EXPLICIT_SYNC") {
        settings.push(("__NV_DISABLE_EXPLICIT_SYNC", "1"));
    }
    // Ubuntu/Debian disable this renderer on NVIDIA. Force alone fails GBM allocation;
    // the pair retains GPU compositing but transfers completed frames in shared memory.
    settings.push(("WEBKIT_FORCE_DMABUF_RENDERER", "1"));
    settings.push(("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1"));
    // GPU paint workers fault in libnvidia-eglcore during ordinary window destruction.
    // This disables only painting on the GPU, not the compositor or CSS backdrop blur.
    settings.push(("WEBKIT_SKIA_ENABLE_CPU_RENDERING", "1"));
    settings.push(("WEBKIT_SKIA_GPU_PAINTING_THREADS", "0"));
    settings.push(("WEBKIT_SKIA_CPU_PAINTING_THREADS", "2"));
    settings
}

/// A loaded NVIDIA module does not identify the active GPU on a hybrid machine.
/// Apply the measured defaults only when every render device is NVIDIA.
fn only_nvidia(devices: &[(String, String)]) -> bool {
    !devices.is_empty() && devices.iter().all(|(vendor, driver)| vendor.trim() == "0x10de" && driver == "nvidia")
}

fn nvidia_devices(root: &Path) -> bool {
    let Ok(entries) = root.read_dir() else { return false };
    let mut devices = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else { return false };
        if !entry.file_name().to_string_lossy().starts_with("renderD") {
            continue;
        }
        let Ok(vendor) = std::fs::read_to_string(entry.path().join("device/vendor")) else { return false };
        let Ok(driver) = entry.path().join("device/driver").canonicalize() else { return false };
        let Some(driver) = driver.file_name().and_then(|name| name.to_str()) else { return false };
        devices.push((vendor, driver.to_owned()));
    }
    only_nvidia(&devices)
}

pub fn version() -> Version {
    // SAFETY: these argument-free getters return constants from the loaded library.
    unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
            webkit2gtk::ffi::webkit_get_micro_version(),
        )
    }
}

/// Sets this process's defaults before GTK decides which display and renderer to use.
///
/// # Safety
/// Call only from main, before Tauri, GTK or any worker thread is started.
pub unsafe fn configure(software: bool) {
    let existing = OVERRIDES
        .iter()
        .copied()
        .chain(["__NV_DISABLE_EXPLICIT_SYNC"])
        .filter(|name| std::env::var_os(name).is_some())
        .collect();
    let backend = std::env::var("GDK_BACKEND").ok();
    let settings = defaults(
        version(),
        nvidia_devices(Path::new("/sys/class/drm")),
        software,
        std::env::var_os("DISPLAY").is_some(),
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
        backend.as_deref(),
        &existing,
    );
    for (name, value) in settings {
        // SAFETY: the caller guarantees that no other thread can read the environment.
        unsafe { std::env::set_var(name, value) };
    }
}

/// Observe the real view, rather than treating selected environment flags as proof that
/// acceleration worked. This also reports a live web-process failure in the app's log.
pub fn observe(window: &tauri::WebviewWindow, shell: &Arc<Shell>) {
    let observed = shell.clone();
    let result = window.with_webview(move |view| {
        let webview = view.inner();
        let (major, minor, micro) = version();
        let policy = webview.settings().map(|settings| settings.hardware_acceleration_policy());
        let setting = |name| std::env::var(name).unwrap_or_else(|_| "default".into());
        observed.hub_log.line(&format!(
            "graphics: WebKitGTK {major}.{minor}.{micro}; policy={policy:?}; backend={}; shared-memory={}; CPU-paint={}",
            setting("GDK_BACKEND"), setting("WEBKIT_DMABUF_RENDERER_FORCE_SHM"), setting("WEBKIT_SKIA_ENABLE_CPU_RENDERING"),
        ));
        webview.connect_web_process_terminated(move |_, reason| {
            observed.hub_log.line(&format!("graphics: web process terminated: {reason:?}"));
            if observed.smoke.is_some() {
                eprintln!("smoke: web process terminated: {reason:?}");
                std::process::exit(1);
            }
        });
    });
    if let Err(error) = result {
        shell.hub_log.line(&format!("graphics: could not inspect the web view: {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_compositing_and_cpu_painting_are_selected_together() {
        for version in [(2, 50, 4), (2, 50, 6), (2, 52, 5)] {
            let selected = defaults(version, true, false, true, true, None, &BTreeSet::new());
            assert_eq!(selected[0], ("GDK_BACKEND", "x11"));
            for setting in [
                ("WEBKIT_FORCE_DMABUF_RENDERER", "1"),
                ("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1"),
                ("WEBKIT_SKIA_ENABLE_CPU_RENDERING", "1"),
                ("WEBKIT_SKIA_GPU_PAINTING_THREADS", "0"),
                ("WEBKIT_SKIA_CPU_PAINTING_THREADS", "2"),
            ] {
                assert!(selected.contains(&setting));
            }
            assert!(!selected.iter().any(|(name, _)| *name == "WEBKIT_DISABLE_COMPOSITING_MODE"));
        }
    }

    #[test]
    fn unverified_engines_and_other_or_ambiguous_gpus_keep_their_defaults() {
        for version in [(2, 48, 0), (2, 50, 7), (2, 52, 6), (2, 54, 0)] {
            assert!(defaults(version, true, false, true, true, None, &BTreeSet::new()).is_empty());
        }
        assert!(defaults((2, 52, 5), false, false, true, true, None, &BTreeSet::new()).is_empty());
        assert!(!only_nvidia(&[]));
        assert!(only_nvidia(&[("0x10de\n".into(), "nvidia".into())]));
        assert!(!only_nvidia(&[("0x10de".into(), "nouveau".into())]));
        assert!(!only_nvidia(&[("0x10de".into(), "nvidia".into()), ("0x8086".into(), "i915".into())]));
    }

    #[test]
    fn explicit_settings_win() {
        for name in OVERRIDES {
            assert!(defaults((2, 52, 5), true, false, true, true, None, &BTreeSet::from([*name])).is_empty());
        }
        let selected = defaults((2, 52, 5), true, false, true, true, Some("wayland"), &BTreeSet::new());
        assert!(!selected.iter().any(|(name, _)| *name == "GDK_BACKEND"));
        assert!(selected.contains(&("__NV_DISABLE_EXPLICIT_SYNC", "1")));
        let selected =
            defaults((2, 52, 5), true, false, false, true, None, &BTreeSet::from(["__NV_DISABLE_EXPLICIT_SYNC"]));
        assert!(!selected.iter().any(|(name, _)| *name == "__NV_DISABLE_EXPLICIT_SYNC"));
    }

    #[test]
    fn software_is_an_explicit_escape_hatch() {
        assert_eq!(
            defaults((2, 54, 0), false, true, true, true, None, &BTreeSet::from(["WEBKIT_FORCE_DMABUF_RENDERER"])),
            [("WEBKIT_DISABLE_COMPOSITING_MODE", "1")],
        );
    }
}
