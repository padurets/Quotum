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

**The desktop app** (`desktop/`) is checked after `node desktop/prepare.mjs`: it builds
the hub into one file, fetches the Node.js the app carries (checked against a pinned
SHA-256) and writes the icons and licenses, all of which the app's build reads. On Linux
the app needs `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libxdo-dev libssl-dev
librsvg2-dev` (Debian and Ubuntu names). `cargo run` in `desktop/` starts it with its hub
and agent; `npx @tauri-apps/cli@2.11.5 build` there makes its installers (on Linux a deb,
an rpm and an AppImage, on Windows a setup.exe). CI builds it on Linux and Windows and runs
each build with `--smoke` (the rpm installed on Fedora): the hub starts, a stand-in client is measured, the board
shows it, the window opens twice and the app quits (`desktop/smoke/`).

Linux smoke checks also need `xvfb`, `xauth` and `strace`. Run
`python3 desktop/smoke/test_trace.py` when changing their supervisor: a crashing WebKit
child must fail the check even if the app exits successfully. On real Linux hardware,
check the displayed image, scrolling and repeated window close/reopen with the actual
package. Frame callbacks alone do not measure physical presentation; keep performance
measurements separate from tracing, and check child crashes during teardown too.
The intentional child-crash regression requires `QUOTUM_TEST_FAULT=1`; CI enables it.
Leave it off on a person's desktop, whose crash handler can notify them even with core
files disabled.

For native Linux UI automation, a debug build can retain WebKitWebDriver's loopback
inspector transport when `QUOTUM_NATIVE_QA=1`, `TAURI_WEBVIEW_AUTOMATION=true` and all
three isolated paths (`QUOTUM_APP_DATA_DIR`, `QUOTUM_STATE_DIR`, `QUOTUM_CONFIG`) are
set. Use a private session bus and synthetic data, with providers disabled or stand-ins.
Release builds always remove inspector listeners, including with those variables set.

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
