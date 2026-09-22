# Agent Limits

One page with the subscription limits of every coding agent you use — Claude Code,
OpenAI Codex, Google Antigravity: how much of each 5-hour and weekly window is left,
when it resets, whether you spend it faster than planned, and the history of all of
them on one chart.

> Status: early. The hub (`hub/`) has accounts, personal and shared boards, and takes
> measurements from the native agent (`agent/`), connected with a one-time code or a
> board token. Next: one measurer per subscription, team pages, packaging
> (`npx agent-limits`) and a desktop app. See [docs/architecture.md](docs/architecture.md).

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
agent/crates/cli/          the `agent-limits` command (status, run, connect, config)
spec/ingest-v1.md          what the agent sends to the hub
hub/server/domain/         sources, quota windows and consumption rules, ingest, reset feeds
hub/server/store/          SQLite schema, migrations and queries (node:sqlite, WAL)
hub/server/ingest.ts       POST /v1/ingest: devices, owners, subscriptions
hub/server/pairing.ts      connecting a device with a one-time code
hub/server/routes/         sign-in, boards, invites, tokens, devices; agent endpoints
hub/server/store/directory.ts  users, sessions, boards, tokens, devices
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
agent-limits connect https://hub.example # connect to a hub with a one-time code
agent-limits run                         # keep measuring; deliver when connected
agent-limits run --hub URL --token al_b_… [--owner alice]   # or with a board token
agent-limits config                      # where settings live, which clients were found
```

Settings (`~/.config/agent-limits/config.toml` on Linux; all optional):

```toml
interval = 120          # seconds between measurements of one provider, at least 60
eco = true              # measure less often while nothing changes
owner = "alice"         # whom this machine measures for on a shared board (board tokens)

[hub]
url = "https://limits.example.com"
token = "…"

[providers.antigravity]
interval = 300
account = "work"        # names a subscription the client does not identify
# enabled = false
# path = "/opt/agy/bin/agy"
```

`AGENT_LIMITS_HUB_URL`, `AGENT_LIMITS_HUB_TOKEN`, `AGENT_LIMITS_OWNER`,
`AGENT_LIMITS_INTERVAL`, `AGENT_LIMITS_CONFIG` and `AGENT_LIMITS_STATE_DIR` override the
file. `connect` keeps its device token in the state directory (readable by the user only).

### Hub

Requirements: Node.js 24+.

```sh
cd hub
npm ci
npm run build
npm test
npm start   # http://127.0.0.1:8080 — the first account created becomes the admin
```

Configuration (environment):

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_LIMITS_BIND` | `127.0.0.1` | Listen address |
| `AGENT_LIMITS_PORT` | `8080` | Listen port |
| `AGENT_LIMITS_ALLOWED_HOSTS` | `127.0.0.1,localhost` | Host names the service answers to; others get 403 |
| `AGENT_LIMITS_FRAME_ANCESTORS` | — | Extra origins allowed to embed the page |
| `AGENT_LIMITS_DATA_DIR` | `./data` | Where the SQLite database lives |
| `AGENT_LIMITS_SIGNUP` | `invite` | `open` lets anyone sign up; otherwise only the first user and people with an invite |
| `AGENT_LIMITS_PUBLIC_URL` | from the request | Address shown to agents and in invite links |
| `AGENT_LIMITS_INGEST_TOKENS` | — | Extra static tokens (16+ characters) that deliver to the first user's board |
| `AGENT_LIMITS_VENDOR_TOKEN` | — | Token of a local `codexbar serve`; enables the built-in CodexBar collector |
| `AGENT_LIMITS_CLAUDE_PROFILE` | `~/.claude.json` | CodexBar collector only: Claude Code profile, read for the account id |

People sign in with e-mail and password; devices connect from the board's
«Устройства» panel: a one-time code for machines people work at, a board token for
images, VMs and containers ([spec](spec/ingest-v1.md)). Serve the hub over HTTPS (behind
a TLS-terminating proxy is fine): sessions are cookies, tokens are bearer secrets.

API: `/health`; for people `/api/session`, `/api/auth/*`, `/api/overview?board=`,
`/api/history?board=&range=24h|7d|30d`, `/api/boards/*` (members, invites, tokens,
devices), `/api/device` (approving codes), `/api/resets`; for agents `/v1/device/code`,
`/v1/device/token`, `/v1/ingest`. Add `?preview=reset` to the page URL to see a sample
reset announcement.

## Roadmap

1. One measurer per subscription across all devices of a board.
2. Team pages: people × providers on shared boards.
3. Move the dashboard fully to agent data and drop the CodexBar collector.
4. One-line start: `npx agent-limits` (npm package with per-platform binaries),
   `curl … | sh` and PowerShell installers, autostart.
5. Desktop app (Tauri): agent and dashboard in one, tray icon and settings, no server.

## License

MIT, see [LICENSE](LICENSE). Third-party notices: [NOTICE.md](NOTICE.md).
