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
- `spec/ingest-v1.md` — the protocol between them.
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

`npm start` in `hub/` serves the built dashboard on `127.0.0.1:8080` (a new hub prints
the setup code of the first account to its log). `cargo run -p quotum` in `agent/`
measures this machine once through the clients installed on it; that makes no model
requests, but it does start the real clients. `cargo run` in `desktop/` starts the app
with its hub and agent, which measures with this machine's `quotum` settings and state
as the installed app would (`QUOTUM_CONFIG`, `QUOTUM_STATE_DIR` and
`QUOTUM_APP_DATA_DIR` point it elsewhere); a debug build never turns on start at login.
A hub in local mode (`QUOTUM_LOCAL_KEY`, `QUOTUM_LOCAL_TOKEN`) runs only while its stdin
is open.

## Rules

- **Tests never start a real client.** They use recorded answers and stand-in programs.
  Keep it that way: no test may depend on an account, the network or an installed
  Claude Code, Codex or Antigravity.
- **The agent never touches secrets.** It never reads provider tokens, cookies or
  credential files, never makes a model request and never calls provider APIs. A new
  provider is an adapter in `agent/crates/core/src/providers/` that asks the provider's
  own command-line client.
- **The protocol is a spec.** A change to what the agent sends or the hub answers goes
  into `spec/ingest-v1.md` in the same commit, including its Privacy section.
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

- **Build from the shared pieces.** A menu, dropdown or any panel that opens from a
  button is a `Popover` (`hub/ui/components/Popover.tsx`); a dialog or side panel is a
  `Modal` (`hub/ui/components/Kit.tsx`). They are glass: the `glass` class and its
  tokens in `hub/ui/style.css`. A new floating surface uses one of them rather than
  styling its own.
- Widgets on the board are a `.card` (a source) or a `.panel` (the chart, the table).
- **Keep the board cheap to render.** Nothing on the page is `position: fixed` or has a
  fixed background, and widgets have no `backdrop-filter` (floating surfaces and the
  sticky bars may): whole-window repainting during scroll is expensive, especially
  with software rendering. What shows time reads `useNow(step)`
  (`hub/ui/lib/api.ts`) itself rather than a clock passed down from the board, and
  polled state is set through `unlessSame`, so an unchanged answer renders nothing.
- Colours come from the tokens at the top of `hub/ui/style.css`, and the colours of
  series from `hub/ui/lib/providers.ts`. Status colours (ok, warn, crit) are for status
  only: how much of a limit is left, a source or device in trouble, a destructive
  action; never decoration or a series.

## Code and commits

- Match the surrounding code: its naming, comment density and idiom. Comments explain
  why, in plain sentences.
- Keep dependencies few; adding one needs a reason.
- Commit messages are short English sentences about the result, without conventional
  prefixes: `Agent: quotum start runs it in the background`. One logical change per
  commit.
- Never commit secrets, `.env` files, hub data (`data/`, `*.sqlite`) or build output.
- **One task is one pull request into `main`**, merged with *Rebase and merge* (see
  *Pull requests* in CONTRIBUTING.md): never one opened only to run CI. Changes after
  review are new commits on the branch; force-push only for a strong reason, stated in
  the pull request.
