# Architecture

Quotum shows coding-agent subscriptions (Claude Code, Codex, Antigravity and z.ai)
and OpenRouter budgets on one page: for one person on one machine, or for a team
across many machines and accounts. This document explains how the parts work and why
they are built this way.

## Parts

```
 each machine                                     hub (self-hosted)
┌───────────────────────────────┐  HTTPS         ┌──────────────────────────────┐
│ agent (Rust)                  │  /v1/checkin   │ duty: who measures what      │
│  claude  -p stream-json       │  /v1/ingest    │ ingest ─► rules ─► SQLite    │
│  codex   app-server           │  /v1/sessions  │ running agents ──►│          │
│  agy     -p /usage            │ ─────────────► │                   │          │
│  process list: who runs       │  device or     │ dashboard (React)◄┘          │
│  schedule · spool · pseudonym │  machine token └──────────────────────────────┘
└───────────────────────────────┘
```

- **agent/** — a small native program: Rust, one binary per platform, about 3 MB. It
  measures limits through each agent's own command-line client and delivers them to a
  hub in the [ingest format](../spec/ingest-v1.md).
- **hub/** — the dashboard service: Node 24, Fastify, the SQLite built into Node, a
  React UI. It decides which device measures which subscription, stores measurements,
  applies the rules (what counts as spending, what is a reset, what is a gap) and
  serves the dashboard. The hub measures z.ai subscriptions and OpenRouter budgets
  through its read-only connectors and encrypted credentials. Agents deliver the
  client-measured subscriptions.
- **spec/** — the contracts: the [ingest format](../spec/ingest-v1.md) between the two
  (anything that speaks it can deliver to a hub), and the
  [dashboard's events](../spec/dashboard-v1.md) between the hub and its page.
- **desktop/** — the desktop app (Rust with a platform host): the agent's core, the hub and its board in one
  program for one machine (see [Desktop app](#desktop-app)).

## Ways to run it

1. **Agent + hub.** The agent runs in the background (a systemd user service, launchd,
   Windows autostart) on every machine where agents work: laptops, servers, cloud dev
   environments, containers. It delivers to a hub, and one page shows every machine
   and account of a person or a team. The hub is one Docker image that needs no
   settings (`ghcr.io/padurets/quotum-hub`); `deploy/compose.yaml` puts it behind
   Caddy for HTTPS.
2. **One-off check.** `npx quotum` prints the current limits of this machine and exits.
3. **Desktop app** (Windows and Linux; macOS later). The agent of this machine, a hub
   of its own and its board in a window, with a tray icon: no account and no server,
   for a person with one machine.

The rules of the domain (spending, resets, gaps, the chart's time grid) live in the hub
alone. The desktop app runs the hub's own code rather than a copy of the rules, so there
is one implementation of them.

## Measuring

The agent's collectors ask each coding agent's own client, never provider endpoints.
The hub's read-only connectors measure z.ai subscriptions and OpenRouter budgets
directly. These are the client interfaces used by the agent:

| Provider | Interface | Notes |
|---|---|---|
| Claude Code | `claude -p --input-format stream-json …`, control request `get_usage` (the Agent SDK protocol) | No MCP servers, hooks, plugins, skills or saved session. Claude Code caches the answer for 60 s. |
| Codex | `codex app-server`, JSON-RPC `account/rateLimits/read` (the protocol of the IDE extensions) | Plan, per-model limits, free resets, purchased credits, account id. |
| Antigravity | `agy -p /usage --output-format json` (agy 1.1.11+) | The agent sends agy's log to its own file; otherwise agy writes a new log file on every run. |

What follows from this:

- The agent never reads tokens or cookies and never refreshes them: the client does
  that itself, as when a person uses it. No model request is made.
- When a provider changes its API, updating the client fixes it, not the agent.
- It costs little, and the cost is known. Measured on one machine: Claude 1.0 s of CPU
  and ~230 MB at peak, Codex 0.8 s and ~100 MB, Antigravity 0.9 s and ~170 MB. The
  agent itself idles at about 5 MB.

**Which account.** Claude reports the signed-in email and organization when it starts,
Codex the account id. Both become a pseudonym (a truncated SHA-256, see the spec)
before anything leaves the machine, the same on every machine. Antigravity does not say
which account it is: its measurements belong to the person the device belongs to, and a person
with two Antigravity subscriptions names them in the agent's settings
(`[providers.antigravity] account = "work"`).

**What the agent reads itself.** To check in before starting Claude Code (see duty
below), the agent reads the signed-in account (`oauthAccount`: email and organization)
from `~/.claude.json`, which holds no tokens. Of every other file of the clients it
reads only the time of the last change, to tell whether someone uses a client on this
machine. Credential files are never opened.

**Which agents run.** The agent also looks at the process list: which `claude`, `codex`
and `agy` processes run, since when, in which folder and project (names only; not the
home or a temporary folder), where (a terminal, an editor, or the Codex desktop app,
told by the programs above them), and whether they work. The project is the git
repository the folder is in, else the folder: once per session and folder the agent
looks for `.git` in the folder and above it, but not in the home folder or above it; in
a worktree the `.git` file leads to the main repository's git folder through its
`commondir`, so worktrees and folders inside a repository are one project. It reads
only those two small files: no git is run, no settings of it are read (remotes may hold
tokens). On macOS it touches nothing in the folders the system guards (Desktop,
Documents, Downloads, iCloud Drive, other volumes), neither directly nor through the
`.git` of another folder, so that the system does not ask for access: there the project
is the folder. Paths are checked as git writes them; a chain of links made by hand may
still lead there. Boards list agents by project, with the folder under it where that is
another, so agents in different worktrees stay apart. An editor or the app runs one client per
window for all its chats, so there a session is a window. A session works while its owned
process tree (the client, tools, builds and tests) spends more of a CPU core than the
client does when idle (6% for Claude Code, 3% for Codex, 4% for Antigravity and 10%
for OpenCode), and for a minute after, so a pause of the model is not idleness.
OpenCode's threshold tolerates native idle redraw bursts. This is a CPU estimate,
not a provider's report of model work; a quiet model wait can eventually appear idle.
Only this user's processes count (on Windows, those of this logon session), and the
clients the agent starts to measure do not, even behind an accounting boundary.

On Linux, bounded Codex invocation metadata recognises `app-server daemon
pid-update-loop` (maintenance), `app-server proxy` (transport), and app-server
runtimes. Service branches stop both same-provider session folding and ancestor CPU
accounting. A known runtime in a different OS process session from its provider owner
is also separated; merely detaching an ordinary shell or build is no boundary. A
runtime behind such a boundary, or without a proven client or editor/app owner, remains
visible, with its own CPU estimate but no project or folder. Its inherited cwd does
not establish which projects it serves. Private same-provider runtimes and ordinary
editor/app windows retain their existing ownership and placement. CPU is never moved
to another client based on a connection or a tool's folder.

Linux skips at most 2048 executable-name bytes, compares exact leading role words,
and stops at the first mismatch, a recognised service role, or the first option-prefix
byte of a runtime. No option values, process environments or conversation files are
read; no command line is retained or sent. Process birth and executable file identity
are checked around these reads and every CPU contributor. Unknown or initially
unreadable roles prove no boundary. A previously proven boundary survives temporarily
unreadable metadata and reparenting for that process birth; exhausting the invocation
read bound or losing executable metadata does not prove a replacement. A confirmed
invocation or executable change invalidates placement authority. Current shared roots
are boundaries for every descendant on the same look, and an initially proven ancestor
can still deny ownership or measurement eligibility if its later validation fails.
Temporary missing owner metadata leaves placement unproven for that observation,
including the first look without a cache. An absent non-init parent is incomplete
ancestry, not proof of an orphan. It does not make a private runtime permanently shared.
Confirmed role, image and accounting
scope remain tied to the observed birth across snapshot gaps, until exit or replacement
is proved. An initially known unsafe branch also retains pending birth-specific ancestor
evidence until that same ancestor can be validated. This includes a first snapshot's
proof when its additional validation fails, and a retained unsafe birth whose current
validation is unavailable. Observed parent links pin both process births, so pending
ancestor evidence survives the later absence of the source too. A cached parent PID
supplies only a conditional target until its birth is confirmed; it cannot prove that
old birth's other ancestors. Raw-proven authority changes invalidate old ownership
and working holds even before successful additional validation; newer validated
evidence supersedes them. A reused PID inherits no state.
These guarantees require observed or conditional birth links. If an ancestor's birth
was never available before the excluded source disappeared, its later child CPU
cannot be safely linked by PPID alone; the existing fallback can still show work for
that first-seen client. Completely unavailable metadata is a detector capability limit.

The OS also gives CPU of finished children, without telling which branch earned it.
For every ancestor of a proven excluded branch, across wrappers and other-provider
session roots, this reaped CPU is ignored for that ancestor's remaining process birth.
The restriction survives branch exit, reparenting and same-birth exec. A previously
excluded process that becomes eligible also keeps its delayed child CPU excluded,
including when the first raw Shared proof is superseded before its cache is committed.
Its own CPU and live owned tools still count; clean trees retain their finished-tool
accounting. The conservative cost is that a short owned tool entirely between looks
can be missed at an affected ancestor. Changing the accounting basis discards incompatible deltas and
working holds rather than turning a lifetime-counter jump into work. Accounting owner
and authority transitions of observed births also reset affected sessions, even when
an ancestor was already marked unsafe. New owned tools retain their first observed CPU.
Unsafe births count their own CPU separately from clean owned subtrees. Each clean
subtree keeps its live-plus-reaped counter; sampled increases accumulate without
subtracting retired subtrees, so an observed tool's exit cannot hide new self or live
CPU. Short looks retain their sampled CPU while keeping references at the last full
judgement, so a brief metadata gap cannot replay an unchanged counter. Regrouping
observed contributors discards incompatible deltas and holds. Unsafe
births continue to mark physical ancestors after the original service has gone,
including an ancestor whose metadata becomes readable later.

macOS and Windows currently have no invocation-role or process-session detector for
these shared branches; their existing process observation remains the fallback, not
proof of shared ownership. Persistent/remote-only servers are not hidden simply for
being detached or idle. Collection reads process metadata only, starts no program,
and looks once through the process list, then validates the relevant ancestry and CPU
trees. Not seen: a client that runs as `node` (an npm install on macOS and Windows),
and on Windows the folder, which the system does not tell of another process. macOS names
a process after the file a link leads to, so there a client is also told by its path.

**Where the client is.** On PATH, in its own installer's place, where package managers
put programs, and, for Codex, last of all the copy the Codex desktop app or an editor
extension carries: whoever uses only those needs no command-line client. On Windows the
Codex app keeps its copy in `%LOCALAPPDATA%\OpenAI\Codex\bin` or its Store package's
`LocalCache`, newest first. Antigravity's Windows installer puts its CLI in
`%LOCALAPPDATA%\agy\bin`; finding it does not depend on the desktop's PATH.
Claude Desktop's main executable is a GUI, not a Claude Code
client: use a separately installed Claude Code CLI, or `path` pointing to a standalone
CLI executable. The app execution aliases Windows puts in
`\Microsoft\WindowsApps\` are passed over: they start the Store app, not a client that
answers. A program started from the desktop does not see the PATH a shell sets up, so
the desktop app finds a client only in these places; one elsewhere is given by `path` in
the settings.

### Coding clients and board session access

The Rust client catalogue owns executable discovery and process tracking independently
of quota collectors. Claude Code, Codex and Antigravity map explicitly to their existing
collectors; OpenCode has no collector. Client enabled/path settings apply to discovery
and activity; collector enabled settings apply only to measuring. A runner with no
collectors keeps reporting clients while session reporting is enabled.

Legacy sessions retain their released subset and cap priority. Supplemental sessions
carry work that cannot enter that subset. Schema 21 adds a client namespace, nullable
source and evidence metadata to session contexts, preserving ledger row/producer IDs
and every work interval; device inventory is stored separately. Evidence never changes
process identity. Temporal owner rules resolve attribution when read: device scope
precedes all devices, then provider-conditioned class, class alone and no condition.
An inactive winning rule gives no source and masks weaker rules and account fallback.
Without a matching rule, API and unknown routes have no source; absent or subscription
routes may use a currently held observed account. Explicit route suppression disables
route conditions. Only exact catalogue endpoints and session evidence identify providers.
Live sessions, working state, retained counters and history share this resolver.
History cuts raw work at rule boundaries without rewriting the ledger. Display fragments
share a board-scoped row identity so source splitting adds no agents. Stronger context
evidence applies to retained history, including when received in an idle report.
A single immutable WorkAccess snapshot admits saved-device
work independently of subscriptions. Personal boards always admit their owner's work.
Settings, admission and funding dependencies use the same device inventory: connected
devices and disconnected devices with retained work. A disconnected device without
retained work cannot establish coverage or invalidate the session cursor.
Schema 25 appends sparse board_device_sessions overrides: absent means on from joining,
NULL means off, and an explicit timestamp means on from a new cutoff. Every effective
change receives a fresh opaque revision for CAS, including same-millisecond OFF/ON.
The saved device owner controls its setting; disconnect keeps retained history and its
policy, while leaving a board removes overrides and rejoining starts a new cutoff.

Funding disclosure is separate: current held sources provided to the board retain their
public source ID; held sources not provided become null with sourceStatus:notProvided;
unknown or unheld sources become plain null. Hidden cards never filter admitted work.
The immutable raw ledger and presence binding retain their original source/context.
No source, holding, duty or retrospective attribution is created.

Every board uses the released source sessions map plus one disjoint unattributedSessions
slice, without a second full roster. Source-free workSince events update the shared
work index without financial updates, clipped to device admission before publication.
An opaque workAuthority changes only with relevant access, names or actual retained
evidence boundaries; ordinary time, measurements and new contexts do not change it.
One board funding revision in existing metadata changes atomically with relevant
holding or sharing mutations. Retained admitted evidence, current session source facts
and quota work coverage determine relevance; unrelated wallet holdings stay independent.
The revision belongs to the captured WorkAccess, alongside its maps. History cells,
metadata, cache keys and quota tapes reuse that single reserved snapshot; an allocation
failure is shared by dependent sections. Actual database changes revalidate authority
with a fresh bounded snapshot before delivery. Revocation
replaces queued stream/poll data with a fresh snapshot and retires the browser's work
index, staged replies, drawings, gestures and retained summaries immediately. Closed
tiles, including empty source-less tiles, invalidate even without watchers; their
dependency metadata is counted within the existing 32 MiB cache budget. Empty boards
use the same explicit Add widget flow and saved visibility.
An account-private devices hint invalidates an open owner-device disclosure on any
board without sending session data; opening or reconnecting also reads the owner API.
The same presence deadline clears the disclosure even when its only sessions use held,
hidden sources. Unchanged inventory and presence do not change connection revisions.
OpenCode native local TUI attribution is proven only by bounded Linux invocation metadata;
shared or unproven invocations and other operating systems have no project authority.
Version transport bounds bytes before line parsing and waits for both EOF and successful
exit within five seconds. It never retains raw output or reads client secrets.

### Tracking coverage and quota growth

The agent captures processes on a dedicated thread. Client version probes, quota
collection and HTTP stay on the coordinator, with no capture lock held while they
run. The worker publishes one immutable bounded snapshot and accepts at most eight
pending metadata commands. Stopping the runner disconnects and joins this worker;
the CLI and app use the same state directory and writer lock after their handoff.
A replacement waits interruptibly for a preceding writer still finishing delivery.
Permanent capture failure produces one bounded warning instead of silently leaving
the quota loop without activity capture.

Capture and classification have separate clocks. CPU thresholds and the one-minute
hold use complete fifteen-second judgement windows. New roots first establish a
baseline on that grid; extra looks do not judge short typing or redraw bursts or
renew the hold. Capture aims at eight subdivisions per window while active, three
after thirty seconds of known idle, and one with no clients. Capture prices use the
greater of an EWMA and the last four costs to reduce subdivisions under pressure.
Extra looks repay paced debt and reserve space for a judgement. Full judgement
looks instead require room in a conservative rolling five-minute actual CPU ledger,
including journal and command work. Costs are normalized by their mode's allowance
at completion; changing mode or resetting the grid never erases spending or debt.
Large descendant trees and large root rosters use the dense allowance. An aged
price permits one new calibration only after debt repayment and with ledger room.
No polling loop catches up missed captures. Thread CPU clocks measure capture,
context, journal and control work; an unavailable CPU clock uses elapsed time as a
conservative fallback. Waiting time spends no CPU allowance when the CPU clock is
available. Delayed looks, clock faults, suspend,
incomplete ownership and restarts break evidence instead of filling a gap with idle
or work. A hold expiring between captures is cut at its monotonic deadline.

Completed intervals go to a private segmented append journal before delivery. Its
length-prefixed JSON records have checksums, a 512 KiB payload bound and immutable
sequence numbers. A synced atomic manifest publishes a complete capture transaction;
a crash discards uncommitted tail bytes, or explicitly retires a corrupt committed
suffix while keeping its verified prefix. Full-state transitions too large together
split into an old-state interval and a zero-duration new capture checkpoint. Batches
carry at most 64 frames within 512 KiB. An acknowledged prefix is persisted before
its files or referenced clock mappings and coverage proofs can be reclaimed.
Before a calibrated clock can be sent, the manifest records its commitment. A partial
metadata restore that loses that anchor explicitly retires its pending suffix and
starts a new clock identity; it cannot recalibrate an epoch already known to the hub.
For a coherent older backup, hello returns the authenticated stream's committed
prefix anchor. The worker restores that exact mapping, including the canonical
context-date offset derived from its private origin, before publishing it. If the
remote cursor consumed positions of an uncalibrated clock without a recoverable
matching anchor, its remaining intervals become explicit loss and capture starts
with a new clock identity. Already calibrated mappings remain immutable.
The exact mapping is persisted before its commitment marker; reopening completes
a missing marker from the saved mapping. An interrupted first calibration therefore
keeps the durable intervals. Recovery or durable retirement of a clock identity
precedes local acknowledgement and reclamation. Retirement first removes the old
private basis, so a crash after deleting its evidence cannot revive that identity.
One manifest entry retains the active clock's first sequence independently of
reclaimable segments. Privacy and credential retirement cannot erase that origin
and make an already consumed clock appear new. Startup also checks the active
metadata identity against this durable entry before continuing it.
The hello's historical send sample is checked against its clock origin; later
captures may legitimately advance the current high-water while HTTP is pending.
Current clock continuity and the five-second calibration deadline still apply.

One writer and a directory budget cover all destination namespaces, including inactive
ones: 64 MiB on disk, at most 128 segments per namespace, 256 clock mappings and 256
proofs, with 64 KiB manifest and 256 KiB metadata bounds. Inactive namespaces are
validated and bounded before a writer starts. Seven-day expiry uses each completed
frame's calibrated UTC endpoint. A fresh tail does not retain an expired prefix in
the same segment; its file stays intact until the remaining suffix is retired or
acknowledged. Every history attempt, including a retry, asks the writer to expire
and prepare again. A prepared reply permits one immediate attempt within five
seconds of the start of that maintenance; coordinator delays discard it. Both elapsed
time and the private boot/tick/wall sample bound the handoff, including suspend and
clock faults when the elapsed clock alone would look fresh. An immutable request
already authorized within that bound may finish its five-second HTTP operation
while capture retires later data, without holding a writer lock.
Overflow, age, corruption and privacy restrictions persist explicit unknown
loss before deleting payloads. Reporting, project or scope opt-out changes a durable
privacy revision before a namespace can send again. Desktop file reloads apply the same
barrier even when the new configuration leaves its agent idle. Queue binding is checked against
the authenticated hub and device before replay; a bound mismatch fences the current
capture run instead of replacing its authority. Before that binding exists, a private
one-way credential scope prevents a changed credential from inheriting the pending
prefix. Bound token rotation still requires the same remote device and authority.
Desktop settings persist a restriction even when tracking is idle or a later save
coalesces the restart. A private policy lock serializes that acceptance with delivery;
subsequent sends require the worker's original privacy revision. Capture never waits
on this lock. Missing clock metadata retires the unmappable suffix as explicit loss,
preserving the verified prefix and allowing new observations to be delivered.
A compatible boot clock and immutable anchor survive a process restart, while CPU
baselines and holds do not. Native clocks
include suspend; without a verified native boot clock, continuity is limited to one run.

Agents using `/v1/activity` negotiate a persistent observed-interval capability.
Schema 32 saves one fenced queue, accepted sequence, immutable prefix clock anchor
and bounded state checkpoint per device, plus at most 256 issued topology proofs.
The initial transaction closes the legacy writer and establishes an activation
floor. Every legacy report and sweep checks the durable barrier; later presence
never extends history. Unmigrated devices retain their existing session path.

Completed working intervals enter the existing work ledger in chronological slices
containing every concurrent key. Cursor, clock checkpoint, history and captured
coverage commit together; notifications and live presence publish after commit.
Retries discard their committed prefix before comparing the current anchor, so an
older epoch can be retried after a newer one without remapping time. Missing FIFO
prefixes need an explicit unknown skip. Queue replacement compares its authority
and establishes a new conservative floor; it never reconstructs lost history.
Captured account evidence never falls back to a login first seen at delivery.
Account resolution checks sign-in metadata before and after reading local or measured
evidence. A change leaves funding unknown; capture checks that same witness again.

Coverage uses the witness captured with the interval, including its original
issuance time, exact scope and current topology version. Rehello and hub restart
reuse applicable proofs. Topology changes invalidate them even if the same devices
return. Missing proof leaves positive work intact and asks for a coalesced refresh.
Witness release is bounded and idempotent. These internal references never enter
board projections; the existing admission and funding rules remain authoritative.

Legacy session reports carry optional configured tracking scope and delivery completeness.
An initially old hub still receives known roots when another root is unknown, with
an incomplete witness that breaks coverage across the uncertain observation.
The agent repeats empty reports every two minutes while that scope is enabled, and
requires a positively acknowledged incomplete report after any capture or delivery fault.
The hub stores completed intervals separately from positive work. Two compatible complete
endpoints within 200 seconds prove an interval; silence, restarts and topology changes
cannot repair a gap. Finished intervals survive restarts and are coalesced and retained
with measurement history. Installed-client inventory is never coverage evidence.

A source-level helper compares adjacent native quota observations over the last 24 hours.
Growth of at least one percentage point within 30 minutes and the same valid reset period
can produce one diagnostic finding per window, exposed as `usageWork` in card events.
Reported caps retain actual native endpoints before sparse deduplication, with their
own allowance and generation. Any overlapping resolved work from current holders vetoes
the finding, including work outside the reader's board. Complete coverage of all current
holder devices makes it confirmed; other cases
explicitly report incomplete work data. This describes configured observation only.
Findings contain no actor guesses, private scope, holder identity or money attribution.
They expire at reset or 24 hours and share existing event deadlines. Dashboard and
compact cards do not render these findings as warnings.

## Scheduling

Clients are expensive to start, so the schedule is about starting as few as possible,
and never several at once:

- **One at a time.** Measurements run strictly one after another, so at any moment at
  most one client is running.
- **With a hub, the hub sets the pace** (see *One measurer per subscription*): the
  device on duty measures when the hub tells it to. An interval set for a provider is
  then the most often it is measured; eco mode and the rest of this list hold only
  while the hub does not answer, or without a hub.
- **An interval per provider**, configurable, at least 60 s (below that Claude Code
  answers from its cache anyway), 120 s by default.
- **Spread.** After the first round (all providers right away, one after another) each
  provider is offset by an equal share of its interval, plus ±10% jitter so the machines
  of a team don't fall into step. After sleep or suspend the spread is set up again
  instead of catching up on missed runs.
- **Eco mode** (on by default): while a provider's values don't change and nobody uses
  it on this machine (its history and state files are untouched), its interval doubles,
  up to 15 minutes. Any change or use brings it straight back. A known reset pulls the
  next run to 30 s after it.
- **Failures back off:** a missing client is checked every 30 minutes, a signed-out one
  every 15, other errors double the interval up to 15 minutes.
- Clients run at low priority (nice 10, below normal on Windows), in an empty working
  directory, in a process group of their own. After a measurement, or after 60 s at
  most, the whole group is killed, so nothing a client starts in the background
  outlives it. (On Windows only the client process itself is killed for now.)
- `SIGINT` and `SIGTERM` stop the agent at once, a running measurement included.

Every measurement carries `staleAfterMs`: when the next one is due, plus a margin. That
is how the hub knows a sparse eco-mode series is continuous and a missing measurement
is a gap.

## One measurer per subscription

The same subscription is often signed in on several machines: a laptop and a couple of
dev environments, or a whole team's containers. Measuring it everywhere would multiply
the cost for the same numbers, so the hub keeps one device **on duty** per
subscription:

- Before measuring, a device checks in (`POST /v1/checkin`) with the subscription and
  whether someone is using the client on this machine right now.
- The first device to ask gets duty. It keeps it while it delivers: each measurement
  extends duty until the measurement goes stale. Asking does not extend it; a holder
  that keeps asking but never delivers loses duty after five minutes.
- A holder following the pace that is told to measure keeps duty while it measures:
  until it delivers, fails or asks again, for at most five minutes. It asks nothing
  meanwhile, measuring its providers one by one, and another device taking over halfway,
  even one where someone works, would measure the same again.
- The others are told to wait and when to ask again: when the holder's measurement goes
  stale or its waiting plan ends, or while it measures, when its five minutes end; sooner,
  in a minute if someone works on that machine, otherwise in up to ten minutes.
- A holder that asks again without answering what it was told keeps duty no longer than
  the others were told to wait, and until it answers the last command, however late,
  telling it to measure again keeps it no duty: one that keeps asking but never delivers
  loses duty as any other.
- Duty moves to a device where someone works if the holder has been idle for ten
  minutes, so the numbers come from where the subscription is actually being used.
- A holder that goes quiet (asleep, switched off) loses duty when its last measurement
  goes stale and its bounded plan protection ends; the next device to ask takes over.
- A fresh accepted failure answering the current holder's latest command releases
  all its duty protection, including a new holder's starter lease. Its own cooldown
  remains; the next eligible healthy device takes over. Older and off-duty failures
  cannot end a newer command. Source figures retain their independent validity.
  A delayed snapshot taken before or at the device's latest failure can update the
  source without renewing that device's duty; recovery requires a later observation.
  Release also invalidates that holder's waiting planner. Expiring its cooldown,
  receiving another batch or accepting another device's data cannot restore it.
  A new eligible claim or the holder's own successful recovery restores planning;
  the shared successful-data baseline still determines fixed due times.

Duty decides who measures; the hub's **pace** (`hub/server/cadence.ts`) decides when,
from what it sees of the subscription everywhere, which no single machine does:

- The device on duty asks every 15 seconds, one request for all its subscriptions,
  without starting a client, and measures only when told. The answer gives times as
  durations, so a machine's clock being off does not matter, and with each `measure`
  a promise: the next measurement comes within `nextInMs` of this one, which is how
  long the measurement says it stays representative.
- A subscription with little left (any window at 10% or less, above 0) is measured
  every minute while it was active within the last hour (its numbers changed or it was
  in use), every 2 minutes after an hour of quiet, every 5 after three. One in use (a
  coding agent working on it on any machine, or its client used on the device on duty)
  or whose numbers just changed, every 2 minutes. Otherwise the interval doubles, up
  to 15 minutes, a cap the hub never passes; a known reset pulls the next measurement
  to 30 seconds after it. A device's own interval is the least it is asked for.
- The hub waits out a device's failed measurements, longer each time in a row (15
  minutes for a signed-out client), and a device doing so does not take duty; a healthy
  one does, as before. A `measure` nothing came back for (a lost answer) is asked again
  after 90 seconds, then less and less often.
- A healthy paced holder waiting for its ordinary plan keeps duty through its due time
  plus one minute for check-in, independently of snapshot freshness. Cadence calculates
  this from the last successful data and the current interval and device minimum;
  Ingest installs it in Duty on a delivery, holder check-in or actual frequency change,
  and before a competing claim. Reads cannot extend it. Pauses and unanswered commands
  get no waiting protection; retrying cannot renew an expired lease. A silent holder
  cannot receive a later protection just from a setting write, but a shorter plan cuts
  its existing protection. Expired backlog that leaves a command unanswered gives no
  new arrival-time lease; representative snapshots still keep their own lease.

**Measuring frequency.** `sources.measure_interval_ms` stores one nullable preference
per subscription: Auto or 1, 2, 5 or 15 minutes. It is outside the board's View and the
snapshot payload. Every reader sees it; every current holder may change it through the
board API, independently of owning that board. An equal write is a no-op; otherwise
Ingest replans duty synchronously and touches every board showing that source.

A fixed ordinary plan follows the last accepted successful measurement, across restart
and handover, without activity, low-limit, change or reset acceleration. The device's
minimum can make it slower; failure pauses, unanswered retries and refresh remain.
Until the first success, a failed command starts no fixed interval: the next attempt
waits only for the existing failure pause and device minimum.
A fresh manual measurement starts the ordinary interval anew. Frequency changes affect
unissued plans immediately and leave issued commands alone. A longer interval may leave
old data stale; neither stored freshness nor history changes. The card explains its
real next measurement even then.

**Refresh on demand.** Any reader of a subscription on a board can request fresh data
through its existing card menu, above the action to hide the widget, in the web
dashboard and the desktop app. The header groups the board selector and two icon
buttons on the right, before the account menu: Add widget and Board controls.
These controls remain available on settings pages for the selected board. Changing
boards preserves their space in the header while source status loads inside the menu.
The board's event connection stays open across settings navigation; history reads and
chart preparation pause until the dashboard returns, with live invalidations retained.
The brand link returns to the selected board and its range through the shared router.
A completed connection opened from settings navigates to its destination before focusing
the card; visibility in the live store alone does not mean that its widget is on screen.
Add names the destination board and lists eligible absent or hidden widgets with their
type. One Add action provides or restores the selected widget; a source being shared
discloses access to its measurements and history in its row before submission.
The row retains an Added mark until the menu closes, without a confirmation page,
success page or automatic scroll. Pending requests and recoverable errors stay in
the row too. Search appears only above ten unfiltered entries in either list, preserves
pending rows and their receipts, and stays visible while filtering; reopening reads the
eligible catalogue again. Its Connect entry opens a separate provider/device choice
while retaining the target board and the connection's verification and recovery flow.
Board controls shows only the measured sources with visible cards under Data updates,
their last successful measurements and errors, an explicit Refresh all action, the
original free/locked layout control and board settings. Analytic widgets keep their
settings and hiding actions in their own menus. Opening Board controls
makes no refresh requests. The list keeps compact single-line rows: name and a short
measurement age or outcome, with the complete timestamp in its tooltip and error
details revealed only by clicking the row. Its wide layout puts status beside actions; at narrow
widths actions precede the status list in one column, scrolling inside the Popover.
The dropdowns share their heading, close action and inset row styles and start below
the header's bottom edge. Navigation icons use library SVGs.
Refresh all requests non-hidden cards through the same source endpoint, up to four
at a time. A refusal does not stop the rest. Outcomes stay with each source's row
after the hub retires its status, also while the dropdown is closed. Error details
expand in that row. An old outcome cannot stand in for a new request, and a reconnect
with a missing outcome says it is unknown. Nothing moves the widgets. A new attempt
needs an explicit click, including the first one. An individual card cannot be requested again until its refresh finishes, nor
while the page is still sending its request, from its menu or the header. Already
pending subscriptions need no additional POST from the board action. The charts and
tables receive new measurements through the usual events. Leaving the board stops
requests that have not started. The accepted card action closes the menu; a circular
loader replaces the logo's dot while the request is queued or waiting, then its ordinary
status and tooltip show the outcome without adding a control or a line to the card.
Outside an active request the menu action remains clickable: the hub rechecks
availability, and a refused request explains the reason and next step in the menu.
Nothing is sent while the page is disconnected. One request per subscription is accepted
each minute across the hub; another click joins a pending request. Cadence shortens the
ordinary wait to the earliest permitted measurement, respecting the one-minute floor,
the device's minimum interval, failure pauses and unanswered-command backoff. A raised
minimum takes precedence over an earlier staleness promise. The floor applies after the
later of the last measurement and command for the current holder; an old delivery or
failure cannot acknowledge a newer command outside the 30-second clock tolerance, and
only a success taken after a failure clears its pause.

Refresh capability comes from that subscription's latest check-in, not the agent
version: the live duty holder must follow the hub's pace and have been heard from within
120 seconds, or be measuring what it was told to. It is heard from when it asks, and
when it delivers a measurement or a failure of any subscription within five minutes of
asking: while it measures its providers one by one, the ones done are not silent. A
request never claims duty or extends its lease. A click joins a command to the holder
while it is under way: until the holder asks again, for at most five minutes, as long as
duty stays with it for that. A holder that asks again without answering lost the
command, and the request waits for its retry. A lapsed lease ends nothing while the same
device holds duty: an already dispatched request retains its bounded deadline,
but an unanswered holder cannot renew duty or accept another refresh after expiry.
Queued requests end on silence;
requests already dispatched keep waiting through it for up to five minutes, as providers
are measured sequentially and a holder busy measuring neither asks nor delivers the
others. Duty passing to another device, revocation, legacy check-in, an error or the
deadline ends the request. A fresh accepted snapshot of the same subscription, from any
device, can satisfy it even if its percentages are unchanged. The protocol has no
request id or startup acknowledgement; the card says it is waiting for data, not that a
client started. Terminal outcomes show for a minute. Refresh is its own projection and
event, so time boundaries and reconnect work without polling or rendering other cards.

Duty and the pace are kept in memory; after a restart of the hub the first devices to
check in take duty again. Auto measures at once; fixed schedules restore their due
time from stored successful data, measuring at once only without data or when due.
An agent that cannot ask keeps asking
every 15 seconds while it waits for a measurement the hub promised, and measures on its
own schedule (eco mode) once the hub has been silent for four minutes and that
measurement is due. An agent's log says when another device measures; waiting for the
hub's pace is not logged.

### Device participation and preferred collectors

Schema 27 adds durable per-device participation gates, collector epochs, policy
confirmation, global source preferences, bounded mutation receipts and latest resource
producer anchors. Device participation restricts admission independently of tracking,
connections, holdings and history. Effective gate changes permanently require launch
epoch evidence; a delayed packet cannot bypass disable/re-enable using corrected time.
The agent bootstraps policy before discovery and enforces its connection-bound durable
cache separately from local configuration and scheduler waits.
A managed runner with no local collectors declares that empty scope once at bootstrap;
it does not add a recurring policy loop for an empty local scope.

MeasurementSelection indexes current account evidence in both directions. Explicit
check-ins can declare several accounts across batches; a singleton replaces the previous
login, while a delivery group containing several accounts preserves each account and
multiplexed evidence expires independently. Account evidence covers every allowed
check-in's requested wait, with bounded grace, including off-duty and paused devices.
Old resource backlog
cannot refresh newer account evidence. Historical device
bindings are display facts. Auto uses Duty and Cadence; a global preferred own eligible
device waits for the issued measurement's safe boundary, falls back on ordinary eligible
collectors when unavailable, and returns on recovery. Reads and intent saves do not
extend leases. No per-resource parallel collector or completeness ranking is added.
An explicit complete collector list supplies bounded local availability independently
of account evidence. An omitted collector cannot be preferred while the declaration
is current; listing one never establishes or renews an account. The twelve-minute
cache and its private event deadlines use the existing maintenance and event clocks.
Unchanged declarations update their deadline without enumerating candidate accounts.
Configuration does not revoke an issued command or change resource admission.

Ingest decides resource admission, issued-command acknowledgement, source failure and
manual fresh-data completion separately. Modern commands have immutable IDs and launch
scope; an accepted fresh resource can complete a request without acknowledging its
command. Unknown/legacy failures remain private device diagnostics. Producer capture
keeps independent latest value/observation anchors for windows, resets and funds.
Unavailable readings preserve the value producer; equal finite readings advance the
latest accepted producer. Historical absent evidence stays unknown.

Owner contact events are coalesced separately from semantic Devices hints, rechecked
at disclosure, and consumed by small contact-row selectors. My connections hosts the
controls; widgets offer contextual navigation. Semver age, capability confirmation,
collector eligibility and resource availability are distinct diagnostics. Native compact
navigation carries a bounded typed destination through the existing command and keeps
one latest intent. Local desktop retains its local measurement configuration.

## Delivery

The agent posts each measurement right away. When the hub is unreachable, measurements
wait in a spool file (at most 5,000, about two days, rewritten atomically) and go out
oldest first when it answers again; meanwhile the agent tries again after a minute,
then less and less often, up to once an hour. Check-ins and policy recovery keep their
own contact schedule; their success never shortens an ingest retry deadline. Once
that deadline allows it, contact or delivery retries send the retained spool even
without an installed or enabled collector. Resending
is safe: a measurement the hub already has counts as a duplicate. When the hub says
the device was removed or its token revoked, the agent stops; any other refusal only
makes it wait. A sign-in page in front of the hub (a redirect, or a web page where the
API answers with JSON) is named as such in the log, and the data waits for the hub.

Before sending, the agent makes every measurement fit the format (text cut to the
length a hub takes, empty names dropped, repeated windows merged), so one odd value from
a client rarely gets a batch refused. If the hub refuses one anyway, the agent halves
it until it finds the measurement at fault, drops that one and delivers the rest. The
hub moves the times of a batch whose agent clock is off by more than 30 seconds; the
agent moves its own schedule back when the machine's clock is set back.

**Running agents.** While the agent runs, it looks at the process list every 15 seconds
(see [Measuring](#measuring)) and tells the hub the machine's whole list when it changes,
and at least every two minutes while anything runs, with a short timeout: it never holds
up measuring, and a list the hub did not take goes out again at the next look. Without a
hub that takes it, the agent does not look (an older hub, which does not know the
request, is asked again every hour: it may have been upgraded). An idle session reports
when it last spent CPU like a working one, if the agent saw it:
the observation's date is remembered, never recalculated. A clock jump invalidates that
date without changing the working judgement or its hold; after a restart or a jump it
stays unknown until new work. Older agents may omit it. At most 200 sessions go
out: working first, then those that worked most recently, then the newest. The hub keeps
the latest list of each machine in memory for five minutes (after a restart the agents
send theirs again), files each session under its subscription (the account the client is signed in to now, else the one
the machine last delivered for that client; only one its person holds; the agent leaves
out a session of a client signed in anew since it last measured, until it knows which
account that is). This list supplies current presence by project (as that person named
it) and folder, visible to members of boards admitting that saved device's sessions.
Source disclosure follows the board's provided subscriptions separately. The compact panel uses current sessions; dashboard lists
use retained work in the board's period, with this presence attached when known.
Each list also counts until the next one, for at most 200 seconds: the hub
keeps when each session worked, with its machine, subscription, where it runs, since
when and its project and folder names as reported, as long as samples. A session is
never credited twice for the same time: after the hub's clock goes back, it is credited
again from where its time already ends, so a clock that ran ahead costs its sessions at
most as much time as it ran ahead, and the time counted before is never rewritten. Sums are worked
out when read (`domain/work.ts`): agent-hours add each stretch up, two agents counting
twice; active time is their union, overlaps counted once for whichever machines,
people or projects are asked about. The corrections people make to project
names apply when read, so they reach all the time kept. The database says since when
this is kept (`agentWorkSince`): before it, how agents worked is not known. The live
session projection carries each identified running agent's retained credited work on
its current subscription, summed across project, folder and origin contexts. This
operational counter is separate from the dashboard's period totals. The optional opaque
producer identity hashes a persisted private installation salt, OS, provider and native
process birth; wall clocks and context names do not tell identity. Linux and macOS use
boot IDs with raw process birth clocks, while Windows attempts only a validated fixed
96-byte process telemetry prefix and falls back when unavailable. Neither raw native
metadata nor producer IDs appear on boards or in history. A legacy session has an
unknown live counter, shown as a dash; known zero is distinct. Legacy history retains
its working-only ordinals, with no guessed mapping to identified work. An appended
migration preserves every historical row ID and work interval. Identified work has one
persisted high-water end across its contextual rows; crossing legacy and identified
namespaces clips against the opposite namespace's retained device-wide end, snapshotted
before writes. On rollback this can conservatively undercount parallel work until that
end. Shared session history and live counters are clipped to the device's current
joining or re-enable cutoff. Source quota attribution is additionally clipped to its
sharing cutoff; personal live counters retain their own captured credit. Dashboard session lists
and the agents panel opened from a card's tray use authorized work intersecting the
board's selected period, clipped to that period and those cutoffs. They include retained
contexts absent from the current machine list. The tray panel shows that period's work
in agent-hours, with project and folder, grouped by machine. Optional current presence
never supplies additional credited work or changes the historical roster.

The accounting table and agent activity use that same period. The table tells, for
each window, its subscription's active time, what the window spent per active hour, what share of its
spending came while agents were active, and, beside the forecast by time, a forecast by
work: how many active hours what is left lasts at that spending (or that it lasts to
the reset). An optional Agent-hours column adds each agent's time separately.
Agent-hours and the spending share while active are off by default; enabling either can turn the
full-width table into a list, where every value keeps its heading.
A widget stacks agent-hours by subscription, project or machine in bars of an hour
(the period's cells where those are longer; shorter bars where a range holds fewer
than twenty hours). Four agents over an hour make a bar 4h tall. The legend's groups
add up to the total in every split; projects and machines take nine Nord Warm colours by their
agent-hours, in order: red, orange, yellow, green, teal, frost, blue, deep blue and purple.
Those past them share a neutral one. Each group is its own however
small. Above the stacks are agent-hours, active time, recorded sessions and the average
at once (agent-hours divided by active time). Active time is not drawn: it is in the
totals and tooltips. A bar's tooltip gives these totals first, then all admitted group parts.
The summary and bar numbers describe all data admitted by board work filters. All four metrics change together: active time is an
interval union and recorded sessions are distinct identities across the selected work.
Empty selection, confirmed zero, unavailable work and pending exact evidence remain
separate states. Zero active time has no average concurrency.
The four metrics sit directly below the heading, without a separate group-name row.
Pointing to a visible legend entry or focusing it with the keyboard temporarily shows
that group's metrics in the same space. Pointer takes visual priority over keyboard
focus. A retained legend identity with no work in the known selected interval shows
zero for that group, preserving unknown and unavailable evidence; it does not borrow
the totals of other groups. Each focused entry keeps its own accessible description. Escape dismisses the
preview, and a tap toggles emphasis and holds that entry's preview for four
seconds. Click choices do not alter the summary or bar numbers. Shift and panning suppress
temporary readouts. The heading area, plot and widget retain their geometry throughout.
A subscription's activity grouping includes all admitted work. Its quota work columns
use the separate source-grant cutoff, so work before a subscription was provided can
appear in Activity without entering quota attribution.
The Agent sessions table compares the same work by project, machine or subscription,
with reader grouping and sorting independent of the activity chart. Its existing
count, credited work and last-activity columns can be accompanied by union active time
and average concurrency. These two grouped columns are off by default and enabled in
owner settings; individual-agent rows and disclosures retain their contextual fields.
It reads the shared period work index without quota history or plot preparation.
Whole-period totals never add group active times or average row concurrency. Recorded
sessions are positive-work retained contexts, so one logical producer can count more
than once after a context change. The chart explains the same count. Opening a group
shows those retained contexts, including ones without current presence, with their work
clipped to the same period. The table uses common whole-row pages and a bottom-right
pager without an inner vertical scroller. Its disclosure uses existing 50-row pages.
Small cells and visible raw-value sort crossings use the common clock; fixed ranges
do not tick. Ratio ordering uses shared exact BigInt cross-products, and its scheduler
searches bounded discrete polynomial segments around their integer vertex. It never
uses floating roots or polling. The existing nearest 250 ms batching applies. Replacement reads keep the last complete summary with its original basis
until new evidence is accepted, and access or work-authority loss clears retained work.
Session coverage begins with retained capture and the earliest admitted device cutoff;
no admitted devices means unavailable, distinct from known zero. Source quota coverage
also observes its source grant. A backward clock correction behind discarded evidence
keeps one complete prior range for rows, scalar work, coverage, summaries, order and
geometry through wait/error/retry; operational presence stays independent. Revocation
clears that basis instead of retaining it. The
pace and the share while active are taken over the activity within the steps between
samples whose spending counts, so a gap counts neither, and need half an hour of it. Work that
would outlast the reset, or a whole window where no reset time comes first (a range),
lasts to the reset, however slow the pace (too slow a pace names no hours for it); short
of either, what is left runs out before it, and its hours are named at any pace. Only
where neither bounds them (a window of no known length with no reset ahead) does a pace
under a twentieth of a percent an hour foresee nothing past a week of work. A reset gone by unmeasured leaves
what is left unknown until the next measurement, used up or not: the forecast by work
waits for it where agents worked, and where none did says so. Where none of the agents
worked, there is no share either. The share counts a step that any work
touches whole, so it is an upper bound. Source-wide quota estimates use admitted
work with held, disclosed subscription funding, independently of card layout. Shared
boards clip it at device admission and the source's grant; personal boards retain
their own captured credit. Work outside these bounds is
not in its hours while the window's spending is, and so is spending outside tracked
agents (claude.ai, a phone, machines without Quotum, cloud tasks): the share while
active says how far to trust the pace.

## Storage and the rules

One SQLite file (WAL). The UI calls a subscription or budget a **resource**. Its
internal **source** identity is kept once for the whole hub:
keyed by the account pseudonym, or by the device's person for clients that don't name
their account. Which boards show it is recorded apart from it (see below). Each source
has its last state (what the card shows) and samples: one row per window per
measurement (value, reset time, the window's kind and scope as the agent reported
them), kept for 90 days.

- **Spending** is only an increase of the used percentage between two consecutive
  samples of the same window, inside one reset window, with no gap between them.
  Resets, corrections by the provider and gaps (a sample arriving later than the
  previous one promised) are excluded. An idle rolling window whose reset time drifts
  forward is not a reset.
- **The chart** puts every series on one time grid and shows the lowest remaining value
  in each cell. The finest grid keeping a frame within about 360 cells is shared by hub
  and page (`server/domain/history.ts`): a minute up to 6 hours, 5 minutes for a day,
  30 minutes for a week, 2 hours for a month, with 5% over allowed. Periods from an hour
  to 30 days belong to the page (`ui/lib/periods.ts`); a selected range is 15 minutes to
  31 days. Both use whole cells, with a half-open right edge. Proven spending steps belong
  to the cell of their later measurement; the value held at the first measured cell's
  start and the last measurement give the table's edges. Cell totals are rounded to four
  decimal places and added for a frame. Resets inside a cell void only their step.
  The page keeps history as tiles of 60 cells aligned to the epoch, reading only missing
  or changed cells through `GET /api/history`. A cold read starts at the frame's first
  cell, omitting the unseen head of its first tile. Each tile records the interval read
  in this connection. Entering its unread head fills that tile once; subsequent frames
  reuse it. The hub reads at most eight tiles at once,
  in one pass through each measured window, including its preceding sample. Each cell
  carries the point, its edges and break, spending and work, and per-session activity;
  compact indexes and omitted defaults keep the answers small. Every window with samples
  is included; the page selects current windows and gets their metadata from cards.
  The chart, table and activity are composed on the page from the same cells. A whole
  tile ending before now is cached on the hub, within 32 MiB. Every measurement and
  credited work invalidates tiles it can affect, including an empty tile of that source;
  a changed `Store.workKey` (device admission, funding disclosure or relevant project/machine names) recounts it. Resource selection and financial proof remain separate.
  Tiles near retention's edge are never cached. Deleting retained samples, work or events
  advances a private store revision; the next server read clears the tile cache before
  looking for hits. Even a distant tile can depend on a preceding sample of any age.
  This housekeeping emits no history event: observations already read by the page stay
  until its usual data or connection changes. Stored plan events are an exception:
  quota tiles carry actual nonempty plan observations and the latest authorized
  differing predecessor. Their independent retention deadlines limit closed-tile
  reuse; the page redacts expired facts from tiles and readouts with its shared clock,
  without HTTP or a physical database prune. A first accessible observation means
  first known to this reader. Plan names count towards the existing byte budgets.
  The page keeps packed buffers within an
  estimated 15 MiB, protecting the frame on screen and removing dictionaries no retained
  cell uses after replacement. Session references are opaque and
  change with the hub's run, so answers cannot mix runs. A machine's list credits work
  with its next list or after five minutes of silence (`KEEP_MS`, up to 200 seconds of
  work); each credit tells history its actual start. The chart begins where the history
  does, the same for every board: the database's creation or an older retained sample
  delivered from an agent's spool. The dashboard protocol specifies the cells and privacy
  in [Reading history](../spec/dashboard-v1.md#reading-history).
- **The plan** is per source and belongs to the board's view: whole percents per day of the
  weekly window (30/25/15/15/10/5/0 by default). A day at 0 has no spending planned,
  wherever it is; the plan ends with its last non-zero day. Other windows are planned
  linearly to their reset. The board's owner can switch a source's plan off: then none
  of its windows is planned on that board. The chart draws the plan of the current week
  only. A plan the owner chose for a weekly window that ends before its reset adds a line
  to the forecast's tooltip: what the forecast has left when the plan ends. The default
  plan chosen explicitly is not kept as chosen, and adds none.
- **The forecast by time** says where a window leads, the same over any period (the
  forecast by work is told with agents' work, under *Delivery*). A weekly window's is the
  hub's (`hub/server/domain/forecast.ts`), one for the whole hub, and goes by how its
  subscription spends. It follows the window as a series through its resets over the last
  23 days of samples: what was spent between two samples is spread over the ten-minute
  cells between them, time without samples or with a rolling window not yet begun is time
  spent idle (but from the last sample before a reset to the start of the new window, when
  longer than a cell, it is unknown and does not count), and a cell at zero (99.5% used or
  more, or a model's window while its subscription's weekly window is at zero and resets
  no sooner) counts as neither; an hour counts with three counted cells. How the
  subscription usually spends is a shape over the hours of the day in UTC, from up to 168
  counted hours of the last three weeks, and, with 14 days of them or more, a factor for
  each day of the week; its level is that of the last 24 counted hours. From the sample it
  stands on to the window's reset the line goes down as that shape does, fast in the hours
  it usually spends and nearly flat in the others. It runs out once the line reaches zero
  and ends 5 or more points under it, and keeps saying so while it ends no more than 2
  over; the moment it shows moves only by more than an hour or a fifth of the time to it,
  whichever is more. Otherwise it lasts: "~X% left" when it ends with 5 points a day to
  the reset or more (at least 5), "just enough" otherwise, each held until the forecast
  passes that mark by a day's worth of points, so steady spending in whole percents does
  not flicker between the two; X is a multiple of 5, held until the forecast moves from it
  by 5 points or 2.5 a day to the reset, whichever is more. The board makes it red when it
  runs out within half the time to the reset, and yellow at most with free resets, or with
  a reset for everyone announced before it and not measured yet. The last 6 hours going
  twice as fast as usual or more (at least 3 counted, against the shape without them and
  never under its mean hour), so that it would run out before the reset at that pace, put
  a muted arrow up by the words, and how many times and when it would run out in the
  tooltip; the verdict stays.

  The producer records the actual observed plan boundary used at its confirmation
  hour. Each board filters this provenance by source grants, sharing and retention;
  expiry updates only the provenance, leaving the shared numeric model intact. A
  compatible weekly forecast's tooltip gives the plan observation and explains its
  confirmation after an hour, including a forecast waiting for more data.

  A series says nothing until it has an hour of history. Under a day it goes by the hours
  it has, leaning on the window's own mean (once the window ran half an hour when the
  series saw it begin, else a twentieth of its length), never says what will be left and
  is yellow at most, and its line is that pace as it is: it may end high above zero while
  the table says just enough. While the whole life of a series lies within the 23 days it
  reads, time idle before the first window it saw not yet begun or beginning is not
  history, if nothing was spent before it: for a rolling window (Codex after a reset) that
  beginning is its first use. A window on a schedule (Claude: a new one begins at the
  reset) and one already begun when Quotum first measured it keep the idle time before its
  first spending as history, so steady spending after a long idle start may read "~X%
  left" for some hours before it says it runs out. A change of plan starts the history
  anew once the new plan has held an hour (the hub records a subscription's plan when a
  measurement first reports it and whenever it changes); Claude Max 5x and 20x report the
  same plan (`max`), so a change between them does not.

  After it starts, the hub works a series out first on its latest sample, as of the last
  whole hour if the sample came before it (or goes on from what it kept, if that took the
  sample in), so a board measured no more is told nothing more. It works it out again at
  its subscription's hour after a sample the forecast has not taken in (the hour whole,
  worked out up to ten minutes after it, by the subscription's id, so a hub's forecasts
  are not all worked out at once), and at once when a sample contradicts it: a series
  coming back from zero or reaching its first hour, a new window begun, the used share
  falling by 5 points or more, the moment it showed come with some left, an hour or more
  with no sample (or longer, as long as the samples were said to last). A sample come late
  for the moment a forecast stands on, from another device, works that moment out again.
  What the verdict keeps from one to the next goes into the database after each round of
  events and each read of the overview, so a restarted hub goes on where it was; a series
  that fails is left without a forecast until the next hour, the others stand.

  A five-hour window's is the board's: what was spent since it started over the time since
  then, idle time too, goes on to its reset; within 5 points either way of spending it all
  then it is on pace, 5 or more over it runs out, otherwise some is left. It says nothing
  until it has run half an hour, or a twentieth of its length when that is longer, nor
  while it is a rolling window not begun. A window due to have run out already says when
  and waits for a new measurement, as does one whose reset went by unmeasured, used up or
  not. Numbers gone stale keep their forecast: the moment it runs out is a moment, as true
  for an old measurement until it comes. On the chart each window with a forecast gets a
  thinner, fainter line in its colour and dash, from its last value to zero or its reset:
  a weekly window's in the shape of the hub's line, which stands on the sample of its
  hour, moved to start there. With the plan or the forecast shown the chart keeps some
  future on its right; on `auto` it stretches to the last moment a window runs out within
  about 40% of its width, and a window that runs out further leaves the future as it is
  and is pointed at from the right edge, the soonest first, as many as the plot has rows
  for; those with no room are said together on the last row, each with its time in its
  tooltip. A range in the past, dragged or moved to, has no forecast.
- **Events** mark the chart behind now. An early reset is derived from the samples: a
  window's used share drops by more than 5 points before its reset time (resets of one
  source within 15 minutes are one event). Free resets granted are recorded when a
  measurement reports more of them than the one before. Resets for everyone that the
  community trackers report are kept as the hub sees them (the trackers only tell the
  latest one), and listed for as long as samples are kept, so the chart marks every
  one of its period, however far back it is moved.

Hub-measured sources keep exact unit-valued meters separately from percentage
windows. OpenRouter stores credits and lifetime usage; balance is their difference,
spending is positive usage movement and a top-up is positive credits movement.
The account pair keeps the time its response arrived. Each key page has its own
observation time for counters, period totals and cap resets, even when a traversal
crosses a UTC boundary. One atomic store write preserves those independent times.
Money readings use signed integer millionths; native Codex credits carry their own
exact coefficient and scale. Both have sparse value/semantic changes and
continuous observation spans. Unchanged heartbeats extend freshness without another
reading. Retention keeps one predecessor to distinguish a late increase from a reset.
Spans and provider contexts store their confirmed first observation separately from
their retained start. Pruning clips geometry without changing that observation or its
currency quote. A same-value recovery records its actual new start. Legacy heads are
unknown unless retained evidence proves them. Extending a span with an unknown head
preserves its previous confirmed tail before advancing it; that anchor cannot date an
earlier historical value. Readers never treat the retention cutoff as a measurement.
Reference and private currency retention preserve the quotes needed by these anchors.
Safe provider context has its own sparse history alongside that ledger: DeepSeek funds
availability, inventory completeness and observed key identities, and each key's
properties, reported period usage, BYOK usage and supplier dates. Exact amounts stay
as millionth strings; period totals retain their UTC day/week/month anchors and key
page observation time. Unchanged context extends its observed span; changed context
starts another. It is saved in the same transaction as numbers and state, independently
of what the card displays. An upgrade seeds the last known safe values with their
original timestamps. Retention keeps crossing spans and the latest baseline; it never
makes a stale baseline fresh. Raw responses, credential data and supplier identifiers
are not archived. Exchange rates and derived monetary values have their own shared
archive, separate from provider facts.
Future budget analytics can read these records without inventing
spending or retroactively reconstructing overwritten period totals.
A missing key is stale after one successful traversal and archived after two successive
successful misses; partial traversals never confirm absence, and history is retained.
A valid null limit explicitly ends the current cap, including in a partial round.
Each key's explicit cap presence or absence is saved at that key page's observation
time. Partial inventories and malformed limits do not replace this evidence. Historical
cards apply the last confirmed state before their right edge, and retention keeps its
predecessor; a later incomplete response cannot restore a removed scale.
Older retained inventories can establish absence only by their recorded completion
time. They cannot recover an earlier page time or a removal that retention already
discarded; without that evidence the old amount remains last-known and stale.
Invalid money leaves stay distinct from null. The ledger retains the last confirmed
span endpoint as evidence through archival and retention; reappearance uses that
heartbeat time as its spending anchor.

Codex reports purchased credits on its existing subscription source. Dashboard and
compact show additional funds as a footer mark, with exact amounts and conversion
details in its disclosure; the subscription body keeps its percentage limits.
Clients that have never reported credits get no empty footer mark. A confirmed zero
is numeric; a missing, invalid or stale reading keeps the last known amount visible
in the same warning colour as stale free resets. It remains one balance informer,
with no separate warning icon. Its disclosure uses the tray's shared heading and
detail table for native credits, measurement time and rate. Hovering shows the exact
native balance. The separate Subscription extra funds trends widget plots credit
history in the display currency alongside the subscription limit chart. Wallet budget
charts and tables exclude subscription funds.
Windows, free resets and credit status have independent strictly newer observation
watermarks; a separate monotonic delivery baseline drives cadence and survives restart.
Accepted late resources acknowledge eligible commands without advancing that baseline.
New quota evidence can update Auto's change detection independently of transport progress.
Fixed schedules restore their persisted baseline; Auto still measures immediately after
restart until a genuinely newer delivery arrives. Deferred runtime acknowledgements run
only after the mixed database transaction commits.
An explicit unavailable quota observation persists an availability barrier separately
from the original samples and their freshness promises. Native quota history, forecast
evidence and alert baselines break there; recovery starts a new segment without an
inferred spend or a threshold-crossing alert. Packed quota cells carry an exclusive
availability end for both drawing and readout, limited by that sample's own freshness.
Bounded native readouts use the precise pointer time and retain that deadline even if
later samples have a different freshness promise.
A coarse cell recovering after an unavailable start remains unavailable as a whole for
drawing and readout, including when the gap began in an earlier cell. Recovery exactly
on a cell boundary starts an ordinary new cell. Totals retain only proven consumption steps.
Native credit amounts use exact coefficient/scale values, with scale stored per reading
and retained in packed history and conversion provenance. Finite availability ends
exclusively on missing, invalid, unsupported or unlimited observations; equal-value recovery starts
a new span. No credit change implies spending, top-ups or quota forecasts.

The shared currency layer defines `credits:codex` and an offline public default of
0.04 USD per credit. Personal rate events can override or restore that default using
the existing revision/receipt contract, without changing successful historical bindings.
One chosen credit/USD leg precedes the ordinary display-currency path, rounded once.
The builtin is managed in Currencies, immutable and unavailable as a display target.
No provider-specific conversion or synthetic USD meter is needed in the adapter.

Financial authority is per shared placement. Old and new Codex shares default off;
wallet shares retain unrestricted retained history. Member-holders explicitly grant
finance with a revision-checked command; owner status alone is insufficient. Enablement
records an admission cutoff, and its first finite heartbeat forces one durable numeric
anchor. History filters evidence before conversion, independently of retention/crop
geometry. Current last-known values preserve their original time. Projection, events,
history and currency context use the same grant; revision changes invalidate both
native tiles and client generations. See the dashboard and ingest specs for the wire
fields, exact decimal bounds and privacy contract.
Event delivery rechecks the prepared batch's financial authority before sending. A
mismatch rebuilds its snapshot and private currency context. A changed revision also
discards undelivered poll frames, including across a disable/re-enable cycle. Normal
SSE changes keep the delta protocol; grant metadata invalidates client history.
History invalidations expose only admitted resource scopes and anchors.

DeepSeek reports totals, granted credits and topped-up balances separately for CNY
and USD. Stable catalogue descriptors identify total and component roles. Its
balance-only policy makes spending and top-up events unavailable at the ledger,
packed-cell, composition and UI boundaries; balance changes never become estimates.
`balanceStatus` carries the supplier's availability boolean, partial issues and its own
observation/freshness. Accepted empty or partial replies retain missing numerical
values as stale and persist an exclusive interruption on their observation spans.
A same-value return starts a new span without inventing a changed reading. Accepted
status time is the watermark even when numerical success is older.
Budget cards and the compact panel use one typed presentation of funds and selected
allowances. Dashboard cards use the latest retained measurements before the end of a
historical selection; compact keeps current values. A single Available balance section
uses the reader's display currency. Native reference currency takes precedence over
separate converted observations; the two are never summed. Composition
opens from the balance amount in a shared Popover. Key allowances appear separately, with their own scope, limit and reset;
they do not add to account funds. Only catalogue-supported caps have scales. Lifetime
credits never supply a wallet's percentage denominator. DeepSeek has no key-cap scales
or spending summary. Each value keeps its own observation time and stale state.
Additional observations have explicit purposes: balance components explain the displayed
funds, counters and reported period totals support analytics, BYOK retains a separate
accounting basis, and key properties and inventory quality describe access and
measurement reliability. New API fields do not automatically add card rows. The safe
context archive is independent of this presentation.

Currency behavior belongs to the shared money layer. Native adapters and `readings`
keep reported amounts, units and observation times. `DEFAULT_CURRENCY` defines the
initial USD reference and display policy once. A persisted preference selects each
reader's display currency independently of the shared board. Standard currency identities
are ISO codes; personal definitions use opaque `personal:<24 hex digits>` identities,
with owner-only names, symbols and display precision. Percentage quotas and non-monetary
counters keep their units. Personal Settings → Currencies manages this same registry
and preference on the web and in the local desktop hub. Standard definitions and public
reference rates are read-only. Display, Personal and Archive tabs separate the overview.
Clicking a currency row opens a dialog with Settings and Rate history tabs; the row menu
holds selection and archive actions. Editing shows one form at a time with native
selectors, without nested menus.
Personal metadata can be edited without changing identity.
Archiving the selected currency requires an explicit active replacement in one transaction;
restoring a currency does not select it or resume stopped rate pairs.
Standard display precision comes from the runtime's currency metadata; personal
definitions carry their owner's explicit precision.

The currency domain accepts generic named rate sources, bases, effective times and
validity. Source adapters own transport and supplier validation. The current public
adapter is the fixed credential-free ECB XML read, with bounded bytes, timeout and no
redirects. Public snapshots are shared; fixed personal rates belong to their owner.
An initial personal ratio defines a timeless nominal unit, rather than a historical
provider observation. Later dated versions preserve prior assignments. An append-only pair timeline selects
the latest effective rate or stop, with a stable sequence for equal dates. A stop prevents
older prices of that pair from becoming eligible again; another explicitly configured
active pair may still provide a path. Initial ratios and immutable quote payloads survive
archival. Backdated corrections apply only to points without a successful assignment. Exact BigInt
arithmetic composes supported paths and rounds once, including conversion from the
original CNY amount rather than a rounded USD intermediary. Neither provider keys nor
account identifiers reach reference-data readers.

One hub service captures no provider data itself. It subscribes to accepted native
measurements and requests public references after native transactions and secret-buffer
cleanup. Its cache, cancellation and lazy refresh are shared across accounts. Native
reference-currency display needs no rate request; another selected currency requests
references only when its path is missing. Provider authentication and accepted data are
independent of conversion health. Missing or overflowing conversion remains unknown,
with native cap percentages still available.

`exchange_rates` preserves immutable snapshots in public or private owner namespaces.
`money_valuations` retains the default public reference estimates separately from native
facts. `currency_bindings` pins a reader/source/from/target/time/anchor path; identical
assignments extend sparse ranges. Retention keeps needed predecessors and current
observations, with referenced quotes. Changing a preference or receiving a later rate
never overwrites original provider history or an already assigned historical path.
The additive upgrade keeps earlier default estimates and legacy provenance.
Unused private rate versions follow the same retention policy as public references.
The initial nominal definition, a predecessor for each rate pair, and every quote
needed by retained assignments remain. Bindings serving a retained native predecessor
survive even when the binding itself ends before retention.
Timeline retention also keeps the rate or stop decision at every retained native
observation anchor, including points with no reader assignment yet. Retryable unavailable
observations preserve actual heartbeat boundaries across packing: a missing observation
ends the previous displayed interval, while a later permitted rate can recover that exact
anchor. Equal successful paths coalesce only across continuous eligible intervals.
The definition pins its initial quote explicitly; later zero-date versions are ordinary
retained rate updates, rather than additional permanent definitions.

Management writes use an owner registry revision and optional replay receipts; settings
always send both. One transaction validates CAS, writes changes and records the result.
Receipts last seven days; a stale expired request cannot pass CAS. Notifications and
cache invalidation occur after commit. Private path revisions are owner-wide, so a
standard selected target using a personal bridge also refreshes missing history. Metadata
edits change the registry revision without forcing monetary history reloads.

Reader snapshots and the private `currencies` event carry the registry revision, one target definition and
source-specific bindings. Personal definitions and rates never enter shared card or
history caches. The page preserves each source's binding slice so another source's
measurement does not render its card. Dashboard, compact, key allowances and money
analytics use the common presentation and formatter. Financial scope and label retain
native meaning; conversion metadata identifies original values and the quote path.
Caps derive their percentage from native numerator and denominator and convert their
remaining amount once. Composition stays in the existing disclosure.

Money history first computes native accounting and coverage, then applies the reader's
currency outside the shared native tile cache. Original CNY provenance avoids repeated
rounding. Exchange movements cannot create spending or top-up events; balance-only
accounting stays unavailable. History requests validate board membership, source grants and ownership
of the selected currency. A price revision refreshes the selected monetary history when
a previously missing path becomes available. Native reference mode keeps its existing
request, packing and performance behavior. Subscription selection remains independent.
Each authorized history read loads binding ranges by source and unit once, converts
cells in memory, and commits sparse new assignments after transformation. Effective
quote intervals cache successful and missing paths, while the bridge index avoids
comparing every pair of historical versions. Converted semantics stay sparse too.
The reader loads the requested binding interval and its predecessors, with stable
indexes for starts, endpoints and anchors. A native heartbeat need not change the
amount to introduce a new valuation: its assigned price has its own point on the
timeline. Multiple admitted valuations retain their individual timestamps through
clipping and packing, without creating spending or rewriting native observations.

Observation-mode money cells retain their actual sample offset, segment and exclusive
validity, bounded by their fixed grid cell and span interruption/TTL. Composition can
emit a confirmed opening prefix before an ordinary change in the same span, while
new or recovered spans have no prefix. Packing preserves these fields and replaces
the whole selected interval, including an empty response. The existing chart uses
actual observation anchors and raw pointer time for these series. A deadline endpoint
is geometry, never a measurement. Subscription and OpenRouter series retain their
cell midpoint and snapped readout. No value carries into an unconfirmed next cell.
Retention keeps original heartbeat endpoints as evidence while bounding observation
points and coverage to the retained interval, including a cell crossing its edge.
An opening prefix has its own offset after clipping, so known values survive from
retention up to the primary observation without backfilling its unretained edge.
Its own semantics preserve the quote and original amount independently of the
primary point, through packing and reader conversion across chunk boundaries.

Personal Global z.ai Coding Plan quotas are hub-measured subscription caps in
`credits:zai`, separate from monetary counters. The adapter supports only the observed
`CREDIT_LIMIT` tuples `(unit=3, number=5)` and `(unit=6, number=1)`; allowance and usage
come from original JSON numeric tokens, quantized once to integer millionths. Legacy
prompt/token/MCP and unknown quota shapes remain unsupported. Valid neighboring caps
survive partial replies and optional invalid reset fields; missing amounts never
become zero. The fixed raw-Authorization GET is the provider-published usage plugin
interface, not a versioned quota OpenAPI schema. No model request is needed.

Subscription caps and OpenRouter key caps share a status dot beside each limit name.
Subscription cards and compact rows use the same percentage-limit component as
client-measured subscriptions. Exact credit amounts and allowances stay in value
tooltips, and period names come from the shared subscription labels. Stored meter
units and historical cap semantics remain unchanged.
Subscription analytics project these caps into the ordinary five-hour and weekly
percentage series, alongside client-measured windows. The page's history loader
requests both cap periods with native window history; switching period does not
create a separate credit mode or request.
Server history retains native window series when the selection includes a
subscription source, using the provider catalogue's funding type. Wallet-only
selections retain the money-mode optimization that skips native window reads.
Each historical percentage uses that cell's own allowance and exclusive observation
bounds. Source order, colours, legend keys,
period visibility, time navigation and measurement-table rows are shared. Unknown
allowances and unobserved intervals remain unknown. Cap-only sources have no native
quota spending, plans, forecasts or agent-work attribution; those table cells are
unavailable rather than zero.
The shared chart and table explain a bounded-history refusal using the same message
as monetary analytics, without leaving a loading or empty-selection message.
Missing or stale measurements keep their last confirmed values at full opacity; the
dot explains the status and shows the last observation time. Key inactivity keeps its
distinct dot state. Freshness clocks update these small marks, not the whole limit row.

Accepted quota outcomes persist completeness and observation time independently from
last success. Authenticated missing quotas hard-close `meter_spans.hold_until` in the
same transaction as accepted neighboring readings. Recovery opens a new span, even
inside the previous freshness deadline. No-valid replies create no reading or
heartbeat. Historical cap cells carry their own exclusive `knownFrom`/`knownUntil`
bounds through packing, composition, chart geometry and readout; no value crosses an
omission, reset, missing cell or freshness deadline. A coarse cell with incompatible
segments remains unknown. Cap usage is neither a spending counter nor a top-up.

Money history uses the same bounded tiles, cache and page loader. Its exact strings,
historical cap semantics and original spending intervals stay separate from the window
Float64 codec. A logical balance selection internally reads its two counters. Axes and
arithmetic never combine units; money does not contribute percentage attention,
forecast or quota notifications.
Source-level spending counters also retain every accepted unchanged native endpoint
in the same readings ledger, with a capture fence established at the first supported
observation. Sparse financial access uses its partial index and excludes these extra
anchors. Retention preserves both the sparse financial predecessor and the accepted
pair predecessor. Legacy spans never reconstruct missing timestamps.
Optional wallet work history correlates whole continuous counter pairs with the union
of resolved work. It estimates spending per active hour after thirty active minutes and
remaining active hours from fresh native funds. Balance-only sources, subscription
funds, individual keys and quota caps supply no monetary work rate. A single source
correlation is shown once among its selected account rows, with its native evidence
and partial coverage. Current currency presentation uses the shared recorded binding.
A work burst combines quota/activity and opt-in budget tails through the shared
authenticated read-only period POST. Their grids remain independent and share a
bounded work read. Composite drawing cells contain financial data; work estimates
use the common period tape and curves. Ordinary finance-only history keeps its
existing path and cache dependencies, and the legacy GET history route remains available.
Money cells are packed separately, with small header and interval leaves; unchanged
cells share their byte buffers during private staging. Packing, decoding and composition
yield between leaves and cells through the shared preparation scheduler. Monetary
points also enter the progressive plot during a gesture while table totals retain the
last complete answer. A monetary visible frame that cannot fit the existing 15 MiB
tile estimate reports the history limit before publication, without dropping data.
The plot holds raw monetary cells and the visible period separately. Spending
composition uses that period's interval classifier even when the drawing holds wider
neighboring cells; a cached movement updates the period without rereading the tiles.

A hub polling service starts after readiness and stops before SQLite closes, with at
most two concurrent jobs and one per source. It rechecks access versions and source
generation before committing a result, so deletion and replacement discard late
answers. Auto intervals stretch from two to fifteen minutes; existing fixed preferences
also apply. OpenRouter bounds its whole round to sixty seconds; exhausting the
inventory budget preserves successful account measurements. Lifecycle cancellation
still discards the whole result. An inventory rate limit ends the traversal and its
bounded Retry-After delays automatic and manual retries. Permanent access failures pause automatic retries. Refresh requires a
source holding and shares a one-minute cooldown across boards. Owner source access is
projected separately for each reader, outside the shared board cache.
Frequency saves publish the new preference during an active poll; its cadence is
recomputed after that poll finishes.
Resolved held client work keeps healthy Auto polling at two minutes. Starting work
shortens an idle promise while preserving the last-dispatch minute, supplier retry
floor and fixed settings. A single activity timer follows rule boundaries and report
expiry without a dashboard reader. In-flight observations use current activity for
their next interval and freshness promise.

## Trusted connector keys

The hub has a write-only credential service, separate from password and machine-token
hashes. OpenRouter uses it for a management key, through code-owned GET operations
for the account, credits, workspaces and keys. Connector adapters are registered in code;
tests inject their own adapter. Each credential belongs to its person and can be
created, replaced, listed or removed only by that person's session. Create and replacement
identify the account outside SQLite, then commit encrypted access and its verified
source holding atomically. A replacement cannot change the account. No-expiry access
is admitted in one informed submit.
DeepSeek has declared identity: each owner creates an
immutable account UUID and private name, independent of keys. An owner/provider-scoped
pseudonym determines the source. Same-account replacement requires an attestation;
a different account needs a new connection. Both declared connectors use the same
`sameAccount` attestation and owner/provider/logical-UUID pseudonym generator. Named
accounts additionally support explicit selection and reconnection; neither names nor
keys identify an account. Existing source bindings are reused without recalculating
their pseudonyms. Removing the last key releases the holding
but preserves identity and retained history for explicit reconnection. A persisted
last-binding deletion trigger advances its lifecycle revision. Unknown key expiry is
stored separately from no expiry and requires its own acknowledgement. Owner account
pagination and sharing labels never enter shared source projections. Creation retries can use an owner-scoped UUID for 24 hours;
a deletion leaves its replay tombstone. Deleting the last own access releases that
person's holding, preserving others and history. Missing or broken access preserves
last measurements and a neutral shared failure, with details only for its owner. Mutations require
an explicit same-site Origin before parsing, accept only a connector's strict printable
ASCII key format, and are limited to ten attempts a minute per person and address.
Replies contain only the safe record details, including a last-four hint; neither the
key nor encrypted bytes go to the dashboard's events or shared boards.

Without explicit inputs a new server creates a durable key in separate storage:
`/keys/current.key` on a distinct persistent container mount, a private POSIX sibling
of the canonical data directory, or a private nonvolatile HKCU branch on Windows.
POSIX publication uses an exclusive temporary file, file fsync, a no-replace hard
link, and directory/parent-entry barriers, repeated when admitting an existing key.
Linux container storage identifies the opened directories by their kernel `mnt_id`
and compares the actual backing mount roots, including stacked and hidden mounts.
Windows reserves a durable nonsecret UUID, then a packaged bounded helper owns a
global native mutex through private registry query/write, flush and read-back. The
Windows hub build compiles this helper with the system .NET Framework compiler and
copies its DLL beside the PowerShell loader. Key requests load the prepared DLL
within their ten-second deadline; they never invoke a compiler. The resolver runs
under the same SQLite transaction as the key check; an established
missing or mismatched store is never regenerated, including an empty credential set.
The desktop's native controller remains the authority in local mode.

z.ai does not supply account identity or key expiry. Its connector declares authenticated
access without an account pseudonym; the credential service creates a random,
owner-local logical account and stores `source_identity` provenance atomically with
the encrypted credential and holding. New connections never merge by key or plan.
Explicit same-account replacement keeps that source and history, with the API's
identity-verification limitation explained in My connections. Unknown expiry requires
its own consent and remains distinct from a known deadline or confirmed absence of
one. z.ai HTTP and envelope authentication rejections have a neutral private code;
shared credential failures remain `unmeasured`. Ordinary z.ai keys may permit model
requests, though Quotum calls only the fixed quota GET.

`QUOTUM_SECRET_KEY` supplies 32 random bytes as canonical unpadded base64url (43
characters); `QUOTUM_SECRET_KEY_FILE` instead reads those characters, optionally
followed by one LF or CRLF, from a regular file whose real path is outside the data
directory. The two inputs are exclusive. HKDF-SHA256 derives separate encryption and
check keys. AES-256-GCM binds each credential to its id, owner and provider, using a
fresh 12-byte nonce per write. SQLite keeps only ciphertext and its tag, nonce and key
generation. Asynchronous credential operations capture and recheck the full current
key check value and monotonic epoch inside the commit transaction. Real rotation,
reset and replacement of an unused key advance the epoch, including empty-account
resets and an A→B→A sequence; an old loaded key cannot submit new work.
A full key check value in `meta` identifies the database's KEK; its first
eight bytes are the diagnostic fingerprint. The KEK is never written to SQLite or its
data directory. Input variables are removed after capture. The entry point protects
Node reports and sets a private file mode before loading configuration or other hub
modules, so even early startup failures exclude the environment from diagnostics.

Startup reports `created`, `ok`, `rotated`, `mismatch` or `missing`, with safe
fingerprints and record counts. Missing or mismatched keys preserve every credential
and leave ordinary agent measurements available. `QUOTUM_SECRET_KEY_PREVIOUS` (or
its `_FILE` form) permits rotation in one transaction. Unreadable records retain their
ciphertext and old generation. SQLite uses secure deletion and full synchronization;
each successful start verifies a TRUNCATE checkpoint before its report, so a committed
rotation with a busy WAL cannot authorize deletion of the previous key.

The server's one-shot `reset-secret-key --from <fingerprint|none> --to <fingerprint>`
command uses the same decision engine and checks both fingerprints inside the
transaction. It never listens or leaves a reset instruction behind. Restoring an old
backup requires a new explicit reset action. See [deployment](../deploy/README.md).
Connectors send credentials only to their own fixed HTTPS hosts and operations, with
an explicit TLS agent, no redirects or environment proxies, a ten-second total deadline
and a one-MiB response cap. Errors cross the boundary as codes, never raw messages,
paths, supplier replies or causes. See [SECURITY.md](../SECURITY.md) for the protection
and its limits.

## People, boards, devices

- **Users** sign in to the hub with an email and a password. The first person on a hub
  signs up without an invitation but with its setup code: a new hub prints one to its
  log, so only whoever started it can claim it. After that, signing up needs an invite
  link unless the hub is open (`QUOTUM_SIGNUP=open`).
- **Devices** are running agents, and each belongs to a person. *My connections* has
  separate Accounts, Devices and Tokens segments. Devices shows aligned overviews of
  the person's machines and measured subscriptions. Selecting a row opens its object
  in the shared dialog: a machine's measurement participation or diagnostics (Quotum and client
  versions, observations, failures and sessions), or a subscription's preferred machine
  and retained resource origins. Resource details use the shared popover, fitted to
  the dialog's scrollport without enlarging it. The shared dialog keeps its glass
  backing beside its scrolling content so nested popovers can blur the text behind
  them with the same glass as other menus. Expanding diagnostics never lengthens
  a machine row or the page. A widget's contextual link
  opens its subscription dialog directly. Unsaved measurement drafts ask before leaving,
  and a save stays locked through its authoritative read. Connect a device opens the
  one-time command separately; token creation and revocation belong to Tokens. The
  local app omits tokens and distributed measurement controls.
  *Settings → Clients and resources* manages temporal client/resource links. Device and
  resource entry points open the same editor with context, without creating a link.
  An existing matching link opens for editing instead of creating an overlapping
  rule. The editor has one effective-date choice: saving time, a chosen date, or
  the entire period. A dated edit atomically preserves the old prefix and replaces
  the remaining rule, including its device and route scope; a whole-period edit
  can also move the original bounds. Active links default to preserving earlier work.
  Disconnected targets retain their owner-visible identity and the shared
  disconnected label, but cannot be selected for new work. Their owner-only
  management metadata includes no measurements or other people's private labels.
  Current and scheduled links share one list; the History switch shows completed
  periods in that same list. The editor keeps client, device, resource and effective
  date visible. Only the optional end and route conditions use a disclosure.
  Resource choices show their name and type (Subscription or Budget). Recommendations
  appear inside the editor after choosing a client and device. Selecting one fills
  its condition and exact free period; the person reviews these values before an
  ordinary manual Save. Opening the editor or
  choosing a recommendation records nothing. Session resource explanations live
  beside the session in its device dialog, including the saved name of a
  disconnected winning resource. Their private evidence loads only while the device
  diagnostics are open, follows owner presence changes and never enters board events.
  The owner device request adds `details=<device>` to include each session’s
  attribution in the same synchronous response. Project aliases and otherwise
  identical session metadata cannot attach another row’s explanation.
  *Agent activity → Settings → Manage projects* lists the projects their agents worked
  on, with the machines and when they last did:
  the person renames them and merges several into one, which applies everywhere they are
  shown and to all the time kept (only on their own machines), and gives a reported name
  back its own to undo it. How long agents worked is not shown there. A device connects in
  one of two ways:
  - *a one-time code* (the RFC 8628 device flow): `quotum connect <hub>` shows a code, a
    signed-in person confirms it in the browser; the device gets its own token and
    belongs to that person;
  - *a machine token*: a person creates one and writes it once into an image, VM or
    container setup; every machine that starts with it becomes that person's by
    itself. A machine connected with a code keeps its own token: a machine token cannot
    take it over. Revoking a token disconnects its machines; a machine removed by hand
    comes back only with a new token.

  Who a device belongs to is decided by the token alone. What the clients report (their
  sign-in emails) is never used for it: it is neither stable nor unique. One person's
  Claude and Codex may be different accounts, and a team subscription is used by
  several people.
- **Subscriptions** are what is measured. An account the client identifies is one
  subscription however many devices, of however many people, measure it; each of those
  people **holds** it. A subscription the client does not identify (Antigravity) is its
  person's own, optionally named in the agent's settings.
- **Boards** are what is shown. Everyone has a personal board: it shows every
  subscription they hold, by itself. Anyone can create shared boards; the owner names
  one and invites people with a link (valid for a week, several uses). On a shared
  board people **share** what they hold: the data belongs to whoever measures it, and
  only they decide whether a board shows it. A card leaves a shared board when whoever
  shared it takes it off, when the board's owner does, or when no member holds it any
  more (its last holder left or was removed). Deleting a board deletes its sharing and
  its view, never the measurements.
- **The view** of a board is how it is arranged: the order of its widgets (a card per
  source, agent sessions, activity, quota and budget charts and tables, and subscription
  funds history), their places on a six-column grid (`x`, `y`, `w`, and `h` where the
  owner chose a height; what the content
  needs is measured, never stored), names and colours
  given to cards, the hidden widgets (and those
  off by default, the list of agents, turned on), the columns hidden in a widget's table,
  the agents' and the limits' (and those off by default turned on), and the spending
  plans, or that a card has none. Agent sessions and activity include admitted device
  work independently of card visibility or subscription sharing.
  It is stored once per board, like a dashboard in Grafana: the owner arranges it and
  names the cards the way the team calls them, and everyone sees the same board. Nothing
  in the view changes what is measured or stored.

Project colours are a separate board presentation resource in
`board_project_colors`, outside the layout and filter documents. Owners choose Auto
or one of the nine shared Nord Warm swatches in the existing project editor under
Manage projects. The same popup edits the name and board colour with one Save.
Readers share that colour, including on the local desktop board; the Activity menu
opens the same project management. Names retain their personal scope and colours
their board ownership. A combined edit commits both changes atomically.
Repeated manual colours are allowed. The picker keeps a local draft with the resource
version read when it opens. An unchanged draft sends no mutation; a rejected stale
save requires reopening the editor with the current choices. Resetting every colour,
including dormant choices, requires confirmation.

Only admitted corrected project names appear in settings or colour projections.
Dormant pins remain private in storage, and colour metadata grants no access.
Owner patches use independent revision and process-private HMAC authority checks;
old layout writers cannot erase them. Storage reserves each of its 89 slots for a
maximum escaped name within 64 KiB, so later aliases always fit. A whole-group
unambiguous rename to a fresh name transfers the pin atomically on every affected
board. A target's dormant choice wins; a merge keeps the target, including Auto,
and retains source settings dormant for a later split. Another participant remaining
under the old name prevents transfer. These decisions use admitted live/retained raw
owner/name membership, independent of time range, filters, funding and card visibility.

Browser snapshots carry colour references and a separate bounded configuration frame;
HTTP overview also includes the authorized map. The native background reader omits
all colour fields and frames to preserve its 320 KiB decoder boundary. The desktop
window gets ordinary browser presentation. The configuration is its own browser
metadata slice: colour-only updates neither invalidate evidence nor read history.
Queued poll batches retain their producing authority and live-session deadline.
Expired or withdrawn work is replaced before configuration is refreshed or a
prepared response is delivered. Replacements preserve pending history invalidations
under current permissions, so cached cells remain current even when the work
authority stays the same. Incremental delivery coalesces colour metadata before
its final serialized size check. The physical queue retains its own memory limit.

Secrets (sessions, tokens, codes, invites) are random, prefixed by kind (`qt_s_`,
`qt_m_`, `qt_d_`, `qt_c_`, `qt_i_`) and stored only as SHA-256 hashes; passwords as
scrypt hashes. Changes made with a session cookie are accepted only from the hub's own
pages (Origin check, SameSite cookie). Failed sign-ins and sign-ups and code lookups are
rate-limited. An agent's request with an unknown or revoked token is refused before its
body is read, so whoever reaches the hub cannot make it hold bodies it would throw away,
and a request has 30 seconds to arrive in full.

`SIGTERM` and `SIGINT` stop a server hub within five seconds of its first signal.
Open events and polls end first; ordinary in-flight requests can finish during that
grace while integrations stop concurrently. At the deadline the hub cuts its own
connections, closes SQLite and exits without running further callbacks. The local
hub keeps its two-second bound. Demo and managed-development parents allow seven
seconds before killing a child; the managed outer fallback remains eight seconds.
These deadlines require a responsive event loop.

Server read JSON on the explicit overview, history, event-poll, reset, device,
project and source-key inventory routes negotiates Brotli or gzip at a 1 KiB
threshold. Compression uses native asynchronous streams, Brotli quality 4 and gzip level 6;
explicit encoding exclusions outrank wildcard weights. These representations vary
on `Accept-Encoding`, including identity responses. The shipped Caddy forwards the
encoded response. SSE, static files, other routes and local/desktop hubs remain
uncompressed, and compressed request bodies are not decompressed.
Fastify owns the native encoder returned as the response stream. A Node pipeline
connects its input to that encoder, so an aborted response destroys both without
waiting for garbage collection or continuing to encode the abandoned body.

## The dashboard

Private device-contact updates do not reconfigure analytical readers. Resource-card
readers share their projections while the immutable board is unchanged.

A single-page React app served by the hub. It asks nothing again and again: it opens one
connection to its board's [events](../spec/dashboard-v1.md) (`GET /api/events`), and the
hub tells it the board as it is, then each part of it that changes, within a tenth of a
second. On the hub, whatever changes data says what it touched (a source, a board, a
person); a moment later the hub puts the touched parts of every board being read
together again (`hub/server/projection.ts`) and sends each reader only what differs from
what it last got (`hub/server/events.ts`). What changes with time alone (a card going
stale, a machine's agents no longer shown, a holder falling silent, a past reset leaving
the history, a subscription's forecasts worked out again at its hour) it tells when that
comes: it keeps the moment each board being read next
changes by itself. A board nobody reads costs nothing, and one the hub cannot work out
(its data spoilt) fails alone: its readers start over, and a new one is answered an
error. Every connection starts with the board as it is, so a dropped connection, a
sleep, a restart of the hub or a tab hidden for half a minute (the page lets its
connection go then) lose nothing; where a proxy holds a stream back, the page reads the
same events with long polls for ten minutes. A session keeps at most 8 readers, a person
16 and the hub 2000; a new one takes the place of the oldest of its session, or else of
its person, so tabs a sleeping laptop left behind never keep a new one out (at the
hub's limit, someone reading nothing yet is refused). Over plain HTTP/1.1 a browser
opens at most six connections to one host and every open board keeps one: behind a proxy
that speaks HTTP/2 (Caddy in `deploy/`) that is no limit, without one more than about
five tabs of a hub in one browser wait for each other.

### The page's connection

`hub/ui/lib/live.ts` does what this table says and nothing else; its code and tests name
the rows. `mode` is a stream or long polls (for ten minutes once chosen); `short` counts
streams in a row that ended before their first `ping`, closed neither by the page nor
with `bye`; retries back off 1, 2, 5, 10 and 30 s, ±20%, and start over once `live` or
`polling`. Its timers count in the page's clock; `lostAt`, when the connection was lost,
in the hub's: entering `connecting` or `retrying` without one sets it to now unless a row
says otherwise, `live` and `polling` clear it, `paused` keeps it once a connection was
lost (`retrying`, or a row that says when) and clears it when one was only opening, and
the page leaving the board (signed out, the board gone) clears it with the board. Waking
is `online`, the tab shown, `pageshow`, `focus`, or a timer of its own more than 5 s late
(a sleep). The header says the hub cannot be reached once `lostAt` is 45 s old, unless
`paused`.

| # | From | When | Does | To | `lostAt` |
|---|---|---|---|---|---|
| 1 | any | another board opened | ends the connection; the page forgets the last board; on a tab hidden for 30 s already (row 18), opens nothing until it is shown | `connecting`; `paused` | as above; as row 18 |
| 2 | `paused` | the tab shown | | `connecting` | as above |
| 3 | `connecting` | `200` | waits 10 s more for `hello` and `snapshot` | `connecting` | |
| 4 | `connecting` | `hello` and `snapshot` on a stream | watches for 2.5 heartbeats without a byte; waits a heartbeat and 10 s for the first `ping` | `live` | cleared |
| 4a | `live` | no first `ping` in time, its timer on time (a proxy holds small frames back; a timer late is waking) | ends it; long polls | `connecting` | the last byte |
| 5 | `connecting` (stream) | no answer in 10 s, or no `hello` and `snapshot` 10 s after it | ends it; long polls | `connecting` | as above |
| 6 | `connecting` (polls) | an answer with `hello` and `snapshot` | asks again at once | `polling` | cleared |
| 7 | `connecting`, `polling` | `401` | stops; the page asks who is signed in | | cleared |
| 8 | `connecting`, `polling` | `404` with `board_not_found` | stops; the board leaves the list, the session is read again | | cleared |
| 9 | `connecting`, `polling` | any other answer (`429`, `403`, `5xx`, a proxy's `404` or sign-in page), a first poll answer without the board, no network, a poll unanswered for 35 s | backs off (`429` never means long polls) | `retrying` | as above |
| 9a | `connecting` (stream) | the stream ends after `200`, before `hello` and `snapshot` | as row 14 | `retrying` | as above |
| 10 | `live` | `ping` or an event | the first `ping` clears `short` | `live` | |
| 11 | `live`, `polling` | `bye unauthorized` or `bye gone` | as rows 7, 8 | | cleared |
| 12 | `live`, `polling` | `bye restart` | tries again in 1 to 5 s | `retrying` | now |
| 13 | `live`, `polling` | `bye limit` | tries again, not sooner than in 30 s | `retrying` | now |
| 14 | `live` | the stream ends, neither by the page nor with `bye` | before its first `ping` it counts in `short`, and the third in a row means long polls; backs off | `retrying` | the last byte |
| 15 | `live` | 2.5 heartbeats without a byte, found by its watch or on waking | opens again at once | `connecting` | the last byte |
| 15a | `connecting`, `polling` | waking after the attempt's time (10 s, or 35 s for a poll) is up; waking before does nothing | opens again at once, the same way | `connecting` | as above; the last byte from `polling` |
| 16 | `retrying` | its time came, or waking (not sooner than rows 12 and 13 allow) | a stream again once the time for polls is up; opens | `connecting` | as above |
| 17 | `polling` | a poll answered | applies its events in order, none after `bye`; asks again at once, or opens a stream once the time for polls is up | `polling`, `connecting` | cleared; as above when it opens a stream |
| 18 | any but `paused` | the tab hidden for 30 s, counted from when it was hidden (or the page loaded hidden), whatever board it was given meanwhile, if any | ends the connection and its timers | `paused` | kept once lost; cleared while only opening |

In the page, the events go through one reducer into a store (`hub/ui/lib/board.ts`); each
widget reads its own part of it and renders only when that part changes (a card, its
agents, its pace, its forecasts, the list of agents, the chart), and a part the same as before stays
the same object. What shows time (how long ago, how soon, the freshness dot, the plan's
mark, that the hub cannot be reached) is a small part of its own that tells the page's
one clock (`hub/ui/lib/clock.ts`) when it reads otherwise, and renders only then: the
clock keeps one timer for the whole page, none on a hidden tab, and counts in the hub's
time as the hub's messages tell it. Chart geometry moves on a cell of the history's grid
at a time. Activity totals, legend amounts and open readouts follow their exact selected
interval and wake separately when their displayed numbers change; a label past the
chart's right edge counts down on its own, and
a forecast's line goes at the moment the table says it runs out, or at the reset; in the
table, the plan, where the pace leads and the active hours left each read otherwise at
their own moment. A timed compact cell marks its complete preview wrapper as showing
time; ordinary data cells and static measurement remain outside that clock boundary.
History is read when the hub tells of measurements or credited agent
work. Quota/activity, wallet budgets and additional subscription funds use separate readers,
caches and selections. The two monetary readers share the budget history protocol;
selected source IDs isolate their invalidations.
Budget reads never query native quota or agent-work history, and money never enters
quota forecasts. Legacy unscoped history replies retain their combined contract.
The optional Activity heatmap shares the common selection and work filters.
The server partitions its exact selected interval into minute or quarter-hour cells
inside the same period transport. Compact signed demands replace changed intervals
and share one sparse extraction with other work consumers; they read neither
financial history nor a full session ledger just for the heatmap. Browser geometry
aggregates those fine cells into a chronological strip, day/hour matrix or compact
calendar as the duration and width require, without new reads or inner scrolling.
Civil coordinates and geometry are prepared after commit through the shared
cancellable scheduler. A compatible refresh keeps the complete grid until its
replacement is ready; a changed selection or authority retires it immediately.
Bounded civil-time and label caches contain no work values. A hidden surface keeps
its last positive measurement until it can measure its visible width again.
The plot has a natural height of 300 CSS pixels and a minimum of 160, independent
of the selected duration. A chosen height changes orientation, cell grouping and
label density; it never removes a civil date or divides a coarse amount to invent
fine evidence. Repeated DST hours retain separate lanes. Its cells fill the assigned
plot while labels remain legible and gaps fit the available pitch.
Pointer and keyboard previews share one active cell. Opening a cell's detail
suppresses previews; touch opens that detail directly.
Its legend inherits the same typography as the other charts and keeps the
agent-hours unit beside its scale.
Anonymous aggregate hour patterns share the history budget and preserve exact
within-cell changes, so cached return and nearby endpoints reuse accepted work
without rereading it or dividing already aggregated amounts. Work or authority
changes invalidate these patterns; eviction falls back to the common transport.
Wire decoding releases its temporary anonymous sweep after projecting numeric cells,
before expanding other reply sections. Restored cells and the original packed proof
keep their own charge in the shared history budget.
Cache projections borrow only the anonymous curves used by their selected segments,
without charging a second copy. Planning releases references to unrelated entries
before reserving the projection, so those proofs remain available for eviction.
A removed cache entry stays charged while a synchronous read still
owns it; authority changes retire that read's answer immediately. Curve construction
releases temporary arrays as it proceeds, and an accepted numeric reading takes
over its projection reservation before notifying subscribers.
Named local dates, repeated hours and partial bounds preserve actual elapsed time.
Shared filter choices cover the common selected work range; closed controls request
nothing. Shared-clock expiry retires stale contributions in individual buckets
without rebuilding geometry or polling. Null history, registered zero and
observation completeness remain distinct.
An explicit interval/day action changes the common selection and focuses its ready
grid after the requested evidence and geometry commit. Temporary unknown cells
cannot consume that focus handoff. Later deliberate input or focus revokes permission
to move focus; selection or authority changes retire the request altogether. An explicit
calendar Retry can continue its still-pending drill, while background recovery cannot
reclaim that permission. A committed ready grid completes the request even when focus
stays elsewhere. Only elapsed retained
evidence is counted. Fixed thresholds scale with the displayed interval, use the
first Nord Warm colour and remain independent of the filtered sample.

The page makes cells from `since` stale and reads only those its frame needs,
without a rate limit or a timer. Reconnect, a new lineup, or a change of whose work the
board shows or its names (`Store.workKey`) makes all tiles stale. The last frame stays
undimmed while its tail loads. A replacement period retains compatible content at full opacity until its cells
are complete; incompatible or unauthorized evidence retires inside the same shell. One pending read per target coalesces news until its response, while another
target can read independently. Errors and retries belong to the target that requested
them. Time alone never rebuilds or reads history; cells past the hub's cut are
known empty until new data arrives, and a response predating news cannot restore that
proof. Nothing that shows data or time keeps a timer of its
own (a tooltip or a gesture may wait a moment; `hub/ui/test/timers.test.ts` lists where).
Range validity advances the latest read's hub time by monotonic elapsed time from
its request's start, including its delivery delay; a range
wholly beyond its current grid cut returns to the chosen period.
`npm run bench` checks a board without measurements or working agents asks nothing and
renders only what shows time. It also checks measurements reach the card and chart
within a second, small reads per measurement, and one small read for a machine report
crediting work, rendering only that card, agents and analytics.
The event observer retains raw traffic and separately validates owner-private contact
metadata and empty device-selection hints. At a UTC calendar boundary, it also verifies
each expected card against its stream baseline: only the exact new unknown spending
period is allowed, with every other field unchanged. Raw events remain reported;
missing, duplicate and unrelated updates fail. These exceptions permit no page requests,
extra rendering or increased script cost. Other board events, including refreshes,
still fail the idle budget.
Nothing on the page is fixed and the widgets are not frosted, so a
scroll paints only what comes into view, even in a WebKitGTK window that draws without
the GPU.
A card's dot by the logo tells how its measurements go: its colour, and in its tooltip
when it was measured and, while the hub sets the pace, when the next measurement comes
and why, each a line of its own.
A board has one grid for source cards, agent sessions, activity, quota history and
table, and budget history and table. A filter button in the header toggles a separate
row directly beneath it, with its controls aligned right. Navigation and filters share
one sticky glass backing and a continuous outer edge, with an inset divider between the rows.
Its translucent surface remains distinct from the page background. On wide screens
the backing shares the content's 1240 px maximum width and 28 px inner side spacing,
with rounded lower corners. Hiding filters reduces that same surface to the header.
Narrow screens keep edge-to-edge bars.
Viewing controls use a viewport-based grid. Filter counts and reset actions cannot
wrap the shared bar onto another row; narrow controls retain their full accessible
names when their visible labels need an ellipsis.
The row also owns data selection for Resources, Projects, Devices and Clients.
Provided-data authority, these predicates and layout visibility are independent.
The v1 defaults live in `board_filters`, with their own revision and an opaque
projection-authority precondition. Owner Save compares both atomically, merges
authorized changes while retaining dormant raw rules, and explicitly adopts the
initial revision zero. Readers keep current filters and dirty drafts per user,
board and tab; foreign saves only update Restore. Compact consumes saved defaults
and follows the layout's hidden-card visibility. Native attention consumes saved
defaults with its existing hidden-card admission, including a final check before
notification delivery.
Legacy wallet and funds preferences seed revision zero until that user edits the
family or restores the board defaults. A receipt for each user, board and family
survives clean tab drafts; the original preferences can still seed other boards.
Separate stream configuration frames carry the authorized filter projection;
snapshots carry only matching revision/authority references.
The period coordinator applies work predicates to authorized intervals before
building session, activity or direct-hour indexes. Facets come from the unfiltered
period, adding the current roster only for a live period. One raw read also supplies independent source-wide
curves for supplier rates and forecasts, transported as a source-only live sweep
or compact fixed summary. Work-filter changes retire selected indexes and details,
while source evidence retains its own cursor, cache identity and generation.
Late source-only adoption shares native arrays and copies only changed fixed
summaries after reserving their metadata. The captured response remains charged
beside recipient staging until adoption and its chart consumers finish.
After preparation, the period coordinator commits resource tapes, values, facets,
work indexes and row snapshots together, including their resident storage charge,
before notifying any subscriber. Synchronous navigation or new evidence from a
subscriber therefore sees a complete snapshot and cannot revive the captured reply.
Period changes, cached restoration and retirement also finish their storage and
clock updates before publishing. Calendar notifications share that synchronous
boundary; calendar replies retain their independent authority and adoption boundary.
Relevant work news advances the calendar's evidence generation before a queued reply
can adopt. A reply from before that news cannot publish, cache a fresh proof or clear
the new demand. The permitted prior reading stays visible until a current answer
arrives; a failed replacement cannot make its obsolete proof reusable after navigation.
The private storage wrapper keeps boolean decisions that coincide with a changed
rule's default; repeated include/exclude or wallet auto/only transitions cannot
forget a dormant exclusion. Its filters and retained decisions together fit
256 KiB. Public projections disclose no unavailable references or private ledger.
Per-unit migration branches retain their own decisions until materialization or reset.
Dirty tab drafts retain their origin projection for authority-only rebase after reload;
reset intent stays dirty even when the visible projection is unchanged. Restore
creates a new edit boundary that a pending Save cannot overwrite.
Canonical defaults fit 256 KiB and their merge/projection envelopes 272 KiB. Full
period requests fit 256 KiB; Save and runtime share a 76 KiB minimal work template
and 80 KiB detail limit. The transport checks the final encoded body after inserting
evidence and metadata. Native-only reads omit an unused work predicate; work-sensitive
reads preserve it in full, including a separate facet read for removable explicit choices.
An inherited oversized predicate remains exact and
recoverable through successive decreasing local edits, without an oversized work
request. Parsed queued input, its canonical allowance and prepared membership sets
share the existing 32 MiB server reservation; retained and staged facets share the
browser's 15 MiB history pool. The selected-work matcher is prepared on its first
consuming read. A failed preparation or raw read releases its matcher charge; a
capacity failure stays within that section while independent native sections remain
readable. Source cursor planning has the same section boundary: a refused plan does
not widen the shared raw range or discard native siblings. Work authority changes
retire closed-menu facets too.
Ordinary session and work changes invalidate their cached choices without a closed-menu
read. Reopening checks that generation and the live evaluated range; an older reply
cannot mark newer choices complete.
The response keeps the period's facet universe separate from authorized explicit choices
outside that period. Those choices remain individually removable. The hub confirms their
project/device admission before returning labels; browser draft references do not provide
that authority. Their metadata follows predicate, range and work-authority generations.
Source-work tape, curves and cursor are adopted together after bounded preparation.
A limit refusal retains the previous baseline and cursor while making its estimates
unavailable; failed preparation releases only successfully admitted scratch.
Quota charts and tables subscribe to source/window presentation choices separately from
their native history identity, so a window-only edit updates both on a quiet board without
reading unchanged history or rebuilding for unrelated project-only presentation changes.
The filter button forms its own group after the board controls. A small dot marks a
non-default data selection or historical range, including while the row is hidden.
The row starts closed and remembers its visibility in the reader's browser.
Each data filter has on/off choices, a small minus-count tag for exclusions and an
adjacent cross that shows all again. Include counts use a confirmed cached universe;
until one is available, the existing changed dot appears without reading a closed menu.
Shared filter rows keep every switch on the
right, including group headings and unknown resources. Dropdowns align with the
filter label independently of its exclusion badge; unchanged filters reserve no
status space. Search uses a short placeholder and an accessible hidden label,
outside the scrolling options so it stays in view.
On phones the four data dimensions keep two columns sized to their content, so an
exclusion badge cannot move the open control to another row.
Resource groups use provider logos and inline
disclosures; disabling a parent hides its children without changing their choices.
Expandable and plain resource rows align their names; child guides have inset ends
and a gap before the row's hover surface.
Wallet key batches append within that disclosure instead of replacing the menu
with another screen. The horizon uses the same dropdown style without its selected
value in the trigger. Restore precedes Save at the right end of the complete row;
the date arrows stay beside them as the period caption changes.
Hiding it preserves the selected period and shared chart horizon; while open,
it keeps them available during scrolling. Board navigation and widget management
stay in the header. Five-hour limits, weekly limits and wallet balance
each have independent chart/table pairs. The common Resources control selects logical windows, wallet balances and key caps
for cards, charts and tables together. Each chart's legend emphasizes
its own series without changing data membership. Subscription funds use their own filter family. Projects, devices and clients
intersect the session cohort before aggregation; source-wide quota and financial
estimates retain a separate source-only work sweep from the same authorized read. Table columns
remain owner settings, while shared data controls are available to every reader. Each
analytics panel uses the same heading and reader-error component. The selected
period and its back/forward buttons appear together at the right end of the shared
analytics controls. Its caption stays on one line within the arrows' remaining
width; the period menu exposes the complete range. Changing the range cannot grow
the sticky controls or move the board. Pending reads, retained evidence dates and
retry use the existing heading disclosure without adding a status row. Compatible
values remain visible until their complete replacement is ready. The
limit and budget tables share their column controls, cells and responsive renderer;
when their selected columns no longer fit, both become labelled rows. Their own
data models provide the values and column widths, including clock-driven cells.
Every widget is arranged on one grid. A row is 48 px (a 32 px track and a 16 px gap).
Content measurements update grid positions and reading order directly, without a
React render of the grid or neighbouring widgets. Only a widget whose own allocated
height changes hears a sizing update; layout edits still reconcile through React.
Each widget establishes its natural height and minimum from its structural shell.
The grid rounds that height to whole rows unless the owner chose a height (`h`, in rows),
clamped to the structural minimum. Data, filters, period navigation and asynchronous
results do not revise those dimensions. Display configuration and viewport reflow
can establish a new structure. Spare room stays above a card's tray or at the bottom
of a panel. All five charts give the allocated content height to their plot while
keeping their heads, totals and legends whole. The Agent sessions widget gathers the period's sessions
by project (one name across people, as agent activity counts it), machine or subscription,
each viewer for themselves, or lists each agent with None first. Client is shown by
default in individual and disclosure rows; its owner column setting is independent
of chart series, and narrow ordinary rows keep it quietly on their existing first line. A group tells how many of its agents
are currently known to work, their credited work within the period and the date and
time of their last intersecting work endpoint, using `stamp` in `ui/lib/format.ts`.
An unknown time is a dash. Presence and rolling work labels have separate clocks;
current presence does not turn a period's last-work timestamp into a relative label.
In a narrow grouped list, the default first line pairs the name with the agent count;
the second pairs credited work on the left with last activity on the right, aligned
with the line above.
Machines and subscriptions are in the individual agents' details, opened by clicking
the group. A folder stays under the project in the same table cell, wrapping long
worktree names. Their default columns fit a wide dialog as a table with rows highlighted
edge to edge; a narrow dialog uses an inset compact list. The dialog has no repeated
count or work total above its rows; its toolbar holds only Back and list sorting when
needed. Board tables share `ui/components/TableWidget.tsx`: one width decision,
height measurement, page model, pager and sort presentation. Natural pages contain
ten rows; a chosen height fits as many complete rows as its space allows. Variable row
heights follow row identities through ordering and paging. Static measurement starts
with fifty candidates and expands to the fitting page and its next row, without clock
subscriptions. A separate footer puts the whole-selection summary on the left and
the matching row count beside the compact pager on a separate line below it.
Wide totals align with their table columns, using the same widths and showing only
values under the dividing rule; column headings are not repeated. When session
grouping has no matching row columns, its whole-period totals use one labelled line
of the same height. The owner's metric switches select those totals independently
of grouping, including None. A narrow list uses
a fixed two-column metric grid above the count and pager. Tables without aggregate
metrics show only the count and pager.
Each value names its metric and scope. The sessions table shows whole-period work and
context counts; quota and budget tables show matching row counts without summing
unrelated percentages or overlapping wallet components. One-page tables keep the disabled 1/1
pager in the same footer slot. Grouping uses the shared labelled segmented control, with None first and
Project still the default. Optional activity and concurrency columns do not add
details to the compact session rows. The current working count is a subtitle under
the session widget's heading, in the shared analytics-note style.
Wide headers cycle
ascending, descending, reset; a reset leaves no header selected and restores the
table's default order. Only the compact list shows a sort menu. Activity totals
cover the complete period on every page. Height and paging select rows from the
already complete shared index; neither changes the API request nor starts another
history read. No table uses an inner vertical scroller.
Its disclosure pages through the complete retained roster in batches of fifty. Such a widget tells the grid
through a context of its own (`ui/components/sizing.ts`) the least it can show, what it
needs whole and, as it lays itself out anew, how tall it shows, so the grid fills the
rest of its rows before that paints; it reads how tall it is to be and when the grid gives
it another width (the grid's columns, its own, a gesture on its side ending), to draw
itself at that width in the same frame, and only these read it, so a neighbour's height
renders none of them.
Widgets float up within their columns without stretching
their neighbours. Saved `y` gives the reading order; each viewer's measured content and
the chosen heights determine the actual rows. Dragging by the head places a widget by
its top-left corner against the original layout: it goes after widgets whose top is
above that row, taking an occupied slot unless its neighbour can rise into the place
it left. Neighbours move down, never sideways. Widths snap to a third, a half, two
thirds or the whole grid, by the left or the right edge, the other one staying; widened
by its left edge a widget keeps its row unless a widget above reaches into the columns it
takes, and what it covers there goes after it, as the right edge sends its neighbour
down. Heights snap to whole rows, by the bottom edge; both
by either bottom corner. The top has no edge: a widget floats up to what is above it, so
its top has no place of its own to pull, and it is moved by its head. The edges are not
drawn: each is a strip along its whole length in the gap beside it, with the cursor of
its axis; under the pointer the widget's own border on that side lights up a little, in
focus it takes the accent. Only the bottom corners have marks. The right and
bottom edges take the arrow keys too. A height is saved only where a gesture or a key
changes what shows, the way it pulled (`heightIntent` in `ui/lib/grid.ts`): pushed below
the least its content can show, a widget stops there; one already there, a click, or a
corner moved only sideways keeps the height it had, chosen or its content's. Only the
pointer's way down the window pulls, with the page the gesture scrolls under it: near an
edge of the window the page scrolls once the pointer is taken half a row toward it, or
to the edge itself from a press nearer to it than that, never by a click's jitter nor by
a corner or a widget's head moved along the edge (`edgeScroll`), and nothing else that
moves the page or the grid (the wheel, a key, what is above growing, the browser keeping
its place) changes the height. A double click on the bottom edge
or a bottom corner, or Enter or Space on the bottom edge, gives a widget back the height
of its content. At 1000 px and below the page uses two columns, at 680 and below one, in
reading order, with the heights chosen where the least their content can show fits them;
arranging is available only on the wide grid.
The hub migrates pre-grid views and legacy analytics anchors atomically, retaining
hidden intent, heights, unrelated geometry and each table's columns. A board view and
revision are read as one reconciled pair. Saves use the compact version 5 codec and its writer header;
a stale runtime cannot save a version it merely echoed from a snapshot. The ordinary
body limit is 80 KiB UTF-8 of the encoded request; decoded drafts fit 132 KiB.
Storage and POST use the same tuple codec; readers receive a semantic View object.
The legacy split migration concatenates the old visible orders, retains saved hidden places and
keeps unarranged source cards implicit. Version 4 retains the old weekly and wallet balance widget IDs and inserts five-hour siblings beside their saved weekly parents, copying width, height and visibility. The upgrade preserves unrelated owner fields and expands retained Add receipts once. New membership never saves all their defaults. Up to the aggregate browser keepalive limit of 64 KiB, saves
retain their debounce. Larger drafts start ordinary serialized saves immediately; a
browser close warning stays until acknowledgment or explicit discard, and navigation
that destroys the saver waits, including native browser Back/Forward. A failed save
retains the exact history entry; a successful queue resumes the original traversal.
The router publishes only the accepted address to path, board and time-range readers.
Restoration and replay acknowledge their expected history entry, so repeated native
traversals and unrelated React renders cannot expose a transient destination to the saver.
Native shells keep immediate autosave with no additional close flow. Places have no
separate count limit.
The board's view comes with its events; the owner's changes show at once and are saved
about half a second later, one request per burst (a drag, typing a plan), and stay on
screen until the hub tells the view it saved. Saves carry `If-Match` with the persistent
view revision and are serialized per board by the authenticated shell. A stale save
returns the current view and a visible conflict; it never silently reapplies an old
full document over an Add or another window's edit. Add flushes this shell's pending
save first, then patches only its requested visibility inside its transaction.
Failed saves keep their unsent intent and a notice throughout settings navigation,
with an explicit retry carrying the captured revision. Ending the authenticated shell
drops unsent successors; a submitted Add continues when only its form closes, while an
owner-scope change prevents further phases. No timer polls for those results.
New empty boards keep analytics widgets pending. Resource capabilities place
the five-hour and weekly pairs, wallet balance pair and subscription-funds chart independently on first use.
If those automatic placements would exceed a view size bound, they remain pending
while the board keeps its valid saved view and revision. A smaller save makes room
for reconciliation to retry; new source cards remain implicit. Explicit Add and save
still reject oversized changes without discarding saved settings.
An explicit Add also places an empty widget; placement
is sticky after its last source or series disappears. Explicit hidden intent wins.
`enabledWhenEmpty` applies to agents and activity; analytics placement lives in `shown`.
What
is only about how one person looks (the board's period, the chart's
horizon, whether it draws the plan and the forecast, what agent activity is stacked by, reset announcements, the lock on the widgets,
the agents and quota tables' sort orders, the chosen board and language) stays in their browser.
The controls above the mixed widget grid own the common period and forecast
horizon. Shared wallet data selection lives in the common Resources filter and remains
accessible when either wallet widget is hidden. Each widget keeps its display settings, such as
columns, forecast visibility and stacking. Legend emphasis lives only in the open chart.
A fixed accounting interval is exactly `[from,to)`: card values use the latest retained
observation strictly before `to`, with validity evaluated at `to`. Missing predecessors
stay unknown. Native membership follows the last retained nonempty measurement batch;
monetary values retain their original amounts, allowances and conversion evidence.
Their optional exclusive `validUntil` separates availability from the recoverable
observation timestamp: compressed heartbeats can confirm a value between stored anchors
without inventing a newer measurement time. Live values without it use their normal TTL.
Historical monetary readings supply their recorded conversion paths to the common
renderer for both native and already converted amounts at the same original anchor.
Changing the display target, monetary path revision or source financial grant retires
their financial fields, cached states and pending replies immediately, even with money
analytics hidden. Native quota and work evidence remain independent. Currency metadata
edits alone do not reload history.
An archived display target can invalidate a history request before its replacement
event arrives; that request fails locally while access to the board stays active.
Current operational status, connector failures, actions, forecasts and reset news remain
live. Compact mode and native notifications also remain live.

The board's period coordinator collects quota, wallet budget, subscription funds, value and session demands into
one read-only `POST /api/boards/:board/period`. The GET history route and the period
route call the same cell reader. Source-work budget estimates join this coordinator
through an explicit work demand; their native observation pairs and admitted source
curves use the same period accounting and fixed shift machinery. Unchanged financial
indexes retain their identity when work alone changes. Sections succeed or fail independently. Within the
same authorized scope, a retained complete presentation keeps its own interval while
a replacement loads or fails, including across reconnects. A source or resource removal,
changed currency context or changed permission to read work retires both the displayed
result and its reusable presentation until a new authorized baseline is ready; panning
or restoring the same IDs cannot bring back a retired result. Board, access,
currency, resource selections, visible consumers and request generations prevent a late
response from acquiring a newer label. Superseded period reads leave the transport queue;
retrying an analytical widget repeats its failed exact evidence as well as its drawing cells.
Leaving the board invalidates pending numerical preparation before clearing its data.
Subscribers see the complete cleared period before they can reopen it. Old flights keep
their memory and slots until their readers finish, then wake a newer entry if one exists.
A bounded signed frontier lets the next read replace changed work and measurement
intervals or extend missing older evidence. Each bounded work and measurement journal
has its own monotonic proof boundary. Session cursors require the work proof, quota
tapes require both proofs, and financial tapes require measurement proof independently
of work. Once a required proof is discarded, its older cursor needs a complete bounded
baseline. Quota cells and the session projection share
one authorized work extraction within a composite read. The request captures one clock,
expires quiet sessions at that time, then captures the evidence revision. Nested readers
use that same clock, and every section and cursor names that revision.
Server period reads yield between preparation slices and share a serial queue, so an
abandoned request can release its reservation while the hub serves other routes.
The same protected work capture supplies its authority key to nested readers. Retained
project names and device labels enter that key one row at a time; temporary hashing
buffers share the request reservation, including detail and access revalidation reads.
An authority buffer that cannot fit returns the existing history-limit error while
independent financial sections can still complete.
Before resuming or publishing a response, the reader checks access, currency context
and relevant evidence changes. A changed input discards the whole preparation and
permits one fresh attempt; continued churn returns `unavailable`. Unrelated boards
and facts beyond the captured evidence interval do not invalidate the read.

Retained work traces and measurement tapes provide exact boundaries beside the shared
interior cells. Work prefixes and interval unions compute clipped session duration,
active time and agent-hours. Hour blocks share identical work patterns without losing
gaps or millisecond boundaries; the roster, activity and quota accounting share their
curves. Numeric columns use constant values, piecewise integer progressions or exact integer offsets where possible,
with 64-bit values for fractions and wider ranges. Changed series rebuild only their own
prefixes. Rolling quota cells plan their next formatted change from the same retained
window and source work curve they display, including the knowledge boundary. A partial
replacement refusal keeps that clock with the retained accounting, independently of a
newer roster index. Other rolling numeric labels read their prefixes through the shared
clock and wake when their formatted value changes. A duration update alone does not wake its roster or
table; membership and ordering still do. Charts advance at their own grid boundaries.
As a live window advances, expired work blocks and redundant measurement prefixes
leave the retained indexes. Work indexes retain unchanged timelines and hour patterns;
only timelines with an expired prefix copy their remaining buffers. The last real
observation before the boundary, its availability bounds and required currency evidence
remain intact. Cleanup uses the cancellable preparation scheduler without reading
history. Widening past discarded coverage, including a backward correction of the hub
clock, requires a new bounded baseline and keeps the previous basis visible until it
arrives. Capture and authority cutoffs remain independent of the locally retained coverage.
When a continuous monetary span grows, merging retires a superseded heartbeat tail
only when it is no longer an observation anchor, the new answer omits its binding
and its complete rate path is unchanged. Explicit bindings and real rate changes
remain, so accumulated history and a fresh read retain the same conversion provenance.
Fixed selections carry exact totals and boundary geometry instead of a rolling
ledger; the server and browser share the accounting implementation in `server/domain`.
Their native endpoint values retain their own exclusive validity deadlines. A future
endpoint uses the elapsed evaluation clock, while a past endpoint keeps its historical
state. The shared clock expires chart and table values even if the separate card-values
section fails; plotting bounds and cached shifts do not extend that validity.
The interior drawing still uses cached history cells. Neighboring card states keep exact sparse changes instead of repeated measurement objects.
When exact boundary observations and interior quota cells share a drawing, cell
support is normalized before clipping: consecutive cells of one segment support the
unmeasured cells between them, while explicit exclusive bounds and segment breaks
remain intact. A predecessor in the first boundary cell may support the interior;
the exact boundary geometry and accounting totals still come from the fixed summary.
Their interval lookup allocates no replay; restored values share immutable proofs.
The server reads each source's neighboring state boundaries once and finds native batches
through a source/time index. Fixed summaries retain compact numeric columns while being
built; temporary wire rows are released before the next source is read.
Complete live indexes and fixed
summaries can move into the shared LRU when a different interval is selected. Returning
to a retained target reuses it. History events invalidate each retained target against
its own exclusive endpoint. A later change preserves earlier evidence and bounds its
shift proofs at the first changed instant; it cannot be replayed into the changed tail.
Calendar curves can retain that unchanged prefix of a wider interval. Authority changes
retire their evidence immediately, independently of event timestamps.
Adopting a newer compatible revision preserves those prefixes. Each segment stops at
its observed range and first changed instant; a fresh tail can complete their union.
Retained live proofs keep their observation cutoff as the clock moves, while historical
curves alone cannot satisfy an unread live tail. Missing coverage requires a read.
Fixed summaries also describe exact duration and timestamp changes between
observation, work, availability and grid boundaries. Nearby positions use sparse
changes between those intervals and an immutable starting summary. The initial reply
borrows that base from its requested projection; shifted copies retain it. A card
whose validity already spans the neighboring positions needs no extra sequence. Nearby integer
timestamps use exact deltas; fractional readings and money retain their original values. A repeated gesture
can reuse the proof even when native input moves an endpoint to the other side of a
boundary. Card states retain their own observation and availability intervals. Amounts
and spending steps are replaced exactly at changes, never interpolated. Positions
outside the retained proof require another bounded read. Optional summary and card-state
preparation covers neighboring endpoint cells. Native return/repeat gestures can move
the selected edge within a cell when the live plot's future area changes its pixel
scale. Summaries keep exact partition boundaries; card states keep their full actual
validity intervals. Preparation stays within the existing memory limits without
changing the selected projection, history cells or observation admission.
On the wire, replay programs group changes by field and share path prefixes. The
browser charges restored path and patch containers before allocation, then restores
the same exact edits for replay. This encoding never changes supplier evidence or
interpolates fractional values.
Widgets keep their last complete presentation during replacement, including native panning.
Cold drawing cells and resource evidence are read separately; live ledgers are split
by resource family, while compact fixed summaries share one response. Preparation
replaces scratch reservations as each retained index is completed. Monetary indexes
retain numeric boundaries in typed buffers and exact amounts in unbounded integer
prefixes; only uncertain steps need separate amount records. Their retained charge
includes buffers, collections and integer payloads, while preparation also reserves
overlapping builders and sorting scratch before allocation. Shared pan readers
decode one input tile at a time, as do coarse cold reads, so an unread month cannot displace the complete period
with one large transport body.
Monetary steps remain exact integers; a partially
intersected spending step is uncertain, never divided by elapsed time. A balance's TTL
does not establish spending coverage beyond its last confirmed observation. Cards and
analytical boundary values use the same recorded heartbeat valuation; an exchange-rate
change does not become spending. Both readers exclude observations and availability
barriers at or beyond the hub clock captured for the request. A future compressed endpoint
cannot extend freshness or accounting coverage: only a retained observation anchor may
replace it, with its own freshness duration when that duration is recoverable. Admission
precedes currency binding and accounting, without rewriting stored supplier facts.
The page clock
advances live boundaries locally through already received evidence, without a request
or invented work after the evidence cut. Fixed past accounting does not tick. These
indexes, dictionaries, response staging and cached values share the history readers'
15 MiB budget and two transport slots. Server projections share the 32 MiB tile budget.
Work packing reserves its hourly expansion, dictionaries and overlapping buffers
before allocation; cancellation releases scratch, and completed packing retains only
its output charge.
An oversized section reports `history_limit` without publishing partial totals. Numeric
preparation uses the shared cancellable scheduler; aggregate benchmark traffic includes
composite and detail reads, cancellations and responses that finish after measurement.

Quota history, wallet budgets, subscription funds and agent activity read and move along time alike
(`ui/components/timeAxis.ts`), each with its legend under it. Clicks independently
emphasize several series; pointer or keyboard focus-visible previews one with pointer
priority. Previewed series retain their normal paint, other chosen series use 65% and
unchosen series 40%. Without a preview, chosen series are normal; with no represented
choices, every series is normal. Each multiplier preserves the layer's intrinsic
opacity. Shared plans take their strongest associated series multiplier.
Activity preview replaces the four useful summary metrics without changing their
geometry. A retained legend identity with no work in the interval previews confirmed
zero, preserving unknown and unavailable evidence rather than borrowing the board total.
Monetary details and currency provenance appear in the shared glass tooltip
anchored to the legend entry, using exact money presentation. They occupy no space
at rest and do not constrain a widget's minimum height. Quota charts reserve no strip.
Quota window and series names keep their source, scope and duration as semantic
lines in plain text. Cards, compact rows, filters, legends and tables use the shared
name renderer, with quieter details and the existing line allocation. Forecast SVG
labels flatten those lines for their measured fit, then distinguish the detail by
fill alone; their tooltip keeps the complete name. Owner punctuation stays literal.
Recovery controls return keyboard focus before they disappear. A removed Retry
returns to its surviving disclosure button; a retiring disclosure returns to an
available control in the same widget, or its heading when no control remains.
This covers source measurement details, session trays and wallet allowances as
well as analytics. A disclosure owns its portaled panel, while its stable return
target belongs to the widget that holds its trigger. Each attached recovery node
keeps its own removal cleanup, including details reused by several disclosures.
Filter-save recovery returns to the resource filter while Save is disabled. These
returns preserve a newer focus elsewhere and do not count as new reader navigation.
The existing widget heading keeps at least its control height for both owners and
readers. A temporary reader control cannot move the plot or table when a reader
has no permanent settings button.
The common Resources filter selects accounts, key caps and subscription funds
across cards, charts and tables. An account selects its total balance; a key selects
its reported remaining cap within the shared 32-meter bound. Balance components
remain in card details. When capacity blocks an available key, its expanded list
explains how to free a choice; selected rows remain removable. Loading, stale rows
and keys without a reported cap do not receive that explanation.
Board opening defaults are saved separately from each tab's
current selection. Existing per-unit data subsets retain their shared-filter semantics;
old legend hiding and its monetary visibility fallbacks are no longer read.

All five charts share `ui/components/seriesFocus.ts`: inherited CSS variables change
paint without rebuilding paths, writing preferences, requesting history or rendering
data consumers. Choices remain in memory in that board/chart; dates, pan, data updates
and unrelated filter edits preserve them. A temporarily absent identity stays dormant
and only its represented intersection contributes to dimming. A relevant applied
selection edit resets only that legend immediately: Activity's grouping dimension,
each quota kind's source/window choices, or money's sources and active-unit wallet/funds
rule. Canonical ref order, menu/search, Save and presentation revisions are not edits.
Board/grouping changes and real authorized-context revocation clear affected choices
and previews; delayed replies cannot restore them. A financial grant revision retires
its money legend even if the source stays on the board; an ordinary first-observation
anchor does not. Escape dismisses only preview.
A time range selected on any chart becomes the board's period, including card measurements, session lists and
accounting tables; it lives in the page's
address (`?from=&to=`), so a reload keeps it, Back undoes it and a link to it can be shared on the board.
‹ and › beside the period move the board by half its period: back, to a range in
the past held in the address like a dragged one; forward, up to now, where the chosen
period comes back. A horizontal touchpad swipe, Shift with the wheel, or Shift with a
mouse or pen drag moves all five charts continuously. A page-local transaction captures
each chart's scale in CSS pixels and applies the same time delta on animation frames;
plain dragging still selects a range and touch retains its hold-to-select gesture.
Prepared SVG artwork moves in composited HTML surfaces behind a stationary clip;
the axes and readouts stay in place. The surfaces keep their compositor hints between
gestures, avoiding repeated promotion and rasterization on the first input. Label
backgrounds retain their measured offsets when only their anchor moves. Each chart
reuses glyph bounds for matching text, anchors and font weights in its bounded caption
cache. Shortening a name also reuses its measured fit for the same text, available
width and font weight. Loading a web font or changing the SVG viewport scale clears
both sets of measurements. Its container
owns pointer capture and wheel input, projected through its fixed SVG viewport, including labels in another
surface. Surface geometry and painters become visible only after their DOM commits.
The future moves with the strip during the gesture. Historical release retains the
last displayed time-to-pixel mapping, including its future margin, through pending
reads, the complete answer and later ordinary updates. Returning to live can unfold
the future over 160 ms; reduced motion skips that transition. Release within eight
source pixels of now restores the chosen live preset.
Time labels share the moving HTML owner but sit outside the scaled SVG data group.
Their translation and whole-label visibility use the data animation's easing and
document timeline. Replacement labels join its original start; interruption freezes
both at the sampled pose. Glyphs keep their width, and a date crossing an edge is
shown only while it fits entirely inside the clip. At subdaily density, the first
represented tick and each local day boundary name the date; the other ticks show
the clock. Offscreen strip labels do not consume the visible interval's first date.
One changed gesture creates one address entry; cancellation or returning to the exact
origin creates none. A horizontal wheel ends after a 200 ms pause. An arriving event
starts a new transaction only when both its capture and delivery gaps reach that
boundary; a renderer backlog cannot reset its axis through either clock alone. Shift-wheel keeps
one captured scale across pauses and ends when Shift is released, like a held drag;
a pointer can continue that transaction. A wheel restarting in the same event keeps
the preceding gesture's committed range as its origin, even before that selection
renders. Publishing it preserves the new gesture; a later navigation still cancels it.
Neither adds inertia. Holding Shift hides
chart and activity-legend readouts even before movement starts. The plot and legend
keep their height through gestures and range changes; extra legend entries scroll
inside their bounded viewport. Only structural layout, width or language changes
establish another shell allocation. Data filters and readiness never resize the plot.
An answered activity frame without work keeps its time axis and legend viewport;
its empty message sits inside the plot, which still accepts the next gesture.

While panning, the history store keeps the previous complete answer for the table,
activity totals and legend numbers. A separate bounded plot buffer decodes the same
tiles without computing frame totals. Known parts stay undimmed, lines break across
unread cells, and an activity stack appears only when every contributing whole cell is
read. Two translated HTML clips intersect at the whole-bar edges of the long activity
band; a counter-translation keeps its artwork in place. The clip boundaries use
compositor transforms while the SVG's coordinate system stays unchanged. Two short
edge bars in their own SVG are recomputed when the draft crosses a cell; moving within
a cell only translates the prepared artwork
and updates its clip. A historical completed drawing adopts the held SVG projection
without a release-time zoom. Activity's vertical scale uses the selected visible
interval and exact boundary bars, excluding its overscan and unread cells.
The same native painter updates that value projection with the time position, using
the committed height index. Prepared paths retain their numeric basis; a matching
replacement adopts the displayed value projection without changing it on release.
The final historical value scale is also retained through exact edge replacement:
a smaller partial boundary bar cannot enlarge all the unchanged interior stacks.
Higher newly read work can expand that scale; another navigation, shared data selection,
authority or explicit geometry change establishes a new value projection.
Budget and subscription-funds charts also preserve the monetary value domain painted
at a historical gesture's release. The committed Chart model supplies that domain;
an earlier parent preparation cannot replace it before its drawing commits.
The native stop owns this handoff even when React coalesces an active phase.
Consecutive gestures inherit the domain; a no-op or cancellation never releases it.
Replacing an overscan strip with exact cells cannot
rescale unchanged balances. New values may expand the domain; an explicit range,
currency, resource selection or authority establishes a new one. Its bounds stay in
integer millionths independently of the prepared path's numeric offset.
A compatible change of history cell size prepares a replacement while retaining
the previous complete drawing. Both monetary preparation and the shared chart
publish the cell size with their own model, so its paths, axis and exact readouts
keep one grid until replacement. Authority, display context and geometry changes
still retire an incompatible drawing immediately.
Activity publishes a replacement only when its selected work and native drawing
are both ready. A quota answer arriving first cannot publish its pending-work
placeholder as an empty Activity chart. The previous complete work frame and its
numbers remain visible through compatible refresh failures until replacement; hard work retirement clears
them immediately, independently of native quota readiness.
Activity's rolling work projection does not rebuild native financial series or inspect
plan events. A fixed Activity frame reuses a complete cached projection; it prepares
full native accounting only when another visible quota widget needs that same frame.
With Activity alone it keeps the work-only path. Its numerical clocks remain independent
of financial expiry; quota and monetary consumers retain their own deadlines.
A return-to-live fold lasts 160 ms and uses the existing moving surface over the final
SVG projection. Owners with separately translated whole time labels animate their SVG
projection so the glyphs keep their own width. Composited HTML folds avoid repainting
dotted plan strokes on every frame; only during those folds may horizontal scaling
change stroke thickness. Completion or interruption restores non-scaling strokes.
Each owned animation keeps its absolute projection endpoints; its eased progress
reconstructs the displayed pose without querying computed styles. Retargeting and
interruption use that same pose. An inactive effect uses the committed pose, and an
animation without known endpoints retains the native transform fallback. Ordinary
220 ms navigation slides still animate inside SVG.
A temporary shared registry keeps plot interiors, edge bars, legend markers and readouts
consistent in colour and dash, adding new groups with a pending total. Surviving groups
keep their colours through rank changes and reversal; new projects and machines take
the next free Nord Warm colour, or neutral when all nine are in use. Present manual
project pins reserve their distinct swatches first, including low-ranked groups and
repeated choices. A reservation displaces only conflicting automatic groups. Absent
pins reserve nothing; offscreen registry entries retain their colours, and a
released slot does not promote surviving neutral groups. Current paint resolves after
numeric preparation over both current and still displayed groups, so an in-flight
drawing uses the latest accepted palette across interiors, edges, legends and
readouts without rebuilding geometry. Resource series
keep their card colours. Outside a navigation registry, a new numeric model assigns
automatic colours by its current rank. Visible
missing cells are read immediately in contiguous batches of at most eight tiles.
The nearest unread edge comes first, without crossing fresh cells or another tile
owner. Only a visible miss can add a nearby buffer in the direction of movement:
min(60, ceil(history length / cell / 4)) whole cells. That optional extension stops
at a tile edge when the required cells and at least one tile of cells still fit, so
adjacent responses do not split the same tile and repeat its metadata. Cells trimmed
before dispatch consume no allowance. A cached trajectory starts no new requests.
Unvisited optional cells remain charged to that gesture after an
abort or reversal; entering them restores the allowance. A disjoint jump inside a
held tile also reads the minimum unknown or stale bridge to its retained interval,
without rereading its fresh component. Empty tiles have no head to fill. At most
one foreground drawing read per resource family and one purely speculative flight overall share
the two aggregate HTTP slots. Newly requested filter choices can use the second slot
beside an older combined response for the same cohort that did not request those choices.
Their separate admission identity keeps the original transport and storage owner;
a body already covering the choices prevents duplicate admission. The same two-slot
and retained-memory bounds apply, including while cancelled recipients finish.
The shared transport collects visible family reads before
requesting a slot, so all three families can share one response. A coalesced response
retains its borrowed drawing slots until its HTTP read and recipient preparation settle,
including after that drawing is cancelled. Foreground requests take priority. A waiting
reader anchors its hub-clock estimate when HTTP actually starts. The final range uses
the same batching without a buffer. Writes to the same tile are
serialized, obsolete requests are aborted and speculative errors cannot drop the
selection. The existing 15 MiB tile estimate protects the visible frame. On release,
speculation stops and exact totals switch only after the final frame is complete.
The history transport reuses unchanged `historyStart` and `known` through an opaque
metadata token scoped to the board, resource family and hub instance. Each flight keeps the metadata
it offered, so out-of-order replies cannot borrow a newer or another board's values.
The server still checks access and computes the current scope on every read; older
readers continue to receive complete metadata. Time navigation uses the newest accepted
boundary from either reader, falling back to the current board snapshot before an answer
arrives. Board changes, new snapshots and hub restarts discard previous boundary evidence.
Numeric preparation runs outside React rendering through one cancellable MessageChannel
scheduler. Its shared generators yield between small cell, session, group, event and point
operations. UI slices target one millisecond and check the deadline after at most sixteen
generator advances; server and synchronous readers drain those same generators. Each owner
keeps only its latest job. Stable sorting yields after each copied row and adjacent order
check. Already chronological rows need only this linear check; an inversion falls back to
interruptible merge passes with two reusable buffers. Sorting forwards one immutable
pending result through delegated generators;
iteration and cancellation retain the native generator lifecycle. Tile responses use private COW staging and publish their
tiles, read bounds and metadata together. At most two responses are admitted for
HTTP and processing together, including raw answers waiting for a tile reservation.
A shared response retains its transport reservation until every family has committed
or discarded its private preparation; cancelling one family preserves the others.
Quota, budget and subscription-funds readers share that pool and a 15 MiB retained-tile and staged-growth
budget. Global eviction considers only nonvisible, unreserved tiles; an incoming frame
that cannot fit fails losslessly without evicting the other reader's visible frame. Flights and reservations remain owned until commit or
discard. Projections pin the current tile entry and its write sequence. Eviction outside
the complete target preserves its pending composition; its board, epoch, metadata,
selected series, target bounds and pinned entries still decide whether that work is current.
Financial and work ledgers share their immutable native observations only when every
reading agrees. Retention preserves that shared suffix, and the pool charges its storage
once; differing observations and each ledger's spans retain their own charges.

Activity has one numerical cohort, defined by shared work filters. Its baseline and
bar metrics preserve interval union and distinct-session semantics; a legend preview
reads one exact group, while click emphasis never creates a combined selected summary.
Legend emphasis has no dedicated reader, data request or read allowance. Fixed-range
late updates reuse clean native cells with the existing compact exact summary; news
before dispatch coalesces and news during a response requires a current replacement.
Work-filter replacement can refill Activity drawing cells through the existing reader
and its bounded tile window. Cancelled and late responses remain counted. Work starting
at or after the fixed upper endpoint does not reread the session ledger or start an
independent drawing read, including while the first answer is pending. The reader
keeps the exact outside cutoff until navigation needs that suffix or a necessary
read covers its boundary. Earlier missing tiles can fill without invalidating the
cached tail. Navigation applies the cutoff to cached cells and older flights before
using the new target; a read covering it replaces the dirty cells normally. The shared
calendar may still refresh within the combined transport. The 24h/30d benchmark covers this
shared-filter path and checks that all five charts' emphasis causes zero reads,
preparation or preference writes under the existing transport, preparation, two-slot
and 15 MiB memory ceilings.
A complete Activity frame waits for coherent native and selected-work evidence.
Same-context replacement retains permitted complete metrics; a native-only placeholder
cannot erase them. Hard work cutoffs retire evidence and retained previews synchronously,
even with unchanged IDs/authority. Retry reaches the failed shared work owner.
The summary, legend amounts, previews and bar readout commit with the prepared
stacks. Parent and child preparation carry the same captured numerical frame;
an early answer cannot replace only part of that presentation. Live frames retain
their own authorized interval projector, charged once across current, cached,
displayed and preparing owners. Dropping a cache owner rechecks the actual remaining
charge when another frame still owns that storage. Shared-clock deadlines still
expire rolling work and knowledge during replacement; a gesture freezes its accepted
frame at the gesture's evaluation time. Retired access, filters or ranges cannot
revive old scalar amounts. Fixed frames carry the exact computed numerical evidence
with their prepared drawing, without a separate legend work projector.
Legend controls remain available while replacement prepares. Choices and previews
change paint or contextual details, never the prepared cohort or its value domain.
Same-run greetings and compatible snapshots, ownership and lineup baselines retain
the complete permitted frame. The page records the hub run before widgets mount.
A changed run immediately retires work, session indexes, calendar evidence and
prepared drawings. Independent native financial evidence keeps its authority.
Replacement work must confirm the new run; a late old reply cannot restore it.
Source-free zero work cutoffs, relevant quota zero cutoffs and compatible legacy
zero cutoffs retire work synchronously even when the authority token is unchanged.
Financial and unrelated-source news do not. An unchanged failed view does not retry
because it renders again. Explicit Retry reaches the shared work and native-history
owners; it does not create a legend reader. Evidence dates and recovery use existing
disclosures. Relevant new work follows the ordinary bounded update path.

Selected activity cells have their own filter identity, coverage and prepared strip.
Changing a project, device or client retires those cells and pending selected jobs,
while native buffers, their coverage and the quota chart's prepared strip survive.
When native coverage is already fresh, the same quota reader can refill activity with
an empty source selection and skipped native evidence. Its metadata never replaces
the native basis, and it cannot complete a pending native summary. Both projections
keep the same transport slots and memory budget. A hidden activity widget defers its
refill until shown; activity failures do not discard the native frame.
Their error state and retry belong to activity alone: new native measurements still
read and commit their own cells, including while activity waits for memory or its
retry deadline. Retry also repeats failed selected period evidence. Native failures
remain visible to their own chart while its last complete frame is retained.
Financial consumers observe resource readiness and errors alongside native accounting
authority. A successful retry clears the error even when financial values are
unchanged; ordinary work-only publications keep financial snapshots stable.
Replacing native quota windows or monetary meter choices retires their own projection;
it does not retire an authorized Activity frame with the same selected work scope.
A stored work predicate that exceeds the executable limit makes selected activity
unavailable until the selection is narrowed. Native drawings continue through their
own coverage; their unselected activity cells cannot fill a selected strip, including
after a pan, period change or retry. Native period ledgers and supplier work keep
their independently keyed queries while selected work is unavailable.

Each chart replaces one typed drawing model whole after preparation, then publishes
its geometry and painters after the DOM commits. Input keeps the displayed model and
its composed SVG matrix and CSS offset until that handoff. Finishing a gesture commits
the address immediately and presents its last pending delta on RAF. If another gesture
starts first, each chart applies that accepted delta before capturing its new origin.
The final pose stays held until the matching drawing model is ready, then remains
the historical projection. The SVG matrix and CSS offset compose to the same displayed
coordinates before and after adoption. Activity paints its value scale and clipped
edges after the committed time pose in that same native frame, including cancellation;
logical completion cannot pin a value scale from a pose that is still about to be
restored. Every retained Activity drawing uses its actual visible viewport for its
value scale and edge clipping, including another gesture before replacement and a
forced release. A saved strip keeps its own cell grid, whole-cell accounting and
coverage checks. The selected period and the saved paths' numeric basis cannot
substitute for that viewport. The axis also supplies each commit's intended presentation for
time labels: its shifted bounds set their inventory, and its visible span sets their
density. A borrowed strip's label inventory stays within one extra visible period
on either side, including the visible interval even past unread data. Matching
historical and default live projections keep the native strip's complete inventory.
Explicit navigation
supplies its new projection before layout; matching
native captures and unpainted final frames retain the physical pose. A ready live
handoff uses the live target. A historical viewport survives ready data when both
of its measured endpoints match the committed interval; a different requested
duration or a retention clamp adopts its own interval at the reached measurement
end. That end moves with the presented artwork, including a sampled animation;
an older, longer drawing cannot turn the duration difference into forecast space.
Its known-data boundary belongs
to that same drawing, including a confirmed absence of an unknown prefix. A new
gesture samples that actual presentation, including an interrupted fold, separately
from its URL origin.
Partial plots continue to publish during the gesture. Its final drawing readiness
also requires the complete history answer for the requested range, so a partial
strip cannot complete the handoff before that answer replaces it.
User navigation owns the requested projection separately from drawing readiness.
Back, a preset or a horizon change retires an older held pose and its pending RAF or
fold; all five charts immediately place their retained data in the requested projection.
Ready data keeps that projection when it replaces the borrowed model. Borrowed data
keeps its own coverage and time domain, so future points are clipped rather than
clamped into an edge and a requested past frame shows no old future labels.
Ordinary clock movement reprojects the ready drawing without preparing its unchanged
numeric series again. Its bounded overscan rebases in slices only when the requested
frame crosses the cached margin. Future outlines are clipped to that drawing extent;
their full facts remain available for readouts and later navigation. The drawing
keeps the data cutoff it was prepared with; the current
frame supplies the future boundary, readouts and expiry of forecasts, plans and reset
markers. Forecast availability stays independent of its display switch. Child drawing
jobs wait for their input model to be ready, so a clock wake cannot publish intermediate
geometry built from stale parent data. Stationary hover overlays use the same composed
coordinates as the displayed artwork.
If a speculative response is evicted to fit that budget, its interest stops reading
ahead until movement or history news changes what is needed.

For ordinary discrete navigation the chart moves to the new period at once, drawing
the answer it has until the next frame is assembled. A run of quick steps reads its
first and last missing parts. Tiles are kept across frames on the same grid, so a return
or switching 12h and 24h asks nothing once both have been seen. A new lineup makes them stale; changed work attribution invalidates quota/activity and explicitly requested source-work budget accounting; a late measurement or credited work makes only cells from
its actual time stale, and the page reads them when a frame needs them.

Dashboard agent lists contain contexts with credited work intersecting the selected
period, including contexts absent from the current machine list. Duration is clipped
to that period, and recency uses the last intersecting work endpoint. Current presence
is optional and expires separately; it never proves more work or an end time. The hub
keeps renewal deadlines internally and publishes only semantic changes, so an unchanged
idle confirmation does not wake panels or card trays. The page confirms presence from
the latest stream snapshot, clears it on lost continuity, and waits for a new snapshot
before confirming it again. Historical replies cannot renew current presence. The
card's panel keeps machine groups, ordered by each one's most recent credited work.
It groups and orders the complete roster before paging. Loading and failure remain
visible in its tray disclosure even before any sessions arrive; retained rows name their
own interval and offer a retry there. The full session dialog carries the same interval,
loading state and retry, so its modal surface does not hide the evidence behind its rows.
A failed read never establishes an empty period.
The compact view keeps live measurements and current session counts independently of
the board's selected period. The Agent sessions table's headers sort ascending,
descending, then back to activity;
a hidden column does not sort. When its owner's chosen columns do not fit the widget's
own width, it becomes a compact list with a sort menu. State is off by default: the
mark already tells it. Explicit column choices belong to the board, sorting to the viewer.

The quota table shares one viewer sort with its compact list: ascending, descending,
then default, with unavailable columns falling back without losing the saved choice.
Live default order puts exhausted limits first, then absolute exhaustion time,
then known remaining shares; fixed selections use descending spending. Missing
values follow known values in either direction, with numeric locale names breaking
ties. Rolling work, agent hours and plans use existing accounting indexes and the
shared page clock for exact boundaries and adjacent key crossings. Only a changed
permutation publishes retained row descriptors; sorting does not wake other widgets.

Agent sessions, quota metrics and budget metrics use the same sortable header and
menu pieces in `ui/components/TableWidget.tsx`, including typography, active colour,
reserved arrow space and accessible selection. Headers cycle through both directions
and default; menus expose default as a separate row. Budget sorting is a separate
viewer preference. Wide tables sort through their headers; only compact lists show
a separate sort button beside settings, and settings contain no sorting choices.
Rows and controls share the same width decision, preserving the viewer's choice
when the widget changes between table and list. Names use the reader's locale;
values and top-ups compare exact integer millionths from the same accounting
model as their cells. Unknown values stay last in either direction. Hidden columns
temporarily use default without losing the saved choice. Default preserves the budget
series order; live accounting boundaries use the shared page clock and retain cells.
Each table owns a stable content viewport and footer for its structural column
configuration. Empty, pending, retained, failed and complete results occupy that
same viewport; grouping, sorting and paging do not change its capacity or neighbours.
Rows use a bounded preview, with oversized text and complete values reachable through
the shared Popover. Whole rows page through the full loaded index without an inner
vertical scroller or another history read.
Subscription cards keep two primary percentage slots, with a session and weekly
limit when both families are available. General five-hour and weekly windows lead;
equal-specificity and equal-duration ties use descending stable IDs, independently
of supplier reply order or remaining amounts. Every selected native window
remains in their existing measurement disclosure. Wallet cards show one available
balance, or the first selected cap when the balance is excluded; other caps and exact
amounts remain in the balance disclosure.
Full disclosure names wrap within the glass, including nested historical status labels
and unavailable allowance names; their values and status marks stay beside the text.
The first cap follows canonical English key-name and ID order before it joins historical
evidence, independently of server or browser locale.
An absent first cap stays unavailable instead of promoting a later arrived cap; unresolved
selected names keep the primary unknown until their bounded metadata read completes.
Native choices combine current descriptors with historical-only windows. A selected
missing window remains named in the disclosure without borrowing a current percentage.
A successful historical read before any observation shows one empty state inside
the primary area, replacing empty quota scales rather than appending a row.
An explicitly empty limit selection keeps its hidden-limits state and filter action.
Loading extra selected caps never adds a card row or an inventory-wide lookup.
The allowance count and disclosure use the logical wallet selection shared with
analytics. Explicit choices remain named with an unavailable value when their cap
is absent, including beside known caps and before their first historical observation.
Automatic choices include only the capped preview. Current key names can label an
older gap, but current amounts cannot fill it. Compact uses the same full disclosure.
The budget chart, legend and table name a total balance by its account rather than
repeating "Available balance". Scoped key limits keep their names; balance components,
roles and currency provenance remain reachable in card details.
Monetary table values open their exact amount and existing provenance through the shared
Popover even when the rounded value fits. The same timed cell supplies both presentations,
including in narrow lists; static row measurement adds no interactive controls. Closed
details schedule nothing; an open time-dependent detail owns its shared-clock deadline.

On charts narrower than 560 SVG units, reset and exhaustion labels show the name
and countdown, with an arrow only beyond the visible edge. Their backing is bounded
by 180 units and 60% of usable plot width. Hover and touch retain the full event
meaning and date in the shared tooltip; the primary image description carries them
too. Each mounted label caches shaped grapheme-prefix measurements by name and
font, measures its current countdown separately, and moves with cached local bounds.
Unavailable mappings, fonts or overflowing shaping use a bounded ellipsis with the
complete suffix until the next real input changes. Wide label layout and the overflow
stack keep their existing behavior.
The table of limits does the same: its owner chooses its columns, and where they do not
fit it lists each window with what is left, then its other values, each with its heading.
Agent-hours and the share of spending while active are off by default: adding either can
turn a table as wide as the board into a list.

Text is translated through typed catalogs in `hub/ui/i18n`: English is the source,
every other language must translate all its keys (checked by the type checker and by
tests, together with placeholders and plural forms). The hub stores nothing in a
particular language: window kinds and error states are codes, and personal boards have
no name of their own, so each reader sees "My limits" in their language.

## Desktop app

```
 the app (quotum-desktop)                      quotum-node (its child)
┌──────────────────────────────────┐ 127.0.0.1 ┌─────────────────────────────┐
│ window: the board ───────────────┼──────────►│ the hub, local mode         │
│ agent (quotum-core, a thread) ───┼──────────►│ SQLite in the app's folder  │
│ tray · settings · start at login │ stdin ───►│ ends when its stdin closes  │
└──────────────────────────────────┘           └─────────────────────────────┘
```

- **The app** is a Rust controller (`desktop/`). It runs the machine's agent in a thread:
  `quotum-core`, the library the `quotum` command is built on, with `quotum`'s own
  settings (`config.toml`) and state folder, so the command and the app measure alike.
- **Its hub** is the hub of the same commit bundled into one file
  (`hub/vite.bundle.config.ts`), run by the Node.js 24 the app carries under its own
  name, `quotum-node` (a deb or an rpm puts it in `/usr/bin`, where `node` is the
  `nodejs` package's). It listens on `127.0.0.1` only, on a port chosen once from
  20000–39999 and remembered: the port is part of the page's origin, and with it of what
  the board keeps in the browser's storage.
- **The window** shows that hub's board in WebView2 through Tauri on Windows and in
  bundled Electron/Chromium on Linux. The controller's hub supervision, settings,
  takeover and command dispatch are shared; `desktop/src/host/` supplies each platform's
  window, tray, single-instance activation and start-at-login integration.

Windows has an NSIS installer and a portable ZIP (`desktop/package-windows.mjs`) from
the same compiled executable and prepared Node/hub resources. The ZIP keeps those
files together and requires the system WebView2 runtime; the installer can install
that runtime. Both variants use the same Windows profile directories, instance lock
and start-at-login settings. Moving a portable folder requires updating its autostart
entry by turning start at login off and on again.
On a Windows tray activation, the tray thread shows a small Win32 loading surface
before WebView2 creation can occupy the app event loop. Its spinner, Escape and
blur handling remain responsive even while that loop is busy. The panel replaces
it only after placement and page loading have both completed. Tauri shows and focuses
the browser on its own event loop; the tray thread only dismisses the loader when
that current browser takes over. Both surfaces disable
DWM transitions so their handoff does not animate as a second window opening. A second click
cancels either phase. No web view is retained just to warm the next opening.
The host handles Escape before page scripts, including on startup/error pages.
Windows are created on worker threads; restoring, fitting and showing them is queued
on the event loop after the window-state plugin's initialization. This keeps its state
locks on the same thread as native window events. Closing a window destroys it with its
web view. The compact panel has no native window frame, has its own label and never
persists main-window geometry. Only its last content height stays in the controller,
so the next panel can start at that height, clamped to its current monitor. Its initial hidden focus changes do not dismiss it;
losing focus after it has been shown and focused does. A request to open it asks the event loop whether the window it finds is still
there: a second start can arrive while a closed window still holds its label, and that
one does not count as open. The new window is created once it has gone, and the app's
`hub.log` tells each request, attempt and outcome.
Panel presentations carry the controller's request revision. Retiring an old window
cannot close or blur a newer request; each native window keeps its request for life.
The Win32 loader rechecks its captured request between showing, bringing to the foreground
and focusing, and stops the remaining calls when that request has been retired.
A newer request retires that window before creating its own. Cancellation marks the
presentation before queuing its close, and stale loader commands cannot cover a ready panel.
The panel is hidden before its WebView2 controller is destroyed, so focus leaves while
that controller can still handle native messages.
Main-window requests also keep the revision accepted before their worker starts. The
event loop checks that revision before restoring, showing or focusing a window: a late
main request cannot take focus from a newer tray loader. Creation starts hidden and
unfocused; cancelled main creations are destroyed, and a later request waits for their
label to be released before creating another window.

**Linux rendering and lifetime.** The Rust controller uses a D-Bus StatusNotifierItem
through `ksni`. A small GTK loading surface responds before Chromium starts; GTK
draws only a spinner and a localized label, never subscription data. No second web
engine is linked. It waits for the desktop's tray watcher
when starting early at login and registers again when that watcher restarts. Opening a window starts an Electron
process; it holds at most the main board and a compact panel. On X11/XWayland the panel
uses the tray's activation coordinates. An X11 menu can use the pointer; on Wayland
the menu reuses the last tray activation, since the XWayland pointer can still name
another window. Before that first activation, it opens at the reserved panel edge
of the primary monitor, or within that monitor if no edge is reserved. The resolved
anchor determines its monitor and stays put while the content changes height; native
Wayland leaves positioning to the compositor. Where X11 is available, GTK and Electron
use that same backend. The controller shows the native loader immediately, then
hands off to the browser only after its first paint. The loader is a native popup
with skip-taskbar hints; the browser is an unmanaged popup. While the browser is
visible, the native owner stays transparent and accepts no pointer input, preserving
keyboard focus across XWayland. Both close together. Neither is a taskbar entry. The
controller accepts every foreground request into one current head: its revision, main,
compact or none, and resolved anchor. Startup, second launches, tray actions and the
compact panel's buttons share that order. Workers carry an immutable ticket and the
initial handshake reads the current head, so an older worker cannot reclaim focus.
If a main request reaches a browser already committed to its idle exit, the
controller starts a replacement for that newer, unopened request after the old
process and its private channel finish. Main surface acknowledgements remain
recorded after closure, so closing a window does not replay its request. A fresh
engine's initial request is never retried by this handoff.
Cancellation is terminal for its revision; native callbacks also belong to one engine
and presentation. Each GTK loader has its own native window and immutable ticket;
its focus, Escape and close signals retain that ticket even when delivered late.
Retiring it removes the timeout, stops the spinner and destroys the window; only
parsed CSS and the last tray anchor are shared between presentations. Explicit
*Limits* on the current panel keeps that presentation and its anchor.

A bounded publisher sends the complete head before showing a new loader beside an
existing engine. Its nonblocking fast path never waits for the browser; under socket
backpressure one pending head replaces older unsent heads, after tray toggles have
been reduced. A partially written frame completes before another message can start.
The loader's show waits for that publication only when the channel is blocked; GTK
continues to accept cancellation and Escape immediately. With no engine, the loader
appears immediately and the handshake supplies the latest head. Other host messages
use a bounded queue, so the private IPC reader keeps draining requests while replies
wait. Quitting shuts down the private socket without waiting for its writer.

Electron drains available complete socket frames before reconciling the latest head;
a partial final frame delays that reconciliation. Deferred paint, reveal and closed
callbacks cannot replay an obsolete foreground request. A new compact revision gets
a new native presentation, while a current main request reuses and restores its normal
Electron window. A superseded main that has never appeared is retired. Closing never
depends on first paint. The loader and ready panel both dismiss on an outside click or
Escape. Without X11 the app
keeps the compositor-managed browser path. A direct tray activation toggles it; the blur and activation
of the same pointer gesture cannot close and immediately reopen it. The menu's
*Limits* command explicitly opens it. Closing both destroys their renderers and ends
the process after a half-second gesture window; no browser or hidden page stays
resident afterwards. The Rust agent and Node hub
continue. A socket pair inherited as fd 3 carries typed messages, not a TCP listener or
command-line secrets. EOF tells Electron to quit if the controller dies. A second start
sends only an Open signal through a per-user Unix socket; the receiver checks peer UID.

Electron starts with renderer sandboxing, context isolation and no Node integration in
the page. A preload exposes only the app commands allowed for its window role and a way to hear the app's state.
The main process checks the sender is the current main frame and its origin is the
current hub; Rust repeats the origin check before dispatch. The app's state goes to the
window over the same channel and on only to the main frame of the current hub. Startup/error pages at `quotum://localhost` can only
quit. Navigation, new windows, downloads and permission requests are restricted. No
inherited Node/Electron debugging switches reach the window process.

With an available X11 display the native loading surface selects X11/XWayland before
Chromium initializes Ozone; the NVIDIA launcher does so even if the loader could not
initialize. Other systems use Chromium's default display selection.
`--software-rendering` disables hardware acceleration for that launch. No driver,
kernel or desktop settings are changed. Both the native window and the page use the
same background colour while newly exposed areas are painted during a resize.

Both loading and ready panels have a rounded native drawing/input boundary, using
the popup radius prepared from the shared style tokens. The header has matching
icon buttons for opening the board and closing the panel, with localized labels
and tooltips.

The compact view keeps each quota on one row: its name, a short reset countdown with
the full date in its tooltip, the board's shared remaining meter and percentage.
If there is no countdown to show, the compact row leaves that detail empty.
The provider header carries its measurement indicator and the working-agent count;
the total agent count is in that count's tooltip. Hidden windows and the owner's
ordering are shared with the board. Large lists can scroll, but ordinary subscriptions
do not reserve a separate footer or a second line for every reset. The panel grows
with its content up to 80% of its monitor's work area, with no fixed pixel ceiling;
only content beyond that height scrolls. The native loader uses the same screen limit.
Native height reports are serialized, keeping only the latest pending layout. An open
Linux panel refits when displays or their work areas change. Measurement tooltips shift
inside the viewport without changing the card's height.

The engine version and archive checksum are pinned in `desktop/prepare-electron.mjs`;
updating Chromium means rebuilding the Linux packages. `desktop/package-linux.mjs`
packages the controller, Node, hub, GUI code and Electron's license notices into deb,
rpm and AppImage. Native packages install Chromium's root-owned sandbox helper; the
AppImage uses user namespaces. Neither disables Chromium's sandbox. Child failures
are reported over the private channel, including during teardown, and the controller
waits for GUI termination when quitting.

**The hub's local mode.** Started with `QUOTUM_LOCAL_KEY` and `QUOTUM_LOCAL_TOKEN`, a
hub has one person and no accounts. At start it makes sure the person exists, sets the
secret of its machine token (*Quotum app*) to the one given and deletes every session.
`GET /local?key=…` with the right key gives a session cookie with no expiry, which ends
with the web view, and leads to the board; a wrong key leads there without one. The
routes of accounts, boards, sharing, invitations, pairing and tokens are not registered
at all, and `/api/session` says `local`: the board then has no account, board switcher
or people, and a settings panel of the app instead. The hub runs only while its stdin is
open: when it closes (the app quit or died, even killed) or on `SIGTERM`, the hub prints
a `stop` line and exits within two seconds, a hanging request or not.

**What keeps it private.** Every user of a machine can reach any port on `127.0.0.1`,
so nothing there is open without a secret. The key and the token are random and new on
every start of the hub. They reach Node in its environment, never on its command line,
and are kept nowhere else: no file, no log. Node gets only a short list of variables of
the app's environment (`PATH`, the home and temporary folders, the language, and
`QUOTUM_RESETS`), nothing `NODE_*`. The hub still checks Host and Origin as on a server,
and the agent reaches it with no proxy in between. The window's bridge to the app is
open only to pages of the hub's current origin and to the commands in `ipc.rs`. The main window can read state, save measuring and app
settings, take over, change start at login, reset saved trusted credentials with no
arguments, reenter and quit. The compact panel can read
state, reenter, open the main window, close itself and report its content height. The
host clamps that height; no command accepts a window id, position or arbitrary URL.
On Windows `watch_state` registers a channel for each trusted window instance. The window goes
nowhere else; links open in the system's browser. The app's folder is this user's only.

**Files.** The app's folder is `%LOCALAPPDATA%\com.padurets.quotum` on Windows and
`~/.local/share/com.padurets.quotum` on Linux: the hub's database (`hub/`), `app.json`
(the port, whether taking over was agreed to, whether start at login was set),
`app.lock` (one app per user), the web view's data and, on Linux, `window.json` (window geometry). The logs are in
`%LOCALAPPDATA%\com.padurets.quotum\logs\` on Windows and `~/.cache/com.padurets.quotum/logs/` on Linux (`hub.log`
and `agent.log`, each moved aside at 1 MiB).
`QUOTUM_APP_DATA_DIR` puts the app's data and logs under the chosen isolated directory, and the web view's
data too on Linux and in the smoke run (`--smoke`); elsewhere on Windows WebView2 keeps its profile in
`%LOCALAPPDATA%\com.padurets.quotum\EBWebView`. Measurements that wait for the hub go to
`app-spool.jsonl` in `quotum`'s state folder.

**Trusted keys in the app.** A separate sibling folder, `com.padurets.quotum-keys`,
contains one namespace per canonical app-data path. SHA-256 of that path's native
bytes (UTF-16LE on Windows) names the namespace. Its positive, increasing key names
are `hub-secret-key@<hash>#<number>`. The system store is Windows Credential Manager
with Local persistence, or Linux Secret Service. Discovery is limited to this
namespace; it never enumerates all of a person's credentials. A private-file fallback
lives in the sibling namespace, outside the hub's data. Directories and files are
checked for ownership, permissions and symlinks or reparse points through native
handles. Linux directories are 0700 and files 0600; Windows permits key reads and
mutation only to the current user, SYSTEM and Administrators in the private namespace.
Deletion uses the same checked handle, which denies replacement until it closes.
Its system-drive ancestors may also be owned by Windows' privileged TrustedInstaller
service. A writable default
collection is required before
creating a Linux store key. A locked collection or an incomplete search means waiting.

The namespace's `marker.json` records current, staged next and previous key references,
their transition reason and fingerprints, and whether a file was used. It contains no
key. Empty `.reserved` files book names before a store operation, so a late write or a
lost marker cannot reuse them. The marker is a hint: the hub's stored fingerprint
selects a readable matching key. A replaced marker's former target and other found
keys are never turned into previous keys or automatically deleted. An empty database
reuses the highest-numbered valid found key. Incomplete discovery never creates one.
Recovery to another key or an empty database removes stale rotation cleanup records
from the marker while keeping their keys. A later `ok` after `created` on a replacement
database cannot revive permission to delete those old keys.

One worker serializes native store work away from the UI and the app's async runtime.
A Linux session and all its item, collection and prompt requests stay with the unique
Secret Service owner that created them. Losing that owner cancels its pending operation;
the worker reconnects after it finishes and the retry backoff, preserving the keys and
marker. The pinned Secret Service client carries that destination through its proxies.
A soft 60-second deadline publishes waiting while leaving that operation able to
finish; no second prompt runs alongside it. Retry backoff is bounded. Planned hub
restarts have their own bounded budget, apart from crash recovery. Each Node spawn
gets only its chosen generation's KEK and transition in its own environment. The app
does not put them in its process environment, state DTO, settings or bridge. The first
hub start report validates fingerprints and safe counts before authorizing progress.
Session storage details are a startup snapshot; settings read the live numbered app
state, including changes that require no hub restart.

A file-to-store migration writes and reads back a fresh store key, stages it, and
activates it on the next outer app start with the matching previous key. Cleanup needs
an `ok` or `rotated` report matching the recorded transition, completed WAL truncation
and zero unreadable records. `created` after replacing the database does not authorize
rotation cleanup. An explicit reset has its own fingerprint-bound transition and
consumes its one-shot input on one spawn. A late result from an older operation cannot
change that transition. Unrelated found files are retained and shown in settings;
`wasFile` persists because old backups remain sensitive.

**Its life.** A second start of the app opens the window of the first. Closing the
window destroys it and its web view; the app keeps measuring, and the tray icon (*Open
Quotum*, *Quit*) or starting the app again brings the window back. *Quit*, there or in
the settings, ends the agent and the hub. On Linux the icon is a StatusNotifierItem, which
GNOME shows only with an extension; without it, starting the app again opens the
window. The first time the app measures it turns on start at login (a start without the
window), once: the settings turn it off. On Linux only a program that no other user can
change is started at login. When the hub ends by itself, the app starts it again, on
the same port with new secrets, at most three times in five minutes; the window follows
it to the new start and the agent delivers with the new token.
Window creation counts as a foreground request while it is pending, so a fast hub
cannot mistake it for a hidden start. Navigation follows the requested hub generation,
including a transition whose page has not loaded yet. A stopped agent worker keeps its
spool until delivery ends; a replacement waits for that handover.
The last window's close is resolved after any startup or takeover operation, so closing
while the question is being prepared cannot leave an unseen consent request running.

**Background attention.** One cancellable Rust reader enters the local hub using its
key, keeps the session cookie in memory and reads the desktop variant of its SSE stream
(spec/dashboard-v1.md). The hub shares level, visibility and naming with the board.
A persistent window ledger consumes each threshold once per confirmed cycle inside the
measurement transaction; candidates and observation boundaries leave only after commit.
The ledger expires after the sample-retention horizon since its last observation,
including for a source still present. A returning window starts silently. New cycles
use one persisted global high-water counter, allocated in the same transaction,
so cleanup and restart cannot reuse a consumed notification identity. The counter
is bootstrapped from legacy cycles before any ledger is removed; invalid or exhausted
metadata suppresses new cycles with a safe diagnostic.
Failed legacy bootstrap disables allocations even if the counter itself looks valid;
the same scalar records that failure so cleanup and restart cannot make it usable again.
Boundaries precede the coalesced card deltas, and new candidates follow them. Thus a
temporary replacement or disappearance can revoke an already queued native intent
even when the final card has its old metadata again. The boundary/candidate buffer is
bounded; unaffected windows keep their events. Candidates are also checked against
current window semantics and ledger cycle before SSE emission. Scheduled tracker news has
its own watermark. Every connection starts from an empty notification baseline; old
spooled observations cannot become live events through a new receipt time.

The reader uses paired suspend-aware and awake clocks plus a reader-progress barrier.
Sleep, a pause or a hub generation change invalidates pending native intents. The sink
checks the generation, observation epoch, visibility, current names, settings and age
again after its bounded queue. A failed clock detector suppresses notifications while
status reading continues. This promises at most one native attempt, not an OS display:
crashes and system suppression may lose an event, and nothing replays it.

Linux keeps one ksni handle and uses session D-Bus notifications independently of its
tray watcher. The notification connection's authentication and each method call have
a one-second timeout, so an unresponsive bus does not hold shutdown indefinitely.
Its action listener is an owned cancellable task on the same runtime; stopping it
does not wait for the notification daemon to close its end of the connection.
Windows owns one Shell_NotifyIcon control window, used for its status,
menu and silent notifications in both installer and portable builds. Its queue keeps
at most 64 notification intents; the latest status and panel controls are coalesced
separately and processed first, so notification overflow cannot discard them. Explorer restart
registers only the current icon. Native text is generated from the same EN/RU catalogs
as the page; settings and language are saved atomically in `app.json` and published to
both windows in the common numbered AppState.

**Taking over from `quotum`.** One agent measures a machine: whoever holds `run.lock` in
the state folder, and `run.info` next to it names its process, version and hub. When a
`quotum` measures as the app starts, the app asks once whether to take over; the
question names the hub that `quotum` delivers to, which gets nothing from this machine
while the app runs. Closing the window at the question quits the app, and so does a
start at login before anyone agreed, with a line in `agent.log`. On the agreement the
app asks `quotum` to make way (`yield` in `run.stop`). A `quotum` of this version lets
go at once and waits (`run.wait.*`) until the app quits, then measures again with its
settings read afresh, so `quotum run` as a service goes on by itself. Older ones (0.3.0
and before) stop instead: update them, or start them again after the app quits.
One that has not stopped within 15 seconds (30 for one that makes way) is ended, and
only while that same process still holds the machine; one that does not name its
process is left alone, and the question says taking over failed. `quotum` tells who
measures, and `quotum stop` ends a waiting `quotum` but never the app.

**Its settings** are in Account settings, under Application, only in the app's window: which
providers are measured and how often, a name for the Antigravity account, whether
running agents are shown, start at login, the version and *Quit*. They are `quotum`'s
settings: a change is written to `config.toml` at once, keeping comments, symbolic links
and permissions. Windows uses `ReplaceFileW` to preserve an existing file's ACL;
its temporary file receives the existing DACL when it is created, and its inherited ACEs
are restored before any contents are written. Unix temporary files start private. New Windows files inherit the profile
folder's ACL. The app sends its state to the board whenever it changes (the agent's
state, a measurement, the settings, start at login), numbered, so the board keeps the
newest; the answer of each command carries the same number. Whatever changes it only
wakes the app's ticker, which puts the state together and sends it, one at a time, off
the window's own thread. Saves are serialized, and the board receives the accepted
settings at once while restarting measurements is debounced. The board waits for each state-changing
command's response before issuing the next; quitting and reentry do not wait in that queue.
A change made in the file by hand is
picked up within seconds.

## Releases

An annotated version tag runs `.github/workflows/release.yml` from that commit. It
checks the shared version, runs CI, builds the CLI, and calls `desktop.yml` for the
Linux and Windows packages and their installation and smoke checks. The complete set
of binaries is assembled with one `SHA256SUMS` before the hub image or npm packages
are published. CLI and desktop downloads have build provenance; the tag's message is
the GitHub release's description. The desktop app is updated by downloading and
installing a newer package; it has no automatic updater yet.

## Roadmap

1. ~~Ingest format, the agent (three providers, schedule, spool), hub ingest.~~
2. ~~Users, boards, devices, machine tokens; connecting with a one-time code;
   subscriptions held by people and shared with boards.~~
3. ~~One measurer per subscription.~~
4. ~~The dashboard fed by agents only (CodexBar removed); English and Russian.~~
5. A team view on shared boards: people × providers.
6. ~~Distribution through npm: `npx quotum`, a launcher with a prebuilt binary per
   platform (npm/build.mjs cross-compiles them all on one Linux machine).~~
   ~~Installers (`curl … | sh`, PowerShell) and `quotum update`: each release also has a
   bare binary per platform, which they fetch and check against `SHA256SUMS`; the
   latest version is read from where `releases/latest` redirects, one request with no
   API behind it.~~ Next: autostart registration.
7. ~~The desktop app for Windows and Linux: the agent, its own hub and board,
   tray and settings, built and tested by CI.~~ Next: automatic updates, then
   macOS.
