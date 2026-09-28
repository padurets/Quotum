# Contributing

Issues and pull requests are welcome, in English or Russian. For anything bigger than a
fix, open an issue first so we can agree on the approach before you spend time on it.

## Checking a change

```sh
(cd hub && npm ci && npm run typecheck && npm test && npm run build)
(cd agent && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked)
node desktop/prepare.mjs && (cd desktop && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked)
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
The release workflow calls the same Desktop workflow and publishes its packages only
after these checks pass; ordinary CI runs also keep the versioned release packages.
`desktop/smoke/windows-ui.ps1 <app.exe>` also checks ordinary startup with the real
window-state plugin: a visible, responsive window, restored bounds inside the monitor's
work area, close/reopen through a second launch, and a second launch while the window is
minimized, which restores that very window. It disables every provider. Each
run also opens and closes the tray panel twice, checking that it stays visible and
fits its monitor without changing the main window's geometry. Each
run starts from a fresh WebView2 profile, as the first start on a machine does: the one
in `%LOCALAPPDATA%\com.padurets.quotum\EBWebView` is set aside and put back afterwards.
With `-Diagnostics <dir>` it keeps its report (the times of every close and reopen), the
app's logs and the app's processes there. CI uploads them when the UI smoke fails and in
every manual run; a manual run of the Desktop workflow takes `ui-runs`, how many times
the UI smoke runs on the installed app and on the portable one each.

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

## The demo board

A change to the dashboard is looked at on the demo board, with every state it can meet:

```sh
cd hub && npm run build && npm run demo
```

It starts the built hub on throwaway data (in the system's temporary folder), fills it
with the catalogue in `hub/demo/catalogue.ts`, with the days its agents worked before it
started, and keeps it alive: machines measure, agents start, work and stop, a machine
sleeps. The reset trackers are stood in for, so
it needs no network and no account. It prints the address and how to sign in; Ctrl+C
stops it and leaves nothing behind. `npm run demo -- showcase` opens the clean board
the README images come from; `--resets <scene>` picks what the reset trackers say (one
scene a run, the list is printed). Set `QUOTUM_PORT` if 8080 is taken. After changing
the UI, `npm run build` and reload the page; after changing the server, `npm run build`
and start the demo again.

A new state of the board gets an entry in the catalogue, with the codes it shows in
`expect` (the file's header explains them): `npm test` then checks it holds, and it is
on the board for the next person. `npm run demo -- --still` keeps the board still:
nothing is measured after the start, and no card goes stale for three hours.

For README screenshots, use `npm run demo -- showcase --still`. Capture the cards and
the analytics separately in English and Russian, with the same viewport and preferences.
Keep a weekly window with its plan, forecast and a forecast label at the chart’s right
edge in view. Update `docs/dashboard.png`, `docs/dashboard.ru.png`, `docs/analytics.png`
and `docs/analytics.ru.png`, and refresh `docs/social-preview.png` with the current board.
Keep the existing presentation: the README images sit in a browser-window frame on
the coloured backdrop, with one card’s agents panel open; the social preview uses
the tilted board beneath its title. Preserve the typography, proportions and backdrop
when replacing the underlying screenshots, and compress the PNGs with pngquant.
Use only the demo’s synthetic accounts and machines.

`npm run bench` (after `npm run build`) runs such a still demo, opens Ana's board in
headless Chrome and holds it to the budget in `hub/bench/budget.ts`: for two minutes
(five without `--ci`) the idle page asks the hub nothing, is told nothing but `ping`,
renders and changes nothing but what shows time (and that no more than it reads
otherwise), and spends a fifth of the script it did before it was driven by events;
then twenty measurements of one card all show on it, 19 of them within a second,
rendering no other card nor the header (what shows time there, only as its clock would).
It prints what it measured as JSON and exits 1 over budget. It needs Chrome:
`QUOTUM_CHROME`, `google-chrome` or `chromium` on `PATH`, or `--cdp http://host:port` to
one already running. CI runs it on every push; run it yourself when you change the
dashboard and have Chrome.

## Pull requests

- **One task, one pull request.** A pull request takes one issue (or one fix) to `main`
  and is merged once it is done. Open it as a draft while the work goes on: CI runs on
  every push to it. Never open one only to run CI and close it after.
- **One pull request, one commit on `main`.** Pull requests are merged with *Squash and
  merge*: the pull request lands on `main` as one commit named by its title, so the title
  is written as a commit message is, a short English sentence about the result. Commits
  on the branch are for the work and the review; what review asks for goes into new
  commits on the same branch.
- **`main` changes only through pull requests.** Nothing is pushed to it directly, and it
  is never force-pushed or deleted.
- **No force-push without a strong reason**, such as a rebase onto `main` to resolve a
  conflict; when you do, say so in the pull request.

## What to keep in mind

- **The dashboard speaks English and Russian.** Every new string goes into both catalogs
  in `hub/ui/i18n`; the type checker and the tests will tell you if one is missing.
- **Both READMEs say the same thing.** A change to `README.md` goes into `README.ru.md` too.
- **The protocol is a spec.** Anything that changes what the agent sends or what the hub
  answers goes into [spec/ingest-v1.md](spec/ingest-v1.md) in the same change; what the
  hub tells its dashboard, into [spec/dashboard-v1.md](spec/dashboard-v1.md).
- **A released database layout never changes.** A new layout is a new step at the end of
  `hub/server/store/schema.ts`; `hub/server/test/schema.test.ts` guards the released ones.
- **The agent stays out of the way and out of your secrets.** It never reads provider
  tokens or cookies, never makes a model request and starts clients as rarely as it can.
  A new provider is an adapter in `agent/crates/core/src/providers/` that asks the
  provider's own command-line client, the way the existing three do.

[docs/architecture.md](docs/architecture.md) explains how the parts fit together.

### Tray, compact panel and notifications

The desktop's background reader must work with both windows closed. Use isolated
`QUOTUM_APP_DATA_DIR`, `QUOTUM_STATE_DIR` and `QUOTUM_CONFIG`, with providers disabled
or stand-ins. Never send real system notifications from ordinary unit tests.

For native acceptance on Windows, test both the installer and a portable ZIP in a
path with spaces, including a clean profile without an earlier installation. On
Linux test the packaged app with a tray watcher and notification daemon, then without
each and after restarting them. Use synthetic measurements to cross 30% and 10%,
confirm a reset, and supply a scheduled tracker fixture. Check the icon and actual
notification display with both windows closed, each setting off/on, notification
activation, and no replay after restart or sleep. OS suppression is distinct from a
successful native API call. On Windows restarting Explorer must restore one icon.

Open the compact panel, then the main window; close and reopen each in both orders.
Check long names, hidden windows, empty data, both languages, small displays and DPI
changes. Panel height is clamped to its monitor and never saved as the main window's
geometry. Its commands must fail from the main window, subframes, foreign origins and
closed instances. `node --test desktop/electron/policy.test.cjs` exercises the Linux
transport policy and two-window registry; native smoke remains necessary.

The demo's `/compact` page uses the same fixtures and store as its dashboard. It is
also available in a browser for visual inspection; native actions require the app's
bridge. Check it in English and Russian after `npm run build && npm run demo`.

For an isolated, explicit check of real native delivery, run the packaged executable
with `--smoke=notifications`. It creates temporary app/config/state directories,
disables every provider and tracker, then feeds synthetic 35%, 29%, 9% and 100%
measurements five seconds apart. Expect no initial alert, then low, critical and a
confirmed early reset. Close both windows before the sequence to check background
operation. This mode intentionally submits real silent notifications; ordinary smoke
and unit tests do not. It stays open for inspection until *Quit* and prints the
isolated directory, which can be removed afterwards. Tracker announcement semantics
are covered separately by fixtures, and real sleep/resume still needs native QA.
