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

After building the hub, `npm run bench -- --ci` in `hub/` checks dashboard costs in
Chrome (`QUOTUM_CHROME`, one on `PATH`, or `--cdp http://host:port`). It includes native
wheel and Shift-drag starting from the quota, budget and subscription-funds charts at
24h and 30d, moving all four charts with at least twelve real series per resource family and
CPU throttled fourfold. The scenario covers delayed history, strip rebuilding, reversal
and returning to live. Moving-frame intervals must stay within 34 ms at p95 and 50 ms
at p99; input to an actually updated chart frame must stay within 34 ms at p95. Empty
callbacks and missing samples fail. The previous idle, measurement, work and native
frequency-focus checks retain their budgets. Mixed Codex subscriptions also exercise
changed credit balances and unchanged-value heartbeats: each updates its own card and
funds history without waking quota or wallet analytics. No browser means the check
was not run.
DevTools commands keep their thirty-second response deadline. An explicit renderer
crash or target-detach event fails pending commands immediately, even if the socket
stays open, and retains the original failure before cleanup. It does not retry work.
Page-evaluation exceptions retain their original command and scenario too, without
page text or source. Later cleanup timeouts or crashes cannot replace the first failure.
Gesture-completion frames follow each data plot's actual HTML or SVG animation,
including a budget or funds plot that finishes after quota. The last input remains
uncredited until every data plot has finished and its final geometry has committed.
If the original settle wait fails, its captured panel state survives cleanup as
bounded numeric timestamps and readiness/loading/movement flags. No page text is
retained, and extracting that evidence sends no additional browser command.
Every original panning report also retains the largest native wheel timestamp and
delivery gaps within each feeding segment, and at most 32 numeric receipts for
address writes while input is being fed. Omitted receipts and invalid clocks remain
explicit. A single native scroll command can stop generating events while its target
is blocked; these observations distinguish that gap from continuous delivery without
changing the gesture-completion assertions or their 200 ms pause rule.
Failed scenarios retain these receipts and their pending inputs in the partial report.
A missing, retired or different scenario probe is marked unavailable instead of
attributing an earlier scenario's measurements to the failure.
`QUOTUM_BENCH_DIAGNOSE_PANNING=pairs` runs a fixed OFF/ON, ON/OFF, OFF/ON
experiment for bounded input/frame/history correlation. Every result is retained;
these diagnostic runs cannot satisfy the canonical gate. Input traces retain only
fixed native event types and numeric generation, compositor-delivery and main-handler
stages; interval tracks may be reused by later inputs, so attribution also needs the
original start/end timestamps. The optional
`benchmark-diagnostics` PR label requests the same experiment in a separate CI job.
`QUOTUM_BENCH_DIAGNOSE_PANNING=trace` (the `benchmark-trace-diagnostics` PR
label) records an owned synthetic browser's new intervals with numeric
script/layout/paint/GC events from `cc` and `devtools.timeline`, bounded to 32 MiB per
scenario. Broad task instrumentation is excluded from this diagnostic; its delivery
can exceed the unchanged five-second drain. This is opt-in. Trace data
never contains script sources, arguments, arbitrary URLs or user text. Missing
scheduler evidence and truncated timelines remain explicit. Trace events retain both
elapsed and thread CPU time where Chrome supplies them, with start/end page clock
markers. The opt-in timeline also records observed animation phases, including pending
start and the first sample after completion. These observations bound the phase;
they do not replace actual moving frames or prove physical presentation. Traces retain
compositor pipeline stages and interval-local numeric track identities, with reported
frame sequences, animation flags, main-frame duration breakdowns and raster layer/source
frame numbers. Raw opaque IDs and arbitrary arguments are omitted. A raster source
frame number is not a pipeline sequence; concurrent events alone do not establish a
dependency. Missing identities and unsupported fields remain unavailable. Collection
counts and handler duration, the original five-second drain stage and the end-command
acknowledgement distinguish incomplete trace delivery from a scenario failure. An
unconfirmed drain closes only its owned browser and stops the diagnostic; it preserves
any earlier scenario failure. CPU time
includes Chrome's Linux throttling spin and is not a JavaScript
cost estimate. Separate fixed busy/timer/busy controls run afterwards on an empty
owned tab, first without throttling and then at fourfold throttle. The unthrottled
controls must distinguish execution from timer waiting; both sets retain their
readings. Missing thread clocks cannot pass. Cumulative CPU differences use observed
anchors inside and outside each interval, never interpolation across missing samples.
Wall and CPU clocks are sampled independently: reported CPU can exceed elapsed time,
and that excess remains visible instead of being clipped. These are counter readings,
not exact on/off-CPU intervals. Off-CPU time alone cannot distinguish scheduler delay
from deliberate sleep or a lock wait. An input's final
geometry must still commit before it can be credited.
`QUOTUM_BENCH_DIAGNOSE_PANNING=cpu` (the `benchmark-cpu-diagnostics` PR label)
samples JavaScript stacks during each of the six original native scenarios in an owned
synthetic browser. It retains only numeric sample graphs, public bundle positions and
fixed browser operation names, bounded to 100,000 entries and 32 MiB per scenario.
Profiler setup and stop keep five-second deadlines; an unconfirmed stop closes its
owned browser and preserves an earlier scenario failure. Page clock brackets retain
alignment uncertainty. Sample widths include throttling and are not thread CPU time;
sampling overhead remains unqualified. V8's signed sample deltas and their original
order are retained; timestamps are never clipped. Fixed busy/timer/busy controls at
rates 1 and 4 follow on an empty owned tab. The unthrottled controls must distinguish function samples
from timer waiting; contradictory or missing calibration cannot pass. This is a
diagnostic result and cannot satisfy the canonical gate. If both CPU and trace labels
are present, the existing diagnostic job runs the CPU mode.
`QUOTUM_BENCH_DIAGNOSE_IDLE=double` (the `benchmark-idle-diagnostics` PR
label) checks one idle board, then two independent live copies over the same
real cell transition. The sum of their measured script costs must exceed the
single-board baseline. The report retains both costs, their ratio and whether the
sum crosses the unchanged 0.3 ms/s budget; crossing it is not required to detect
growth. Invalid measurements or no growth fail this sensitivity experiment, which
cannot replace CI.
The owned headless browser uses one raster worker: concurrent software raster jobs
in Chrome 154 can leave a tile unfinished and deadlock an input frame's commit.
An attached CDP browser retains its own launch settings.
The optional `benchmark-startup-diagnostics` PR label runs a fixed first/repeat launch
pair on three runners after the same benchmark fixture preparation. Each launch keeps
the 20-second deadline and a fresh profile. Numeric process, scheduler, I/O and pressure
counters are sampled separately from performance gates; missing counters and sampling
cost remain explicit. All six outcomes are retained, and a repeat success never replaces
a first failure. These diagnostics cannot satisfy the canonical benchmark.
An owned browser is ready only when its private `DevToolsActivePort` and a bounded
loopback `/json/version` reply identify the same browser. Its stderr announcement
is optional. Startup stays bounded at 20 seconds; cancellation drains pending tab
creation and closes every identified benchmark target, including auxiliary tabs.
Cleanup escalates only the owned process group and reports unconfirmed exits or
lost target-creation replies as failures. A profile is retained when exit cannot be
confirmed. Attached browsers and their existing tabs remain outside that ownership.
Launch diagnostics contain version, timing, process identity and classified stream
counters; arbitrary browser output and command arguments are omitted.
On Linux, the existing ownership reads also retain bounded root-process fault and CPU
tick samples during startup, and the first observed port publication time. No extra
process reads or sampling timers are added. These counters are not a scheduler trace;
missing samples and unsupported counters stay explicit.
`QUOTUM_BENCH_DIAGNOSTICS_DIR` keeps a unique run manifest and completed phase reports
before cleanup, including when a later phase fails. CI retains these artifacts for
every attempt. The `make bench` wrapper forwards this setting without loading preview
configuration. A pending CDP command still has its 30-second deadline; the canonical
observer does not pause JavaScript or start a profiler while waiting. On failure it
collects bounded liveness and command identity, without recording command parameters.
Debugger intervention belongs to an explicitly diagnostic replay, with mandatory
resume and owned-target cleanup, and cannot provide a passing canonical result.
The observer credits input after its coalesced position reaches the actual data layers
in the production RAF. Stationary input-free gaps are excluded; delayed pending input
remains measurable. A last input committed on release waits for the final geometry and
fold. These RAF proxies do not establish physical presentation.
The expected position respects the transaction's captured history and live bounds,
discarding overscroll on each delta as the gesture does. Every input remains measured,
including one that reaches an already displayed boundary without scheduling a new RAF;
stationary boundaries add no movement samples. Only the same gesture's reached position
can credit its input, so a new gesture cannot hide an unfinished previous gesture.

**The desktop app** (`desktop/`) shares a Rust controller between Electron on Linux
and Tauri/WebView2 on Windows. `node desktop/prepare.mjs` builds the hub, downloads
checksum-pinned runtimes, and writes icons and license notices. Run it before the
checks above. The desktop build requires Rust 1.90 or newer. Linux needs `libssl-dev` and `libgtk-3-dev` for the Rust build, `unzip` for preparation,
and Chromium's runtime libraries (`libnss3 libgtk-3-0 libgbm1 libasound2` on Debian).
`cargo run` in `desktop/` starts a prepared debug build. `node desktop/package-linux.mjs`
builds deb, rpm and AppImage; its packaging tools are `dpkg-deb`, `rpmbuild` and
`mksquashfs`. On Windows, `npx @tauri-apps/cli@2.12.0 build --target x86_64-pc-windows-msvc`
makes setup.exe; then `node desktop/package-windows.mjs` packages that build as a portable ZIP.
CI runs both the installed app and the extracted ZIP, including a path with spaces.
The release workflow calls the same Desktop workflow and publishes its packages only
after these checks pass; ordinary CI runs also keep the versioned release packages.
`desktop/smoke/windows-ui.ps1 <app.exe>` also checks ordinary startup with the real
window-state plugin: a visible, responsive window, restored bounds inside the monitor's
work area, close/reopen through a second launch, and a second launch while the window is
minimized, which restores that very window. It disables every provider. Each
run also opens and closes the tray panel three times, including Escape and a repeated tray
activation, checking that it stays visible and fits its monitor without changing the main window's geometry. Each
run also pauses only its own app UI thread and checks that the native loader stays
responsive, rounded and cancellable before WebView2 finishes. The thread is always
resumed. Each run starts from a fresh WebView2 profile, as the first start on a machine does: the one
in `%LOCALAPPDATA%\com.padurets.quotum\EBWebView` is set aside and put back afterwards.
With `-Diagnostics <dir>` it keeps bounded stage readings, owned process identities
and a manifest with the source and package hashes. CI uploads these on every run;
raw application logs and command lines are excluded. A separate observer samples the
owned UI and tray threads during a pause, with timestamps delimiting that interval.
It starts before the pause and is stopped only after the UI resumes; startup and stop
each wait at most two seconds. A stuck observer cannot delay resume. Wait-chain
artifacts exclude lock names and foreign thread identities, and retain partial samples.
A successful WCT call with only its root thread is inconclusive: unsupported waits
can hide their dependencies. It does not establish responsiveness or exclude a lock
dependency; native window checks still establish responsiveness independently.
A manual run of the Desktop workflow takes `ui-runs`, how many times
the UI smoke runs on the installed app and on the portable one each.
The queued-close check runs with the main window open and with only the compact
panel: a delayed close must neither lose the latest open nor crash the last WebView.
The handoff check also pauses the app UI just after accepting a main-window request,
then opens the tray panel. Its cross-process dispatch has a shared three-second
preflight/acceptance deadline; a timeout leaves acceptance unknown and never pauses
the UI. The native probe's accepted, rejected, unresponsive and late-response cases
run through `desktop/smoke/test-window-probe.ps1`. That newer panel must keep focus; an obsolete main creation
must leave no hidden WebView after it is cancelled.

Run `node --test desktop/electron/policy.test.cjs` for the Linux bridge/navigation
policy. CI runs the installed packages with `--smoke`: the hub starts, a stand-in client
is measured, its board appears, the window opens twice and the app quits. Linux checks
need `xvfb`, `xauth` and Python 3; `desktop/smoke/monitor.py` adopts surviving
children and audits their exits, alongside Electron's live child-failure reports.
This uses no ptrace and keeps Chromium's sandbox intact. The installed-package checks also start the controller before a stand-in tray watcher
(`desktop/smoke/tray.sh`, Python 3 with PyGObject) to cover early start at login.
The panel check also queues three activations while its own controller is briefly paused,
then verifies that the final open survives delayed focus events. It pauses its browser,
queues a main-window reopen followed by a newer tray activation, and checks that the
main window never takes focus from that newer loader or panel when the browser resumes.
With an existing browser still paused, it also queues a loader close/reopen and checks
that the retired loader's focus event cannot cancel the replacement. The native GTK
callback regression runs separately under Xvfb:
`xvfb-run -a cargo test --locked native_signals_keep_their_presentation -- --ignored --test-threads=1`
in `desktop/`. It uses real GTK signals and checks that retired windows are released;
ordinary `cargo test` skips this display-dependent test. CI runs both.
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

### Trusted-key storage

Ordinary tests use synthetic keys and store ports. The real system-store tests are
explicitly ignored, create their own random namespace, and need an isolated backend.
On Linux, prepare a protected directory under your home (not `/tmp`, whose writable
ancestors are deliberately refused), then run the GNOME Keyring checks on a private bus:

```sh
mkdir -p "$HOME/.cache/quotum-key-tests"
chmod 700 "$HOME/.cache/quotum-key-tests"
export QUOTUM_TEST_PRIVATE_DIR="$HOME/.cache/quotum-key-tests"
export QUOTUM_KEYRING_SMOKE=1
export XDG_DATA_HOME="$QUOTUM_TEST_PRIVATE_DIR/keyring-data"
cd desktop
dbus-run-session -- sh -c 'printf quotum-test-password | gnome-keyring-daemon --unlock > /dev/null && cargo test --locked native_store_is_local_scoped_byte_safe_and_recovers_without_pointer -- --ignored --test-threads=1 && cargo test --locked native_controller_recovers_pointer_stages_rotation_and_preserves_foreign_keys -- --ignored --test-threads=1'
```

Windows CI runs the scoped Credential Manager roundtrip with Local persistence,
reads it in a new process and tests private ACLs, rejection of junctions and deletion
through the same checked native file handle. It also checks the native controller's
file-to-store rotation cleanup and the isolated key helper. CI does
not prove persistence through a real reboot or access from a noninteractive logon.

Use a dedicated test profile for that acceptance, with the installer and the portable
ZIP in a path with spaces. From PowerShell, run the helper with the actual executable:

```powershell
./desktop/smoke/keys-windows.ps1 -App 'C:\path with spaces\quotum-desktop.exe'
```

It disables all providers, isolates config/state/app data under
`%LOCALAPPDATA%\Quotum key QA`, and reads only the exact key target in that profile's
marker. Before a launch it marks start-at-login as already decided in that profile,
keeping its other app settings, so the person's global Run entry is unchanged.
`-VerifyOnly` does not launch the app or change the profile's configuration or ACL;
it writes only its safe result report. The report contains the target, protection
result and start-at-login check, never key bytes.
Open app settings in English and Russian: expect system-store protection, no file
history and no reset action. Quit and run the helper again; the target must be the
same. Reboot without deleting the profile, then run the helper with `-VerifyOnly`;
the same Local credential must be readable before the app starts. Run it with
`-Hidden` to check background startup and reopen through a second launch.

For the noninteractive case, use Task Scheduler under the same test user with
*Run whether user is logged on or not*, and run the helper with `-VerifyOnly`, then
`-Hidden`. Pass `-Work` with the exact profile path from `key-report.json`; do not
depend on that logon's default environment selecting the same app-data path. Keep
the task's result and safe report. When that logon can access the
user's credential store, expect the same target. If it cannot, expect waiting and
preserved data, with no replacement key or implicit reset. Hidden startup in an
interactive session is a separate case, not proof of a noninteractive logon. Remove
only this test task, its recorded exact credential target and its isolated profile
after acceptance; leave the person's other credentials and app profile alone.

On Linux, also run open and locked KWallet and KeePassXC, including an absent default
collection. Each test bus must have one Secret Service owner. An unavailable or locked
default must not cause a new store key. The ignored
`native_controller_keeps_one_pending_unlock_and_accepts_its_late_result` uses the real
controller and store: it creates its own fixture, asks the driver to lock the default
collection and send a newline, then holds one unlock beyond 60 seconds. Count the
visible prompt, unlock it and expect recovery with the same target. Repeat with
`QUOTUM_TEST_UNLOCK_CANCEL=1`, cancel after the deadline and expect waiting with the
marker preserved. The cancelled fixture stays in that disposable backend for
inspection. Do not run these destructive lock scenarios against a person's keyring.

For settings-only visual checks, `cd hub && npm run demo:keys` serves seven safe app
states at its printed loopback address. Select `?state=waiting&lang=ru` or the other
states listed in `hub/demo/key-storage.ts`. Check both languages, a narrow window and
reset confirmation. This fixture has no native store authority; also inspect the
actual packaged app. The board benchmark and ordinary package smoke remain required.

## The demo board

### Worktree development stands

On Linux with Node 24, Make, Git and `flock`, a checkout has an isolated managed stand:

```sh
make dev       # prepare, install dependencies, build current code and start the all demo
make info      # actual instance, build, addresses, fixture login and resource budget
make logs      # last 200 lines of this stand's log
make dev       # reuse unchanged code; rebuild and restart after source/configuration changes
make down      # stop only this stand; keep its port reservation
```

The root `.env` is local and ignored. `make prepare` writes missing development
defaults and the lowest available port at or above `DEV_PORT_START` (8080 by default).
It preserves existing user settings and never evaluates shell expressions. Existing
worktrees reserve their saved ports even while stopped; listeners and unknown external
access policies are excluded. Removed trees release their numbers after their owned
processes exit. The first probe/bind race retries ascending numbers up to eight times;
an established port conflict fails with a diagnostic. To change an established port,
stop the stand, edit `QUOTUM_PORT` in `.env`, then run `make prepare` and `make dev`.
An explicit environment port is saved too. Initial claims keep a recoverable intent
before updating `.env`; existing configuration symlinks are preserved and rejected.
Concurrent changes to managed `.env` settings stop preparation or startup with a
diagnostic; retry the command with the current file. A change during the build leaves
the previous live stand available.

Settings are in [.env.example](.env.example). `DEV_SET=showcase DEV_STILL=true make dev`
uses the still showcase; `DEV_SET=activity` uses the activity set. `DEV_RESETS` selects
a scene from `hub/demo/catalogue.ts`. `DEV_SET=money DEV_STILL=true make dev` places subscriptions beside
the monetary cases on Ana's personal board: balance and caps, large key inventory,
revoked and expired access, a history gap, negative balance, zero cap and an unknown
provider. `DEV_SET=quotas DEV_STILL=true make dev` shows personal z.ai subscription
quotas in credits, unknown resets, exhausted and closed allowances, partial and
unsupported readings, and private access failures. The other catalogue cards remain
available through Add widget.
`DEV_SET=analytics DEV_STILL=true make dev` shows native quotas, z.ai, OpenRouter and DeepSeek with the quota and budget analytics and the separate subscription-funds chart.
`DEV_SET=onboarding DEV_STILL=true make dev` exercises board and account onboarding.
Ana owns *Studio* and *New board*; Boris is a member of both. OpenRouter starts
unconnected. Add widget offers synthetic keys for successful, partial and failed
answers, a lost-reply control, and an explicit subset from a synthetic device report.
Services, encrypted storage, receipts and board events use production code; only
external answers and device reports are synthetic. No real provider or client is
contacted. Use `make info` for the actual address and synthetic sign-in.

`DEV_MODE=hub make dev` starts an ordinary hub on
isolated persistent data with reset trackers disabled. No mode starts coding clients.
Hub mode provisions its persistent key automatically in the private `hub-keys`
directory outside `hub-data`. Explicit `QUOTUM_SECRET_KEY_FILE` overrides remain
supported; relative paths start at the checkout root and must stay outside data and
version control. Demo, builds and component checks do not inherit
it. After changing a key file's contents, restart with `make down` and `make dev`.
Changing mode restarts the owned stand. Demo data goes away on stop; hub data stays in
`.quotum-dev/hub-data` until the tree is removed. Managed state, build stamps and logs
are private local files, outside source control. Info labels demo fixture defaults and
never shows them for an ordinary, stopped or unverified hub; it never dumps real
credentials. A failed build leaves an earlier live stand available.
Successful builds freeze the server, demo source and supervisor together. Later source
edits enter a new build, and managed data is removed only by the controller after its
ownership check. A directory supplied to the standalone demo remains caller-owned.
The launcher records supervisor ownership before authorizing startup. An interrupted
registration cannot start a backend later; an already registered process remains
available to verified cleanup after its launcher exits.

The optional `DEV_ACCESS=coder` profile requires `PUBLIC_DOMAIN` and the workspace/agent
metadata in the example (the agent environment may supply them). It verifies that
metadata through the existing Coder CLI login. Tokens are read only at runtime, never
copied into `.env` or journals. After local readiness it publishes only the selected
port as HTTP/public. A known matching entry is reused without a POST. Unknown/different
policies are preserved. A lost response keeps an unconfirmed intent; later matching
observations permit read-only reuse, without granting ownership for destructive changes.
`make info` observes access again and reports failures separately from local readiness.
Configured access requires an available policy authority before claiming a port or
starting a changed stand; an existing runtime is kept on failure. A definite auth or
validation rejection can be retried after correction. An uncertain request stays
unconfirmed even when a later GET sees no row, and info keeps that distinction.
`make down` and removal perform no provider mutation and work during authentication or
API failures. Pool records may remain public after stop; provider tickets follow the
provider's semantics. A reused public port may be reachable during bootstrap. Concrete
domains, workspace values and credentials belong only in local configuration.

Use the configured remote browser for visual checks. This workflow installs no browser.
The existing benchmark still needs Chrome or its supported CDP connection; a missing
browser is not a passed benchmark.

#### Worktrunk integration

`make install-dev` installs a versioned shared hook runner in Git's common directory.
Configure blocking **user** hooks for this repository, using the printed absolute path:

```toml
[projects."github.com/owner/repository"]
worktree-path = "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}"
pre-start = "node /absolute/common/quotum-dev/hook.mjs hook-prepare {{ worktree_path }}"
pre-remove = "node /absolute/common/quotum-dev/hook.mjs pre-remove {{ worktree_path }}"
```

Put optional non-secret defaults in that private hook environment, such as
`DEV_PORT_START`, `DEV_ACCESS`, `PUBLIC_DOMAIN` and `SLOT_CPUS`. Do not copy a primary
checkout's `.env` into every tree. Update the shared runner with `make install-dev` after
updating the tooling. The runner remains available when a branch lacks its local
scripts: it cleans recorded managed state, or reports an unsupported state version.
An unmanaged old branch gets a diagnostic, without adopting its legacy processes.

With Worktrunk's interactive shell integration:

```sh
wt switch --create feat/NN-task-name
make dev
# After the task has been integrated and the tree is clean:
wt remove
```

For independent agent tool calls, use `wt switch --create ... --format=json`, retain
the returned **actual path**, and pass that as the next tool command's working directory.
A child shell's `cd` does not change a later tool call. Alternatively,
`wt switch --create feat/NN-task-name --execute 'make dev'` runs in the destination.
Bare removal in the current tree is sufficient; `--foreground` is optional. The shared
pre-remove hook independently checks the target's Git status, including hidden untracked
files and regardless of `status.showUntrackedFiles` or inherited Git relocation settings,
**before** stopping its runtime. Direct `make down` works with dirty source. Neither
path touches another stand or shared caches. The hooks do not authorize Git integration:
tasks still merge through their GitHub pull requests.

`make dev-test` checks allocator concurrency, process ownership, cleanup and publication
recovery with stand-ins. CI runs it on Linux. `make check-hub`, `make check-agent` and
`make check-desktop` run the component gates above, with Rust and desktop preparation in
shared Docker images/caches. Heavy operations serialize per repository, with
`SLOT_CPUS=4` by default; that is a build budget, not a cgroup limit. Image overrides
are `DEV_RUST_IMAGE` and `DEV_DESKTOP_IMAGE`. Checks and `make bench` do not load `.env`
and strip preview address/data/access/local-mode variables. The benchmark accepts
`QUOTUM_CHROME` or `BENCH_CDP` explicitly and retains its existing CI gate and budget.

A change to the dashboard is looked at on the demo board, with every state it can meet
that lasts on a working hub:

```sh
cd hub && npm run build && npm run demo
```

It starts the built hub on throwaway data (in the system's temporary folder), fills it
with the catalogue in `hub/demo/catalogue.ts`, with the days its agents worked before it
started, and keeps it alive: machines measure, agents start, work and stop, a machine
sleeps. Live devices accept refresh requests from their cards; only the explicit legacy
scene simulates a device without that support. The reset trackers are stood in for, so
it needs no network and no account. It prints the address and how to sign in; Ctrl+C
stops it and leaves nothing behind. `npm run demo -- showcase` opens the clean board
the README images come from; `--resets <scene>` picks what the reset trackers say (one
scene a run, the list is printed). Set `QUOTUM_PORT` if 8080 is taken. After changing
the UI, `npm run build` and reload the page; after changing the server, `npm run build`
and start the demo again.

A new state of the board gets an entry in the catalogue, with the codes it shows in
`expect` (the file's header explains them): `npm test` then checks it holds, and it is
on the board for the next person. One a working hub never holds for long is named in the
header instead, with the tests that hold it. `npm run demo -- --still` keeps the board
still: nothing is measured after the start, and no card goes stale for three hours; running
agents still work and their credited activity advances.

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

Refresh `docs/openrouter.png` and `docs/openrouter.ru.png` from
`npm run demo -- money --still` too. Show a healthy wallet's balance and capped keys
beside a subscription, with the same viewport, crop and browser-window frame in both
languages.

`npm run bench` (after `npm run build`) uses a still demo whose agents repeat their
lists without working, opens Ana's board in headless Chrome and checks the budget in
`hub/bench/budget.ts`. During warmup no `history` may arrive. For two minutes (five
without `--ci`) an idle board with neither measurements nor working agents asks nothing,
is told only `ping`, renders and changes only what shows time, and spends a fifth of
the script it did before events. Then twenty measurements reach their card and chart,
19 within a second, reading a small tail of history rather than the whole period.
Finally the stand's laptop reports one working agent: each credited report makes at
most one small history read and renders only its card, agents and analytics. The report
prints latency, history bytes and reads as JSON and exits 1 over budget. After the
readings, it also checks that consecutive frequency saves with native arrow keys keep
focus in the card's menu and fails otherwise. It needs Chrome:
`QUOTUM_CHROME`, `google-chrome` or `chromium` on `PATH`, or `--cdp http://host:port` to
one already running. CI runs it on every push; run it when you change the dashboard
and have Chrome.

The history traffic matrix runs first, while the seeded measurements age, and closes
its temporary pages before the idle board opens. The same warmup requirements still
apply. Idle measurement starts at a planned grid phase with its endpoints away from
minute ticks and includes one real five-minute cell transition in each chart.
Reports retain planned and observed bounds, transition counts and actual
performance duration; missing coverage is a failure and the 0.3 ms/s budget includes
the transition's work.

The completed measurement phase's React/DOM observer is disconnected before native
panning. Native wheel and Shift-drag start separately from the subscription limit, budget and subscription-funds
charts at both periods. Each input owner starts with fresh readers, captures its own
events and must move all four plots within the same budgets.
Panning keeps its own movement and mutation checks; resetting the measurement
probe resumes full observation for money updates. Money-view controls wait for a
populated, committed drawing and stable layout before switching, then require the
line to remain present and inside its scale on every frame until the new view commits.

The same run checks pan traffic separately from the native frame budget, using the
dense 75-day fixture and all four charts at 24h and 30d. Controlled production-loader
replays and native browser gestures use 0, 100 and 400 ms answer delays. Cached
return and repeat must start no history GETs; half-width movements allow at most
seven attempts from the history chart and five from activity, and a 4% movement
allows two. Seed and independent reference reads are excluded. A benchmark-owned
loopback proxy uses fixed Brotli settings (quality 4, text mode, window 22), without
adding production compression. Decoded JSON may reach 1.5 times, and encoded body
bytes twice, the reference for the exact missing union and permitted buffer or
within-tile bridge. The report separates complete bodies, partial byte bounds and
unknown transfers; headers are never counted as body bytes. Independent whole-cell
composition also checks series, activity and events. Each history attempt gets its
fixture identity before HTTP starts, so aborts before response headers cannot borrow
another attempt's byte proof. Separate real HTTP and native Shift-wheel cohorts
exercise cancellation before headers, after delivery and reversal with a repeated
query. Controlled production staging also verifies a delivered answer discarded
before publication; native transport observations do not infer staging disposition.
Reports retain attempted/completed/failed/aborted counts and uncertain body bounds.
Proxy sockets and traffic tabs
close before the benchmark stops its own demo.

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
Repeat a tray click while the panel is visible and while it is loading: both dismiss
it. On X11/XWayland, the native loading surface appears before Chromium starts;
check Escape and outside clicks during loading too. Neither loading nor ready panel
belongs in the taskbar. `QUOTUM_TEST_PANEL=1 xvfb-run -a sh desktop/smoke/tray.sh <app>`
checks the native handoff and cancellation with its own suspended browser on a
private bus, with providers disabled. It verifies the controller ancestry and process
birth before using a pidfd for pause/resume. `QUOTUM_SMOKE_DIAGNOSTICS_DIR` saves
bounded native window and process timelines before temporary data is removed.
Check a click outside followed by a new tray
click too, so the blur from the same press cannot reopen it or consume a different
gesture.
On Wayland, also open *Limits* from the tray menu before any direct tray click,
after using an X11 window on another monitor. It must use the primary monitor's
reserved panel edge; after a direct tray activation, the menu must keep that tray
position even when the last X11 pointer was on another monitor.
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
