# Architecture

Agent Limits shows the subscription limits of coding agents — Claude Code, Codex,
Antigravity — on one page: for one person on one machine, or for a team across many
machines and accounts.

## Parts

```
 each machine                                    hub (self-hosted or shared)
┌──────────────────────────────┐   HTTPS POST   ┌──────────────────────────────┐
│ agent (Rust)                 │  /v1/ingest    │ ingest ─► rules ─► SQLite    │
│  claude  -p stream-json      │ ─────────────► │                   │          │
│  codex   app-server          │  device token  │ personal & team pages (React)│
│  agy     -p /usage           │                └──────────────────────────────┘
│  schedule · spool · pseudonym│
└──────────────────────────────┘
```

- **agent/** — a small native program (Rust, one static binary per platform). It measures
  limits through each agent's own command-line client and its machine-readable
  interface, and delivers normalized values to a hub in the [ingest format](../spec/ingest-v1.md).
- **hub/** — the dashboard service (Node 24, Fastify, SQLite; React UI). It stores
  measurements, applies the consumption rules (what counts as spending, what is a
  reset, what is a gap) and serves the dashboard. Today it can also collect by itself
  through CodexBar; that path goes away once the agent has replaced it.
- **spec/** — the ingest format, the contract between the two.

## Three ways to run it

1. **Desktop app (planned).** Agent and dashboard in one application with a tray icon and
   a settings window, built with Tauri: the Rust core plus the same React UI. It keeps
   history locally and needs no hub, no token and no server. This is the default for a
   person with one machine.
2. **Agent + hub.** The agent runs headless (a user service: systemd, launchd, Windows
   autostart) on every machine where agents work — laptops, servers, cloud dev
   environments — and delivers to a hub. One page shows all machines and accounts of a
   person or a team.
3. **One-off check.** `npx agent-limits` (or the installed binary) prints the current
   limits of this machine and exits.

The domain rules (consumption, resets, gaps, the time grid of the chart) must behave
the same in the hub and in the desktop app. They live in the hub today; when the
desktop app is built they move into the Rust core, and the hub either uses that core
or is checked against shared test fixtures. Which of the two is decided then.

## Measuring

Each provider has an adapter that asks the agent's own client, never the provider's
endpoints directly:

| Provider | Interface | Notes |
|---|---|---|
| Claude Code | `claude -p --input-format stream-json …`, control request `get_usage` (Agent SDK protocol) | No MCP servers, hooks, plugins, skills or saved session. Claude Code caches the answer for 60 s. |
| Codex | `codex app-server`, JSON-RPC `account/rateLimits/read` (the protocol of the IDE extensions) | Plan and per-model limits, account id. |
| Antigravity | `agy -p /usage --output-format json` (agy 1.1.11+) | Answered locally. The agent redirects agy's log to its own file; otherwise agy writes a new log file per run. |

Consequences:

- The agent never reads tokens or cookies and never refreshes them: the client does
  that itself, as when a person uses it. No model request is made.
- A changed provider API is fixed by updating the client, not the agent.
- Measured on one machine (2026-09-22): Claude 1.0 s CPU / ~230 MB peak, Codex 0.8 s /
  ~100 MB, Antigravity 0.9 s / ~170 MB. The agent itself idles at ~5 MB.

Identity: Claude reports the signed-in e-mail and organization in its `initialize`
response, Codex the account id; both become a pseudonym before anything leaves the
machine, the same on every machine. Antigravity does not say which account it is, so
the hub keeps it per machine.

## Scheduling

Clients are expensive to start, so the schedule is about starting as few as possible,
never at the same time:

- **One at a time.** Measurements run strictly one after another, so the peak is one
  client, not three.
- **Interval per provider**, configurable, at least 60 s (below that Claude Code answers
  from its cache anyway), 120 s by default.
- **Spread.** After the first round (all providers right away, one after another) each
  provider is offset by an equal share of its interval, plus ±10 % jitter so machines
  of a team do not synchronize. After sleep or suspend the spread is re-established
  instead of catching up missed runs.
- **Eco mode** (on by default): while a provider's values do not change and nobody uses
  it on this machine (its history and state files are untouched), its interval doubles
  up to 15 minutes; any change or use snaps it back. A known reset pulls the next run
  to 30 s after it.
- **Failures back off**: a missing client is checked every 30 minutes, a signed-out one
  every 15, other errors double the interval up to 15 minutes.
- Clients run at low priority (nice 10, below-normal on Windows), in an empty working
  directory, and are killed with their process tree after 60 s.

Every measurement carries `staleAfterMs` — when the next one is due plus a margin — so
the hub knows a sparse eco-mode series is continuous and a missing measurement is a gap.

## Delivery

The agent posts each measurement right away. When the hub is unreachable, measurements
wait in a spool file (at most 5,000, about two days) and go out oldest first when it
answers again. Resending is safe: the hub treats a measurement it already has as a
duplicate.

The hub resolves a snapshot to a *source* (one provider account) by its pseudonym. The
same account measured from two machines is one source; its history is one line.

## Roadmap

1. ~~Ingest format, agent MVP (three providers, schedule, spool), hub ingest.~~
2. Run the agent next to CodexBar for a few days and compare; then remove CodexBar.
3. Distribution: `npx agent-limits` (npm package with per-platform binaries),
   `curl … | sh` / PowerShell installers, `agent-limits connect <code>` pairing with a
   one-time code, autostart registration.
4. Hub multi-tenancy: users, device tokens, teams, a team page.
5. Desktop app (Tauri): tray, settings, local dashboard.
