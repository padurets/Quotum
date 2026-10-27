# Local provider hooks

Quotum can run trusted local programs to collect a provider's measurements or react
to a completed collection. Configure them in the agent's `config.toml`. These programs
run with your operating-system permissions. They are not sandboxed.

```toml
[providers.codex.hooks.collect]
path = "/usr/bin/python3"
args = ["/home/me/bin/collect-codex.py"]

[providers.codex.hooks.on_collected]
path = "/home/me/bin/export-measurement"

[providers.codex.hooks.on_collection_failed]
path = "/home/me/bin/report-failure"
```

The three optional hooks are independent. `collect` replaces only that provider's
native measurement adapter; failure never falls back to a native client. Observers
also work with native collection. The available provider keys are `claude`, `codex`
and `antigravity`. A command has an absolute executable or interpreter `path` and an
optional `args` array of up to 32 literal arguments, each at most 4096 bytes. There
is no shell expansion. `.cmd` and `.bat` files require an explicitly selected
interpreter. Unknown configuration fields and hook names are rejected.

`providers.<provider>.path` and `clients.<client>.path` still select the native client
for installation discovery and activity tracking. Hook accounts do not become native
login evidence or change which client sessions are attributed to a subscription.
The desktop app preserves hook settings when saving other preferences. It exposes
account outcomes read-only; neither the web dashboard nor IPC installs commands.
The provider summary follows local result event order, including results sharing one
batch completion time; the account disclosure retains each account independently.

## Process contract

Each collector invocation reads one UTF-8 JSON request from stdin, followed by EOF, and writes
one JSON object to stdout before exiting successfully. Version 1 uses camelCase;
unknown fields are rejected. The collector has a 60-second deadline and 256 KiB input
and output limits. Its stderr is discarded. The process starts at low priority in a
neutral working directory, with `QUOTUM_*` environment variables removed. No hub
credentials, config paths or raw native-client replies are included in the request.

Measurement processes run one at a time. A collect invocation receives all admitted
due accounts of its selected provider in one batch. The coordinator continues control-plane
contact and activity delivery while a collection runs. Shutdown or a learned policy
restriction cancels running work. Results are checked against the launch's immutable
account, policy epoch and command before they are delivered. Process groups on Unix
and a Job object on Windows clean up children. A bounded command fails if Windows
cannot attach its Job object. Deliberately escaping those
mechanisms is outside this trusted-code contract.

## Account identities

Only these provider-specific forms are accepted:

| Provider | Identity |
| --- | --- |
| Claude | `{"email":"one@example.com","organization":"Example"}` |
| Codex | `{"accountId":"provider-stable-account-id"}` |
| Antigravity | `{"accountName":"work"}` or `{"accountName":null}` |

Required strings are nonempty, control-free and at most 120 characters. Claude's
organization may be empty. Antigravity's `accountName` field is required even when
null: that is a known unnamed default account, with the same source as native
Antigravity without a configured name. The name `"default"` is a different account.
Names compare after trimming and lowercasing. Supplier identities are hashed with
the native pseudonym function before delivery; raw email and account IDs stay local.

## Discovery

The same collector first receives:

```json
{"version":1,"action":"discover","provider":"codex"}
```

It returns the complete list of accounts it can measure, at most 16:

```json
{"version":1,"accounts":[{"identity":{"accountId":"one"}},{"identity":{"accountId":"two"}}]}
```

A successful empty list withdraws this device's membership for the provider. A failed
or malformed discovery retains the previous membership and suspends new collection
until discovery succeeds. Duplicate canonical identities invalidate the whole list.
Discovery repeats on the configured provider interval, with bounded failure backoff.

Membership is independent of which accounts are due. Removing an account withdraws
this device's association and duty; it does not delete the account's history.

## Collection

When an account is due and the device has permission to measure it:

```json
{"version":1,"action":"measure","provider":"codex","accounts":[{"identity":{"accountId":"two"}}]}
```

Return one result for every requested account:

```json
{"version":1,"results":[{"identity":{"accountId":"two"},"status":"observed","observedAt":"2026-10-26T12:00:00Z","plan":"pro","windows":[{"id":"session","kind":"session","minutes":300,"usedPercent":12.5,"resetsAt":"2026-10-26T17:00:00Z"}]}]}
```

There are three exclusive result forms:

- `observed`: a newly obtained observation, even if its values equal the previous
  observation. Include `observedAt`, `windows`, and optionally `plan`, `resets`,
  `resourceStatus` and `balances` as described below. Do not invent a fresh timestamp
  for retained data. A timestamp more than 30 seconds in the future is rejected.
- `no_new_data`: only `identity` and `status`. The attempt finished without a new
  observation. Retained values and their timestamps, availability and history remain
  unchanged. A matching refresh finishes as **No new data**; collection follows its
  normal interval without a failure backoff or immediate retry.
- `failed`: `identity`, `status` and `error`, one of `not_installed`, `not_logged_in`,
  `unsupported`, `timeout`, `invalid_output` or `failed`. Free-text errors are not
  accepted.

For example:

```json
{"version":1,"results":[{"identity":{"accountId":"one"},"status":"no_new_data"},{"identity":{"accountId":"two"},"status":"failed","error":"timeout"}]}
```

Results are independent by account. A missing, duplicated or malformed requested
result fails that account. An unrequested or unrecognizable identity produces a safe
local diagnostic and never creates an account. Invalid envelope JSON or version fails
the whole invocation. The program cannot choose a pseudonym, producer metadata,
`staleAfterMs`, or a hub command context.

### Resources

Resources match [ingest v1](../spec/ingest-v1.md). They do not add provider APIs:

- Up to 32 windows, with unique nonempty `id`, `kind` (`session`, `weekly`, `other`),
  finite `usedPercent` from 0 to 100, optional positive integer `minutes`, `label`
  and RFC3339 `resetsAt`.
- Optional `resets`: integer `available` from 0 to 1000 and up to 50 `expiring`
  groups. Each group has a positive `count` and optional RFC3339 `expiresAt`.
  Counts sum to at most available; expiry times are unique and increasing, with an
  unknown expiry last. Zero is a confirmed observation.
- Identified Codex may include `resourceStatus.windows` and `.resets`, each
  `observed`, `missing`, `unsupported` or `invalid`. `observed` means its numeric
  payload is present; other statuses mean it is absent. Empty windows are valid with
  these explicit statuses, including a credits-only observation.
- Only Codex accepts `balances`, at most one, with `id: "balance:credits"` and
  `unit: "credits:codex"`. Its `status` is `finite`, `unlimited`, `missing`,
  `unsupported` or `invalid`. Only `finite` has `amount`, an exact decimal string
  with at most 18 significant fractional places and a coefficient at most signed
  64-bit maximum. No float conversion or rounding is performed. Optional
  `hasCredits` is a boolean.

Omitted resources keep the existing native semantics. Explicit missing ends their
availability without inventing zero. Timestamps, nested fields and limits are
validated before normalization.

## Observers

An observer receives one normalized event per account, after local admission,
independently of hub delivery. Its account reference contains the supplier pseudonym
or an Antigravity name, never the raw supplier identity:

```json
{"version":1,"event":"on_collected","provider":"codex","account":{"account":"0123456789abcdef01234567"},"attemptId":"12345678-1234-4234-8234-123456789abc","completedAt":"2026-10-26T12:00:01Z","measurement":{"observedAt":"2026-10-26T12:00:00Z","plan":"pro","windows":[{"id":"session","kind":"session","minutes":300,"usedPercent":12.5}]}}
```

`measurement` contains normalized resources and their timestamps. A native success
without a known identity uses `account: null`; a previous identity is never inferred.
Known unnamed Antigravity uses `account: {"accountName":null}` instead.

A failed attempt uses `event: "on_collection_failed"` and, instead of `measurement`,
`error: {"code":"timeout","stage":"measure"}`. A discovery failure produces one
provider-level event with `account: null` and `stage: "discover"`. It does not fail
every retained account. Partial-resource observations produce one success event.
`no_new_data` and cancellation produce no observer events.

One worker handles a FIFO queue of 32 events without blocking the coordinator. Each
observer gets one attempt, a 10-second deadline, 256 KiB stdin and 16 KiB stdout;
stdout and stderr are discarded. Overflow or process errors produce fixed local
codes, not measurement failures, and never invoke another observer. There is no
persistent observer outbox, retry or replay. Normal one-shot exit gives the entire
queue a shared 10-second grace period. Explicit stop cancels it immediately. Provider
policy changes also cancel queued and running discovery-failure observers when the
provider has not discovered any accounts yet.

A collector connected to a hub requires that hub to advertise `accountRosters: 1`
and `collectionCompletions: 1` in its normal check-in reply. Missing support is an
explicit upgrade error, not an offline or native fallback mode.
