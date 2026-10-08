# Agent instructions

Instructions for coding agents (Claude Code, Codex, Antigravity and others) working on
Quotum. They add to [CONTRIBUTING.md](CONTRIBUTING.md), which applies to everyone; read
it first.

## What this is

Quotum shows how much of coding-agent subscriptions (Claude Code, Codex, Antigravity) is
left, across machines. Two parts, a contract between them, and an app that puts both on
one machine:

- `agent/` — Rust workspace: `crates/core` (a provider adapter per client, schedule,
  settings, delivery), `crates/cli` (the `quotum` command).
- `hub/` — Node 24, Fastify, the SQLite built into Node, a React dashboard:
  `server/domain` (the rules), `server/store` (SQLite), `server/routes`, `ui/`.
- `spec/ingest-v1.md` — the protocol between them; `spec/dashboard-v1.md` — the events
  the hub pushes to its dashboard.
- `desktop/` — the desktop app (Rust, a Cargo workspace of its own; Electron on Linux, Tauri on Windows): `quotum-core` as
  the machine's agent, the hub bundled into one file and run in its local mode by the
  Node the app carries, and the hub's board in a window.

Also `npm/` (the npm packages and the build that cross-compiles the agent), `install/`
(the installers for `curl … | sh` and PowerShell), `deploy/`
(Compose behind Caddy), `.github/workflows` (CI; releases from a version tag).
[docs/architecture.md](docs/architecture.md) explains how it all works and why; read the
relevant part before changing behaviour.

## Checking a change

```sh
cd hub && npm ci && npm run typecheck && npm test && npm run build
cd agent && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
node desktop/prepare.mjs && cd desktop && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
```

Run the checks of every part you touched; a change is done when they pass. The app's
come after `prepare.mjs` (it builds the hub and fetches Node, which the app's build
reads), and on Linux they need the system packages listed in CONTRIBUTING.md. A change
to `agent/crates/core` or to the hub touches the app too. CI also runs the agent on
macOS and Windows, and builds the app on Windows and Linux and runs each build
(`desktop/smoke/`): if you change process handling (`process.rs`, `stop.rs`,
`holder.rs`, `activity.rs`, `desktop/src/hub.rs`) or start at login and can check only
one system, say so.

`npm run bench` in `hub/` (after `npm run build`) measures the board in headless Chrome
against its budget (`hub/bench/budget.ts`). An idle board has neither measurements nor
working agents: it asks the hub nothing and renders only what shows time. Every
measurement reaches its card and chart, 95 of 100 within a second, reading only new
history cells and rendering no other card nor the header. A machine report crediting
work makes at most one small history read and renders only its card, agents and
analytics. Run it when you change the dashboard and have Chrome (`QUOTUM_CHROME`, one
on `PATH`, or `--cdp` to one already running); CI fails over budget. After the readings,
it also checks consecutive measuring-frequency saves with native arrow keys and fails
if saving loses focus.
Native horizontal wheel and Shift-drag scenarios then move all three charts at 24h and 30d
with at least twelve real series per resource family and CPU throttled fourfold, including an unread edge,
strip rebuilding, reversal and return to live. Moving-frame p95/p99 must stay within
34/50 ms and input-to-updated-frame p95 within 34 ms; callbacks without actual chart
movement cannot pass. Existing idle, measurement and work budgets remain unchanged.
Input is credited after the production RAF reaches its coalesced position on the real
data layers. Input-free pauses are excluded from moving intervals; pending input keeps
delayed work measurable. The final geometry must commit before an unpainted last input
can be credited. These are RAF proxies; physical presentation is checked separately.

`npm start` in `hub/` serves the built dashboard on `127.0.0.1:8080` (a new hub prints
the setup code of the first account to its log). `npm run demo` in `hub/` serves it on
throwaway data with every state the board knows that lasts on a working hub, needing no
network or account; see *The demo board* in [CONTRIBUTING.md](CONTRIBUTING.md).
`cargo run -p quotum` in `agent/` measures this machine once through the clients
installed on it; that makes no model requests, but it does start the real clients.
`cargo run` in `desktop/` starts the app with its hub and agent, which measures with
this machine's `quotum` settings and state as the installed app would (`QUOTUM_CONFIG`,
`QUOTUM_STATE_DIR` and `QUOTUM_APP_DATA_DIR` point it elsewhere); a debug build never
turns on start at login. A hub in local mode (`QUOTUM_LOCAL_KEY`, `QUOTUM_LOCAL_TOKEN`)
runs only while its stdin is open.

## Rules

For an isolated development stand on Linux, use `make dev`, `make info`, `make logs`
and `make down` at the actual worktree root (see *Worktree development stands* in
CONTRIBUTING.md). Creation prepares configuration only. Independent tool calls must
pass the created worktree's returned path explicitly as their working directory.
Use the configured remote browser for visuals; do not provision a second browser.
`make dev-test` checks the lifecycle tooling. Component check wrappers strip preview
configuration, serialize heavy runs and use Docker for Rust; canonical CI performance
and platform smoke checks still apply.

- **Tests never start a real client.** They use recorded answers and stand-in programs.
  Keep it that way: no test may depend on an account, the network or an installed
  Claude Code, Codex or Antigravity.
- **The agent never touches secrets.** It never reads provider tokens, cookies or
  credential files, never makes a model request and never calls provider APIs. A new
  provider is an adapter in `agent/crates/core/src/providers/` that asks the provider's
  own command-line client.
- **Trusted hub keys are write-only.** Connector credentials pass through the hub's
  secrets service, are encrypted before SQLite sees them, and never enter board
  projections, errors or logs. Connectors use only their fixed HTTPS transport;
  provider clients inherit no `QUOTUM_*` variables. Never log a raw crypto or keyring
  error, whose contents may include secret bytes.
- **Identity follows its evidence.** Supplier identity uses the provider's stable
  account pseudonym and keeps mismatch checks on replacement and polling. Declared
  identity uses the shared owner/provider/logical-UUID generator, never a key, name,
  plan or balance. All declared replacements require `sameAccount` before provider
  work; named account selection adds no second identity or consent mechanism. Reuse
  persisted source bindings without recomputing their identity. Private account labels
  and owner IDs never enter shared projections.
- **The provider catalogue defines authority.** Known hub-measured providers are
  dropped from agent snapshots, failures and sessions before their other fields are
  parsed. Check-in replies preserve those elements' positions and tell the agent to
  wait off duty. No such traffic creates a source, holding or duty.
- **Meters keep their units and precision.** Money is whole integer millionths,
  serialized as exact decimal strings. Counter spending, top-ups and cap remaining
  are separate from percentage windows; they never enter quota forecasts or native
  quota notifications. Historical cap semantics, exclusive quota validity bounds and uncertain spending intervals
  survive history packing and retention. Catalogue balance roles and accounting
  capabilities are authoritative: balance-only sources never infer spending or top-up
  events. Accepted missing observations preserve values but end availability; actual
  sample anchors and exclusive deadlines survive packing, drawing and readout.
- **The protocol is a spec.** A change to what the agent sends or the hub answers goes
  into `spec/ingest-v1.md` in the same commit, including its Privacy section; a change to
  the events the hub tells its dashboard, into `spec/dashboard-v1.md`.
- **Released database layouts are frozen.** A new layout is a new step at the end of
  `hub/server/store/schema.ts`; never edit a released step.
- **Two languages everywhere.** Every UI string goes into every catalog in
  `hub/ui/i18n`; every change to `README.md` goes into `README.ru.md` too.
- **One version.** `agent/Cargo.toml`, `agent/Cargo.lock`, `desktop/Cargo.toml`,
  `desktop/Cargo.lock`, `hub/package.json` and `hub/package-lock.json` always carry the
  same version; see *Releasing* in the README. `desktop/Cargo.lock` also locks
  `quotum-core`: after a change to its dependencies, `cargo metadata --format-version 1`
  in `desktop/` updates it (no build needed), or `desktop.yml` fails on `--locked`.
- **The app's bridge stays narrow.** The board in the app's window reaches the app only
  through the commands in `desktop/src/ipc.rs`, each behind its origin check; what the
  app's hub serves stays behind the key. A new command needs a reason.
- **Releases are the maintainer's.** Never create or push a version tag, run the release
  workflow or publish packages or images unless the maintainer asked for that release.
- **Docs describe the current system.** Update `docs/`, the READMEs and the spec with the
  change that makes them wrong; no changelogs or history in them.

## Dashboard UI

- **Look at a change on the demo board** (`npm run build && npm run demo` in `hub/`), in
  both languages, not only through tests. A state the board did not show before gets an
  entry in `hub/demo/catalogue.ts` with the codes it shows; `npm test` checks them. One
  a working hub never holds for long is named in the catalogue's header instead, with
  the tests that hold it.
- **Build from the shared pieces.** A menu, dropdown or any panel that opens from a
  button is a `Popover` (`hub/ui/components/Popover.tsx`); a dialog or side panel is a
  `Modal` (`hub/ui/components/Kit.tsx`). They are glass: the `glass` class and its
  tokens in `hub/ui/style.css`, as are the tooltips of our own (the charts', from
  `hub/ui/components/Tooltip.tsx`, a card's dot's). A new floating surface uses one of
  them rather than styling its own. Nothing floating scrolls the page, lengthens it or
  widens it: a panel opens whole in the window, under the bars stuck at its top, on the
  side of its button where it fits, or where there is more room, cut to that room and
  scrolling inside (`sideOf` in `hub/ui/lib/place.ts`); a chart's tooltip keeps to the
  window too (`placeOf`, and `edgeOf` for its labels past the edge). A chart along the
  analytics' time reads and moves through `useTimeAxis` (`hub/ui/components/timeAxis.ts`),
  keeps its own options in its settings, and has its legend under it, each entry switched
  off and on by a click.
- Scrollbars have one style, set once at the top of `hub/ui/style.css`; nothing styles its own.
- Widgets on the board are a `.card` (a source) or a `.panel` (the list of agents, agent activity, the chart, the table).
- **Keep the board cheap to render.** Nothing on the page is `position: fixed` or has a
  fixed background, and widgets have no `backdrop-filter` (floating surfaces and the
  sticky bars may): whole-window repainting during scroll is expensive, especially
  with software rendering. Nothing polls: data comes as the hub's events into the page's
  store, and a widget reads its own part of it with a hook of `hub/ui/lib/board.ts`,
  never the board passed down, so it renders only when that part changes. What shows
  time is a small part of its own that reads `useClock(changesAt)` (`hub/ui/lib/clock.ts`)
  with a `…ChangesAt` of its own beside the function that words it, tested to read the
  same until then; nothing that shows data or time keeps a timer of its own, only a
  tooltip or a gesture may wait a moment (`hub/ui/test/timers.test.ts` lists where), and
  what shows time is marked `data-time`, as `npm run bench` counts it.
- A card tells how its measurements go in the logo's dot and its news in marks on the
  left of its tray, with the details in a tooltip or a panel, never in a line of its own; neither
  changes a card's height.
- A scale with its own status dot stays at full opacity, including stale or missing
  readings. Explain the status in the dot's tooltip.
- Subscription cards and compact rows share the percentage-limit layout and period
  names. Provider-specific amounts and allowances belong in value details; the
  provider's storage unit does not define a separate card layout.
- Subscription analytics share the same period switches, percentage chart and table,
  including hub-measured caps. Convert a historical cap with its own reported allowance
  and observation bounds; never reinterpret it using the current allowance or invent
  spending, forecasts or agent-work attribution.
- Devices and provider accounts connect through My connections. Account settings hold
  profile and app settings. A widget's display switches live in its own settings;
  measurement tables do not change chart selections.
- **Budget widgets share one semantic presentation.** Dashboard and compact use the
  same budget view and renderer: one Available balance, supported scoped allowances
  separately, and balance composition in the existing disclosure. Accounting totals
  belong in analytics. Never add card rows just because a provider returns more fields;
  each extra field needs a defined purpose, while safe financial observations are saved
  at capture for later analytics. Only reported caps have scales, and lifetime credits
  never become a wallet's percentage denominator. Totals, components and currency
  representations are never added without evidence that they are independent funds.
  Unknown, unsupported, stale and confirmed zero remain distinct.
- **Currency behavior belongs to the shared money layer.** Provider adapters capture
  native facts; shared services own rate integrations, cache, exact conversion and
  provenance. Widgets consume common presentation and formatting instead of choosing
  provider-specific currencies or fetching rates. USD is the current display policy.
  The user's display currency and personal currency definitions use one user-scoped
  registry and persisted preference consumed by every monetary widget; future settings
  forms must use that same contract.
  Keep public reference rates separate from private user rates. Preserve original
  amounts and recorded conversion provenance; changing a display preference must not
  rewrite provider history or turn exchange movements into spending. Percentage quotas
  and non-monetary counters keep their own units.
- **Times.** Say when as `stamp` in `hub/ui/lib/format.ts` does: "26 September 14:00",
  never "today" or "tomorrow", never seconds; under a heading that already gives the day,
  the time alone. Where how soon or how long ago matters more, and room is short (a mark,
  a cell, the line under a limit, a panel's heading), say that instead (`countdown`,
  `duration`, `ago`: "in 20h", "5m ago"), with the time as `stamp` gives it beside it or
  in its tooltip. How long something has run ("running for 31m") is not a time, nor is
  the scale along a chart's axis ("22 Sept", "14:00").
- **No dots between parts.** A line never runs its parts together with " · ": what it
  says leads, and a detail or a time is set apart by layout (a tag beside it, a quieter
  line under it). In plain text, a tooltip or a name for screen readers, each part is a
  line of its own.
- **A row lights up under the pointer, one of two ways.** A table's row, in a widget or
  a dialog, across its whole width, as its columns run edge to edge. A row of a list or a
  menu in a `Popover` or a `Modal`, inset with rounded corners (`.popover-row`), and a
  little brighter, to show on the glass.
- Settings sections share their page's surface: `.settings-section` separates them
  with space and a rule. Reuse `.settings-list` for aligned names, details and actions,
  and `.button` for visible actions; do not nest decorative panels inside the content.
- Colours come from the tokens at the top of `hub/ui/style.css`, and the colours of
  series from `hub/ui/lib/providers.ts`. Status colours (ok, warn, crit) are for status
  only: how much of a limit is left, a source or device in trouble, a destructive
  action; never decoration or a series.
  Missing, partial, unsupported or invalid supplier quota replies use `warn`. Known
  access failures (expired or revoked credentials, denied permission, unavailable
  secret storage) use `crit`; an inactive key is neutral. Every tray mark receives
  its status colour from the shared `.tray-pill` styles.

## Code and commits

- Match the surrounding code: its naming, comment density and idiom. Comments explain
  why, in plain sentences.
- Keep dependencies few; adding one needs a reason.
- Commit messages are short English sentences about the result, without conventional
  prefixes: `Agent: quotum start runs it in the background`. One logical change per
  commit.
- Never commit secrets, `.env` files, hub data (`data/`, `*.sqlite`) or build output.
- **One task is one pull request into `main`**, merged with *Squash and merge* (see
  *Pull requests* in CONTRIBUTING.md): its title becomes the one commit on `main`, so it
  is written as a commit message is. Nothing is pushed to `main` directly, and never a
  pull request opened only to run CI. Changes after review are new commits on the
  branch; force-push only for a strong reason, stated in the pull request.
