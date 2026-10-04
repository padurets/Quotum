# Architecture

Quotum shows the subscription limits of coding agents (Claude Code, Codex, Antigravity)
on one page: for one person on one machine, or for a team across many machines and
accounts. This document explains how the parts work and why they are built this way.

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
  serves the dashboard. Hub-measured providers, such as OpenRouter, use its read-only
  connectors and encrypted credentials; subscription measurements come from agents.
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

Each provider has an adapter that asks the agent's own client, never the provider's
endpoints:

| Provider | Interface | Notes |
|---|---|---|
| Claude Code | `claude -p --input-format stream-json …`, control request `get_usage` (the Agent SDK protocol) | No MCP servers, hooks, plugins, skills or saved session. Claude Code caches the answer for 60 s. |
| Codex | `codex app-server`, JSON-RPC `account/rateLimits/read` (the protocol of the IDE extensions) | Plan, per-model limits, account id. |
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
window for all its chats, so there a session is a window. A session works while it and
what it started (tools, builds, tests) spend more of a CPU core than the client does
when idle (6% for Claude Code, which redraws its screen even then; 3–4% for the others),
and for a minute after, so a pause of the model is not idleness. Only this user's
processes count (on Windows, those of this logon session), and the clients the agent
starts to measure do not. On Linux, a bounded invocation prefix of this user's Codex
processes also distinguishes `app-server daemon pid-update-loop` (maintenance) and
`app-server proxy` (transport forwarding), which are not sessions. The reader skips at
most 2048 bytes of the executable name, then compares only the leading role, byte by
byte, stopping at the first mismatch or the end of a recognised role. It never reads
ahead into argument values, retains no command line, and checks the process's identity
again after the read. Unknown or unreadable roles remain eligible; processes that exited
or whose identity changed during the read are left for the next look. A service ancestor
does not hide a real client it started. Persistent app servers remain eligible, including
detached servers that may serve remote work; idle alone does not make a service. macOS
and Windows currently have no invocation-role reader. No client settings or session files
are read or changed, and no program is started for it. A look is one pass over the process
list for names and parents, then the times of the clients' own processes: about 20 µs per process
on Linux. Not seen: a client that runs as `node` (an npm install on macOS and Windows),
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
dashboard and the desktop app. The header also refreshes all non-hidden cards on the
current board through those same requests, up to four at a time. A refused request does
not stop the rest; a tooltip at the header button lists every requested card in one
compact row, with its name, status icon and short outcome. Error details expand by
clicking the row. Each outcome stays in this attempt's receipt after the hub retires its
status, also while the tooltip is closed. An old outcome cannot stand in for a new
request, and a reconnect with a missing outcome says it is unknown. Nothing moves the
widgets. While its refresh is pending, and once it has finished, clicking the button
only opens or closes that information; a row at the top of the tooltip starts another
attempt. An individual card cannot be requested again until its refresh finishes, nor
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

## Delivery

The agent posts each measurement right away. When the hub is unreachable, measurements
wait in a spool file (at most 5,000, about two days, rewritten atomically) and go out
oldest first when it answers again; meanwhile the agent tries again after a minute,
then less and less often, up to once an hour. A check-in the hub answers ends that wait
at once, and what was kept goes right after it. Resending
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
account that is) and shows it on
that card, by project (as that person named it) and folder, to the members of a board
the person is on where the subscription is shown, whoever brought it. Each list also counts until the next one, for at most 200 seconds: the hub
keeps when each session worked, with its machine, subscription, where it runs, since
when and its project and folder names as reported, as long as samples. A session is
never credited twice for the same time: after the hub's clock goes back, it is credited
again from where its time already ends, so a clock that ran ahead costs its sessions at
most as much time as it ran ahead, and the time counted before is never rewritten. Sums are worked
out when read (`domain/work.ts`): agent-hours add each stretch up, two agents counting
twice; active time is their union, overlaps counted once for whichever machines,
people or projects are asked about. The corrections people make to project
names apply when read, so they reach all the time kept. The database says since when
this is kept (`agentWorkSince`): before it, how agents worked is not known.

The analytics show it over their period. The table tells, for each window, its
subscription's active time, what the window spent per active hour, what share of its
spending came while agents were active, and, beside the forecast by time, a forecast by
work: how many active hours what is left lasts at that spending (or that it lasts to
the reset). An optional Agent-hours column adds each agent's time separately.
Agent-hours and the spending share while active are off by default; enabling either can turn the
full-width table into a list, where every value keeps its heading.
A widget stacks agent-hours by subscription, project or machine in bars of an hour
(the period's cells where those are longer; shorter bars where a range holds fewer
than twenty hours). Four agents over an hour make a bar 4h tall. The legend's groups
add up to the total in every split; projects and machines take seven colours by their
agent-hours, and those past them share a neutral one. Each group is its own however
small. Above the stacks are agent-hours, active time, distinct agents and the average
at once (agent-hours divided by active time). Active time is not drawn: it is in the
totals and tooltips. A bar's tooltip gives these totals first, then its group parts;
a legend entry's glass bubble gives the group's agent-hours, active time, average at
once and distinct agents. Hover or keyboard focus opens it, Escape dismisses it; a
tap also switches the group and keeps the bubble for four seconds. Switching groups
off recomputes stacks, scale and the shown agent-hours; active time, agents and at
once still cover all the board's agents. A subscription's agent-hours equal its
windows' Agent-hours column, and its active time equals their Active time column.
What is known of a period begins with `agentWorkSince`, and on a shared board no earlier than the
subscription came to it: the part before is said to be unknown, not drawn as idle. The
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
touches whole, so it is an upper bound. A board shows the work of its
members who hold each subscription it shows, but those of hidden cards: on a shared
board from the later of their joining it and the subscription coming to it, on a
personal board all of it. Work the board does not show (off the board, from before) is
not in its hours while the window's spending is, and so is spending outside tracked
agents (claude.ai, a phone, machines without Quotum, cloud tasks): the share while
active says how far to trust the pace.

## Storage and the rules

One SQLite file (WAL). A **source** is one subscription, kept once for the whole hub:
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
  a changed `Store.workKey` (lineup, work selection, project or machine names) recounts it.
  Tiles near retention's edge are never cached. Deleting retained samples, work or events
  advances a private store revision; the next server read clears the tile cache before
  looking for hits. Even a distant tile can depend on a preceding sample of any age.
  This housekeeping emits no history event: observations already read by the page stay
  until its usual data or connection changes. The page keeps packed buffers within an
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
Readings use signed integer millionths, with sparse value/semantic changes and
continuous observation spans. Unchanged heartbeats extend freshness without another
reading. Retention keeps one predecessor to distinguish a late increase from a reset.
A missing key is stale after one successful traversal and archived after two successive
successful misses; partial traversals never confirm absence, and history is retained.

Money history uses the same bounded tiles, cache and page loader. Its exact strings,
historical cap semantics and original spending intervals stay separate from the window
Float64 codec. A logical balance selection internally reads its two counters. Axes and
arithmetic never combine units; money does not contribute percentage attention,
forecast or quota notifications.

A hub polling service starts after readiness and stops before SQLite closes, with at
most two concurrent jobs and one per source. It rechecks access versions and source
generation before committing a result, so deletion and replacement discard late
answers. Auto intervals stretch from two to fifteen minutes; existing fixed preferences
also apply. Permanent access failures pause automatic retries. Refresh requires a
source holding and shares a one-minute cooldown across boards. Owner source access is
projected separately for each reader, outside the shared board cache.

## Trusted connector keys

The hub has a write-only credential service, separate from password and machine-token
hashes. OpenRouter uses it for a management key, through code-owned GET operations
for the account, credits, workspaces and keys. Connector adapters are registered in code;
tests inject their own adapter. Each credential belongs to its person and can be
created, replaced, listed or removed only by that person's session. Create and replacement
identify the account outside SQLite, then commit encrypted access and its verified
source holding atomically. A replacement cannot change the account. No-expiry access
requires explicit consent. Creation retries can use an owner-scoped UUID for 24 hours;
a deletion leaves its replay tombstone. Deleting the last own access releases that
person's holding, preserving others and history. Missing or broken access preserves
last measurements and a neutral shared failure, with details only for its owner. Mutations require
an explicit same-site Origin before parsing, accept only a connector's strict printable
ASCII key format, and are limited to ten attempts a minute per person and address.
Replies contain only the safe record details, including a last-four hint; neither the
key nor encrypted bytes go to the dashboard's events or shared boards.

`QUOTUM_SECRET_KEY` supplies 32 random bytes as canonical unpadded base64url (43
characters); `QUOTUM_SECRET_KEY_FILE` instead reads those characters, optionally
followed by one LF or CRLF, from a regular file whose real path is outside the data
directory. The two inputs are exclusive. HKDF-SHA256 derives separate encryption and
check keys. AES-256-GCM binds each credential to its id, owner and provider, using a
fresh 12-byte nonce per write. SQLite keeps only ciphertext and its tag, nonce and key
generation. A full key check value in `meta` identifies the database's KEK; its first
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
- **Devices** are running agents, and each belongs to a person. The *My connections* dialog
  shows a person's devices, what each delivers and the last failure of each client
  there (not logged in, too old…); the person names them there. The same list contains
  their provider accounts, and its Connect menu opens a device or provider form directly.
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
  source, the list of running agents, the chart, the table and agent activity), their places on a
  six-column grid (`x`, `y`, `w`, and `h` where the owner chose a height; what the content
  needs is measured, never stored), names and colours
  given to cards, the hidden widgets (and those
  off by default, the list of agents, turned on), the columns hidden in a widget's table,
  the agents' and the limits' (and those off by default turned on), the windows hidden inside cards and the spending
  plans, or that a card has none. The list of agents shows only the subscriptions whose cards are shown.
  It is stored once per board, like a dashboard in Grafana: the owner arranges it and
  names the cards the way the team calls them, and everyone sees the same board. Nothing
  in the view changes what is measured or stored.

Secrets (sessions, tokens, codes, invites) are random, prefixed by kind (`qt_s_`,
`qt_m_`, `qt_d_`, `qt_c_`, `qt_i_`) and stored only as SHA-256 hashes; passwords as
scrypt hashes. Changes made with a session cookie are accepted only from the hub's own
pages (Origin check, SameSite cookie). Failed sign-ins and sign-ups and code lookups are
rate-limited. An agent's request with an unknown or revoked token is refused before its
body is read, so whoever reaches the hub cannot make it hold bodies it would throw away,
and a request has 30 seconds to arrive in full.

## The dashboard

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
time as the hub's messages tell it. The chart and agent activity move on a cell of the
history's grid at a time; a label past the chart's right edge counts down on its own, and
a forecast's line goes at the moment the table says it runs out, or at the reset; in the
table, the plan, where the pace leads and the active hours left each read otherwise at
their own moment. History is read when the hub tells of measurements or credited agent
work. The page makes cells from `since` stale and reads only those its frame needs,
without a rate limit or a timer. Reconnect, a new lineup, or a change of whose work the
board shows or its names (`Store.workKey`) makes all tiles stale. The last frame stays
undimmed while its tail loads. A frame of another period stays dimmed until its cells
are complete. One pending read per target coalesces news until its response, while another
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
Nothing on the page is fixed and the widgets are not frosted, so a
scroll paints only what comes into view, even in a WebKitGTK window that draws without
the GPU.
A card's dot by the logo tells how its measurements go: its colour, and in its tooltip
when it was measured and, while the hub sets the pace, when the next measurement comes
and why, each a line of its own.
A board has two areas: the cards (and the list of running agents, when turned on),
which are about now and show every window, and under
them the analytics, agent activity, the chart and the table, which show one period
chosen in the analytics' own head, the chart and the table one window type of it. Each
area is arranged on its own grid. A row is 48 px (a 32 px track and a 16 px gap).
Each widget fills the fewest whole rows that contain its content, with any spare room
above a card's tray or at the bottom of a panel, unless the owner chose a height for it
(`h`, in rows). A chosen height is a request, not what shows: a card or the table never
gets shorter than its content, and grows past the chosen rows while its content needs
more, back to them when it needs less, without the view changing. Both charts give a
chosen height to their plot, never drawing it lower than they do by themselves, their
heads, totals and legends whole. The list of agents can be shorter than its rows: it
shows the most whole rows that fit, in its own order, and a last row saying how many
more, which opens them all in a dialog; to know how many fit, it lays all its rows out
unseen beside it, their running times standing still. Such a widget tells the grid
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
The page translates views saved before the grid, retaining hidden and absent widgets;
the next save writes only the new layout. The hub requires that layout when saving,
so an old page cannot overwrite it. Its view route allows 64 KiB per request, so a full
view also fits the browser's keepalive save when leaving before the debounce, with no
separate limit on the number of places: new visible neighbours can get their places
without removing the ids kept by old views.
The board's view comes with its events; the owner's changes show at once and are saved
about half a second later, one request per burst (a drag, typing a plan), and stay on
screen until the hub tells the view it saved. What
is only about how one person looks (the analytics' period and window type, the chart's
horizon, lines and groups switched off in either chart's legend, whether it draws the plan and the forecast, what agent activity is stacked by, reset announcements, the lock on the widgets,
the agents table's sort order, the chosen board and language) stays in their browser.
Both charts, the remaining shares and agent activity, read and move along time alike
(`ui/components/timeAxis.ts`), each with its legend under it. A time range selected on
either becomes the analytics' period; it lives in the page's
address (`?from=&to=`), so a reload keeps it, Back undoes it and a link to it can be shared on the board.
‹ and › beside the period move the analytics by half their length: back, to a range in
the past held in the address like a dragged one; forward, up to now, where the chosen
period comes back. A horizontal touchpad swipe, Shift with the wheel, or Shift with a
mouse or pen drag moves both charts continuously. A page-local transaction captures
each chart's scale in CSS pixels and applies the same time delta on animation frames;
plain dragging still selects a range and touch retains its hold-to-select gesture.
Prepared SVG artwork moves in composited HTML surfaces behind a stationary clip;
the axes and readouts stay in place. The chart container owns pointer capture and
wheel input, projected through its fixed SVG viewport, including labels in another
surface. Surface geometry and painters become visible only after their DOM commits.
The future moves with the strip during the gesture, then folds away over 160 ms on
release in the past, or unfolds on returning to live. Reduced motion skips this final
transition. Release within eight source pixels of now restores the chosen live preset.
One changed gesture creates one address entry; cancellation or returning to the exact
origin creates none. A horizontal wheel ends after a 200 ms pause. Shift-wheel keeps
one captured scale across pauses and ends when Shift is released, like a held drag;
a pointer can continue that transaction. Neither adds inertia. Holding Shift hides
chart and activity-legend readouts even before movement starts. The plot and legend
keep their height through the gesture, final fold and resulting range; extra legend
entries scroll inside. Ordinary range navigation or a layout/language change measures
them again. Changing the time frame by hand therefore cannot resize the chart.
An answered activity frame without work keeps its time axis and legend viewport;
its empty message sits inside the plot, which still accepts the next gesture.

While panning, the history store keeps the previous complete answer for the table,
activity totals and legend numbers. A separate bounded plot buffer decodes the same
tiles without computing frame totals. Known parts stay undimmed, lines break across
unread cells, and an activity stack appears only when every contributing whole cell is
read. A stationary HTML inset clips the long activity band to whole bars without
laying out that SVG again. Two short edge bars in their own SVG are recomputed when
the draft crosses a cell; moving within a cell only translates the prepared artwork
and updates its clip. The final 160 ms fold stays inside SVG to preserve stroke widths.
A temporary shared registry keeps plot and
legend colors and dashes consistent, adding new groups with a pending total. Visible
missing cells take priority over one adjacent frame of read-ahead, with at most one
visible and one speculative request, eight tiles each. Writes to the same tile are
serialized, obsolete requests are aborted and speculative errors cannot drop the
selection. The existing 15 MiB tile estimate protects the visible frame. On release,
speculation stops and exact totals switch only after the final frame is complete.
Numeric preparation runs outside React rendering through one cancellable MessageChannel
scheduler. Its shared generators yield between small cell, session, group, event and point
operations. UI slices target one millisecond and check the deadline after at most sixteen
generator advances; server and synchronous readers drain those same generators. Each owner
keeps only its latest job. Tile responses use private COW staging and publish their
tiles, read bounds and metadata together. At most two responses are admitted for
processing, including raw answers waiting for a tile reservation; ordinary HTTP
scheduling remains separate. Flights and reservations remain owned until commit or
discard. Completed projections pin the current tile entry and its write sequence.

Each chart replaces one typed drawing model whole after preparation, then publishes
its geometry and painters after the DOM commits. Input keeps the displayed model and
its composed SVG matrix and CSS offset until that handoff. Finishing a gesture commits
the address immediately and presents its last pending delta on RAF; the final pose
stays held until the matching drawing model is ready. The SVG fold and CSS offset
reset then start from the same displayed coordinates. A new gesture samples that
actual presentation, including an interrupted fold, separately from its URL origin.
Partial plots continue to publish during the gesture. Its final drawing readiness
also requires the complete history answer for the requested range, so a partial
strip cannot start the fold before that answer replaces it.
User navigation owns the requested projection separately from drawing readiness.
Back, a preset or a horizon change retires an older held pose and its pending RAF or
fold; both charts immediately place their retained data in the requested projection.
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
or switching 12h and 24h asks nothing once both have been seen. A new lineup or work
selection makes them stale; a late measurement or credited work makes only cells from
its actual time stale, and the page reads them when a frame needs them.

Both agent lists put working sessions first, then the ones that worked most recently,
then the newest. The card's panel keeps machine groups, ordered by each one's most
active session. The table's headers sort ascending, descending, then back to activity;
a hidden column does not sort. When its owner's chosen columns do not fit the widget's
own width, it becomes a compact list with a sort menu. State is off by default: the
mark already tells it. Explicit column choices belong to the board, sorting to the viewer.
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

**Its settings** are in the board's settings panel, only in the app's window: which
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
