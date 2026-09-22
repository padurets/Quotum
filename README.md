# Quotum

**English** · [Русский](README.ru.md)

Quotum shows how much of your coding-agent subscriptions is left — Claude Code, Codex
and Antigravity — on every machine you work on, in one place.

![The Quotum dashboard](docs/dashboard.png)

## Why I made it

I pay for several coding agents at once, and each has its own limits: a five-hour
window, a weekly one, sometimes a separate weekly window for a particular model. To know
where I stood I had to open each tool, type `/usage` and do the maths in my head: at
this pace, will the weekly limit last until the weekend? On top of that I don't work on
one machine. There is a laptop, a few remote dev environments and some containers, and
the same subscriptions are signed in on several of them.

I wanted one page that answers the questions I actually have:

- how much is left in each window, and when does it reset;
- am I spending faster than I planned for this week;
- what did the last few days look like.

I looked around first. What I found either lives on a single machine (the dashboard
started out reading from [CodexBar](https://github.com/steipete/CodexBar), a nice macOS
menu-bar app), or wants your provider tokens or browser cookies so it can call the
providers' APIs for you. The first didn't match how I work, and I didn't want to do the
second. So I wrote Quotum.

## How it works

There are two parts:

- **The agent** is a small native program (Rust, a single binary of about 3 MB). It
  runs on each machine where you use coding agents and asks their own command-line
  clients for the limits, the same numbers you see when you type `/usage`. It doesn't
  read tokens, make model requests or call provider APIs itself: the client does
  exactly what it does when you use it.
- **The hub** is a small web service (Node.js and SQLite) with the dashboard. Agents
  send it what they measured; it keeps the history and draws it.

```
 laptop ──┐
 dev VM ──┼── quotum agent ── HTTPS ──►  hub  ──►  dashboard
 box    ──┘   claude · codex · agy       SQLite
```

If one subscription is signed in on several machines, they don't all measure it. The hub
puts one machine on duty per subscription (preferably the one you're working on), the
others wait, and duty moves on when that machine goes quiet.

The agent also works on its own: run `quotum` and it prints the limits of this machine.

```
$ quotum
                                   left  resets
Codex pro     weekly                 4%  in 3d 16h
Claude max    5 hours               98%  in 4h 27m
              weekly                89%  in 5d 9h
              Fable weekly         100%  in 5d 9h
Antigravity   Gemini 5 hours       100%  in 4h 59m
              Gemini weekly         96%  in 1d 3h
```

## What the dashboard shows

- **A card per subscription**, one meter per window: green above 30%, amber at 30% and below,
  red under 10%. A tick on the meter shows where your spending plan expects you to be
  right now.
- **A weekly spending plan.** By default you spend 30 / 25 / 15 / 15 / 10 / 5% on the
  six days after the reset, and the seventh is a rest day. Each subscription can have
  its own plan.
- **One chart of all windows** over 24 hours, 7 or 30 days, with the plan and the next
  resets drawn ahead of now.
- **A table with a forecast:** at the current pace, does the window run out before its
  reset (or before your rest day), and roughly how much will be left.
- **Reset announcements** from the community trackers [Codex Resets](https://codex-resets.com)
  and [claude-resets.com](https://claude-resets.com), with a link to the source. You
  can turn them off.
- **Boards.** Everyone has a personal board. Shared boards let a team see each other's
  limits; people join by an invite link.

The interface is available in English and Russian.

## What I paid attention to

It's a pet project, but I wanted a tool I'd be comfortable running on every machine all
day, not a script thrown together over a weekend. In practice that meant:

- **It stays out of the way.** The agent idles at about 5 MB of memory. The expensive
  part is starting an agent's client (around a second of CPU and 100–230 MB of memory
  for that second), so Quotum starts as few of them as it can. They run one at a time,
  every two minutes by default. When nothing changes and nobody uses a client, that
  client is measured less often, down to once every 15 minutes. And only one machine
  measures each subscription.
- **Your credentials stay where they are.** Quotum never reads, stores or sends provider
  tokens or cookies. What leaves the machine: percentages, reset times, plan names and a
  one-way hash of the account id, so the hub can tell two machines share one account
  ([details](spec/ingest-v1.md#privacy)).
- **The numbers mean what they say.** Only a real increase inside one reset window
  counts as spending. Resets, corrections and gaps in the data never show up as
  consumption. The agent says when its next measurement is due, so a sparse series isn't
  mistaken for a gap.
- **Few moving parts.** The agent has a handful of dependencies. The hub is Fastify and
  the SQLite built into Node, and the UI is plain React with about 90 KB of gzipped
  JavaScript. There are no external services and no telemetry.
- **Written down and tested.** The protocol between the agent and the hub is a spec
  ([spec/ingest-v1.md](spec/ingest-v1.md)). About 75 tests cover the spending rules,
  resets, duty, device pairing and the translations. The TypeScript is strict and the
  Rust passes `clippy`.

## Status

It works: I use it every day. For now you build it from source. `npx quotum`, installers
and a desktop app are next ([roadmap](#roadmap)).

- Clients: Claude Code, Codex CLI, Antigravity CLI (`agy` 1.1.11 or newer).
- Platforms: I run it on Linux. The agent is written for macOS and Windows too, but
  they haven't had much use yet — issues are welcome.

## Getting started

You need Node.js 24+ for the hub and Rust 1.85+ to build the agent.

**1. Start the hub.**

```sh
git clone https://github.com/padurets/quotum && cd quotum/hub
npm ci && npm run build
npm start                     # http://127.0.0.1:8080
```

Open it and create an account. The first account becomes the admin.

**2. Build the agent and look at this machine.**

```sh
cd ../agent && cargo build --release
./target/release/quotum       # measures once and prints a table
```

**3. Connect the machine to the hub and keep it measuring.**

```sh
./target/release/quotum connect http://127.0.0.1:8080
./target/release/quotum run
```

`connect` shows a code: confirm it in the browser and pick a board. `run` keeps
measuring and delivering, so start it the way you run background programs (a systemd
user service, launchd, Windows autostart).

**Many machines at once** (images, VMs, containers): create a board token in the
dashboard (*Devices → Connect*), then start every machine with it. Each one shows up on
the board by itself:

```sh
quotum run --hub https://quotum.example.com --token qt_b_… [--owner alice]
```

Machines connected with a board token belong to whoever created the token. If several
people share one token, `--owner` says whose machine it is: a board member's email links
it to that member, any other name is shown as given.

## Configuration

### Agent

Everything is optional. On Linux the file is `~/.config/quotum/config.toml`;
`quotum config` shows where it is on your system and what is in effect.

```toml
interval = 120          # seconds between two measurements of one client, at least 60
eco = true              # measure less often while nothing changes
owner = "alice"         # whose machine this is, with a shared board token

[machine]
name = "work-laptop"    # how the machine appears on the hub (default: host name)

[hub]
url = "https://quotum.example.com"
token = "qt_b_…"

[providers.antigravity]
interval = 300
account = "work"        # tells two Antigravity subscriptions apart (agy doesn't say which one it is)
# enabled = false
# path = "/opt/agy/bin/agy"
```

The environment variables `QUOTUM_HUB_URL`, `QUOTUM_HUB_TOKEN`, `QUOTUM_OWNER`,
`QUOTUM_INTERVAL`, `QUOTUM_CONFIG` and `QUOTUM_STATE_DIR` override the file. Other
commands: `quotum --json` (one measurement in the ingest format), `quotum --only codex`,
`quotum disconnect`.

### Hub

| Variable | Default | Meaning |
|---|---|---|
| `QUOTUM_BIND` | `127.0.0.1` | Address to listen on |
| `QUOTUM_PORT` | `8080` | Port to listen on |
| `QUOTUM_ALLOWED_HOSTS` | `127.0.0.1,localhost` | Host names the hub answers to; other hosts get 403 |
| `QUOTUM_PUBLIC_URL` | taken from the request | The address shown to agents and used in invite links |
| `QUOTUM_DATA_DIR` | `./data` | Where the SQLite database lives |
| `QUOTUM_SIGNUP` | `invite` | `open` lets anyone sign up; otherwise only the first person and people with an invite |
| `QUOTUM_INGEST_TOKENS` | — | Static tokens (16+ characters) that deliver to the first user's board: handy when the hub and one agent run side by side |
| `QUOTUM_FRAME_ANCESTORS` | — | Extra origins allowed to embed the dashboard |

If other people or machines reach the hub over a network, put it behind HTTPS (a
TLS-terminating proxy is fine): sessions are cookies and tokens are bearer secrets.

## More

- [docs/architecture.md](docs/architecture.md): how the parts fit, how measuring and
  scheduling work, people, boards and devices.
- [spec/ingest-v1.md](spec/ingest-v1.md): what the agent sends to the hub; anything can
  implement it.

Project layout:

```
agent/crates/core     adapters for each client, schedule, settings, delivery to the hub
agent/crates/cli      the `quotum` command
spec/                 the protocol between the agent and the hub
hub/server/domain     the rules: windows, spending, resets, ingest format
hub/server/store      SQLite: layout, measurements, people and devices
hub/server/*.ts       HTTP API, ingest, duty, device pairing
hub/ui                the dashboard (React), translations in hub/ui/i18n
```

### Adding a language

The dashboard's text lives in `hub/ui/i18n`. Copy `en.ts` to a new file, translate
the strings, and add one line to `LOCALES` in `index.ts`. `npm test` checks that every
key is translated, the `{placeholders}` match and plural forms exist for every form
your language has.

## Roadmap

1. A team view on shared boards: people × providers at a glance.
2. One-line start: `npx quotum`, `curl … | sh` and PowerShell installers, autostart.
3. A desktop app (Tauri) with the agent and the dashboard in one window and a tray
   icon, no server needed.

## Credits and license

Thanks to [CodexBar](https://github.com/steipete/CodexBar) for showing the way and for
being the first data source of this dashboard, and to the people behind
[Codex Resets](https://codex-resets.com) and [claude-resets.com](https://claude-resets.com).
Provider icons come from [LobeHub Icons](https://github.com/lobehub/lobe-icons). Quotum
is not affiliated with Anthropic, OpenAI or Google.

MIT, see [LICENSE](LICENSE). Third-party notices are in [NOTICE.md](NOTICE.md).
