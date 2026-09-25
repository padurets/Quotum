# Contributing

Issues and pull requests are welcome, in English or Russian. For anything bigger than a
fix, open an issue first so we can agree on the approach before you spend time on it.

## Checking a change

```sh
cd hub && npm ci && npm run typecheck && npm test && npm run build
cd agent && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
node desktop/prepare.mjs && cd desktop && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

CI runs the same on every push, the agent on Linux, macOS and Windows. `npm start` in
`hub/` serves the built dashboard on `127.0.0.1:8080`; `cargo run -p quotum` in `agent/`
measures this machine once.

**The desktop app** (`desktop/`) shares a Rust controller between Electron on Linux
and Tauri/WebView2 on Windows. `node desktop/prepare.mjs` builds the hub, downloads
checksum-pinned runtimes, and writes icons and license notices. Run it before the
checks above. Linux needs `libssl-dev` for the Rust build, `unzip` for preparation,
and Chromium's runtime libraries (`libnss3 libgtk-3-0 libgbm1 libasound2` on Debian).
`cargo run` in `desktop/` starts a prepared debug build. `node desktop/package-linux.mjs`
builds deb, rpm and AppImage; its packaging tools are `dpkg-deb`, `rpmbuild` and
`mksquashfs`. On Windows, `npx @tauri-apps/cli@2.11.5 build --target x86_64-pc-windows-msvc`
makes setup.exe; then `node desktop/package-windows.mjs` packages that build as a portable ZIP.
CI runs both the installed app and the extracted ZIP, including a path with spaces.

Run `node --test desktop/electron/policy.test.cjs` for the Linux bridge/navigation
policy. CI runs the installed packages with `--smoke`: the hub starts, a stand-in client
is measured, its board appears, the window opens twice and the app quits. Linux checks
need `xvfb`, `xauth` and Python 3; `desktop/smoke/monitor.py` adopts surviving
children and audits their exits, alongside Electron's live child-failure reports.
This uses no ptrace and keeps Chromium's sandbox intact. The installed-package checks also start the controller before a stand-in tray watcher
(`desktop/smoke/tray.sh`, Python 3 with PyGObject) to cover early start at login.
A successful
controller exit alone does not prove that browser children closed successfully.
The intentional child-crash supervisor regression requires `QUOTUM_TEST_FAULT=1`;
CI enables it. Leave it off on a person's workstation, whose crash handler may notify
them even with core files disabled.

For real Linux QA use isolated `QUOTUM_APP_DATA_DIR`, `QUOTUM_STATE_DIR` and
`QUOTUM_CONFIG`, synthetic data and providers disabled or stand-ins. Check the displayed
image, scrolling, resizing and repeated close/reopen with the actual package. Frame
callbacks alone do not measure physical presentation. An explicitly isolated debug build
can expose CDP with `QUOTUM_NATIVE_QA=1` and `QUOTUM_INSPECTOR_SERVER=127.0.0.1:<port>`;
all three isolated paths must be set. Release builds ignore these switches. Use this
for instrumentation, then check the actual release package on the physical display too. Keep performance measurements
separate from tracing and check teardown too. Never disable the browser sandbox to
make a test pass; an AppImage requires user namespaces, while installed native packages
also provide Chromium's setuid helper.

Tests never start a real Claude Code, Codex or Antigravity client: they use recorded
answers and stand-in programs, so they cost nothing and don't depend on your accounts.

## Pull requests

- **One task, one pull request.** A pull request takes one issue (or one fix) to `main`
  and is merged once it is done. Open it as a draft while the work goes on: CI runs on
  every push to it. Never open one only to run CI and close it after.
- **The history stays linear.** Pull requests are merged with *Rebase and merge*: every
  commit lands on `main` as it is, so each is one logical change with a message that
  says what it does. What review asks for goes into new commits on the same branch.
- **No force-push without a strong reason**, such as a rebase onto `main` to resolve a
  conflict; when you do, say so in the pull request. `main` itself is never
  force-pushed.

## What to keep in mind

- **The dashboard speaks English and Russian.** Every new string goes into both catalogs
  in `hub/ui/i18n`; the type checker and the tests will tell you if one is missing.
- **Both READMEs say the same thing.** A change to `README.md` goes into `README.ru.md` too.
- **The protocol is a spec.** Anything that changes what the agent sends or what the hub
  answers goes into [spec/ingest-v1.md](spec/ingest-v1.md) in the same change.
- **A released database layout never changes.** A new layout is a new step at the end of
  `hub/server/store/schema.ts`; `hub/server/test/schema.test.ts` guards the released ones.
- **The agent stays out of the way and out of your secrets.** It never reads provider
  tokens or cookies, never makes a model request and starts clients as rarely as it can.
  A new provider is an adapter in `agent/crates/core/src/providers/` that asks the
  provider's own command-line client, the way the existing three do.

[docs/architecture.md](docs/architecture.md) explains how the parts fit together.
