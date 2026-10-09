# Dashboard events v1

How an open dashboard hears what changes on its board: the hub pushes it. The page asks
for a board's events once, gets the board as it is, then only the parts that change, as
soon as they change; between changes neither side does anything for it but a heartbeat.
The page and the hub ship together, so this is not a contract across versions: a page of
another build reloads (see [hello](#events)). The reference implementation is `hub/`.

## Asking for events

```
GET /api/events?board=<id>
Quotum-Stream: 1
```

A text/event-stream of one board for the signed-in reader. `board` may be left out: the
reader's first board is taken, as everywhere else. The session cookie authenticates it,
as it does every `/api/*` request.

```
GET /api/events?board=<id>&mode=poll[&lease=<id>]
Quotum-Stream: 1
```

The same events as long polls, for where a proxy holds a stream back. See [Long polls](#long-polls).

Before a stream or a poll starts, the hub answers an error as JSON, checking in this
order for both:

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | No session. |
| 403 | `forbidden_origin` | No `Quotum-Stream: 1` header; or an `Origin` that is not the hub's; or a `Sec-Fetch-Site` other than `same-origin`. |
| 404 | `board_not_found` | No such board, or the reader is not on it. |
| 429 | `too_many_streams` | No room for another reader (see [Limits](#limits)). |

Any other answer (a `500` when the hub cannot work out the board, a proxy's error) is
tried again later.

No link, frame or cross-site request can set `Quotum-Stream`, while the page's own
`fetch` does without a preflight: so only the hub's page takes a reader's place, also on
plain http, where browsers send no `Sec-Fetch-Site`. `HEAD` opens nothing.

A stream is answered `200` with `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-store`, `X-Accel-Buffering: no` and `Connection: close`, besides the
security headers of every answer.

## Measuring frequency

`POST /api/boards/:board/sources/:source/frequency` accepts exactly
`{"intervalMs": null | 60000 | 120000 | 300000 | 900000}`: Auto, 1, 2, 5 or 15 minutes.
The value belongs to the subscription across the hub and survives restart. Every reader
sees it, but only a current holder (whose devices measure the subscription) may change
it. Board ownership alone grants no right; any of several holders may write, with the
last accepted write winning. The route is available in the desktop's local hub too.

The usual Host, Origin and session checks apply. A missing session is `401`; an
inaccessible board is `404 board_not_found`; a source absent from that board is
`404 not_found`; a reader who no longer holds it gets `403 frequency_forbidden`.
Missing or extra fields, arrays and values of another type or outside this set are
`400 invalid_request`. Successful writes return `200 {"ok":true}`. Repeating the same
value does not replan or publish anything. The HTTP reply carries no state: snapshot,
card and cadence events are authoritative, so a late reply cannot revert a newer choice.

A card includes `measureIntervalMs` with the values above, separately from its data
freshness and the board's view. The `cadence.why` set also includes `fixed`; its `next`
is the effective permitted time, respecting the device minimum. Stale data can still
have a next measurement and reason. A frequency write reaches all boards that show the
source through the existing events, without polling or changing the agent protocol.

## Adding widgets and saving views

`GET /api/boards/:board/catalogue` requires membership. It returns the board,
`viewRevision`, `connectionsRevision`, registered connectors, and only sources and
standard widgets this reader can add or show. Sources are the reader's holdings and
data already provided to this board; another member's private sources are absent.
Visible and forbidden entries are omitted. Members may add or show their own cards;
only the board owner may show another member's hidden card or add a standard widget.

`POST /api/additions` reserves an owner-scoped UUID `requestId`, a frozen `boardId`
(null for personal connection or replacement), and one item:
`{kind:"sources", sourceIds:[...]}`, `{kind:"widget", widgetId}`,
`{kind:"connection", provider, account?: {kind:"new"} | {kind:"existing", id}}`, or `{kind:"replace", credentialId}`.
Source selections contain one to 100 unique IDs. Standard widgets are `agents`,
`activity`, `quota-history`, `subscription-funds`, `budget-history`, `quota-table`, `budget-table`. Replacement is personal; the server captures its
provider, source and access revision. Reusing a request ID with another destination or
selection returns `409 addition_conflict`. No secret goes into reservation or storage.

`POST /api/additions/:id/run` accepts optional `secret`, `accountName`,
`allowUnknownExpiry` and `sameAccount` fields. Provider verification
happens outside SQLite, with a 25-second deadline. Before committing the hub checks
the original session, membership, holdings, operation generation and replacement
revision again. Encrypted access, source, holding, initial measurement, sharing,
visibility and the complete receipt commit in one transaction. An own existing account
reuses its access; new key bytes never implicitly replace its saved key. Source batches
are all-or-nothing. Personal connection does not change a shared board or an existing
hidden card. No-expiry access is admitted without another checkbox or submit.

For a declared new account, its free name is supplied only with the secret in
`accountName`; it is validated against that secret before persistence and never enters
the ledger item. Existing declared identities are owner-scoped. Unknown expiry requires
`allowUnknownExpiry: true`, and replacement or existing-account selection requires
`sameAccount: true` for declared providers. OpenRouter's confirmed no-expiry access
needs no additional expiry submission. Receipts include the truthful `expiryKind`.

Concurrent requests may share provider verification, but each waiting request's session
is checked before returning its private result. A revoked session receives
`403 addition_permission` (`401 unauthorized` through legacy credentials APIs).
Another authorized request's committed result remains intact.

`GET /api/additions/:id` is owner-only; another owner's ID and an unknown ID both give
`404 addition_not_found`. `GET /api/additions?limit=20&before=<cursor>` discovers the
owner's recent unfinished and terminal receipts, with a maximum page size of 50 and
30-day retention. An optional UUID `requestId` looks up that owner's reservation.
Results include immutable safe items, timestamps, state, source IDs, optional own
credential ID and access revision, and current disposition per source or widget.
They never include a secret, ciphertext, raw supplier identity or inaccessible board
labels. States are `ready`, `verifying`, `needs_input`, `complete`, `failed`, `expired`.
Reservations expire after 24 hours, with at most 20 unfinished actions per owner.

Verification leases last 30 seconds across process restart. An expired lease becomes
`needs_input` and increments the generation; its late callback cannot commit. A key
not saved before interruption must be entered again. A completed operation returns its
receipt without verification or side effects, even after later hide, unshare, replacement
or removal. Replacement cleanup may report `credential_cleanup_pending` on a complete
receipt; this does not mean the replacement failed. The legacy replacement endpoint
accepts optional `requestId` and returns its operation ID for recovery.

Mutations require an explicit same-site Origin before parsing and owner authentication,
with 32-KiB bodies and ten key-verification attempts per minute per user and address.
Status and reservation have a separate bounded request limit. Credentials cannot be
submitted in a query. Closed panels do not poll or read catalogue/history data.

`POST /api/boards/:board/view` is owner-only and accepts the compact v3 view described
below, up to 76 KiB (77,824 UTF-8 bytes including JSON syntax). The independent
writer header `X-Quotum-View-Version: 3` is required, even when a previous page echoes
a received v3 view. Missing or incompatible writer headers return
`428 view_reload_required` without mutation; malformed or unsupported body
versions return `400 invalid_request`. `If-Match: "<revision>"` remains required:
missing is `428 view_reload_required`, malformed is `400 invalid_request`, and stale
is `409 view_conflict` with the authorized current `{view, revision}`.
Success returns `{view, revision}`. Semantic changes increment revision; no-op saves
do not. Snapshots and view events carry that revision.

Storage and POST use `[3, places, mask, ...fields]`; events, snapshots and conflict
responses use the semantic object with `version: 3`. Each place is `[id, geometry]`
or `[id, geometry, h]`, in reading order. Integer ids 0 through 6 stand for `agents`,
`activity`, `quota-history`, `budget-history`, `quota-table`, `budget-table`, `subscription-funds`; other ids
are unchanged strings (including the distinct string `"0"`). Geometry 0 through 9
indexes `(x,w)` pairs `(0,2),(0,3),(0,4),(0,6),(2,2),(2,3),(2,4),(3,2),(3,3),(4,2)`.
The array position restores `y`; vertical gaps are not persisted height requests.
The ten mask bits select nonempty `names`, `hidden`, `shown`, `windows`, `plans`,
`unplanned`, `colors`, `columns`, `shownColumns`, `enabledWhenEmpty`, in that order.
Omitted fields restore empty defaults. `shown` is `[builtinMask, ...otherIds]`, with
the same seven builtin bits; at most 204 other ids. Other owner fields keep their
ordinary types and limits. Duplicate place ids, invalid aliases, duplicate shown ids,
unknown mask bits and trailing fields are rejected. Decoded drafts must also fit
128 KiB before publication. Byte accounting for normal and keepalive saves uses the
actual encoded request; there is no separate quota for each representation.

The upgrade concatenates the visible reading orders of cards and analytics, then
weaves in saved hidden positions without changing the visible subsequence. It preserves
widths, requested heights and settings. Standard visible widgets become anchors;
implicit source cards still follow their preceding visible source in natural order.
Reads and new membership do not materialize every implicit place. Add, replay and
device-onboarding writes also require the current writer header.

The standard widgets are `agents`, `activity`, `quota-history`, `budget-history`,
`quota-table`, `budget-table` and `subscription-funds`. Each analytics replacement in `shown` is placed;
`hidden` takes precedence. Unplaced analytics become placed once their resource
capabilities appear, independently of filters, latest errors or zero balances. Placed
widgets remain when resources leave. `enabledWhenEmpty` applies only to explicit
`agents` and `activity` additions. New empty boards have no analytics placed and keep
activity hidden; any standard widget can be added explicitly to an empty board.

The schema upgrade converts legacy history/table placements atomically. Mixed boards
keep the quota pair at the old coordinates and append the budget pair after existing
analytics anchors. Money-only boards give the old coordinates to the budget pair.
Explicitly hidden legacy panels hide both replacements. Columns follow their family;
other source settings and geometry are retained. Reader-local modes never participate.
Runtime capability reconciliation produces one authoritative view/revision pair and
preserves the previous editor; a concurrent owner save receives the normal conflict.

Widget reservation and run/resume also require the writer header. Existing addition
items and request bindings remain immutable; legacy receipts carry frozen canonical
`widgetIds` and report `current.widgets` with their current placement. Replaying a
completed receipt never restores a subsequently hidden widget. Only a current client
may resume an interrupted legacy widget addition. Non-widget connection operations
retain their existing version-independent authorization.

The page serializes its own saves and flushes pending changes before Add. Ordinary
bodies retain the debounce; bodies above 64 KiB start an ordinary save immediately.
No oversized body uses keepalive, and outstanding view keepalives share a 64-KiB
budget. In a browser only, pending/failed oversized changes register the native close
warning until acknowledged or explicitly discarded; navigation destroying the saver
waits for these writes. Board/settings navigation keeps the saver and its queue.
This is best-effort browser protection, not durability through forced termination.
Electron and Tauri use the same ordinary save limit and queue without a new browser
warning or change to native close/quit behavior. Save errors retain the existing
retry/discard flow; conflicts never silently reapply an old full document.

`POST /api/device-onboarding {requestId, boardId}` reserves a private device intent.
The existing token-create and code-approval routes accept optional `onboardingId`;
code redemption binds the exact device atomically. Ordinary CLI confirmation stays a
personal action. The owner may instead explicitly select an existing device.
`POST /api/device-onboarding/:id/selection {requestId, deviceId, sourceIds}` freezes
only a delivered subset of that live own device and links the same addition receipt.
Publishing that subset and completing the intent commit together. Neither later accounts
nor other devices become shared. Owner GET/list routes permit recovery for 30 days;
unfinished intents expire after 24 hours. Codes, tokens and provider secrets are absent
from these projections. Local desktop does not expose device onboarding.

## Frames

Each event is `event: <type>`, `data: <JSON>` and an empty line. There is no `id:`: the
hub reads no `Last-Event-ID`. Lines end with `\n`; a reader splits them at `\r\n`, `\n`
or `\r` only, as text/event-stream says, never at U+2028 or U+2029, which JSON leaves in
names as they are.

## Events

Every connection starts with `hello`, then `snapshot`, then the changes. Nothing is kept
of the past: a reader that connects again (after a dropped connection, a sleep, a restart
of the hub, a tab hidden for a while) gets the board as it is, and keeps what did not
change as it was.

| `event` | `data` | When |
|---|---|---|
| `hello` | `{epoch, now, client, heartbeatMs}` | First. `epoch`: when this start of the hub began, base 36. `now`: the hub's clock. `client`: the path of the page's entry script the hub serves (`/assets/index-<hash>.js`), null without a build. `heartbeatMs`: 25000. |
| `snapshot` | `{providers, sourceAccess, board, view, viewRevision, connectionsRevision, historyStart, sources, sessions, cadence, refresh, forecast, mine, boards, resets}` | Second: the board for this reader. |
| `board` | `{board: {id, name, personal}}` | The board was renamed. |
| `view` | `{view, revision}` | The board's view was saved. The monotonic revision belongs to this board. |
| `connections` | `{revision}` | Only this reader's connection structure or access health changed; no private IDs or labels. Successful measurements and unchanged device heartbeats do not increment it. |
| `devices` | `{}` | Only this reader's current device sessions changed. Invalidate an open Devices disclosure; no session fields, IDs, counts or names are sent. |
| `lineup` | `{sources: string[]}` | The board's sources, in order, changed. |
| `card` | a card | A source's state changed. |
| `sessions` | `{id, sessions}` | The agents running on a source, on the machines of its people on this board, changed. |
| `cadence` | `{id, cadence}` | When a source is measured next, or why, changed. |
| `refresh` | `{id, refresh}` | A source's refresh availability, request or cooldown changed. |
| `forecast` | `{id, forecast}` | Where the recent pace of the source's weekly windows leads, as the hub works it out, changed. |
| `mine` | `{sources: string[]}` | Which sources of the board the reader's devices measure changed. |
| `sourceAccess` | `{<source id>: {error, expiresAt, expiryKind, canRefresh, credentialIds}}` | The reader's own connector access changed, cleared when the holding or board access ends. |
| `boards` | `{boards}` | The reader's boards changed: made, deleted, renamed, joined, left. |
| `history` | `{sources: string[], since}` | History of these sources changed from `since`: a measurement or credited agent work (see [Reading history](#reading-history)); with `since` 0, all of the board's history reads otherwise: whose agents' work it shows, or under which names, changed (a card hidden or shown, someone joining or leaving, a project or a machine renamed). |
| `resets` | `{resets, trackers, past}` | The reset trackers' news changed. |
| `ping` | `{now}` | Every `heartbeatMs`, with the hub's clock. |
| `bye` | `{reason}` | Last: the hub lets the reader go (see below). |

The board's `view` includes `layout: {columns: 6, places: {<widget id>: {x, y, w, h?}}}`.
`x` is a column starting at zero, `y` a row starting at zero used for reading order.
Widths are 2, 3, 4 or 6 columns and starts are 0, 2, 3 or 4, with `x + w <= 6`. `h`, when
present, is the height in rows the owner chose for the widget, a whole number from 1 to
200 (`MAX_ROWS`); without it the widget is as tall as its content. The page measures the
content: a widget never takes fewer rows than the least its content can show (all of a card
or the table, a chart as tall as it draws by itself, the first agent of the list and how
many more), so `h` is what the owner asked for, not what shows, and the hub does not check
it against the content. A place has exactly `x`, `y`, `w` and, optionally, `h`; anything
else is refused. The hub migrates stored pre-grid views and split analytics IDs before
serving the view with its revision. Saves require the compact version 3 codec and
its writer header, with a 76 KiB UTF-8 body limit. The page uses keepalive only within its
aggregate 64 KiB budget; larger drafts use immediate serialized ordinary saves.
There is no separate count limit on places; each place is validated.

In a `snapshot`, `sources` are the cards of the board's sources in its order; `sessions`,
`cadence`, `refresh` and `forecast` are by source id, for those sources only. `board` is
`{id, name, personal}`; the reader's role is in `boards`, each `{id, name, personal,
role}`, as it is theirs alone. `resets` is what `GET /api/resets` answers. `historyStart`
is when the board's history begins as of the snapshot; `GET /api/history` tells it later.

`providers` is the public code-owned catalogue: each entry has `id`, `name`, `color`,
`logoAsset`, `order`, `measuredBy` (`client` or `hub`), `meterKinds`, `resets`, and either
`clientId` or `connectorId`. Monetary entries additionally declare `spending` and
`topups` (`counter` or `unavailable`) and `balances` descriptors with stable `meterId`,
`unit` and `role` (`total`, `granted` or `toppedUp`) under `monetary`.
It contains no credentials or user addresses. Readers use
an unknown id itself as its name and a neutral icon and colour; an unknown capability
does not imply quota notifications. Only providers with `window` capability contribute
to the percentage attention state, including a client source awaiting its first window.

A card is `{id, provider, plan, successAt, error, stale, windows, resets, owners,
staleAfterMs, measureIntervalMs}`: the source's last measurement (`successAt`, its
`windows` and free `resets`), the last error, the people on the board whose devices measure it, and how long
its numbers hold, and its shared measuring preference. `stale` is the hub's to say, and
it says so: a card sent when its numbers get too old.

A source's `sessions` are the agents running on it, on the machines of its people on the
board, each `{device, origin, project, folder, startedAt, lastWorkedAt, working,
workedMs}`: its machine (`{id, name}`), where it runs, its project as its person named it
and its folder where that is another, when it started and when an idle one last worked
(both on the hub's clock), whether it works, and how long it has worked: the hub's
credited work of an identified session on this current subscription across its contexts
(see [Reading history](#reading-history)), up to its machine's latest list and as long as
work is kept. `workedMs` is a finite nonnegative number, including known zero, or null
when reliable session identity is unavailable. Older hubs may omit it; the page treats
missing, null or invalid credit as unknown. A group with any unknown counter has an
unknown total, and unknown totals sort last in either direction. A list that credits work changes
`workedMs`, so `sessions` comes with each list while an agent works.

A source's `forecast` is by the id of each of its weekly windows (the page foresees a
five-hour window itself, by what it spent since it began): where the recent pace of that
window leads, the same subscription's window followed through its resets of any kind, as
the hub works it out once for every board. It is `{state, asOf, resetAt, anchor, F, zero,
shownZero, shownLeft, comfy, points, basis}`, worked out as of `asOf`:

- `state`: `runsOut` (it runs out before the reset), `lasts` (it does not), `needData`
  (under an hour of history to go by), `usedUp`, `awaiting` (the reset has passed with no
  sample since), `none` (no reset time known). A window whose working out failed is
  `none` with `failed: true`.
- `resetAt`: the reset of the window it is about. `anchor`: `{at, left}`, the sample it
  stands on; null for `none`.
- `F`: what is left at the reset, below zero when it runs out before. `zero`: when the
  line crosses zero, null when it does not. `shownZero`: the moment it says it runs out
  (moved only when `zero` moves by more than an hour or a fifth of the time to it,
  whichever is more).
  `shownLeft`: the share it says is left at the reset, a multiple of 5, for `lasts`.
  `comfy`: for `lasts`, whether that is "left" rather than "just enough" (held a day's
  worth of points either way). Moments are whole milliseconds.
- `points`: the line from the anchor to the reset, `[minutes from the anchor, left]`, not
  cut at zero; null with no line.
- `basis`: `{hours, cold, usualPerDay, lastDay, burst}`: how many hours of history it
  goes by; `cold` under a day of them; what the subscription usually spends a day; the
  last day against that (null while it goes by a straight line); `burst`, `{times, zero}`
  when the last six hours ran at least twice as fast as usual and would run out before
  the reset at that pace, else null. For `needData`, only `{hours}`; else null.

The first time after the hub starts, it is worked out on the latest sample, as of the
last whole hour if the sample came before it (or goes on as the hub kept it, if that took
the sample in). It is worked out again at the first moment of each hour after a sample
the forecast has not taken in (a few minutes after the whole hour, up to ten, the same
every hour for one subscription, but still as of the whole hour), and at once when a new
sample contradicts it: a window with too little history, one whose reset time has just
become known, back from zero, a new window begun, the used share dropping by 5 points or
more, the moment it said passing with something left, or a sample after an hour or more
without one (longer when the samples before were said to last longer). A sample come late
for the moment it stands on, another device's, works the same `asOf` out again. A window
whose card gives the answer at once (no reset time, a reset time passed, not begun, used
up, or a model's window while its subscription's weekly window is used up) waits for the
hour. The page decides what depends on its clock: the tone, the countdown, a moment
passed with no sample since it; and what the card says at once: used up, waiting for a
measurement, not begun. It shows "left" only with `comfy` and a `shownLeft` of 5 or more.
A weekly window's forecast is up to about 3 KB, so a frame holds about eighty weekly
windows.

Each event carries its part whole; the page puts it in place of what it had. What changes
at the same moment goes out together, in this order: `board`, `view`, the sources'
`card`, `sessions`, `cadence`, `refresh` and `forecast` (sources new to the board before
`lineup`), `lineup`, `mine`, `boards`, `history`, `resets`. A part goes out only when it
differs from what the reader last got; a change reaches the page within a tenth of a
second. What changes with time alone (a card going stale, a machine's list of agents no
longer shown, a holder falling silent, a forecast worked out again after the hour, a past
reset leaving the history) goes out when it does.

`bye` tells why the reader is let go, and the connection ends:

| `reason` | Why | What the page does |
|---|---|---|
| `unauthorized` | The session ended: signed out, a new password, expired. | Signs in again. |
| `gone` | The board was deleted, or the reader is no longer on it. | Opens another board. |
| `restart` | The hub stops, or could not work out the board. | Connects again in a few seconds. |
| `limit` | A newer reader took its place, or it fell 256 KiB behind. | Connects again, not sooner than in 30 seconds. |

## Reading the board period

`POST /api/boards/:board/period` is a read-only, authenticated, origin-checked operation.
The response is JSON with `Cache-Control: no-store`. Board access and visible source
capabilities are checked on every request; a cursor grants no additional access.
The body is at most 76 KiB:

```ts
{
  version: 1;
  selection: {mode: 'live'; periodMs: number} | {mode: 'range'; from: number; to: number};
  evaluatedAt: number;
  quota?: {cell: string; from: string; to: string; meters?: string; unit?: string; meta?: string; evidence?: string; cells?: 'skip'};
  budget?: {cell: string; from: string; to: string; meters: string; unit: string; currency?: string; meta?: string; evidence?: string; cells?: 'skip'};
  funds?: {cell: string; from: string; to: string; meters: string; unit: string; currency?: string; meta?: string; evidence?: string; cells?: 'skip'};
  values?: string[];
  sessions?: {cursor?: string};
}
```

Times are safe integer milliseconds. Period lengths are between fifteen minutes and
31 days, within retained history. `values` contains at most 2000 visible source ids.
The hub clamps `evaluatedAt` to its own clock. Live selects
`[evaluatedAt-periodMs,evaluatedAt)`; a fixed interval keeps its exact endpoints.
The evidence cut cannot extend into the future. Each history section keeps the existing
cell, selection and eight-tile limits below. `evidence` is its previously returned opaque
tape cursor; `skip` asks only for cells during progressive panning. Conversely,
`cells: 'skip'` reads the boundary tape while reusing already cached cells.

The response has a common `basis` and only the requested sections. A basis is
`{run, revision, evaluatedAt, evidenceCut, range: {from,to}}`. Each section is either
`{state:'complete', basis, value}` or
`{state:'error', error:'history_limit'|'history_range_invalid'|'unavailable'}`.
Sessions can additionally return `{state:'delta', basis, value}`. A section error does
not invalidate successful siblings. Authentication, invalid request shape and source
capability failures are HTTP errors. Clients retain the last complete presentation
under its own basis while a requested replacement is pending or failed.

The optional top-level `moneySemantics` dictionary shares identical monetary cell
semantics across the reply. Within each history section's `chunks[].meterSeries`,
`semantics`, a cell extra's `semantics` or `openSemantics`, and an observation's
`semantics` may be a zero-based index into that dictionary. Null remains unknown;
an omitted property still inherits as specified below. Expand indices before using
cells. Entries preserve the complete native amount, observation timestamp and
conversion provenance; no rounding or combination of observations is implied.
Within those monetary cell semantics (inline or in `moneySemantics`), a numeric
`conversion.rate` indexes the optional top-level `rateLegs` dictionary. A rate entry
retains every field of the original leg; `conversion.original` and additional `steps`
remain unchanged. Both dictionaries are scoped to this one reply.
Tapes, card values and the standalone history route retain their existing shape.

Quota, wallet budget and subscription-funds values contain the compatible history reply below and, unless skipped,
a `tape`. A tape contains exact native sample anchors and monetary readings, availability
spans, original allowances and recorded currency bindings. Native quota series also
carry `workFrom`, the source's authorized work boundary. An absent work section does
not project zero work or a fictional date; work columns remain unavailable until it arrives. Its `from` and `cut` delimit
retained evidence; `replaceFrom` and optional `replaceTo` delimit the interval replaced
by a delta. Each native series stores `samples` as a flat numeric array of five-value rows:
`[at, used, resetAt, staleAfterMs, validUntil]`. With `samplesEncoding:"delta"`,
all fields except `used` are exact differences from the previous row. The initial
values are `at=0`, `resetAt=-1`, `staleAfterMs=0`, `validUntil=-1`. Both optional
deadlines use `-1` for absence after decoding; zero is a real timestamp. The encoding preserves every sample and its
exclusive validity bound. Metadata is separate from repeated samples. A complete initial tape allows
a live left boundary to move through its entire retained interval without further IO.
New evidence extends or replaces that interval; a clock tick does not fetch history.
Partial spending steps keep their uncertainty instead of becoming proportional amounts.
Monetary tapes store repeated recorded exchange paths once in
`rateBindings: {paths, entries}`. Each `entries` key is the native unit, a newline and
the exact observation timestamp; its value indexes `paths`. A null path means an
unavailable conversion. Paths retain every rate leg and its recorded provenance.

A fixed selection replaces the rolling tape with `fixed: {range, cell, quota, money}`.
The quota and money arrays contain exact history-series totals and only the first and
last cells' observation geometry. Their interior cells come from the same history
reader and cache. The ordinary `quota` and `money` tape arrays are empty. A summary
applies only to its exact range and cell size; it cannot project another interval.
The server and browser use the same accounting functions, including original scales,
historical cap allowances, availability bounds and recorded currency provenance.

Values are measurement-only projections: source id/provider, retained native windows,
meters, keys and the observed `creditBalance` status when authorized. Native windows include `observedAt`, `validUntil` and `stale`.
Membership is the last nonempty retained batch strictly before the right edge. A meter
keeps exact decimal integer amounts, historical allowance, unit and conversion evidence.
The same financial grant and its observation anchor govern cells, tapes, values and
cursor reuse. Credit coefficients retain their original scale; converted values use
the recorded rate path. Native quota interruptions end availability exclusively.
Expired evidence remains visible as stale; an absent predecessor remains unknown.
An optional `validFor: {from,to}` gives the half-open interval of right-edge positions
with identical values, including membership, anchors and stale state. It is scoped to
the same authority and evidence revision. Fixed values may also carry `states`:
an optional full `start` projection, shared `paths` and `[from,to,changes]` pieces. Changes use
the exact replacement, deletion, integer delta and array splice operations of fixed shift windows.
Each piece retains its own `validFor` interval, including actual observations and
availability changes. Without `start`, replay starts from the value carrying the sequence;
the first patch reaches the first interval. A restored value retains that immutable
starting projection for subsequent replays. No numeric
interpolation or nested state sequences occur. Candidate lookup checks intervals
without allocating a replay; staging accounts for copies before they are built.
Current errors, credentials, actions, forecasts
and live source state are separate.

Session evidence is a complete temporal index:

```ts
{
  anchor: number; cut: number; knownFrom: number; cursor: string;
  refs: {
    ref: string; source: string | null; clientId: string; device: {id: string; name: string};
    origin: 'terminal' | 'editor' | 'app'; project: string | null; folder: string | null;
    startedAt: number;
    currentPresence?: {working: boolean; through: number; workingThrough: number; startedAt: number};
  }[];
  spans: [refIndex: number, fromOffset: number, toOffset: number][];
  packed?: {
    patterns: number[][]; // flat pairs of exact offsets within an hour
    blocks: number[];    // flat triples: refIndex, UTC hour since epoch, patternIndex
  };
  fixed?: {
    range: {from: number; to: number};
    totals: [refIndex: number, workedMs: number, lastWorkedAt: number][];
    activity: Activity; // exact totals, groups and boundary bars
    shift?: {
      until: number;
      steps: [path: (string | number)[], perMs: number][];
      window?: {
        start?: object; // immutable replay base, without shift; otherwise the carrying summary
        paths: (string | number)[][];
        slopes: [pathIndex: number, perMs: number][][];
        pieces: [fromEnd: number, untilEnd: number, slopesIndex: number,
          changes: ([pathIndex: number, value: unknown] | [pathIndex: number] |
            [pathIndex: number, delta: number, add: 0] |
            [pathIndex: number, start: number, remove: number, insert: unknown[]])[]][];
      };
    };
  };
  replaceFrom?: number; replaceTo?: number;
}
```

Dense evidence uses `packed` with empty `spans`. Each block's hour is multiplied by
3,600,000, then its pattern's millisecond pairs give the original credited intervals.
Repeated patterns share storage; gaps and boundary fragments are never approximated.
Both representations have identical replacement and projection semantics.
On the owner's personal board, retained unknown or unheld work has a null `source`
and keeps its `clientId`; shared boards omit these contexts. A held hidden source
remains excluded. Presence enrichment matches the device, client, stable producer
and complete retained context, including its original funding, without exposing that
funding or producer identifier. Private `ownSince` cutoffs invalidate session deltas
and quota activity independently of source measurements and financial evidence.
Fixed selections instead return `fixed` with empty `spans` and no `packed` ledger.
Every positive-work context remains in the summary. Interior activity bars reuse
the history cells; boundary bars and group totals are exact. Fixed summaries are
complete replacements, and changing their interval requires another summary or a
matching cached result. An optional `shift`, also available on a fixed measurement
tape, proves reuse when both endpoints advance by the same number of milliseconds
and the new `to` is below `until`. Its paths address numeric fields of that fixed
summary; each changes by `perMs` times the endpoint advance. The reader bounds the
proof by observations, work endpoints, validity deadlines, evidence cut and cell
edges. Only exact clipped timestamps and durations move; monetary amounts are
never interpolated. Paths and proof bytes share the retained history budget.
An optional `window` instead proves positions in neighboring endpoint cells, in
either direction with the same duration. Its ordered pieces cover half-open intervals
of right-edge positions. Replay begins at the immutable `start` summary, or the carrying
summary when `start` is absent. A restored summary retains this base for repeated moves. Advance
numeric fields using the preceding piece's slopes, then apply the next piece's exact
changes. A one-element change deletes that field. A three-element change
`[pathId, delta, 0]` adds an exact safe-integer delta to a safe-integer field;
fractional values and monetary strings still use exact replacements. A four-element change splices
the addressed array at `start`, removing `remove` elements and inserting `insert`.
Unchanged prefixes and suffixes remain exact. Within a covered piece, advance
using its own slopes. Gaps have no proof. Cell, observation and deadline boundaries
are explicit pieces; monetary strings and changing arrays are replaced exactly.
The immutable start also makes repeated moves independent of the previous position.
These optional proofs and nearby value states share existing memory limits and may
be omitted when they cannot fit. Outside proven positions a new summary is required.
Only optional current presence
can expire locally while a fixed selection remains unchanged.
Offsets in `spans` are exact milliseconds from `anchor`. Only credited intervals intersecting the
requested evidence are included, clipped by capture, retention, membership and sharing
cutoffs. No current list or duration total substitutes for those intervals. Clients
intersect them with the selected accounting range, retain only positive-work contexts,
and derive grouping and ordering from that result. Optional current presence requires
a stable authorized identity match; its absence is not an inferred session end.
A delta replaces its named interval, making retries idempotent. Cursors are signed and
bound to the board, user, hub run, authority, retention and evidence revision. Currency
and resource selections also bind a tape cursor. An unprovable frontier returns a
complete bounded baseline. It never silently returns a partial index.

`POST /api/boards/:board/period/sessions` reads details for at most 100 opaque refs.
Its body is `{version:1, selection, evaluatedAt, cursor, refs}`, at most 8 KiB. The cursor
must still name the current authorized evidence and cover the requested interval;
otherwise the response is `400 history_range_invalid`. It returns a complete sessions
section containing the requested clipped rows, or a section error. Dashboard pages use
50 rows from the complete index, so a clock-driven membership change requires no detail
request. Detail reads use the same accounting transport and memory limits.

The `history` event's optional `changes` entries are
`{source, scope:'quota'|'budget', since, workSince?}`. `workSince` identifies actual
credited-work invalidation; the legacy `sources` and earliest `since` remain present.
Consumers coalesce affected sections into one foreground read. All accounting endpoint
requests and bytes, including aborted attempts, count toward the same benchmark budget.

## Reading history

```
GET /api/history?board=<id>&cell=<ms>&from=<ms>&to=<ms>
```

The signed-in reader's cells on a shared time grid, for the chart, table and agent
activity. Access is checked before the query: `401 unauthorized` without a session,
`404 board_not_found` without access to the board. A malformed query is
`400 invalid_request`. The answer is `application/json`, never reused by HTTP caches.

The grid rule is shared by hub and page (`hub/server/domain/history.ts`). Its cells are
1, 5, 15, 30, 60, 120, 360 and 720 minutes; a frame takes the finest cell that keeps its
length within 360 cells, with 5% over allowed. Reading accepts the grids a frame of at
most 31 days uses, through 120 minutes. A cell is `[k·cell, (k+1)·cell)`, aligned to the
epoch. A tile is 60 cells, also aligned to the epoch. Period names belong to the page.

`cell`, `from` and `to` are decimal integers of 1–15 digits. `cell` must be a supported
reading grid and `from` must be on a cell edge. `to` must be on a cell edge or beyond
now; it is rounded out and cut to the end of the cell containing `now + 30 seconds`,
the clock tolerance of ingest. After cutting, `to > from` and at most eight tiles may
be touched. `from` is no earlier than the tile containing the start of the sample
retention period. The hub credits machines that went quiet before reading the cells.

```ts
{
  now: number,
  run: string, // this start of the hub, the same as hello.epoch
  historyStart: number,
  known: {own?: number, work: number, sources: Record<string, number>},
  meta?: string, // opaque metadata token, only when the request opts in
  chunks: Chunk[]
}
```

An optional `meta` query parameter opts into metadata reuse. Its value is empty on
the first read, or the 43-character base64url token from a previous full answer.
The token binds `run`, `historyStart` and `known` to this board and this hub instance.
If it matches the current metadata, the reply omits `historyStart` and `known` and
still sends `now`, `run`, `meta` and all requested chunks. Otherwise it returns full
metadata and its new token. A reader expands a compact reply from the metadata
captured when that request started, requiring both its token and `run` to match;
it never borrows a later reply's metadata. Requests without `meta` keep the full
answer shape, and a full answer is accepted without a token.

`known.work` is when the hub began keeping work. A personal board's quota/activity
history also includes `known.own`, the lower bound for its owner's private work,
independently of the selected subscriptions. Shared and financial history omit it.
`known.sources` gives when each shown
subscription came to the board; hidden cards are absent. The chunks cover the cut
`[from, to)` whole, including empty cells, in time order, cut at tile edges. A whole tile
ending no later than now is closed. Closed tiles are cached under their board, grid and
tile, with the board's work selection and names; measurements and credited work
invalidate affected tiles. Tiles near the retention edge are counted anew. Actual retention
deletions invalidate the server cache before its next read: a closed tile may depend on
a preceding sample of any age. This is private housekeeping, with no new `history`
event; observations the page already holds follow its usual data and connection lifecycle.

```ts
type Chunk = {
  from: number; to: number;
  series: {
    source: string; window: string; hold: number; open: number | null;
    cells: [index: number, low: number, spent: number, covered: number, extra?: {
      f?: number; l?: number; o?: number | null; g?: 1; h?: number; u?: number;
      w?: [spent: number, covered: number, duringWork: number];
    }][];
  }[];
  activity: {
    sessions: [ref: string, source: string | null, project: string | null, device: string][];
    devices: Record<string, string>;
    cells: [index: number, active: number,
      sessions: (number | [sessionIndex: number, agentMs: number])[],
      groups: ['s' | 'p' | 'd', key: string, activeMs: number][]][];
  };
  resets: [source: string, window: string, at: number][];
  grants: [source: string, at: number, count: number][];
};
```

Cell indexes are relative to `chunk.from / cell`. Each series contains only cells with
measurements, in order. Every window with measurements is included, even one the card
no longer reports; the page selects current windows and takes their kind, label and
length from the cards. The point is `low`, the lowest remaining share, rounded to two
decimal places. `hold` is the last measurement's `staleAfterMs` in the cell. A line breaks
before a cell when its start is more than `max(cell, previous.staleAfterMs)` after the
previous measured cell's start, including the sample before the chunk.

A proven step between consecutive measurements belongs to the cell of the later one:
`spent` adds its percentage-point delta and `covered` adds its elapsed milliseconds.
Resets, corrections and missing measurements void only their step. `first` and `last`
are the remaining shares of the cell's first and last measurements. `open` is the share
held at its start: the previous measurement, unless its step is a gap, or a reset already
happened before the cell began. Otherwise it is null. Remaining shares and spending
other than `low` are rounded to four decimal places; time is in whole milliseconds.
Frame totals add the rounded cells, and remaining at its edges is `open ?? first` of
its first measured cell and `last` of its last.

Only differences from these decoded defaults are written:

| Field | Default |
|---|---|
| `first` (`f`) | `low`; used only when `open` is null |
| `last` (`l`) | `low` |
| `open` (`o`) | series `open` in its first measured cell, then the preceding measured cell's `last` |
| break (`g`) | 0 |
| `hold` (`h`) | series `hold` |
| availability end (`u`) | no explicit bound; an exclusive Unix-millisecond cutoff after an unavailable quota observation, limited by the sample's own freshness end |
| work (`w`) | `[spent, 0, 0]` at or after the subscription's known threshold, `[0, 0, 0]` before |

A reported availability end limits drawing and readout without changing the original
measurement's freshness promise. A bounded readout uses the precise pointer timestamp
against that sample's deadline, not a later sample's freshness promise. Recovery begins
a new segment: neither spending nor forecast evidence crosses an explicit unavailable
observation. An aggregate cell recovering after an unavailable start is unavailable for
drawing and readout (`g=1`, `u=cell start`), even if the gap began in an earlier cell.
Recovery exactly at a cell boundary starts an ordinary new cell. Spending totals still
include only proven steps; the aggregate does not invent intra-cell sample positions.

A field is omitted only when its rounded value equals the decoded default. `f` is
omitted while `open` is not null. The subscription's known threshold is
`S = max(known.work, known.sources[source])`. Work stretches are selected by the board's
holders and cut at the later of each holder's joining threshold and `S`. For proven
steps starting at or after `S`, `w` adds the delta, overlap with the subscription's
union of selected work, and the whole delta when that overlap is positive. Work before
`S` is not attributed; a hidden card has no work record in the frame.

Activity includes those same selected stretches within each cell. `active` is their
union. Each session's time is additive, so parallel agents count separately. A session
is its index in the chunk's `sessions`; when its time equals `active`, that index alone
is written. Groups are subscriptions (`s`, source id), projects (`p`, the project name
or null as JSON) and machines (`d`, device id). A group's active time defaults to the
longest time of its member sessions in the cell, and is written only when it differs.
Machine names are in `devices`. Only sessions with selected work in the chunk appear.

The page adds cell activity into bars of a length chosen from the requested frame's
length (`barOf`), keeping a set of session references to count distinct agents in each
bar and frame. Group agent time is the sum of its sessions; group active time is the
sum of its cell unions. Groups rank by agent time, active time, name and key.

`resets` names each early-reset pair whose later sample is in the chunk, including a
pair entering it. The frame selects current windows and groups a source's resets
within 15 minutes of each group's first reset. `grants` names each grant of free resets
in the chunk, without grouping.

A live frame starts at the whole cell containing `now - length` and includes the cell
of `now + 30 seconds`. A selected range goes out to whole cells and stops no later than
that same cell. Measurements on its right edge belong to the next cell. A range reaching
past now includes accepted fast-clock measurements in their own cells; a chart shows a
point only once that cell's start has come. Work is credited from machine reports, or
when they go quiet; each credit sends `history` with its earliest credited time. An idle
board has neither measurements nor working agents and sends no such news.
The hub's clock advances independently of the known empty data suffix. A selected
range wholly beyond its current grid cut returns to the chosen period.

The page keeps tiles of its open board with a bounded memory budget, preserving its
current frame. Cold reading starts at the frame's first cell; whole inner tiles remain
cacheable. The page tracks each tile's read interval, so its omitted head stays unknown.
Ordinary discrete navigation fills that head once for subsequent frames. A `history` event makes
cells from `since` stale and reads only what the frame needs. Reconnect, a changed lineup or `since: 0` makes all
tiles stale. Answers of another `run` are discarded. The shown frame stays undimmed
while its own cells refresh; an ordinary change of period keeps the previous one dimmed
until all of its cells have been read. Continuous panning has a separate partial plot:
read cells stay visible, unread intervals are empty, and an activity bar is drawn only
when all its contributing whole cells have been read. The previous complete answer
continues to supply the table and totals until the final range is complete. Panning
reads contiguous missing or stale cells immediately, from the nearest unread edge,
with at most two flights and eight tiles per request. It never crosses fresh cells
or a tile owned by another flight. A visible miss may extend that same batch by
min(60, ceil(history length / cell / 4)) nearby whole cells in its direction. The
optional extension stops at a tile edge when that keeps every required cell and at
least one tile of cells, avoiding repeated metadata for fragments of the same tile.
Only dispatched cells consume the optional allowance. No miss means no new speculative
read. Unvisited optional cells remain charged after
cancellation or reversal. A disjoint jump within a held tile reads only the minimum
unknown or stale bridge needed to preserve its connected read interval and fresh
prefix. That bridge is separate from the optional buffer and smaller than one tile;
an empty tile has no bridge. Final range completion uses the same batches without
a buffer, and purely speculative work ends with the gesture. Cells beyond the hub's cut remain known empty until news arrives. Time
alone never reads history. Numerical projection and response staging run in cancellable
slices. Tile data and read boundaries publish atomically for a complete response;
waiting raw answers share the two-owner processing bound. The graphs keep their
current drawing and final gesture pose until a complete matching replacement has
committed. Active partial plots still progress; final drawing readiness requires the
complete answer for the requested range. A newer user navigation supersedes that held pose immediately and projects
the retained data in the requested frame while preparation continues. The retained
data keeps its own coverage; a ready replacement cannot revive the old navigation.
Ordinary clock movement reprojects that ready drawing without rebuilding unchanged
numeric series. Crossing its bounded overscan margin rebases geometry in slices;
clipped future outlines retain their complete facts. Its factual data cutoff stays
separate from the current frame's future boundary
and expiry checks. Drawing preparation waits for its parent input model to be ready.
This adds no wire fields.

## Requesting fresh limits

```
POST /api/boards/<board>/sources/<source>/refresh
```

No body is needed. Any signed-in reader of that source on that board may ask, including
members who do not own the subscription and the desktop app's local reader. The usual
Host, Origin and session checks apply before the board and source are checked.

| Status | Body | Meaning |
|---|---|---|
| 202 | `{ok:true}` | Accepted, or joined the same unfinished request. |
| 429 | `{error:"refresh_too_soon"}` | A new request was accepted less than a minute ago; `Retry-After` is seconds rounded up. |
| 409 | `{error:"refresh_unavailable"}` | No device can fulfil a new request now. |
| 401 | `{error:"unauthorized"}` | No session. |
| 404 | `{error:"board_not_found"}` or `{error:"not_found"}` | No access to the board, or the source is not on it. |

One request and one cooldown belong to the subscription across the hub. A retry after a
lost HTTP answer joins the unfinished request without extending it. The POST does not
wait for a measurement and carries no state: only snapshots and events replace state,
so a late POST response cannot undo a result already received.

`refresh` is `{unavailable, availableAt, retryAt, request}`. `unavailable` is null, or
`no_device`, `unsupported`, `silent`, `paused`; `availableAt` is the end of the error
pause when `unavailable` is `paused`, otherwise null. `retryAt` is the end of a
still-active one-minute cooldown, otherwise null. These describe the ability to create a
new request. `silent` is 120 seconds without a word from the holder: a check-in with the
subscription, or, within five minutes after it, a delivery of any measurement or failure
by that device.

`request` is null or
`{requestedAt, notBefore, dispatchAt, deadline, status, finishedAt}`. All times are
epoch milliseconds on the hub. `dispatchAt` and `finishedAt` may be null. `notBefore` is
the earliest permitted measurement time, not proof of a client starting.

| Status | Meaning |
|---|---|
| `queued` | Waiting for the device's permitted interval and check-in. |
| `waiting` | A measurement has been asked for; waiting for fresh data. |
| `updated` | A newer accepted measurement met the freshness boundary, even with unchanged percentages. |
| `failed` | A relevant new failure came from the bound device. Previous limits may still be representative. |
| `unavailable` | The request lost its executor or became impossible. |
| `no_result` | No fresh data arrived before the deadline. This says nothing about whether the client started. |

A request joins a command to the holder that is still under way: one the holder has not
asked past, since it asks nothing while it measures, for at most five minutes after the
command; meanwhile the holder is not `silent`. A holder that asks again without
answering lost the command, and the request is queued for the command's retry, which it
never brings forward. Before dispatch the deadline is five minutes after `notBefore`
(never counted from a moment already past, when the device lowers its minimum); after
dispatch, five minutes after the command. Joining a command waits five minutes after the
request, with no extension on retries. Silence over 120 seconds ends a queued request. A
dispatched request keeps waiting until its deadline: providers are measured
sequentially, and a holder busy measuring neither asks nor delivers the others. Its
`unavailable` can therefore be `silent` or `no_device` once the five minutes after the
command are over, while a joined request is still `waiting`. A lapsed lease ends neither
while the same device holds duty. Revocation, a changed holder, a return to the legacy
protocol and an error pause end either. Terminal results remain for one minute; an
allowed new request can replace one immediately. The state is in memory and resets with
the hub.

A success must be newer than the success at acceptance and no earlier than 30 seconds
before the request (or the original command when joining one already outstanding), using
ingest's corrected clock. It may arrive from another device of the same subscription.
There is no request id in ingest and no assertion that this click caused that particular
measurement. After a terminal outcome, late data update the usual card only.

Snapshots, SSE and long polls expose the same state to every reader of the subscription.
Time boundaries emit events without page polling. No requester identity, device id or
device name is exposed by refresh state, and no state is returned before board access
is checked.

## The board at once

```
GET /api/overview?board=<id>
```

The board as a `snapshot` gives it, as JSON, for whatever reads a board once rather than
following it. `board` may be left out, as above; `401` and `404` are as above.

## Long polls

A poll without `lease`, or with one the hub does not know, starts a lease and is answered
at once:

```json
{"lease": "<id>", "now": 1790000000000, "events": [{"type": "hello", "data": {…}}, {"type": "snapshot", "data": {…}}]}
```

A poll with its `lease` is answered with the events since the last answer as soon as
there are any, else after 25 seconds with none. A lease counts as a reader while it lives
and keeps its events, up to 256 KiB; it is forgotten 60 seconds after its last answer,
when it falls further behind, or when the hub restarts, and a poll with it then starts a
new lease with a snapshot. A lease is the session's and the board's it was made for. A
lease let go for a newer reader answers `bye` with `limit` once: at once to a poll
waiting on it, else to the next.

## Limits

A session may have 8 readers (streams and leases) at a time, a person 16, the hub 2000.
A new one over a limit takes the place of the oldest in that limit: of its session, of
its person; over the hub's, of its person if they have one, else it is refused with
`429`. So connections a sleeping laptop left behind never keep a new tab out.

## Exact meters and hub connections

Card key scales use the existing view's `windows` visibility list with
`<source id>/key:<opaque key id>` entries. The default preview stays visible unless
hidden; `shown` holds explicitly enabled scales beyond it, using the same entry format.
An explicit enabled choice survives changes in preview ordering. The card's switches
also apply to compact. Card settings page through key-scale switches; there is no
key-table dialog. Chart series are chosen independently in the chart's own settings.
Both resource types use the same segmented meter; balances have no percentage meter.

A hub-measured card may also carry `meters`, `keys` (a preview of at most five),
`keysCount`, `inventory` and `spending`. A meter is `{id, kind, unit, amount, limit,
resetAt, minutes, scope, label, at, staleAfterMs, stale, scale?}`. Kind is `counter`, `balance`
or `cap`; a cap's amount is used, its remaining is limit minus amount. A zero limit
has no percentage. Unless an explicit scale is present (native Codex credits),
unit-valued amount fields are canonical decimal strings of whole millionths,
quantized once from the supplier's original decimal token, with nearest rounding and
halfway values away from zero. They use signed 64-bit SQLite integers; totals use exact
integer arithmetic and never combine units. A balance has no 100%.

Hub sources carry `identityOrigin: "supplier" | "declared"`. The latter denotes an
owner-declared logical account; it does not claim provider verification. Personal
Global z.ai sources have two independent cap meters in `credits:zai`:
`quota:credit:5h` (300 minutes, scope `five_hour`) and `quota:credit:week`
(10080 minutes, scope `weekly`). Their allowances overlap and are never added.
There is no monetary balance, key inventory, calendar spending, forecast or native
percentage-window attention for these caps. Provider catalogue `funding` is
`subscription` or `wallet`, independently of measurement authority.

A quota card carries `quota: {observedAt, generation: "credit" | null, complete,
issue: "empty" | "unsupported" | "invalid" | "missing" | null}`. Partial readings
update only accepted meters. An authenticated omission closes the old meter's
historical validity immediately and leaves its current value stale. Empty,
unsupported and invalid replies retain all last valid readings without extending
success or freshness. Authentication and transport failures preserve the former
freshness deadline. Resets are supplied epoch milliseconds or null; elapsed time
never restores quota. The allowlisted plan is `lite`, `pro`, `max` or unknown.

OpenRouter stores credits and lifetime usage counters; its balance is derived from
the pair. A credit increase is a top-up, and a usage increase is spending.
Key observations use the arrival time of their inventory page; account counters
keep the time of their paired response. UTC cap resets and period totals use the
key's own observation time, which can be later than the account observation.
Initial counters are baselines. Counter corrections are not spending. Account calendar
periods are UTC, with Monday starting the week. `spending` gives day/week/month summaries with
`from`, `to` (the last account observation, or the current period start before its first
observation), `amount` or null, `complete`, `knownFrom`, `uncertain` and `unlocated`.
Completeness ends at that observation. Calendar spending remains available as data for
analytics; source cards show current balances and enabled caps, without spending summaries.
An unlocated step retains its original `{from, to, amount, evidence}`; evidence is
`continuous`, `gap` or `estimate`. A continuous step crossing midnight may be known
for the week and unlocated for the day. No spending is assigned a guessed time.

Key parts contain an opaque id, name, disabled/expiry/BYOK scope metadata, observation
and freshness, `presence` and `missCount`, and current provider day/week/month usage.
They may also carry `createdAt`, `updatedAt` and `byokUsage: {total, day, week, month}`.
Dates are supplier timestamps or null; BYOK amounts are exact millionth strings or
null when unavailable. Current period projections clear out-of-period BYOK totals in
the same way as ordinary usage totals. BYOK values do not alter wallet spending.
A key missing from one successful traversal remains stale; two successive successful
missing traversals archive it. Partial traversals do not confirm absence. A reappearance
restores the same id and history. Inventory completeness describes a bounded traversal,
not an atomic supplier snapshot. Amounts and key names are shared measurement data.
A confirmed unlimited key loses its current cap even during a partial traversal;
an invalid cap remains unknown and preserves the last cap as stale. Historical readings
survive removal. The last confirmed observation also survives archival and retention,
so a returning key's spending interval begins at that observation.
Safe provider context and reported period totals are retained in sparse internal
history with their own observation times and UTC period anchors. This storage does
not add board events or a new history capability. No raw response, raw key hash,
creator/workspace id, connection label or credential enters that archive.

`GET /api/history` accepts optional `scope=quota|budget`. Current readers send a
scope; absent scope retains the previous combined contract. Quota reads contain native
windows, resets, work and selected catalogue-defined subscription cap meters. Budget
reads contain only selected financial meters and never execute native-window or agent
work reads; the native/activity wire fields are empty. Budget scope requires a valid
`unit`/`meters` pair, including an explicit empty list. Resource-family mismatches return
`400 invalid_request`; hidden or unauthorized selected sources remain `404 not_found`.
Quota reads cannot request private monetary conversion. Validated ranges outside readable
bounds return `400 history_range_invalid` for scoped readers, independently of malformed
selection errors. Existing cell, tile, meter, response and retention limits remain.

Cache and metadata identities include the read scope. Work-name changes invalidate only
quota caches; metadata offered by another scope cannot be reused. A `history` event keeps
its legacy `sources` union and minimum `since`, and adds `changes: [{source, scope, since}]`.
Each source/scope keeps its own earliest changed time. Native samples, subscription caps
and credited work affect quota; monetary observations and valuation changes affect budget.
Work refreshes preserve coalesced budget changes. Clients without `changes` conservatively
invalidate both relevant scopes. Scope never grants access or adds private rate or owner
information to a shared event.

`GET /api/history` additionally accepts `unit` and `meters`: a JSON array of at most
32 logical `[sourceId, meterId]` pairs, sorted and deduplicated. Sources must be visible
on the board. `balance` resolves its internal counter pair without spending extra
selection slots. Cache keys include the selection. Without these fields the existing
window protocol is unchanged. A selection containing a hub-measured subscription
also returns the board's native window series, so subscription quotas share its
percentage analytics. Wallet-only selections omit native windows. This follows the
provider catalogue's funding type, rather than the meter's stored unit.
Each chunk may carry `meterSeries`, whose entries are
`{source, meter, kind, unit, semantics, cells, accounting?, role?, pointMode?}`. Semantics is `{limit, resetAt, minutes,
scope, label}` as it actually held before the chunk, or null.

A meter cell is `[index, value, spentInternal, spentExceptional, coveredMs, extra?]`.
Value is the historical amount, or remaining for a cap. The composed money frame also
keeps exact known spending per point, so the spending view draws only located spending.
Summaries distinguish missing coverage from zero spending: no covered interval gives
an unknown amount, and a known subtotal with incomplete coverage is marked partial.
Different kind or unit identities that occur inside one cell retain separate series.
Progressive drawing may hold neighboring cells for movement, while spending uses the
visible whole-cell period. Loading those neighbors cannot change its amounts or make
a boundary-crossing step located within that period.
Extra may give `first`, `open`
(including explicit null), `segment`, historical `semantics`, original exceptional
`steps`, `topupInternal` and `topupSteps`. Cap cells additionally carry
`knownFrom` and `knownUntil`, exclusive epoch-millisecond validity bounds clipped to
that cell, the observation span's freshness and hard omission boundary, and any
reported reset. Cells mixing incompatible quota semantics are unavailable. These
bounds survive packing and composition; both drawing and readout require the
requested fetched cell and its own interval. Missing bounds or cells grant no
carry-forward, including internal/trailing gaps. Other meter kinds keep their
existing interpretation. Amounts remain strings throughout packing.
Known cell spending and original steps compose once over the effective whole-cell
range. OpenRouter balance spending comes from usage, and top-ups from credits.
DeepSeek series have `accounting: {spending: "unavailable", topups: "unavailable"}`.
Their two spending cell slots are null, exceptional/top-up steps are absent, and
composed `spent`, `topup` and per-point `spent` are null. They keep numeric balance
values, coverage and their catalogue role. Missing capability never becomes zero.
The UI omits unsupported spending lines and explains unavailable table quantities.

DeepSeek `pointMode: "observation"` cells additionally use `pointOffsetMs` (omitted
means zero) and an exclusive absolute `validUntil` (omitted means fixed grid cell end).
The actual point time is grid time plus offset. Normalized observation points always
materialize a deadline. An accepted missing currency closes its availability at that
observation, and a same-value recovery starts another segment at its actual time.
An ordinary change in a continuous span can emit a separate confirmed opening prefix
from the grid edge to the primary point; a first or recovered sample cannot.
The prefix may start at retention instead, with `openOffsetMs` relative to the grid
edge (omitted means zero); its exclusive end is the primary point. A clipped prefix
does not establish the value at the unretained grid edge.
When its semantics differ from the primary point, `openSemantics` preserves the
opening value's own financial metadata and conversion provenance. It is read and
converted independently, including when it is the first cell of a requested chunk.
Reader conversion follows its recorded valuation timeline even when the native amount
is unchanged. More than two admitted points in a cell use `observations: [{at, value,
validUntil, semantics?}]`, with absolute times and exact strings. Missing point semantics
inherit the cell's primary semantics. Packing retains each point independently.
Deadlines never exceed the fixed grid cell end, so later heartbeats cannot extend finished cells.
The existing chart draws these actual anchors and reads raw pointer time; deadline
endpoints are not samples. OpenRouter and percentage series retain cell placement.
Observation points and coverage stay within retention even in its first partial cell;
older heartbeat endpoints remain internal evidence.
Replacing a selected interval with empty series removes its old packed rows too.

DeepSeek cards may carry `balanceStatus: {isAvailable, at, staleAfterMs, partial, issues}`.
Issues are only `currency_invalid`, `currency_unknown`, `currency_duplicate`,
`currency_missing` and `empty_balances`. The boolean is a supplier funds status, separate
from authentication. Each currency's three exact strings are an atomic tuple; partial
updates retain absent tuples as stale. Valid empty reads clear current request errors
without renewing numerical freshness. `balanceStatus.at` is the accepted watermark.
Currency totals never include their components again, and units never share an axis.
Connecting a source preserves `unit: null` subscription analytics until currency selection.

Budget presentation separates current funds, scoped allowances, accounting over a
period and balance composition. Dashboard and compact cards project the same catalogue
roles into one Available balance in the reader's display currency, followed by
selected catalogue-supported key caps. Composition is grouped by currency in the
balance disclosure. Counters, reported period totals and BYOK are accounting evidence,
not additional funds or automatic card rows. Key properties and inventory quality
describe access and measurement reliability. Each observation retains its own unit,
scope, time and quality; absent, stale, unsupported and confirmed zero remain distinct.
The hub's shared currency integration keeps native provider meters unchanged. When
there is no native USD total and exactly one supported foreign total family, it records
separate valuations identified as `fx:USD:<native meter ID>`. Derived meters are not
provider catalogue capabilities. Cards and historical meter semantics may carry:

```ts
conversion?: {
  original: {meterId: string; amount: string; unit: string; at: number};
  rate: {
    id: string; source: string; base: string; date: number; fetchedAt: number;
    from: string; to: string;
  };
  steps?: RateLeg[]; // The same rate fields for each composed leg.
};
```

Amounts and positive rate quotes are exact integer-millionth strings. `rate.date`
is the UTC reference day; `fetchedAt` is acquisition time. `from` and `to` are quotes
against the same `base`. Each estimate links to an immutable shared rate snapshot and
keeps native financial scope and label. Packed cells preserve this structured metadata
and observation anchors. Converted series have spending and top-up accounting
`unavailable`; currency movements never become usage. Native USD is preferred even
when retained as stale, and totals, components and different currencies are never
summed. A card may carry `currencyUnavailable: true` when a fresh foreign total lacks
a current USD valuation; this does not alter provider `balanceStatus` or key health.

Native observations commit before currency-service reads. Quotes have no credential or
account inputs. Failure retains original measurements and leaves USD unknown or stale,
never zero. Existing events carry these additive fields; currency settings use authenticated
hub routes in web and local mode, without a native bridge command. Original foreign-currency history stays available through the
measurement API, and existing development-layout converted history is retained.

Reader snapshots may include `currencies`, and a private `currencies` event updates it:

```ts
{
  target: {id, name, symbol, fractionDigits},
  definitions: [{id, name, symbol, fractionDigits}],
  revision?: string,
  registryRevision?: string,
  sources: {[sourceId]: [{from, at, anchor: string | null, steps: RateLeg[]}]}
}
```

USD is the initial policy, not a fixed widget contract. Definitions and display
preference belong to the authenticated reader, independently of the shared board.
A personal currency identity is `personal:<24 hex digits>`; native ingest units are
unchanged. Only the owner receives that definition and its fixed-rate paths. Public
rate snapshots can be reused across users. Native cap percentages and non-monetary
units are never replaced by currency values. Missing paths show unknown target amounts,
not zero or amounts silently labelled with another currency.

For money history, optional `currency=<id>` selects the reader's persisted display
currency. `unit` and `meters` continue to select native/reference data. An inaccessible
currency returns `404 currency_not_found`; a changed preference returns
`409 currency_changed`. Conversion follows native accounting and retains coverage,
interruption and immutable quote assignments. Private converted responses are kept
outside the shared native tile cache. No `currency` parameter preserves the earlier
native history response.
Repeated converted semantics remain sparse. One authorized history read loads each
binding group once, performs conversion in memory, and persists only new or extended
assignment ranges. Missing paths are cached by owner, quote revision and effective
interval; a newly available quote invalidates that result.

Authenticated registry operations, also available in local mode:

- `GET /api/currencies`: the reader's target and personal definitions.
- `POST /api/currencies`: `{name, symbol, fractionDigits, base, rate}` creates a personal
  currency; `base` is a standard currency and `rate` is a positive exact millionth string
  of personal units per base unit. Name/symbol limits are 64/12 characters; precision is
  0..6. The initial ratio defines a fixed nominal unit for display and historical views.
- `POST /api/currencies/display`: `{currency: id}` changes the one display preference.
- `GET /api/currencies/:id`: an accessible definition and its retained quotes.
- `POST /api/currencies/:id/rates`: `{base, rate, date?}` adds an owner-only fixed-rate
  version, effective at `date` or the current time. Future dates are rejected.

- `GET /api/currencies/manage`: `{registryRevision, selected, standards, personal, maxActive}`.
  Standards are the server-issued ISO catalogue. Each personal entry is
  `{definition, archivedAt: number | null, pairs}`, including archived definitions; maxActive is 64.
  Each current pair summary is `{base, rate: string | null}`: exact integer millionths,
  or null for a stopped pair. Superseded rates do not reappear in this summary.
- `GET /api/currencies/:id/history?before=<cursor>&limit=<1..64>`: retained personal
  definition, archivedAt, current `pairs`, paginated `changes` and `nextCursor`.
  A change carries `{sequence, base, effectiveAt, recordedAt, kind: 'rate' | 'stop',
  quote: RateSnapshot | null, nominal}`. Sequence numbers count only this owner's rate
  changes and stops. Pages run newest sequence first; the opaque
  cursor is scoped to this owner and currency. Current pairs are independent of paging.
- `POST /api/currencies/:id`: `{name, symbol, fractionDigits, ...mutation}` updates
  metadata without changing identity, the nominal ratio or any recorded amounts.
- `POST /api/currencies/:id/archive`: `{replacement?, ...mutation}` archives a personal
  definition. If selected, an explicit different active replacement is required; both
  changes commit atomically. Archived definitions cannot be selected or edited.
- `POST /api/currencies/:id/restore`: `{...mutation}` restores availability without
  selecting the currency or cancelling any rate stops.
- `POST /api/currencies/:id/rates/:quoteId/archive`: `{base, ...mutation}` stops the
  current version of this personal pair at server time. A superseded quote conflicts.

`mutation` is `{expectedRevision: string, requestId: UUID}`. New lifecycle routes require
both fields. The existing create, select and rate routes accept them additively and keep
their prior success shapes. Every private write increments the owner's registry revision
once; public rates do not. An owner-scoped receipt is checked before CAS: the same request
and payload return its original success, while reusing an ID with another payload returns
`409 mutation_conflict`. Receipts are retained seven days. An expired request with a stale
revision conflicts instead of creating a duplicate. Legacy writes still validate lifecycle
and update revisions. Settings reload management after success; a source-free command
response must not replace the board's complete currency context.

Private routes use existing session and origin guards. Errors include `400 invalid_currency`,
`400 currency_limit`, `404 currency_not_found`, and `409 currency_conflict`,
`currency_selected`, `currency_archived` or `mutation_conflict`. Display selection keeps
its existing `400 invalid_currency` for inaccessible targets. Foreign personal IDs are
unavailable. Standard definitions and public quotes are read-only. Management details,
archived definitions, full ISO lists, receipts and version lists never enter shared SSE.
The private event includes registryRevision and active personal definitions only.

Rates are immutable. The latest effective pair event wins, with sequence breaking equal
UTC millisecond timestamps. A stop closes that pair without falling back to an older price.
A later rate resumes it; a correction backdated before the stop does not resume it now.
Other configured active pairs can still supply a path. The owner-wide private path revision
refreshes missing history even for a standard target reached through a personal bridge;
metadata-only edits do not change that revision. Successful historical assignments never
change. Rate/preference changes cannot create spending, top-ups or native measurements.

Unavailable real observation anchors are retryable, not immutable negative assignments.
They terminate the previous displayed interval at the actual observation, not at the rate
stop. A later rate may recover that anchor only if its effective interval covers it.
Observation cells retain disjoint intervals with `observations[]`, even with only two
segments. Positive ranges coalesce only across continuous eligibility, without swallowing
missing anchors. Retention preserves pair decisions at retained native anchors even for
readers without prior assignments. Retained versions are not an unlimited audit log.
The hub issues personal identities; names and symbols never identify or merge currencies.

A frame that cannot fit losslessly in the history budget returns `413 history_limit`.

DeepSeek connections use owner-only `POST /api/credentials` with
`{provider: "deepseek", secret, account: {kind: "new", name} | {kind: "existing", id},
sameAccount?, allowUnknownExpiry?, requestId?}`. Existing account selection
requires `sameAccount: true` before provider work. Replacement accepts only
`{secret, sameAccount: true, allowUnknownExpiry?, requestId?}`. Its API cannot verify the
owner's identity declaration. Account names are normalized private labels, unique
per owner/provider, independent of immutable UUIDs and keys. A new account creates a
new source; last-key removal preserves identity and retained history for reconnection.
`GET /api/source-accounts?provider=deepseek&limit=1..50&after=<UUID>` returns owner-only
`{accounts: [{id, provider, name, sourceId, connected}], next}` in UUID order.
`expiryKind: "unknown"` is distinct from `none` and `dated`. Saving unknown expiry requires
`allowUnknownExpiry: true`; a missing consent returns
`409 {error: "credential_expiry_confirmation", expiresAt: null, expiryKind: "unknown"}`.
The owner credential DTO includes `accountId`, `accountName` and `expiryKind`.
Creation replay binds owner, provider and account selector; changed targets conflict.
A last-binding withdrawal revision and current encryption-key epoch invalidate pending
creates, replacement and polls, including resets with no credentials.

OpenRouter connections use owner-only `POST /api/credentials` with `{provider, secret,
allowNoExpiry?, requestId?}` and replacement with `{secret, allowNoExpiry?}`. An access
with confirmed no expiry is admitted in one informed submit; `allowNoExpiry` remains
accepted for compatibility but does not gate admission. Replacement keeps owner,
provider and source; a different supplier account is refused. The optional creation
requestId is a UUID, replayed for the same owner/provider for 24 hours, with a tombstone
after deletion. Replacement accepts an optional requestId and returns the durable
operationId for recovery; its committed cleanup warning does not ask for a new key.
Deleting the last own bound credential releases
that person's holding and orphan shares, preserving other holders and history.

z.ai expiry is `unknown`, distinct from confirmed `none` and `dated`. Owner credential
DTOs include `expiryKind` and `identityOrigin`; private source access includes
`expiryKind`. An unknown-expiry key requires `allowUnknownExpiry: true`, otherwise
`409 credential_expiry_confirmation` carries `{expiresAt: null, expiryKind: "unknown"}`.
Every new declared connection creates a separate owner-local source; it cannot select
or merge another source. Replacement requires `sameAccount: true` before any provider
call; missing consent gives `409 credential_account_confirmation`. It preserves the
source and history based on the owner's declaration, which z.ai does not verify.
Another account must use a new connection. Supplier identity checks remain required,
and supplier connectors reject declared-identity consent flags. Incorrect field types
and unsupported options give `400 credential_invalid`. A rejected z.ai key gives
`credential_auth_rejected`, without asserting revocation or expiry.

Hub cadence and refresh carry `by: "hub"`, with no device identity. Hub refresh
requires both board membership and a source holding; a shared reader without a holding
receives `403 refresh_forbidden`. Requests join an active job and share one source
cooldown of 60 seconds across boards and holders. Fixed measurement preferences retain
the existing interval choices. Permanent access failures disable automatic retries
until replacement, an available explicit refresh or restart.

The reader-only `sourceAccess` map contains only their own bound credential ids,
`expiryKind`, expiry and safe access error, plus whether the source can refresh. It never enters the
shared board cache. Other readers receive no entries. Shared card access failures are
neutral `unmeasured`; management keys, hints, encrypted bytes, raw creator ids and raw key hashes
are absent from every shared projection. Credential details remain owner-only. The sharing picker's `mine` rows may include
`accountLabel` for the reader's own declared accounts, joined through their holding;
`shared` rows and public card names never inherit that label.

## Privacy

Period and session projections expose only authorized board measurements and clipped
credited work. Opaque refs do not expose producer session ids or database row ids.
Current context is joined server-side only after an authorized stable identity match.
Private key labels are absent for other owners; raw meter context/state, owner ids,
credentials and private currency registries are never included. Currency results retain
only the selected measurement's permitted valuation provenance. Cursors confer no
capability and are rechecked after access, visibility or attribution changes.


Declared account IDs/names, connector credential records, hints, abilities and key fingerprints are never part of
a board's state. A source failure whose code begins with `secret_key_` or `credential_`
is projected as `unmeasured`, for its owner too; details remain in the owner's
credential API. Snapshot, source delta, long poll and desktop attention use this same
projection.

A reader hears exactly what the board's snapshot gives them: the same people, the same
cards, the same agents as the dashboard shows them, and of other boards only the list of
their own. What is theirs alone, which sources their devices measure and their role on
each board, goes to their streams only. Events carry no secrets, no email addresses and
no sign-in session ids.
History exposes each selected coding-agent session's time by cell, with its project and
machine. Its opaque eight-character reference is stable only within one board and one
start of the hub, derived with a fresh secret key; it reveals neither database session
ids nor how many sessions other boards have. These are coding-agent sessions, separate
from sign-in sessions. A restart changes the references and `run` together.
Metadata tokens are scoped to the board, hub instance and exact visible metadata.
They grant no access: every history request checks board membership and visibility
before deciding whether it may omit unchanged metadata.
The joining and sharing cutoff applies to history. For a running session the board is
allowed to list, its live `workedMs` includes retained credited work on its current
subscription across contexts, including before that history cutoff. Without reliable
session identity it is null, not a guessed zero. Unidentified history is never matched
by inference, and another subscription's work is never included. The opaque producer
ID is kept only in the hub's work ledger; no producer ID, raw native token, PID, boot
metadata or salt appears in board state, history, errors or logs.
Desktop observation barriers carry only source/window identifiers and corrected times
from those sources; they add no client output, credentials or provider identity.

While a board is read, the hub keeps in memory what its readers last got of each part,
and a lease's events until it is asked; it writes nothing of them to disk. A board nobody
reads costs nothing.

A forecast comes from the same samples the chart shows, and only for the board's
sources. To go on after a restart, the hub keeps on disk the last verdict of each weekly
window (whether it ran out, the moment and the share it said, whether it said "left",
and when), no names and nothing of people, as long as samples.

In local mode, so that the app tells of a limit once in each cycle of a window, a restart
included, the hub keeps on disk for each window its cycle, which of its thresholds it has
reached in it, and its last sample (what is left and used, the reset time, its kind, label
and length, when it was measured), with no end: the hub forgets no source it has measured.
For each provider it keeps when the latest scheduled reset it has learned of was
announced, and the links announced then, up to 64. Nothing of people.

## Desktop attention stream

In local mode a session may request `GET /api/events?desktop=1`, with the same
`Quotum-Stream: 1`, session, origin and resource limits as the board. This mode is
stream-only: combining it with `mode=poll`, or requesting it outside local mode,
returns `400 invalid_request`. A machine token does not grant access.

After `hello` and `snapshot` comes `attention`:

```ts
{
  seq: number; now: number; baseline: boolean;
  state: {
    boardId: string;
    level: 'ok' | 'warn' | 'crit' | null;
    quality: 'current' | 'partial' | 'unavailable';
    minimum: {sourceId: string; windowId: string; remaining: number} | null;
  };
  notifications: Candidate[];
  invalidations: {sourceId: string; windowId: string; at: number}[];
}
```

`seq` increases within this connection; `hello.epoch` identifies the hub start.
The first attention frame is a baseline, with no notifications or invalidations.
Observation boundaries are sent in an attention frame before the corresponding
board changes, with no notifications. A quota candidate observed before its window's
invalidation `at` must be discarded, including one already in a native queue.
These boundaries come from committed measurements: first observation, a gap or
recovery, changed window semantics, a confirmed reset, and disappearance or return.
They survive coalescing even when the final card looks like the earlier one.
When new notifications also exist, a second attention frame follows the board
changes, so their current names and visibility are already available. Both frames
have their own increasing `seq`. Without boundaries, the attention frame follows
the board changes as usual. The minimum includes only visible windows of
visible cards. Levels match the board: above 30 is ok, 10 through 30 warn, below 10
crit. Last known figures retain their level; missing, stale, failed or reset-past
measurements make their quality partial. No visible figures means unavailable,
never a fictitious full quota.

A quota candidate has `id`, `kind` (`low`, `critical`, `reset`), `at`,
`observedFrom`, `observedAt`, `sourceId`, `windowId`, `provider`, `name`,
`window: {kind, label, minutes}`, `remaining` and nullable `resetAt`.
`at` is the hub's receipt time; the observation times are the corrected sample
clocks, unchanged by batch delivery. Both observations must belong to the reader's
current baseline (`observedFrom >= baseline.now`, `observedAt > observedFrom`).
Thresholds are consumed once per confirmed window cycle, even while hidden or
notifications are disabled. A reset needs measurement evidence; a timer alone is
never a reset. One delivery gives at most one current notification per window,
keeping the most severe threshold, or the reset with the resulting remainder.

An announcement candidate has `id`, `kind: 'announcement'`, `at`, `provider`,
nullable `scheduledFor`, nullable `resetKind` (`regular` or `banked`), `credit:
{name, url}` and `url`. It describes a newly learned scheduled tracker event,
not proof that a subscription reset. The first successful tracker answer and
recovery after a failure are silent baselines. Names and links are data, never
instructions to the native host.

Candidates leave ingestion only after its transaction commits. They are not
reconstructed from coalesced card frames. Pending candidates and coalesced per-window
invalidations share the stream's buffer limit; overflow discards both and starts a new
attention baseline. Before emission, a quota candidate must still name the current
window semantics and ledger cycle. Changing kind, label or duration invalidates
pending candidates even if the old values return before the next flush. The desktop
also checks window semantics and its observation boundary after native queueing.
Disconnected readers retain no notification queue. There is
no replay through `Last-Event-ID`, after restart, or across a baseline. A crash
between consumption and native delivery may lose a notification; successful
native submission does not guarantee the operating system displayed it.

The full current key inventory is read through
`GET /api/boards/:board/sources/:source/keys?limit=50&after=<cursor>`.
Board membership and visible source are required; a member may read measurements.
The response is `{keys, meters, total, inventory, next}` with at most 50 keys. Total
counts retained current keys and does not promise supplier completeness. A cursor is
bound to source, ordering revision and this hub run. A changed ordering returns
`409 keys_changed`; a forged or mismatched cursor returns `400 invalid_request`.
No credential records enter this endpoint.

Alternatively, `ids` is a JSON array of 1–50 opaque key ids, mutually exclusive with
`after` and `limit`. It returns only those current keys and their meters in inventory
order, with `next: null`. Enabled scales beyond the preview use this bounded read when
their source changes; they never poll. Membership and source visibility still apply.
Chart settings show current and selected archived keys through the same pages of at
most ten keys. Selected current keys on other pages are not duplicated. An open page
reloads after a successful source measurement.

## Mixed Codex subscription and credit balance

Codex keeps one source/card with independent quota, reset and financial observations.
Authorized cards add `creditBalance: {id, unit, status, hasCredits?, at, staleAfterMs}`,
`resources: {windows?, resets?}` (each `{status, at, staleAfterMs}`; resets also retain `valueAt` and `valueStaleAfterMs` for the last reported count), and a native
`balance:credits` meter in `credits:codex`. Its `amount` is an exact signed integer
coefficient with per-value `scale` (0–18); absent scale means 6 for existing money.
Meter semantics and history retain scale; composed summaries carry `startScale` and
`endScale`. Conversion originals retain amount, scale and actual observation time.
Packed observation cells preserve all exclusive gaps and scale changes, including
within one cell. Retention and a requested crop do not change a sample's origin.

`budget: {enabled, since, anchor, revision}` describes financial authority on a board.
Personal boards allow it. Shared Codex sources default to disabled; existing wallet
providers retain complete historical access (`since=anchor=0`). Disabled finance
removes amounts, credit statuses, flags, histories and currency bindings from every
board projection and event. Quotas and free resets remain visible. `GET /api/boards/:board/shares`
includes `budget`; a member who holds the source may use
`PUT /api/boards/:board/shares/:source/budget` with `{enabled, expectedRevision}`.
A stale revision returns 409 `share_conflict`; repeating the current desired state
with the current revision is a no-op. Board ownership alone cannot grant funds.
Enablement sets `since` and clears `anchor`; the first accepted finite observation
at or after it stores the anchor and one durable reading even for an unchanged value.
Current last-known funds may predate consent and keep their actual timestamp, but
history admits no earlier evidence. Re-enabling starts over. Source addition items
may include `includeBudget: [sourceId, ...]`, a frozen, explicit subset of the selected
Codex sources included in the request's idempotency identity. Device selection alone
never grants financial access.

Native history cache identity includes the financial revision, cutoff and anchor.
Clients include those fields in their selection generation and discard revoked data
and late responses. Both scoped and legacy history endpoints enforce the same authority
before currency conversion, without substituting crop boundaries for admission.
Before delivering a prepared batch, the hub rechecks its financial authority. A
mismatch rebuilds the current snapshot, including the reader's currency context.
Poll leases also retain the authority of their last delivered dataset: an intervening
grant revision discards undelivered frames and returns a fresh snapshot, including
after a disable/re-enable cycle. Normal SSE updates keep the delta protocol; current
card grant metadata changes the client's financial history generation. Financial
invalidations exclude disabled or unadmitted grants and cannot precede the current
admission anchor.

`credits:codex` is an immutable builtin currency definition with `kind: provider-credit`.
It is convertible but cannot be selected as a display currency and uses none of the 64
personal definition slots. Currency management includes `builtins`. Its public immutable
`codex-default` quote is based on credits, dated 0 with unlimited validity, and has
rates `credits:codex=1000000`, `USD=40000`: one credit is estimated at 0.04 USD.
It is independent of the latest public FX quote and requires no network request.
The existing rate endpoint accepts `direction: basePerUnit` for an exact USD-per-credit
personal override; omitted direction retains the legacy `unitPerBase` contract.
Builtin updates require the ordinary revision and request receipt. A POST to
`/api/currencies/credits:codex/rates/default` appends a default-restoration event,
preserving old overrides and successful observation bindings. Overrides are private.

Valuation uses an existing binding first, otherwise exactly one current credit/USD
rate followed by the shared USD/display path (at most three legs), with one final
rounding. USD selection follows this contract too. There is no synthetic USD meter
for Codex: subscription-funds analytics select the native meter and request `currency=USD`
when appropriate. Provider history and spending do not change with exchange rates.
Cards and compact rows show Additional funds in the subscription footer beside free
resets, using the shared money renderer; unlimited, missing, unsupported, invalid, stale
and confirmed zero remain distinct. Hovering shows the exact native balance; the
disclosure adds the timestamp and rate provenance. A stale amount stays visible in
the warning colour as the last known balance. Subscription extra funds trends shows
credit history separately from wallet budgets. Spending and top-ups are unavailable
for credits, and quota analytics remain percentage-based.


## Private machine clients

Only the owner's personal snapshot has `ownSessions`, an array of running sessions
without a currently held source. Each session includes `clientId`, machine ID/name,
origin, project/folder, start, last work, working and credited `workedMs`; it contains no
producer ID, raw source attribution or provenance. Shared snapshots omit this field.
The private `ownSessions` event is `{sessions: [...]}` and replaces this slice only.
Normal source `sessions` also carry `clientId` and retain their visibility rules.

A personal `history` event may include `ownSince`, independently of `sources`, `since`
and scoped `changes`. The quota/activity reader invalidates from this cutoff even when
no sources are selected; budget and subscription funds readers ignore it. Private and
source history coalesce into one frame using their earliest independent cutoffs. No
synthetic source ID is used. Closed history tiles invalidate on private credit even
without watchers. Names, ownership and visibility changes invalidate from zero; quiet
presence expires on the usual five-minute deadline. Shared streams never receive this
private slice or cutoff, including when the owner is a member.

Personal quota history includes activity without cards. Unknown and unheld work uses a
null source in activity cells and the reserved `unknown` source group; it produces no
quota series, spending correlation or forecast. A held source under a hidden card keeps
its existing exclusion. The Agents and Agent activity widgets can be placed through
Add widget on empty or budget-only boards; explicit hiding remains authoritative.

`GET /api/devices` adds owner-private `clients` entries (`clientId`, nullable `version`,
`seenAt`) and current `sessions` with the safe board fields plus a held source ID or null.
Device revocation removes inventory and current presence. Inventory changes use the
existing connection revision. The account-private `devices` hint reaches the device
owner on any board, including a shared board, when current device presence changes or
expires. Other readers receive no hint. It carries no private board data and changes no
connection revision. An open Devices disclosure reads the owner API on this hint, on
reconnect and on opening; closed disclosures do not read on presence hints. Clients and
measuring settings are separate in desktop
`app_state`: `clients` has `id`, `enabled`, reserved `route` consent and nullable `path`;
`app_save_settings` accepts client enabled/route patches without a new bridge command.
With every collector disabled and tracking enabled, the agent state is `tracking`;
`idle` means both measurement and client tracking are off.
