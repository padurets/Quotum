fn main() {
    // The commit the settings show, the same short hash as in the names of CI artifacts.
    // Not rerun on .git/HEAD: in a worktree that is a file, and a build without git works too.
    println!("cargo:rerun-if-env-changed=QUOTUM_COMMIT");
    let commit = std::env::var("QUOTUM_COMMIT")
        .ok()
        .filter(|c| !c.is_empty())
        .or_else(|| {
            let out = std::process::Command::new("git").args(["rev-parse", "--short=7", "HEAD"]).output().ok()?;
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        })
        .map(|c| c.chars().take(7).collect::<String>())
        .unwrap_or_else(|| "dev".into());
    println!("cargo:rustc-env=QUOTUM_COMMIT={commit}");

    // The app's own commands, allowed by name to the pages that may call them (see ipc.rs).
    let manifest = tauri_build::AppManifest::new().commands(&[
        "app_state",
        "save_settings",
        "take_over",
        "set_autostart",
        "reenter",
        "quit",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri-build");
}
