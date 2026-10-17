//! `quotum update`: replaces this program with the latest release when there is a newer
//! one. It is meant to run on every start of a dev environment, so the common case (up to
//! date) is one small request and nothing else.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Where the releases are; `QUOTUM_RELEASES_URL` points elsewhere (a mirror, or tests).
const RELEASES: &str = "https://github.com/padurets/quotum/releases";
/// A release binary is a few megabytes; anything far bigger is not one.
const MAX_BINARY: u64 = 64 * 1024 * 1024;

const CURRENT: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// This program is the latest release.
    Latest(String),
    /// A newer release is out; nothing was changed (`--check`).
    Available { current: String, latest: String },
    /// This program was replaced by the newer release.
    Updated { from: String, to: String, program: PathBuf },
    /// Installed with npm, which updates it; nothing was changed.
    Npm,
}

/// The release asset of this platform: a bare binary, so nothing needs unpacking.
pub fn asset() -> Option<&'static str> {
    let name = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "quotum-cli-linux-x64",
        ("linux", "aarch64") => "quotum-cli-linux-arm64",
        ("macos", "x86_64") => "quotum-cli-macos-x64",
        ("macos", "aarch64") => "quotum-cli-macos-arm64",
        ("windows", "x86_64") => "quotum-cli-windows-x64.exe",
        _ => return None,
    };
    Some(name)
}

pub fn releases() -> String {
    std::env::var("QUOTUM_RELEASES_URL").unwrap_or_else(|_| RELEASES.into()).trim_end_matches('/').to_string()
}

/// Checks for a newer release and, unless `check` only, puts it in the place of `program`.
/// `runs` checks that a downloaded binary starts and is the version it claims to be.
pub fn update(
    releases: &str,
    program: &Path,
    check: bool,
    runs: impl Fn(&Path, &str) -> bool,
) -> Result<Outcome, String> {
    if installed_by_npm(program) {
        return Ok(Outcome::Npm);
    }
    let asset = asset().ok_or("there is no release for this platform")?;
    let latest = latest(releases)?;
    if !newer(&latest, CURRENT) {
        return Ok(Outcome::Latest(CURRENT.into()));
    }
    if check {
        return Ok(Outcome::Available { current: CURRENT.into(), latest });
    }
    let download = format!("{releases}/download/v{latest}");
    let binary = get(&format!("{download}/{asset}"))?;
    let sums = String::from_utf8(get(&format!("{download}/SHA256SUMS"))?).map_err(|_| "SHA256SUMS is not text")?;
    let expected = checksum(&sums, asset).ok_or_else(|| format!("SHA256SUMS of {latest} has no {asset}"))?;
    let actual = hex(&Sha256::digest(&binary));
    if actual != expected {
        return Err(format!("the download of {asset} does not match its checksum; nothing was changed"));
    }
    // Publish immutable versioned sidecars first. An old CLI keeps its own whole
    // payload through a failed download, interrupted staging or final CLI replacement.
    let hook_name = asset.replace("quotum-cli-", "quotum-hook-");
    let manifest_name = format!("{}.json", hook_name.trim_end_matches(".exe"));
    let helper = get(&format!("{download}/{hook_name}"))?;
    let manifest = get(&format!("{download}/{manifest_name}"))?;
    for (name, bytes) in [(&hook_name, &helper), (&manifest_name, &manifest)] {
        if checksum(&sums, name).as_deref() != Some(&hex(&Sha256::digest(bytes))) {
            return Err(format!("the download of {name} does not match its checksum; nothing was changed"));
        }
    }
    let metadata: serde_json::Value = serde_json::from_slice(&manifest).map_err(|_| "invalid hook payload manifest")?;
    let (platform, target) = hook_platform().ok_or("there is no hook payload for this platform")?;
    if metadata["schemaVersion"] != 1
        || metadata["version"] != latest
        || metadata["sha256"] != hex(&Sha256::digest(&helper))
        || metadata["platform"] != platform
        || metadata["target"] != target
    {
        return Err("invalid hook payload manifest".into());
    }
    stage_payload(program, &latest, &helper, &manifest)
        .map_err(|_| "could not stage the hook payload; nothing was changed")?;
    replace(program, &binary, |fresh| runs(fresh, &latest))
        .map_err(|e| format!("could not replace {}: {e}", program.display()))?;
    Ok(Outcome::Updated { from: CURRENT.into(), to: latest, program: program.to_path_buf() })
}

fn hook_platform() -> Option<(&'static str, &'static str)> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => ("linux-x64", "x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => ("linux-arm64", "aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => ("darwin-x64", "x86_64-apple-darwin"),
        ("macos", "aarch64") => ("darwin-arm64", "aarch64-apple-darwin"),
        ("windows", "x86_64") => ("win32-x64", "x86_64-pc-windows-gnu"),
        _ => return None,
    })
}

fn stage_payload(program: &Path, version: &str, helper: &[u8], manifest: &[u8]) -> io::Result<()> {
    let parent =
        program.parent().ok_or_else(|| io::Error::other("missing install directory"))?.join(".quotum-hook-payloads");
    fs::create_dir_all(&parent)?;
    let target = parent.join(version);
    let name = if cfg!(windows) { "quotum-hook.exe" } else { "quotum-hook" };
    if target.try_exists()? {
        if fs::read(target.join(name))? != helper || fs::read(target.join("payload-manifest.json"))? != manifest {
            return Err(io::Error::other("conflicting payload version"));
        }
        return Ok(());
    }
    let stage = parent.join(format!(".new-{}", std::process::id()));
    fs::create_dir(&stage)?;
    let result = (|| {
        fs::write(stage.join(name), helper)?;
        fs::write(stage.join("payload-manifest.json"), manifest)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(stage.join(name), fs::Permissions::from_mode(0o755))?;
        }
        fs::rename(&stage, &target)
    })();
    let _ = fs::remove_dir_all(&stage);
    result
}

/// The latest release's version, read from where `releases/latest` redirects to
/// (`…/tag/v0.3.0`): one small request, no API and so no rate limit.
fn latest(releases: &str) -> Result<String, String> {
    let response = client(Duration::from_secs(5))
        .get(&format!("{releases}/latest"))
        .call()
        .map_err(|e| format!("cannot reach {releases}: {e}"))?;
    let location = response.headers().get("location").and_then(|value| value.to_str().ok()).ok_or_else(|| {
        format!("{releases}/latest answered {} without saying where the latest release is", response.status())
    })?;
    let tag = location.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
    let version = tag.strip_prefix('v').unwrap_or(tag);
    if parts(version).is_none()
        || !version.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
    {
        return Err(format!("the latest release is not a version: {location}"));
    }
    Ok(version.to_string())
}

fn get(url: &str) -> Result<Vec<u8>, String> {
    let mut response = client(Duration::from_secs(120))
        .get(url)
        .config()
        .max_redirects(10)
        .build()
        .call()
        .map_err(|e| format!("cannot download {url}: {e}"))?;
    if response.status() != 200 {
        return Err(format!("{url}: {}", response.status()));
    }
    response.body_mut().with_config().limit(MAX_BINARY).read_to_vec().map_err(|e| format!("cannot download {url}: {e}"))
}

fn client(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .timeout_connect(Some(Duration::from_secs(3)))
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent(concat!("quotum/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// Whether `a` is a later version than `b`. Pre-releases (`0.3.0-rc.1`) count as their
/// release, so one is never offered over the release it leads to.
fn newer(a: &str, b: &str) -> bool {
    matches!((parts(a), parts(b)), (Some(a), Some(b)) if a > b)
}

fn parts(version: &str) -> Option<[u64; 3]> {
    let core = version.split(['-', '+']).next()?;
    let mut numbers = core.split('.').map(|n| n.parse::<u64>().ok());
    let parts = [numbers.next()??, numbers.next()??, numbers.next()??];
    numbers.next().is_none().then_some(parts)
}

/// The checksum of `name` in a `sha256sum` listing.
fn checksum(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.split_once(char::is_whitespace)?;
        (file.trim_start().trim_start_matches('*') == name).then(|| hash.to_ascii_lowercase())
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// npm puts the binary in `node_modules/@quotum/<platform>/bin`, and npm updates it.
fn installed_by_npm(program: &Path) -> bool {
    program.components().any(|part| part.as_os_str() == "node_modules")
}

/// Puts `binary` in the place of `program` in one step: written next to it, checked to
/// start, then renamed over it, so an interrupted update leaves the old one working.
/// Windows cannot overwrite a running program, but it can rename one: the old one is
/// moved aside and removed by the next update.
fn replace(program: &Path, binary: &[u8], runs: impl Fn(&Path) -> bool) -> io::Result<()> {
    let dir = program.parent().ok_or_else(|| io::Error::other("the program has no folder"))?;
    let fresh = dir.join(format!(".quotum-update-{}{}", std::process::id(), std::env::consts::EXE_SUFFIX));
    let result = (|| {
        fs::write(&fresh, binary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fresh, fs::Permissions::from_mode(0o755))?;
        }
        if !runs(&fresh) {
            return Err(io::Error::other("the downloaded program does not start on this machine; nothing was changed"));
        }
        #[cfg(windows)]
        {
            let aside = program.with_extension("old.exe");
            let _ = fs::remove_file(&aside);
            fs::rename(program, &aside)?;
            if let Err(e) = fs::rename(&fresh, program) {
                let _ = fs::rename(&aside, program);
                return Err(e);
            }
        }
        #[cfg(not(windows))]
        fs::rename(&fresh, program)?;
        Ok(())
    })();
    let _ = fs::remove_file(&fresh);
    result
}

/// Removes what a previous update on Windows moved aside, now that it no longer runs.
pub fn tidy(program: &Path) {
    if cfg!(windows) {
        let _ = fs::remove_file(program.with_extension("old.exe"));
    }
}

/// Starts `binary --version` and checks it says `version`.
pub fn reports(binary: &Path, version: &str) -> bool {
    Command::new(binary).arg("--version").output().is_ok_and(|out| {
        out.status.success() && String::from_utf8_lossy(&out.stdout).split_whitespace().any(|word| word == version)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    #[test]
    fn versions_compare_by_number_and_pre_releases_count_as_their_release() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("1.0.0", "0.99.0"));
        assert!(!newer("0.2.0", "0.2.0"));
        assert!(!newer("0.2.0", "0.3.0"));
        assert!(!newer("0.3.0-rc.1", "0.3.0"));
        assert!(!newer("latest", "0.2.0"));
        assert_eq!(parts("1.2"), None);
        assert_eq!(parts("1.2.3.4"), None);
    }

    #[test]
    fn checksums_are_read_from_a_sha256sum_listing() {
        let sums = "ABC123  quotum-cli-linux-x64\ndef456 *quotum-cli-windows-x64.exe\n";
        assert_eq!(checksum(sums, "quotum-cli-linux-x64").as_deref(), Some("abc123"));
        assert_eq!(checksum(sums, "quotum-cli-windows-x64.exe").as_deref(), Some("def456"));
        assert_eq!(checksum(sums, "quotum-cli-linux"), None);
    }

    #[test]
    fn a_binary_installed_by_npm_is_left_to_npm() {
        let program = Path::new("/home/u/.npm/_npx/1a2b/node_modules/@quotum/linux-x64/bin/quotum");
        assert_eq!(update("http://127.0.0.1:9", program, false, |_, _| true), Ok(Outcome::Npm));
    }

    /// A stand-in for GitHub Releases: `/latest` redirects to a tag, downloads are served
    /// from `files`. Answers every request it gets and records their paths.
    fn releases(tag: &'static str, files: Vec<(String, Vec<u8>)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/releases", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let path = line.split_whitespace().nth(1).unwrap_or_default().to_string();
                while reader.read_line(&mut line).is_ok_and(|n| n > 2) {
                    line.clear();
                }
                log.lock().unwrap().push(path.clone());
                let mut stream = stream;
                if path == "/releases/latest" {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 302 Found\r\nLocation: /releases/tag/{tag}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                } else if let Some((_, body)) =
                    files.iter().find(|(name, _)| path == format!("/releases/download/{tag}/{name}"))
                {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(body);
                } else {
                    let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            }
        });
        (base, seen)
    }

    fn installed(dir: &Path) -> PathBuf {
        let program = dir.join(format!("quotum{}", std::env::consts::EXE_SUFFIX));
        fs::write(&program, b"old").unwrap();
        program
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quotum-update-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn up_to_date_is_one_request_and_changes_nothing() {
        let tag: &'static str = Box::leak(format!("v{CURRENT}").into_boxed_str());
        let (base, seen) = releases(tag, vec![]);
        let dir = scratch("latest");
        let program = installed(&dir);
        assert_eq!(update(&base, &program, false, |_, _| true), Ok(Outcome::Latest(CURRENT.into())));
        assert_eq!(*seen.lock().unwrap(), ["/releases/latest"]);
        assert_eq!(fs::read(&program).unwrap(), b"old");
    }

    #[test]
    fn a_newer_release_replaces_the_program_once_its_checksum_and_start_are_right() {
        let name = asset().unwrap().to_string();
        let binary = b"new release".to_vec();
        let helper = b"new helper".to_vec();
        let hook_name = name.replace("quotum-cli-", "quotum-hook-");
        let manifest_name = format!("{}.json", hook_name.trim_end_matches(".exe"));
        let manifest = serde_json::to_vec(
            &serde_json::json!({"schemaVersion":1,"version":"999.0.0","sha256":hex(&Sha256::digest(&helper)),"platform":hook_platform().unwrap().0,"target":hook_platform().unwrap().1}),
        )
        .unwrap();
        let sums = format!(
            "{}  {name}\n{}  {hook_name}\n{}  {manifest_name}\n",
            hex(&Sha256::digest(&binary)),
            hex(&Sha256::digest(&helper)),
            hex(&Sha256::digest(&manifest))
        );
        let (base, _) = releases(
            "v999.0.0",
            vec![
                (name.clone(), binary.clone()),
                (hook_name, helper.clone()),
                (manifest_name, manifest),
                ("SHA256SUMS".into(), sums.into_bytes()),
            ],
        );
        let dir = scratch("newer");
        let program = installed(&dir);

        assert_eq!(
            update(&base, &program, true, |_, _| true),
            Ok(Outcome::Available { current: CURRENT.into(), latest: "999.0.0".into() })
        );
        assert_eq!(fs::read(&program).unwrap(), b"old", "--check changes nothing");

        let error = update(&base, &program, false, |_, _| false).unwrap_err();
        assert!(error.contains("does not start"), "{error}");
        assert_eq!(fs::read(&program).unwrap(), b"old", "a binary that does not start is not installed");

        let outcome = update(&base, &program, false, |_, version| version == "999.0.0").unwrap();
        assert_eq!(outcome, Outcome::Updated { from: CURRENT.into(), to: "999.0.0".into(), program: program.clone() });
        assert_eq!(fs::read(&program).unwrap(), binary);
        assert_eq!(
            fs::read(dir.join(".quotum-hook-payloads/999.0.0").join(if cfg!(windows) {
                "quotum-hook.exe"
            } else {
                "quotum-hook"
            }))
            .unwrap(),
            helper
        );
        let left: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(
            left.iter().all(|name| !name.to_string_lossy().starts_with(".quotum-update")),
            "no temporary file is left: {left:?}"
        );
    }

    #[test]
    fn a_download_that_does_not_match_its_checksum_changes_nothing() {
        let name = asset().unwrap().to_string();
        let sums = format!("{}  {name}\n", "0".repeat(64));
        let (base, _) =
            releases("v999.0.0", vec![(name, b"tampered".to_vec()), ("SHA256SUMS".into(), sums.into_bytes())]);
        let dir = scratch("tampered");
        let program = installed(&dir);
        let error = update(&base, &program, false, |_, _| true).unwrap_err();
        assert!(error.contains("checksum"), "{error}");
        assert_eq!(fs::read(&program).unwrap(), b"old");
    }

    #[test]
    fn a_missing_helper_preserves_the_previous_whole_pair() {
        let name = asset().unwrap().to_string();
        let binary = b"new release".to_vec();
        let sums = format!("{}  {name}\n", hex(&Sha256::digest(&binary)));
        let (base, _) = releases("v999.0.0", vec![(name, binary), ("SHA256SUMS".into(), sums.into_bytes())]);
        let dir = scratch("missing-helper");
        let program = installed(&dir);
        stage_payload(&program, CURRENT, b"old helper", b"old manifest").unwrap();
        assert!(update(&base, &program, false, |_, _| true).is_err());
        assert_eq!(fs::read(program).unwrap(), b"old");
        let previous = dir.join(".quotum-hook-payloads").join(CURRENT);
        assert_eq!(fs::read(previous.join("payload-manifest.json")).unwrap(), b"old manifest");
        assert!(!dir.join(".quotum-hook-payloads/999.0.0").exists());
    }

    #[test]
    fn a_release_tag_cannot_escape_the_versioned_payload_directory() {
        let (base, _) = releases("v999.0.0-..\\..\\outside", vec![]);
        let dir = scratch("unsafe-version");
        let program = installed(&dir);
        assert!(update(&base, &program, false, |_, _| true).is_err());
        assert_eq!(fs::read(program).unwrap(), b"old");
        assert!(!dir.join(".quotum-hook-payloads").exists());
    }

    #[test]
    fn an_unreachable_release_server_is_an_error_soon() {
        let dir = scratch("offline");
        let program = installed(&dir);
        // Nothing listens on port 9 (discard) of localhost.
        let error = update("http://127.0.0.1:9/releases", &program, false, |_, _| true).unwrap_err();
        assert!(error.contains("cannot reach"), "{error}");
    }
}
