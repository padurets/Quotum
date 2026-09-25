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
  serves the dashboard. It never talks to providers itself.
- **spec/** — the ingest format, the contract between the two. Anything that speaks it
  can deliver to a hub.
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
and `agy` processes run, since when, in which folder (its name only; not the home or a
temporary folder), where (a terminal, an editor, or the Codex desktop app, told by the
programs above them), and whether they work. An editor or the app runs one client per
window for all its chats, so there a session is a window. A session works while it and
what it started (tools, builds, tests) spend more of a CPU core than the client does
when idle (6% for Claude Code, which redraws its screen even then; 3–4% for the others),
and for a minute after, so a pause of the model is not idleness. Only this user's
processes count (on Windows, those of this logon session), and the clients the agent
starts to measure do not. Nothing else of the client is read, its settings are not
changed, and no program is started for it. A look is one pass over the process list for
names and parents, then the times of the clients' own processes: about 20 µs per process
on Linux. Not seen: a client that runs as `node` (an npm install on macOS and Windows),
and on Windows the folder, which the system does not tell of another process. macOS names
a process after the file a link leads to, so there a client is also told by its path.

**Where the client is.** On PATH, in its own installer's place, where package managers
put programs, and, for Codex, last of all the copy the Codex desktop app or an editor
extension carries: whoever uses only those needs no command-line client. On Windows the
Codex app keeps its copy in `%LOCALAPPDATA%\OpenAI\Codex\bin` (the Store version under
its package's `LocalCache`), newest first. The app execution aliases Windows puts in
`\Microsoft\WindowsApps\` are passed over: they start the Store app, not a client that
answers. A program started from the desktop does not see the PATH a shell sets up, so
the desktop app finds a client only in these places; one elsewhere is given by `path` in
the settings.

## Scheduling

Clients are expensive to start, so the schedule is about starting as few as possible,
and never several at once:

- **One at a time.** Measurements run strictly one after another, so at any moment at
  most one client is running.
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
  extends duty until the measurement goes stale. Only delivering extends it; a holder
  that keeps asking but never delivers loses duty after five minutes.
- The others are told to wait and when to ask again: in a minute if someone works on
  that machine, otherwise in up to ten minutes.
- Duty moves to a device where someone works if the holder has been idle for ten
  minutes, so the numbers come from where the subscription is actually being used.
- A holder that goes quiet (asleep, switched off) loses duty when its last measurement
  goes stale, and the next device to ask takes over.

Duty is kept in memory; after a restart of the hub the first devices to check in take
it again. An agent that cannot ask simply measures.

## Delivery

The agent posts each measurement right away. When the hub is unreachable, measurements
wait in a spool file (at most 5,000, about two days, rewritten atomically) and go out
oldest first when it answers again; meanwhile the agent tries again after a minute,
then less and less often, up to once an hour, and measures without checking in. Resending
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
request, is asked again every hour: it may have been upgraded). At most 200 sessions go
out, the working ones first. The hub keeps the latest list of each machine
in memory for five minutes (after a restart the agents send theirs again), files each
session under its subscription (the account the client is signed in to now, else the one
the machine last delivered for that client; only one its person holds; the agent leaves
out a session of a client signed in anew since it last measured, until it knows which
account that is) and shows it on
that card, to the members of a board where that person shows the subscription. Each list
also counts until the next one, for at most 200 seconds: how long agents
worked on each subscription, in five-minute cells (agent time, two agents counting twice,
and the time any of them worked, overlaps between machines counted once), kept as long
as samples.

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
- **The chart** puts every series on one time grid (5 minutes for a day, 30 minutes
  for a week, 2 hours for a month) and shows the lowest value seen in each cell, so
  hovering reads every series at once and a short hiccup doesn't break a line. A time
  range dragged across the chart, from 15 minutes to a month, gets the finest cell that
  keeps it within about 360 cells (a minute for an hour, as dense as the fixed periods
  for longer ones; 5% over is allowed, so a day over a month keeps the month's grid). Its
  edges go out to whole cells, so the chart and the table may cover up to a cell beyond
  the selection, and ranges that differ by less than a cell share one answer. Where
  measurements come less often than cells, hovering reads the last value before. Putting a month together takes a busy board a good part of a second, so
  such an answer is reused for a quarter of its cell after the data changed, and says
  when a newer one will be ready for the page to ask again; a source joining or leaving
  the board is never served from it. The range is in the past, so the table reads it from its edges: what
  was left at its first and last measurement, what it spent and how fast.
- **The plan** is per source and belongs to the board's view: whole percents per day of the
  weekly window (30/25/15/15/10/5/0 by default). A day at 0 has no spending planned,
  wherever it is; the plan ends with its last non-zero day. Other windows are planned
  linearly to their reset. The board's owner can switch a source's plan off: then none
  of its windows is planned on that board. The chart draws the plan of the current week
  only.
- **Events** mark the chart behind now. An early reset is derived from the samples: a
  window's used share drops by more than 5 points before its reset time (resets of one
  source within 15 minutes are one event). Free resets granted are recorded when a
  measurement reports more of them than the one before. Resets for everyone that the
  community trackers report are kept as the hub sees them (the trackers only tell the
  latest one), so the chart marks every one of the period.

## People, boards, devices

- **Users** sign in to the hub with an email and a password. The first person on a hub
  signs up without an invitation but with its setup code: a new hub prints one to its
  log, so only whoever started it can claim it. After that, signing up needs an invite
  link unless the hub is open (`QUOTUM_SIGNUP=open`).
- **Devices** are running agents, and each belongs to a person. The *Machines* dialog
  shows a person's devices, what each delivers and the last failure of each client
  there (not logged in, too old…); the person names them there. A device connects in
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
  source, the list of running agents, the chart and the table), their widths on a
  twelve-column grid, names and colours given to cards, the hidden widgets (and those
  off by default, the list of agents, turned on), the columns hidden in a widget's table,
  the windows hidden inside cards and the spending plans, or that a card has none. The
  list of agents shows only the subscriptions whose cards are shown.
  It is stored once per board, like a dashboard in Grafana: the owner arranges it and
  names the cards the way the team calls them, and everyone sees the same board. Nothing
  in the view changes what is measured or stored.

Secrets (sessions, tokens, codes, invites) are random, prefixed by kind (`qt_s_`,
`qt_m_`, `qt_d_`, `qt_c_`, `qt_i_`) and stored only as SHA-256 hashes; passwords as
scrypt hashes. Changes made with a session cookie are accepted only from the hub's own
pages (Origin check, SameSite cookie). Failed sign-ins and sign-ups and code lookups are
rate-limited.

## The dashboard

A single-page React app served by the hub. It reads `/api/overview` every 10 seconds
and re-reads history only when the overview's `revision` says the board's data changed;
an answer the same as the one before renders nothing. What changes with time alone (how
long ago, how soon, the freshness dot, whether the hub answers) reads a clock shared by
the page, which ticks every 15 seconds, and every minute for the chart and the table:
only that is rendered again, the board itself reads no clock. Nothing on the page is
fixed and the widgets are not frosted, so a scroll paints only what comes into view,
even in a WebKitGTK window that draws without the GPU.
A board has two areas: the cards (and the list of running agents, when turned on),
which are about now and show every window, and under
them the analytics, the chart and the table, which show one window type over one period
chosen in the analytics' own head. Each area is arranged on its own grid.
The board's view comes with the overview; the owner's changes show at once and are
saved about half a second later, one request per burst (a drag, typing a plan). What
is only about how one person looks (the analytics' period and window type, the chart's
horizon, lines switched off in the legend, reset announcements, the lock on the widgets,
the chosen board and language) stays in their browser. A time range selected on the
chart becomes the analytics' period; it lives in the page's address (`?from=&to=`),
so a reload keeps it, Back undoes it and a link to it can be shared on the board.

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

**Linux rendering and lifetime.** The Rust controller uses a D-Bus StatusNotifierItem
through `ksni`; it does not link GTK or WebKit. Opening the window starts an Electron
process; closing it ends that process and its renderers. The Rust agent and Node hub
continue. A socket pair inherited as fd 3 carries typed messages, not a TCP listener or
command-line secrets. EOF tells Electron to quit if the controller dies. A second start
sends only an Open signal through a per-user Unix socket; the receiver checks peer UID.

Electron starts with renderer sandboxing, context isolation and no Node integration in
the page. A preload exposes only the six app commands. The main process checks the
sender is the current main frame and its origin is the current hub; Rust repeats the
origin check before dispatch. Startup/error pages at `quotum://localhost` can only
quit. Navigation, new windows, downloads and permission requests are restricted. No
inherited Node/Electron debugging switches reach the window process.

On NVIDIA with an available X11 display the launcher selects X11/XWayland before
Chromium initializes Ozone. Other systems use Chromium's default display selection.
`--software-rendering` disables hardware acceleration for that launch. No driver,
kernel or desktop settings are changed. Both the native window and the page use the
same background colour while newly exposed areas are painted during a resize.

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
open only to pages of the hub's current origin and to six commands: its state, saving
settings, taking over, start at login, entering again and quitting. The window goes
nowhere else; links open in the system's browser. The app's folder is this user's only.

**Files.** The app's folder is `%LOCALAPPDATA%\com.padurets.quotum` on Windows and
`~/.local/share/com.padurets.quotum` on Linux: the hub's database (`hub/`), `app.json`
(the port, whether taking over was agreed to, whether start at login was set),
`app.lock` (one app per user), the web view's data and, on Linux, `window.json` (window geometry). Linux logs are in
`~/.cache/com.padurets.quotum/logs/` (`hub.log` and `agent.log`, each moved aside at 1 MiB).
`QUOTUM_APP_DATA_DIR` puts logs and browser data under the chosen isolated directory. Measurements that wait for the hub go to
`app-spool.jsonl` in `quotum`'s state folder.

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
settings: a change is written to `config.toml` at once (its comments kept), and one made
in the file by hand is picked up within seconds.

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
   tray and settings, built and tested by CI.~~ Next: its releases and installers, then
   macOS.
