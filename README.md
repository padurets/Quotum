# Agent Limits

One page with the subscription limits of every coding agent you use — Claude Code,
OpenAI Codex, Google Antigravity: how much of each 5-hour and weekly window is left,
when it resets, whether you spend it faster than planned, and the history of all of
them on one chart.

> Status: early. The dashboard (`hub/`) runs; the native agent (`agent/`) measures all
> three agents and delivers to the hub. Next: packaging (`npx agent-limits`), team
> pages and a desktop app. See [docs/architecture.md](docs/architecture.md).

The dashboard interface is in Russian for now.

## Quick look

```sh
cd agent && cargo build --release
./target/release/agent-limits
```

```
                                   left  resets
Codex pro     weekly                 6%  in 3d 19h
Claude max    5 hours               95%  in 1h 43m
              weekly                90%  in 5d 11h
              Fable weekly         100%  in 5d 11h
Antigravity   Gemini 5 hours       100%  in 5h 0m
              Gemini weekly       96.3%  in 1d 3h
```

The agent asks each agent's own command-line client (`claude`, `codex`, `agy`) through
its machine-readable interface. It never reads tokens and makes no model requests.

## What it shows

- **A card per account** with one meter per window. Meters use fixed status colours:
  above 30% is fine, 30% and below is a warning, under 10% is critical. A tick marks
  where the spending plan expects the window to be now.
- **A spending plan** for weekly windows: whole percent per day, by default
  30 / 25 / 15 / 15 / 10 / 5 / 0 (the seventh day is a rest day). Each account can
  have its own plan; other windows are planned linearly to their reset.
- **One combined chart** of every window over 24 h / 7 d / 30 d on a shared time grid,
  so a hover reads all series at once. The right edge shows a bit of the future: the
  plan ahead and the next resets.
- **A table** with the plan, consumption and a forecast of whether a window runs out
  before its reset.
- **Reset announcements** from community trackers ([Codex Resets](https://codex-resets.com),
  [claude-resets.com](https://claude-resets.com)), shown with credit and a link to the
  source post. Can be turned off in the settings.

## How it works

```
agent (every machine)  ── POST /v1/ingest ──►  hub: rules ─► SQLite ─► dashboard
  claude · codex · agy                              ▲
                                  reset trackers ───┘
```

- **Agent** (`agent/`, Rust): measures through the clients, one at a time, on a
  per-provider interval (at least a minute, 2 minutes by default, stretched up to 15
  while idle), and delivers in the [ingest format](spec/ingest-v1.md) with a spool
  for offline periods. Account ids leave the machine only as pseudonyms.
- **Hub** (`hub/`, Node 24 + Fastify + SQLite, React UI): stores measurements, applies
  the consumption rules and serves the dashboard. It can also collect by itself
  through a local [CodexBar](https://github.com/steipete/CodexBar) — the path the agent
  is replacing.
- **Sources, not providers.** Everything is keyed by a *source* — one provider
  account. The same account measured on two machines is one source.
- **Consumption.** Only increases of the used percentage within the same account and
  the same reset window count as consumption. Resets, corrections, account changes
  and gaps (a measurement arriving later than the previous one promised) are
  excluded. An idle rolling window whose reset time drifts forward is not a reset.
- **Privacy.** The hub stores percentages, reset times, plan names and account
  pseudonyms. Never tokens, cookies, raw payloads or e-mail addresses. Browser
  preferences stay in the browser.

Code layout:

```
agent/crates/core/         adapters (claude, codex, antigravity), schedule, config, delivery
agent/crates/cli/          the `agent-limits` command
spec/ingest-v1.md          what the agent sends to the hub
hub/server/domain/         sources, quota windows and consumption rules, ingest, reset feeds
hub/server/store/          SQLite schema, migrations and queries (node:sqlite, WAL)
hub/server/ingest.ts       POST /v1/ingest
hub/server/collector.ts    the CodexBar collection cycle (optional)
hub/server/api.ts          HTTP API and security headers
hub/ui/                    React UI: formatting, plan, preferences, cards, chart
```

## Running

### Agent

```sh
cd agent && cargo build --release        # Rust 1.85+
agent-limits                             # measure once and print
agent-limits --json                      # the same in the ingest format
agent-limits run                         # keep measuring; deliver when a hub is set
agent-limits config                      # where settings live, which clients were found
```

Settings (`~/.config/agent-limits/config.toml` on Linux; all optional):

```toml
interval = 120          # seconds between measurements of one provider, at least 60
eco = true              # measure less often while nothing changes

[hub]
url = "https://limits.example.com"
token = "…"

[providers.antigravity]
interval = 300
# enabled = false
# path = "/opt/agy/bin/agy"
```

`AGENT_LIMITS_HUB_URL`, `AGENT_LIMITS_HUB_TOKEN`, `AGENT_LIMITS_INTERVAL`,
`AGENT_LIMITS_CONFIG` and `AGENT_LIMITS_STATE_DIR` override the file.

### Hub

Requirements: Node.js 24+.

```sh
cd hub
npm ci
npm run build
npm test
AGENT_LIMITS_INGEST_TOKENS="$(openssl rand -hex 24)" npm start   # http://127.0.0.1:8080
```

Configuration (environment):

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_LIMITS_BIND` | `127.0.0.1` | Listen address |
| `AGENT_LIMITS_PORT` | `8080` | Listen port |
| `AGENT_LIMITS_ALLOWED_HOSTS` | `127.0.0.1,localhost` | Host names the service answers to; others get 403 |
| `AGENT_LIMITS_FRAME_ANCESTORS` | — | Extra origins allowed to embed the page |
| `AGENT_LIMITS_DATA_DIR` | `./data` | Where the SQLite database lives |
| `AGENT_LIMITS_INGEST_TOKENS` | — | Comma-separated tokens agents may deliver with (16+ characters each); enables `POST /v1/ingest` |
| `AGENT_LIMITS_VENDOR_TOKEN` | — | Token of a local `codexbar serve`; enables the built-in CodexBar collector |
| `AGENT_LIMITS_CLAUDE_PROFILE` | `~/.claude.json` | CodexBar collector only: Claude Code profile, read for the account id |

Without an authenticating proxy in front, keep the hub on loopback: the dashboard
itself has no login yet. Apart from `POST /v1/ingest` it is read-only
(`GET`/`HEAD`) and sets a strict CSP.

API: `/health`, `/api/overview` (current state per source), `/api/history?range=24h|7d|30d`
(every series on a shared grid), `/api/resets` (reset announcements and tracker health),
`POST /v1/ingest` ([spec](spec/ingest-v1.md)). Add `?preview=reset` to the page URL to
see a sample reset announcement.

## Roadmap

1. Run the agent next to the CodexBar collector and compare, then drop CodexBar.
2. One-line start: `npx agent-limits` (npm package with per-platform binaries),
   `curl … | sh` and PowerShell installers, pairing with a one-time code, autostart.
3. Hub for teams: users, device tokens, a team page.
4. Desktop app (Tauri): agent and dashboard in one, tray icon and settings, no server.

## License

MIT, see [LICENSE](LICENSE). Third-party notices: [NOTICE.md](NOTICE.md).
