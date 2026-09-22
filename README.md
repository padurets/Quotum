# Agent Limits

One page with the subscription limits of every coding agent you use — Claude Code,
OpenAI Codex, Google Antigravity: how much of each 5-hour and weekly window is left,
when it resets, whether you spend it faster than planned, and the history of all of
them on one chart.

> Status: early. Today it is a single-user service that collects limits on the
> machine where the agents are logged in. The plan is a lightweight agent daemon that
> pushes limits to a hosted dashboard, so a person or a team sees all their machines
> and accounts on one page (see [Roadmap](#roadmap)).

The interface is in Russian for now.

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
codexbar serve (loopback) ──► collector ──► SQLite ──► HTTP API ──► React UI
                                                ▲
                         reset trackers ────────┘
```

- **Collection.** [CodexBar](https://github.com/steipete/CodexBar) reads the local
  agent credentials and asks each provider for its usage. The service calls its
  loopback `/usage` endpoint once every two minutes, never on page load, and refuses
  anything it cannot verify (stale or unknown values) instead of storing it as if
  it were observed.
- **Sources, not providers.** Everything is keyed by a *source* — one provider
  account. A second subscription of the same provider becomes its own source with its
  own history and settings.
- **Consumption.** Only increases of the used percentage within the same account and
  the same reset window count as consumption. Resets, corrections, account changes
  and gaps longer than 5.5 minutes are excluded. An idle rolling window whose reset
  time drifts forward is not a reset.
- **Privacy.** The database stores normalized percentages and reset times, a one-way
  pseudonym of the account, and error categories. It never stores tokens, cookies,
  raw provider payloads or e-mail addresses. Browser preferences stay in the browser.

Code layout:

```
hub/server/config.ts       every tunable, environment overrides
hub/server/domain/         sources, quota windows and consumption rules, normalization, reset feeds
hub/server/identity/       account pseudonyms (Google ID-token verification, local metadata)
hub/server/sources/        CodexBar client, reset tracker client
hub/server/store/          SQLite schema, migrations and queries (node:sqlite, WAL)
hub/server/collector.ts    the scheduled collection cycle and backoff
hub/server/api.ts          read-only HTTP API and security headers
hub/ui/                    React UI: formatting, plan, preferences, cards, chart
```

## Running

Requirements: Node.js 24+, a running `codexbar serve` with the providers you use
enabled and logged in.

```sh
cd hub
npm ci
npm run build
npm test

# CodexBar on loopback; both processes share one random token.
export AGENT_LIMITS_VENDOR_TOKEN="$(openssl rand -base64 36)"
CODEXBAR_DASHBOARD_TOKEN="$AGENT_LIMITS_VENDOR_TOKEN" \
  codexbar serve --host 127.0.0.1 --port 18081 --refresh-interval 0 --identity redacted &
npm start   # http://127.0.0.1:8080
```

Configuration (environment):

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_LIMITS_BIND` | `127.0.0.1` | Listen address |
| `AGENT_LIMITS_PORT` | `8080` | Listen port |
| `AGENT_LIMITS_ALLOWED_HOSTS` | `127.0.0.1,localhost` | Host names the service answers to; others get 403 |
| `AGENT_LIMITS_FRAME_ANCESTORS` | — | Extra origins allowed to embed the page |
| `AGENT_LIMITS_DATA_DIR` | `./data` | Where the SQLite database lives |
| `AGENT_LIMITS_VENDOR_TOKEN` | — | Token shared with `codexbar serve` (required) |
| `AGENT_LIMITS_CLAUDE_PROFILE` | `~/.claude.json` | Claude Code profile, read for the account id only |

The service is read-only over HTTP (`GET`/`HEAD`), sets a strict CSP and has no
authentication of its own: keep it on loopback or behind an authenticating proxy.

API: `/health`, `/api/overview` (current state per source), `/api/history?range=24h|7d|30d`
(every series on a shared grid), `/api/resets` (reset announcements and tracker health).
Add `?preview=reset` to the page URL to see a sample reset announcement.

## Roadmap

- **Agent**: a small native daemon that reads local agent credentials, polls
  the providers directly and pushes normalized limits to a dashboard. Credentials
  never leave the machine.
- **Hub**: this service as a multi-tenant dashboard: per-user ingest tokens, several
  machines and accounts per user, team pages.
- An open, versioned ingest format, so other collectors can push too.

## License

MIT, see [LICENSE](LICENSE). Third-party notices: [NOTICE.md](NOTICE.md).
