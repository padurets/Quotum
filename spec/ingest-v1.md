# Ingest format v1

How an agent connects to a hub, asks whether to measure, and delivers measurements.
Anything may implement it; the reference implementation is `agent/` (Rust).

## Tokens

A hub organizes data in **boards** (a person's own, or a shared one). An agent
delivers with one of:

| Token | Prefix | How it is obtained | Who the device belongs to |
|---|---|---|---|
| Device token | `qt_d_` | One-time code confirmed by a signed-in person ([below](#connecting-with-a-one-time-code)) | That person |
| Board token | `qt_b_` | Created on the board by a member, shown once; meant for images, VMs, containers | The declared `owner`, else the token's creator, see [Owner](#owner) |

With a board token a machine joins the board on its first batch; its `machine.id`
identifies it from then on. A device removed from the board cannot come back with
the same board token; revoking a board token disconnects every device that joined
with it.

## Request

```
POST /v1/ingest
Authorization: Bearer <device token>
Content-Type: application/json
```

```json
{
  "version": 1,
  "agent": "quotum/0.1.0",
  "machine": {"id": "3f9a…", "name": "workstation", "os": "linux", "arch": "x86_64"},
  "owner": {"name": "alice"},
  "sentAt": "2026-09-22T18:43:45.120Z",
  "snapshots": [
    {
      "provider": "claude",
      "account": "9c1e5a0b7d2f4e6a8b0c1d2e",
      "plan": "max",
      "observedAt": "2026-09-22T18:43:44.870Z",
      "via": "claude-code/get_usage",
      "client": "2.1.280",
      "staleAfterMs": 204000,
      "windows": [
        {"id": "session", "kind": "session", "minutes": 300, "usedPercent": 5, "resetsAt": "2026-09-22T20:20:00.921Z"},
        {"id": "weekly", "kind": "weekly", "minutes": 10080, "usedPercent": 10, "resetsAt": "2026-09-28T06:00:00Z"},
        {"id": "weekly:fable", "kind": "weekly", "minutes": 10080, "label": "Fable", "usedPercent": 0, "resetsAt": "2026-09-28T06:00:00Z"}
      ]
    }
  ],
  "failures": [
    {"provider": "antigravity", "observedAt": "2026-09-22T18:43:52Z", "error": "not_logged_in", "detail": "…"}
  ]
}
```

Timestamps are RFC 3339 strings. Optional fields may be omitted or `null`.

**Limits.** Text fields (names, ids, labels, plan, versions) are 1 to 120 characters.
A batch holds at most 500 snapshots and 500 failures, a snapshot at most 32 windows. A
hub refuses a batch that breaks any rule of this format whole, so an agent should make
what it sends fit (the reference agent trims and cuts before sending).

**Clocks.** `sentAt` is the agent's clock at sending. When it differs from the hub's by
more than 30 seconds, the hub moves every time of the batch by the difference, so a
machine with a wrong clock still lands in the right place.

### Machine

| Field | Meaning |
|---|---|
| `id` | Random id generated once per installation. Not derived from hardware. |
| `name` | Display name, the host name by default (configurable). |
| `os`, `arch` | As reported by the agent's runtime (`linux`, `macos`, `windows`; `x86_64`, `aarch64`). |

### Owner

Optional; used only with a board token. `{"name": "…"}` is whom the machine measures
for, as the person running the agent configured it (`--owner`, `owner = …`). A name
that is a board member's e-mail makes the device that member's; any other name is shown
as given. Without a name the device belongs to whoever created the token — so a person
uses their own token for their machines, and a token shared by several people goes
with `--owner`. With a device token the owner is ignored: the device already belongs to
the person who confirmed its code. The hub never derives owners from what the clients
report.

### Snapshot

One successful measurement of one provider account on one machine.

| Field | Meaning |
|---|---|
| `provider` | `claude`, `codex` or `antigravity`. |
| `account` | Pseudonym of the account: the first 24 hex characters of `sha256("quotum/account/v1\n<provider>\n<stable account id, trimmed, lower-case>")`, see [Stable account ids](#stable-account-ids). The same account on two machines gets the same pseudonym. Absent when the client does not say which account it is (Antigravity); see [Subscriptions](#subscriptions). |
| `accountName` | For a client that does not identify its account: a name the owner gave this subscription, to tell two of them apart. |
| `plan` | The provider's plan name (`max`, `pro`), if reported. |
| `observedAt` | When the client answered. |
| `via` | How the value was obtained (`claude-code/get_usage`, `codex/app-server`, `agy/usage`). |
| `client` | Version of the agent's client that answered. |
| `staleAfterMs` | How long this measurement stays representative. The agent promises the next measurement of this provider before then; a later one is a gap. At most 24 h. |
| `windows` | At least one window. |
| `resets` | Free resets of the limits the account holds, if the client reports them: `{"available": 1, "expiresAt": "2026-10-22T12:52:01Z"}` (`expiresAt`: when the first of them expires, if known; `available` at most 1000). Only reported, never used. |

#### Stable account ids

| Provider | Stable id | Where it comes from |
|---|---|---|
| Claude | `<email>/<organization name>` | `initialize` of Claude Code (the same values its `~/.claude.json` keeps as `oauthAccount`) |
| Codex | the account id | `account/rateLimits/read` of `codex app-server` |
| Antigravity | — | `agy` does not say; see [Subscriptions](#subscriptions) |

Example: Claude's `user@example.com` in the organization `Example` is
`sha256("quotum/account/v1\nclaude\nuser@example.com/example")`, pseudonym
`73d68562e0a4449082684fee`. A pseudonym keeps the id itself off the hub, but it is not
a secret: whoever knows or guesses an id can compute its pseudonym and recognise it.

### Window

| Field | Meaning |
|---|---|
| `id` | Stable within the provider and unique within the snapshot: `session`, `weekly`, `<scope>:<kind>` (`weekly:fable`, `gemini:session`), `window-<minutes>` for other lengths, `window` when the length is unknown. |
| `kind` | `session` (5 hours), `weekly`, or `other`. The hub keeps it as given. |
| `minutes` | Window length, if known; greater than 0. |
| `label` | The provider's name for the scope of the window (a model or model group), if any. |
| `usedPercent` | 0–100, share of the window already used. |
| `resetsAt` | When the window resets, if known. An idle rolling window reports "now + length". |

### Failure

A measurement that did not succeed. `error` is one of `not_logged_in`, `unsupported`
(the client cannot report plan limits: too old, API-key login), `timeout`,
`invalid_output`, `failed`, `not_installed`. `detail` is free text for people, at most
200 characters. The reference agent does not report clients that are not installed.
A hub shows a failure only once the subscription has had no good measurement for as
long as the last one stays representative: another device may be measuring it fine.

### Subscriptions

The hub files snapshots under *subscriptions* of the board: by `account` when the
client names it (one account measured on many machines is one subscription), else as
the owner's own subscription of that provider (plus `accountName`, if given), never
per machine. The same keys decide duty in check-ins.

## Response

`200` with `{"accepted": n, "duplicates": n, "failures": n, "device": {"id": …, "owner": …}}`.
A snapshot the hub already has (same account, not newer than the last one) counts as a
duplicate, so resending a batch after a lost answer is safe.

| Status | Meaning | Agent behaviour |
|---|---|---|
| `400` | The batch does not match this format (`{"error": "invalid_batch", "detail": "<field>"}`) | Drop it |
| `401` | Unknown or revoked board token | Keep the data, retry later, less and less often |
| `403` | `device_revoked`: this device was removed from the board. `device_conflict`: the machine is connected to the board with a code already, and a board token cannot take it over | Stop: nothing will be accepted from it again |
| `413` | Body too large | Drop it |
| `5xx`, network errors | Hub unavailable | Keep the data, retry later, less and less often |

Errors always come as `{"error": "<code>"}`, never with internal messages.

## Asking whether to measure

The same subscription is often signed in on several machines. Before measuring, an agent
asks the hub whether it is on duty for it; the hub lets one device per subscription
measure and tells the others when to ask again.

```
POST /v1/checkin
Authorization: Bearer <token>
```

```json
{
  "version": 1,
  "agent": "quotum/0.1.0",
  "machine": {"id": "3f9a…", "name": "workstation", "os": "linux", "arch": "x86_64"},
  "owner": {"name": "alice"},
  "subscriptions": [
    {"provider": "claude", "account": "9c1e5a0b7d2f4e6a8b0c1d2e", "active": true},
    {"provider": "antigravity", "accountName": "work", "active": false}
  ]
}
```

`machine` and `owner` are as in a batch; `account` and `accountName` are as in a
snapshot, as far as the agent knows them before measuring. `active` says whether someone
is using that client on this machine right now. At most 16 subscriptions.

`200` with, in the same order:

```json
{"subscriptions": [
  {"provider": "claude", "measure": true, "until": "2026-09-22T18:43:45Z"},
  {"provider": "antigravity", "measure": false, "until": "2026-09-22T18:52:10Z"}
]}
```

`measure: true` means measure now and deliver. `measure: false` means another device is
on duty: don't measure this subscription before `until`, then ask again. The device on
duty keeps it while it delivers; a device where someone is working takes over from a
holder that has been idle for a while; a holder that stops delivering loses duty when
its last measurement goes stale; asking again does not extend a holder's time, only
delivering does. Errors are as for ingest (`400 invalid_request`, `401`, `403`). An agent
that cannot reach the hub, or gets any other answer, measures anyway: at worst two
devices measure the same subscription for a while.

## Connecting with a one-time code

The OAuth 2.0 device authorization flow (RFC 8628) with JSON bodies:

1. `POST /v1/device/code` with `{"machine": {…}, "agent": "quotum/0.1.0"}` →
   `{"deviceCode", "userCode": "HVJG-XS8V", "verificationUri", "verificationUriComplete", "expiresIn": 600, "interval": 5}`,
   or `429 {"error": "too_many_attempts"}` when one address asks for too many codes.
2. The agent shows `userCode` and `verificationUriComplete`; a signed-in person opens it,
   sees the machine and picks a board.
3. The agent polls `POST /v1/device/token` with `{"deviceCode"}` every `interval` seconds:
   `400 {"error": "authorization_pending" | "slow_down" | "access_denied" | "expired_token"}`
   until `200 {"token": "qt_d_…", "device": {"id", "name", "owner"}, "board": {"id", "name"}}`.
   A code gives one token; `slow_down` asks to poll 5 s less often.

## Privacy

What never leaves the machine: provider tokens, cookies, account ids and emails,
prompts, file contents, file paths.

What is sent: the pseudonym of each account, the plan name, percentages and reset times
of the windows, free resets, the client's version, the machine's random id, its name
(the host name unless configured) and operating system, the owner name and
subscription names if configured, and for a failed measurement its kind and a short
message of the client (at most 200 characters).
