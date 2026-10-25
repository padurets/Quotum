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

The explicit Linux storage-recovery check runs the production CLI and Runner against
HTTP and SQLite, with synthetic native clients under a separate UID and an owned
1 MiB tmpfs. It covers exhaustion during capture and privacy initialization, repair
in the same process and queue, immutable retries, continuing check-ins, unknown gaps
in both work and coverage, CPU use during a prolonged outage and bounded stop. Build
the release CLI and the `observed_probe` example (the example needs the
`quotum-core/activity-bench` feature),
then, from `hub/`, run:

```sh
node --import tsx bench/observed-storage-recovery.ts ../agent/target/release/quotum /absolute/path/to/previous/quotum
```

The optional second binary reproduces the old failure before checking the current
one. The check needs Docker and the `quotum-rust` development image; it never starts
real clients or changes a running collector. The separate journal/HTTP recovery
matrix remains in `bench/observed-recovery.ts`.

After building the hub, `npm run bench -- --ci` in `hub/` checks dashboard costs in
Chrome (`QUOTUM_CHROME`, one on `PATH`, or `--cdp http://host:port`). It includes native
wheel and Shift-drag starting from each five-hour limit, weekly limit, agent activity,
budget balance and subscription-funds chart at 24h and 30d, moving
all five charts with at least twelve real series per resource family and
CPU throttled fourfold. The scenario covers delayed history, strip rebuilding, reversal
and returning to live. Moving-frame intervals must stay within 34 ms at p95 and 80 ms
at p99; input to an actually updated chart frame must stay within 50 ms at p95. Empty
callbacks and missing samples fail. Idle, measurement, work and native
frequency-focus checks also apply. Mixed Codex subscriptions also exercise
changed credit balances and unchanged-value heartbeats: each updates its own card and
funds history without waking quota or wallet analytics. A separate fixed Activity phase at 24h and 30d checks paint-only emphasis,
shared-filter totals and bar values, clean-cell reuse, coalesced late work, cancelled
responses and all transport/preparation costs under the existing pool limits.
Emphasis owns no reader and receives no extra-read allowance.
Each fixed Activity period saves its bounded pool journal before checking completeness.
With evidence enabled, its existing final phase sample also retains the journal before
assertions. A failed page saves that partial snapshot and its phase before closing;
it adds no recovery command, and its sampling cost stays in the reported CPU duration.
Its larger diagnostic capacity retains the monthly ownership snapshots; omitted entries
still fail the check, and the product's memory and transport limits stay the same.
No browser means the check was not run.
UTC calendar-only card events must match the stream's unchanged observation
baseline and the exact new period. Raw traffic remains reported; missing, repeated or
unrelated updates fail. This exception permits no extra page rendering or requests and
retains the 1 ms/s idle script budget.
The idle artifact retains the original performance timestamps, script-duration counters
and unrounded probe time used in its calculation, so the reported rate can be recomputed.
CI runs the unchanged history traffic matrix and dashboard phases on separate runners,
each with a 20-minute job limit. `--scope history` selects the matrix, including native
traffic and cancellation checks; `--scope dashboard` selects idle, measurements, work,
frequency, all ten native panning scenarios, subscription credits, currency checks and fixed Activity shared filters.
The `bench` check passes only when both jobs succeed; a failed, skipped or cancelled job
fails this check. The default `--scope all` runs the history matrix first, then every
dashboard phase in the same order as `--scope dashboard`. CPU diagnostics (`trace`,
`profile`, `native-trace`, `native-profile`) support `all` or `dashboard`; caption control
requires `dashboard`. The ordinary history job attempts to prepare GDB and matching
Chrome unwind tables in an optional two-minute step inside its existing job limit.
Its setup result remains visible; setup failure still runs every benchmark check.
Native capture starts only after the original command deadline fails and retains
the original failure. The optional `history_pool_control` manual CI input runs the full
history matrix in its existing job with the existing bounded cache observer. It requires
an exact `diagnostic_ref`, compiled-client hash and clean checkout, and rejects other
diagnostic inputs. CI prepares the existing native debugger and matching unwind tables
for capture after a failed command. Passive navigation listeners add no commands; late
renderer binding and native capture keep their existing postfailure deadlines. It adds no retries
or budget allowance; its artifacts cannot satisfy the required `bench` check. The observer
can identify cache eviction and reservation pressure in this instrumented attempt. It
does not preserve fixed-summary shift proofs or every gesture's scale, so a different
repeat range can remain unexplained. Its pinned history-only mode also retains up to
four server preparation refusals, each from a validated stderr record of at most 2048 bytes.
They preserve the original reservation and distinguish input admission, preparation
and work-access revalidation. Numeric request summaries have no physical attempt binding;
compare them with recorded traffic before attributing a delivered HTTP failure.
Missing records remain inconclusive. Locally this mode also accepts `--scope history`
with the same source and client pins; its default `all` scope remains available.
Other optional diagnostics require `all`. Separate jobs retain
normal warmup, chart-grid alignment and budgets.
Manual CI without diagnostic inputs runs the same ordinary checks. A diagnostic
mode still requires an immutable source SHA and the expected compiled-client hash;
missing identity cannot turn a diagnostic request into a successful ordinary run.
Chrome readiness has one twenty-second window starting immediately before the launcher
is spawned, including its work and endpoint validation.
DevTools commands keep their thirty-second response deadline. An explicit renderer
crash or target-detach event fails pending commands immediately, even if the socket
stays open, and retains the original failure before cleanup. It does not retry work.
Ordinary owned Linux history pages keep a pressure journal in their existing bootstrap.
It snapshots numeric cache identities when the pool trims and records later tagged
requests. A known warm-read failure exports at most 64 events and 64 KiB within a
cancellable two-second window, preserving the original assertion. Truncated or unbound
evidence remains inconclusive. Its transport binding adds observation work whose timing
effect is unmeasured; the full pool diagnostics and dashboard keep their existing observers.
The existing five-second pending-command observation also retains at most 32 owned
Linux process identities and raw proc counters, followed by one read after failure
before debugger intervention. Each cancellable read is bounded to one second within
the existing observation/collection windows. Host monotonic timestamps bracket the
reads; missing processes and capped entries remain unknown. Attached browsers are
not inspected. Matching process IDs and birth ticks permit counter differences,
not page attribution, continuous responsiveness or a cause of the timeout.
After an owned command has failed and its page probe does not respond, Linux may
capture one native renderer snapshot using an already installed system GDB. The renderer
with the largest cumulative CPU counter is selected when no target binding was supplied;
this does not bind it to the failed page. A supplied binding limits capture to its PID
and pinned process birth. PID, birth, group, session, UID and tracing state are checked before
attach. Bounded thread identities and fixed wait classes are retained, never
raw debugger text. Up to sixteen main-thread frames additionally retain a validated
file-backed module build ID and file offset, or a fixed reason why that position is unknown.
These offsets are resume addresses relative to the file, not ELF virtual addresses or
proof of a function name; they do not satisfy the control's named-frame check.
Anonymous executable positions remain unknown; a file location alone does not identify
whether code was generated. Map reads are capped at 1 MiB and 8192 entries.
Capture and helper cleanup use the existing five-second
collection and two-second release windows. An unconfirmed detach, helper exit or
pipe closure fails cleanup. Missing GDB falls back to the existing page debugger;
attached browsers and successful commands receive no native intervention.
On Linux, ordinary owned history pages retain their original navigation identity passively,
without extra commands before failure. Missing identity does not gate successful input.
After an original failure and an unresponsive page probe, the existing two-second
resolver may bind capture to that document's renderer. Missing optional metadata keeps
the explicitly unbound capture above; an attempted but incomplete mapping permits no
native or debugger intervention. Resolution shares the original five-second collection
window, so insufficient remaining time can still leave capture incomplete.
The manual CI `native_postmortem_control` qualifies this collector on the requested
source and built-client hash using a separate runtime UID and matching unwind tables.
Before the forced command, a completed metadata trace binds the page's primary frame
to an owned renderer and its process birth. Missing or invalidated identity fails the
control; capture receives only that pinned process and rechecks its birth before attach.
This preparation is diagnostic and does not run in ordinary benchmarks.
After the command fails, the control also resolves identity on the original page
connection using browser navigation evidence retained before the original navigation.
It must match the pre-input PID and birth at both ends of native capture, within the
existing collection limits. This independent pre-input oracle remains part of SDK
qualification; it does not run in the direct history scroll control.
It holds one synchronous HTTP request from its own fixture page until the original
30-second command timeout, then requires native main-thread frames and confirmed
cleanup, including the fixture's pending connection. This exercises native unwinding;
JIT frame unwinding is not qualified. It does not execute the app client,
reproduce the original intermittent hang, qualify forced helper failures or replace
either required benchmark job. Select it without any other diagnostic mode.
Diagnostic CI controls install GDB during setup and first start it after the original
command failure. Package installation can affect the OS file cache; this does not
qualify an untouched runner's cold debugger startup. Ordinary jobs do not install it.
Page-evaluation exceptions retain their original command and scenario too, without
page text or source. Later cleanup timeouts or crashes cannot replace the first failure.
During fixed Activity, a handled process interrupt retains the pending command and
last reply before cancellation clears them. This local snapshot sends no browser request;
hard kills, a blocked Node process and an interrupted write can still leave it unknown.
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
Moving-frame outliers retain the number of sampler entries since the previous moving
frame and the largest gap between those entries, including repeated RAF timestamps.
They also retain elapsed sampler-body time within that interval, excluding the current
body. It is diagnostic only and is never subtracted from frame or input budgets. The
extra clock read has overhead; this is not CPU time or a complete overhead correction.
These entries do not count every RAF callback or establish CPU ownership or presentation.
The original idle interval can be inspected with
`QUOTUM_BENCH_DIAGNOSE_IDLE_CPU=trace` or `profile`, using `--ci` and an owned
synthetic browser. These optional modes support `--scope all` and `--scope dashboard`
and retain the original 120-second idle window. The manual CI control uses `dashboard`,
so its artifacts contain no history matrix; `all` runs the matrix before the dashboard.
Numeric source bindings and bounded raw evidence remain
separate from the required benchmark; observer overhead is unqualified.
The manual CI control checks the requested checkout and compiled client hash before
running. Neither diagnostic mode can satisfy the required benchmark.
Work traffic retains bounded request shapes and numerical transfer counts. After all
three work verdicts, at most three response-body reads partition the decoded JSON into
exact section sizes and retain fixed section states and array counts. Passing replies
remain available for comparison with intermittent overruns; original transferred-byte
limits remain unchanged.
History traffic also partitions its existing metadata-only cold replies after the
original verdict, retaining at most eight bodies of 1 MiB each and reporting omissions.
Native outliers retain their wheel, drag or return origin and the final sample's
running and moving chart masks, with bits ordered quota, activity, budget, funds,
session. These masks do not describe the whole measured interval.
The owned headless browser uses one raster worker: concurrent software raster jobs
in Chrome 154 can leave a tile unfinished and deadlock an input frame's commit.
An attached CDP browser retains its own launch settings.
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
tick samples during startup, and the first observed port-read time. No extra
process reads or sampling timers are added. These counters are not a scheduler trace;
missing samples and unsupported counters stay explicit.
After an uncancelled startup deadline, Linux x64 may collect one root-process wait
sample in an isolated Node helper. Its parent has a 200 ms budget within the existing
seven-second cleanup window; it adds no wait before TERM. PID, birth, process group,
session and UID are checked before and after the reads. Only process states, bounded
kernel symbols, a syscall number and an FD class are retained. Addresses, paths and
syscall arguments are omitted. Identity bookends are not an atomic wait snapshot;
missing access stays unknown, and unconfirmed helper cleanup stays a residual failure.
`QUOTUM_BENCH_DIAGNOSTICS_DIR` keeps a unique run manifest and completed phase reports
before cleanup, including when a later phase fails. CI retains these artifacts for
every attempt. The `make bench` wrapper forwards this setting without loading preview
configuration. A pending CDP command still has its 30-second deadline; the canonical
observer does not pause JavaScript or start a profiler while waiting. On failure it
collects bounded liveness and command identity, without recording command parameters.
The first failed command stays recorded through cleanup, including protocol rejections
and page evaluation failures. Its saved identity contains neither browser error text
nor the evaluated expression.
After the original deadline has failed, a postmortem may pause the same failed owned
target to collect bounded stack locations. Its report marks that intervention;
mandatory resume and owned-target cleanup follow, and the original failure is retained.
Before pausing, a fresh connection to that exact owned target runs the same page probe
within the existing two-second window. A reply records responsiveness through that session;
it does not identify the cause of the original timeout.
An explicit diagnostic replay may also intervene. Neither can provide a passing
canonical result.
`native-trace` and `native-profile` observe `activity/24h` by default. With either
mode, `QUOTUM_BENCH_NATIVE_TARGET=session/30d` selects the five-hour limits chart at
30d; the manual CI input `native_target` chooses the same cell. All dashboard
scenarios keep their workloads, budgets and deadlines. The `session/30d` selection
also writes `native-panning-receipt.json` after its measured report freezes. Movement
intervals, consumed inputs, wrapped RAF callbacks and preparation slices share a
4096-entry journal and a 4 MiB artifact bound. Missing coverage or overflow is
insufficient evidence; trace overlap does not establish causal ownership, and
instrumented runs cannot satisfy the required benchmark.
The optional native trace retains fixed raster, tile preparation and activation scopes
from its existing `cc` category, with numeric preparation IDs and task counts. These
IDs are local to a tile manager; completed CPU tasks do not prove GPU readiness or
identify the owner of a blocked commit.
The observer credits input after its coalesced position reaches the actual data layers
in the production RAF. Stationary input-free gaps are excluded; delayed pending input
remains measurable. A last input committed on release waits for the final geometry and
any active fold. These RAF proxies do not establish physical presentation.
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
responsive, rounded and cancellable before WebView2 finishes. A finally block always
attempts to resume the thread. Stage readings keep their original timestamps in bounded
memory during pauses; file writes follow the last confirmed resume. An unconfirmed
resume fails the smoke and keeps the buffered stages unpublished.
Each run starts from a fresh WebView2 profile, as the first start on a machine does: the one
in `%LOCALAPPDATA%\com.padurets.quotum\EBWebView` is set aside and put back afterwards.
With `-Diagnostics <dir>` it keeps bounded stage readings, owned process identities
and a manifest with the source and package hashes. CI uploads these on every run;
raw application logs and command lines are excluded.
A manual run of the Desktop workflow takes `ui-runs`, how many times
the UI smoke runs on the installed app and on the portable one each.
The packaged Windows UI checks include `-StaleDismissalControl`: after the original
ready and cancellation cases, a third paused-UI case queues close/open callbacks and
closes the older native loader. The latest accepted loader must remain visible,
rounded, foreground and responsive within the original three-second deadline, and
hand off to the ready panel after resume. Numeric observations and cleanup receipts
are retained. This checks stale dismissal separately from activation continuation.
The queued-close check runs with the main window open and with only the compact
panel: a delayed close must neither lose the latest open nor crash the last WebView.
The handoff check also pauses the app UI just after accepting a main-window request,
then opens the tray panel. Its cross-process dispatch has a shared three-second
preflight/acceptance deadline; a timeout leaves acceptance unknown and never pauses
the UI. The native probe's accepted, rejected, unresponsive and late-response cases
run through `desktop/smoke/test-window-probe.ps1`. That newer panel must keep focus; an obsolete main creation
must leave no hidden WebView after it is cancelled.
With `-Diagnostics`, Windows UI smoke also enables `QUOTUM_WINDOW_PROBE=1` for
the owned app and reads its loader's numeric window property. Its hexadecimal
nibbles retain nested operations: 1 idle, 2 position, 3 rounding, 4 show,
5 foreground, 6 focus, 7 timer, 8 update, 9 hide, A completion, B dismissal,
C paint, D blur and E repeated show. The failed one-second response check
captures this property before the mandatory UI resume, without sending another
message to the tray thread. The original failure remains a failure. Missing,
malformed and foreign readings are unavailable. These best-effort markers identify
the last published operations; they do not establish a wait dependency or qualify
the diagnostic's timing overhead. Ordinary app runs do not publish them.

Run `node --test desktop/electron/policy.test.cjs` for the Linux bridge/navigation
policy. CI runs the installed packages with `--smoke`: the hub starts, a stand-in client
is measured, its board appears, the window opens twice and the app quits. Linux checks
need `xvfb`, `xauth` and Python 3; `desktop/smoke/monitor.py` adopts surviving
children and audits their exits, alongside Electron's live child-failure reports.
Navigation failures record the window instance, original and current activation request,
navigation sequence and hub generation, native error number, code availability and
presentation state before smoke exits. They never record the destination, entry key or
raw error message.
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

Shutdown gives the hub five seconds to finish requests and close its store. Demo and
managed parents wait seven seconds before killing a child; the outer managed fallback
waits eight seconds. Ordinary shutdown completes as soon as work drains.

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
`DEV_SET=filters DEV_STILL=true make dev` opens a populated mixed-resource board and
a separate board with an empty saved project selection beside retained resource
measurements. Sign in as Ana to save
opening defaults, or Ben to explore current filters and Restore without Save.
`DEV_SET=links DEV_STILL=true make dev` shows temporal client links, suggestions with
their exact free intervals, inactive targets, account disagreements, spending per
active hour, and complete or partial work observation. Its durable codes are in
`LINK_SCENES` and checked by `hub/demo/test/links.test.ts`.

`DEV_SET=devices DEV_STILL=true make dev` shows agent versions, disabled collectors, an epoch barrier, a preferred device and retained measurement origins in My connections.
`DEV_SET=onboarding DEV_STILL=true make dev` exercises board and account onboarding.
`DEV_SET=calendar DEV_STILL=true make dev` shows 30 days of registered agent-hours
without subscription cards. Ana has varied weeks, quiet stretches, release peaks,
work across midnight and sessions in the opening analytical period;
Boris's No available work history board has no admitted devices. Empty project
selection keeps the heatmap visible with zero registered work. Both views follow the
shared analytical period (up to 31 days) and data filters. Day × hour adapts from a
short interval strip to date rows or, for wide monthly widgets, hourly rows. Calendar
places dates beside intraday segments. Inspect a bucket by pointer, keyboard or touch,
then choose Open interval or Open day when available. Both views fill the widget's
width and manual height, keeping the selected period visible without an inner scroller.
Ana owns *Studio* and *New board*; Boris is a member of both. OpenRouter starts
unconnected. Add widget offers synthetic keys for successful, partial and failed
answers, a lost-reply control, and an explicit subset from a synthetic device report.
Services, encrypted storage, receipts and board events use production code; only
external answers and device reports are synthetic. No real provider or client is
contacted. Use `make info` for the actual address and synthetic sign-in.

`DEV_SET=sessions make dev` opens the session analytics review fixture. Sign in as Ana:
the default 24h period has 57 projects, six machines, four subscriptions and 129
recorded contexts, including OpenCode and another client alongside mapped sessions.
Agent sessions includes active time and average concurrency,
fits whole rows to its height and has a compact pager at the bottom right. Its separate
footer shows totals across the entire selected period, including rows on other pages,
on a separate line above the pager and row count. Wide totals reuse the table's columns
and headings; narrow totals use a fixed grid. The current working count is a subtitle.
Grouping uses shared segments; None comes first while Project stays the default.
Increasing the height fits more rows without a fifty-row page cap or another API read;
when every row fits, its disabled 1/1 pager keeps the same footer slot. Wide tables sort through their headers, with the
third click clearing the selected sort; only narrow lists show a sort menu.
Atlas's 67-context disclosure has two pages.
Recent overlapping work, 64 retained Atlas contexts absent from the live
roster, long names and a projectless context are ready to inspect in either language.
Client and subscription columns are available in individual rows and disclosures.
Shared variants show sessions without subscriptions, subscriptions without sessions,
both permissions, disabled devices, hidden cards and a later subscription grant.
Provided data includes a disconnected device with retained history.
Live synthetic reports keep measurements fresh. The 7d and 30d periods also have work;
the latter explains the fixture's seven-day coverage. For a known-empty fixed range,
select four to two hours before startup; nine to eight days before startup is unknown.

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

`DEV_SET=project-colors DEV_STILL=true make dev` (or `npm run demo -- project-colors --still`)
shows repeated manual project colours, automatic displacement, neutral overflow,
retained out-of-period pins and merged names. Its capacity and dormant-reset boards
exercise the 89-assignment bound and the owner's explicit reset without exposing
unavailable names. Check owner and reader views, both languages and the combined name/colour popup
in Manage projects at narrow widths.

`npm run demo -- links --still` opens the client-link scenarios. For the synthetic
month history comparison, archive the control revision into a separate temporary
directory, install its hub dependencies, then run
`node --import tsx bench/month.mjs --control /absolute/control/root` from `hub/`.
It serializes with the component gates and compares five warmups and 25 alternating
takes per path, with both median and p95 limited to 1.20 times the control, including
authenticated HTTP and pure financial controls. The fixture includes 10 owners,
20 devices, 2,400 contexts, 86,400 work stretches and a second cohort of 1,200 links.

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
is told only `ping`, renders and changes only what shows time, and spends at most
1 ms of script per second after subtracting the probe's own time. This elapsed-time
budget catches script regressions; it does not measure total CPU or energy.
Then twenty measurements reach their card and chart,
19 within a second, reading a small tail of history rather than the whole period.
Finally the stand's laptop reports one working agent: each live credited report makes
at most one small history read and renders only its card, agents and analytics.
The fixed 24h/30d Activity benchmark covers shared filters, exact overlap, late
updates, cancellation and all attempted traffic/preparation within the same limits.
Legend emphasis adds no history reader and receives no extra-read allowance. The report
prints latency, history bytes and reads as JSON and exits 1 over budget. After the
readings, it also checks that consecutive frequency saves with native arrow keys keep
focus in the card's menu and fails otherwise. It needs Chrome:
`QUOTUM_CHROME`, `google-chrome` or `chromium` on `PATH`, or `--cdp http://host:port` to
one already running. CI runs it on every push; run it when you change the dashboard
and have Chrome.

The history traffic matrix runs first and closes its temporary pages before the idle
board opens. Quota, work and money seeds share an anchor ten minutes before the
benchmark's aligned seed time. Warmup still checks actual observations: a fresh
measurement requires its full fade, and the idle board settles for at least thirty seconds.
Idle measurement starts at a planned grid phase with its endpoints away from
minute ticks and includes one real five-minute cell transition in each chart.
The benchmark anchors regular quota retirement fifty seconds before the chart grid
transition, keeping their deadlines separate while admitting the warm deadline one
minute before that grid edge. Planning includes both in the
same observation window, retaining the actual fade deadline, minimum settle wait
and job limits. Sparse and eco histories keep their own cadence.
Reports retain planned and observed bounds, inner CPU counter bounds, transition counts and actual
performance duration; missing coverage is a failure and the 1 ms/s budget includes
the transition's work.
Two read-only storage snapshots inside those counters also require the admitted quota
rows due in that window to lose their expected predecessor, with unchanged evidence
and no additional history requests. Passing the clock and axes alone is insufficient.

The completed measurement phase's React/DOM observer is disconnected before native
panning. Native wheel and Shift-drag start separately from the weekly limit, five-hour
limit, activity, budget balance and subscription-funds charts at both periods.
Each input owner starts with fresh readers, captures its own events and must move all
five plots within the same budgets.
Panning keeps its own movement and mutation checks; resetting the measurement
probe resumes full observation for money updates. The balance checks wait
for populated, committed drawings and stable layout, then require each account or scoped-limit
line to remain present and inside its scale on every observed frame.

The same run checks pan traffic separately from the native frame budget, using the
dense 75-day fixture and all five charts at 24h and 30d. Controlled production-loader
replays and native browser gestures use 0, 100 and 400 ms answer delays. Cached
return and repeat must start no history GETs; half-width movements allow at most
seven attempts from the history chart and five from activity, and a 4% movement
allows two. Seed and independent reference reads are excluded. A benchmark-owned
loopback proxy uses fixed Brotli settings (quality 4, text mode, window 22), without
adding production compression. Decoded JSON may reach 1.5 times, and encoded body
bytes twice, the reference for the exact missing union and permitted buffer or
within-tile bridge. The report separates complete bodies, partial byte bounds and
unknown transfers; headers are never counted as body bytes. Only HTTP 200 responses
qualify as accounting data, including metadata-only reads. Error bodies still count
their physical bytes, and reports retain numeric HTTP status without response contents.
The two 1d activity cold cohorts at 100 and 400 ms also retain decoded wire component
sizes for their final baseline. Numeric rows separate history headers, fixed summaries
and shift programs, card values and neighboring states, and session summaries. Section
states remain visible when a baseline is incomplete. Counts use the original compact
JSON before expansion and must conserve its whole size; they do not allocate Brotli
bytes to individual sections or change the budget verdict. These observations share
the existing 64-read diagnostic limit and retain no response text.
When idle timing diagnostics include history, those baselines also measure a shadow reply
with each final card replay interval omitted when the base value fully covers it.
The original reply must survive a byte-exact expand/repack round trip, and its
recompressed size must match the observed body under the proxy's exact codec.
Cached card-state anchors make the whole packet unavailable to this fresh-reply model.
Numeric readings retain the original and alternative whole-body sizes, omitted
interval count, card-program layouts and observation time; mismatches stay unavailable.
The live reply, reference reads and original verdict are unchanged. This measures
one packet alternative, not a shipped producer fix or compatibility with older
readers. Its extra serialization/compression work has unqualified observer overhead.
Independent whole-cell composition also checks series, activity and events. Each
history attempt gets its
fixture identity before HTTP starts, so aborts before response headers cannot borrow
another attempt's byte proof. Separate real HTTP and native Shift-wheel cohorts
exercise cancellation before headers, after delivery and reversal with a repeated
query. Controlled production staging also verifies a delivered answer discarded
before publication; native transport observations do not infer staging disposition.
Reports retain attempted/completed/failed/aborted counts and uncertain body bounds.
Proxy sockets and traffic tabs
close before the benchmark stops its own demo.

The manual CI input `history_scroll_control` requires `diagnostic_ref` and
`expected_client_sha256`, and selects only the existing 20-minute history job.
It runs one owned benchmark process with the original controlled traffic prefix, all
24 native history cohorts and the six native cancellation cohorts, with every original
assertion, reference-cut rule and deadline. The diagnostic prefix must complete without
invalidations or budget failures. GDB is prepared before the run and first used only
after an original failed command. In the direct history scroll control, passive original
navigation evidence must establish the document before input; this does not bind a PID.
Only after an original failure does the same page connection resolve its owned renderer
and birth through a completed metadata trace, within the existing collection limit.
Unknown or lost document or renderer identity permits neither native attach nor a page
debugger fallback. Reports retain actual binding bookends only when it is resolved.
The first failure stops without a diagnostic replay. Startup, compositor and legacy
controls retain their pre-input metadata binding and existing reversal replay.
The effects of diagnostic preparation are not qualified.
This control also downloads the official debug archive
for the installed Chrome version and installs only its unwind tables under the matching
system build ID. Build IDs and the retained table bytes must agree; full symbol and
source tables are discarded before Chrome starts. GDB still has its two-second limit,
and saved frame positions are symbolized offline. Preparation does not execute Chrome
or GDB; its effects on the OS file cache are not qualified. A completed diagnostic is
an observation, never a canonical benchmark pass or proof that a hang was repaired.
After retaining the successful original result, this direct control runs twelve fixed
pairs of the original 1d/history/0ms/0.5/take1 and 30d/activity/100ms/0.5/take1 cohorts
in fresh tabs of the same Chrome, with separate evidence and the original gestures and
guards. The first failure, including a reference-cut change, stops without retry. The
twenty-minute limit stays; an unfinished suffix remains inconclusive. Startup, compositor
and ordinary checks omit this suffix; ordinary checks need no diagnostic preparation.
Only the suffix's Activity pages also observe bounded history-pool operations. Their
receipts retain tile coverage at response release and eviction; a completed HTTP body
alone does not prove that its cells were published. Source binding runs after the
traffic evidence is saved. This observation does not change retention or readiness.
Pressure events also retain the period's current byte count and preparation flags.
These flags describe simultaneous state, not the exclusive caller of a reservation.
Within that same twenty-minute job, one eligible Activity page may wait up to sixty
seconds for its captured work-prefix boundary before the cached return. The control
requires committed prefix retirement and zero additional reads; a missing eligible
boundary or unconfirmed retirement is inconclusive.

The manual `startup_io_control` input observes file identities and page ranges from
a Linux browser's filemap read and fault tracepoints on an isolated GitHub runner.
A fixed owned-file batch must first produce matching read and fault observations,
identity and SIGTERM generation before the
unchanged full history benchmark starts. Missing BTF, an unavailable probe or an
unconfirmed fixture stops this diagnostic; no retry substitutes for qualification.
The observer admits only the known fixture and the benchmark's detached browser main
thread, checking parent, birth and UID. It keeps numeric device/inode/page identifiers
from the events, never kernel addresses, paths or stack data. A prepared read range's
last index is inclusive. It is reported after successful page acquisition, whereas a
fault entry is reported before the page-cache lookup. A fault entry is one page.
A 21-second observation window does not delay browser termination;
the original twenty-second launch and twenty-minute job limits remain unchanged.
The tracer then exits and retains its final maps. Once the fixture has qualified,
an observer error preserves an inconclusive diagnostic result while the original
benchmark finishes, provided the observer's release is confirmed.
These events identify filemap inputs. They do not prove a physical read, a completed
fault, blocking, its duration, the file behind an earlier wait or the absence of other
operations. No dynamic function probe or duration certificate is collected.
Post-readiness inputs are not automatically startup cost. The original benchmark
verdict and console output survive collection and cleanup, and this optional job
cannot satisfy the required benchmark gate. Select it without other diagnostic modes.
It prepares GDB and matching Chrome unwind tables so the existing postfailure
capture can inspect a bound renderer if the original command deadline fails.
Preparation can affect the runner's caches; this is not a cold-start comparison.
Its isolated tracer retains at most eight 256-character tool-error lines from a 16 KiB
prefix, with paths and memory addresses removed. Other launch diagnostics retain
their fixed categories and coordinates.

The manual `compositor_guard_control` input compares the pending-tree compositor
guard in pinned Google Chrome Beta 157.0.8103.15. Three independent runners execute
the complete original history control, with the guard disabled in OLD1 and OLD2 and
enabled in NEW. They use the same package and launcher, source and client pins,
twenty-second startup and twenty-minute job limits. Matching native unwind tables
must qualify before input. These parallel observations are not a sequential crossover.
An ordinary CI run keeps its existing browser. This control is exclusive with every
other diagnostic mode; successful runs without a matching original failure do not
establish a repair. The upstream regression uses compositor hooks unavailable to a
page, so this workload does not claim to reproduce those controlled scheduler states.

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
