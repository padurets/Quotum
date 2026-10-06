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
| `snapshot` | `{providers, sourceAccess, board, view, historyStart, sources, sessions, cadence, refresh, forecast, mine, boards, resets}` | Second: the board for this reader. |
| `board` | `{board: {id, name, personal}}` | The board was renamed. |
| `view` | `{view}` | The board's view was saved. |
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
else is refused. Stored views from before the grid can still contain `order`
and `sizes`, with an empty layout: the page translates them, including hidden or absent
widgets. Saving a view requires `layout`; the hub drops the old fields. A save is
limited to 64 KiB (65,536 UTF-8 bytes), so it fits the page's keepalive request when
leaving before the debounced save. There is no separate count limit on places; each
place is validated.

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
  known: {work: number, sources: Record<string, number>},
  chunks: Chunk[]
}
```

`known.work` is when the hub began keeping work. `known.sources` gives when each shown
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
      f?: number; l?: number; o?: number | null; g?: 1; h?: number;
      w?: [spent: number, covered: number, duringWork: number];
    }][];
  }[];
  activity: {
    sessions: [ref: string, source: string, project: string | null, device: string][];
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
| work (`w`) | `[spent, 0, 0]` at or after the subscription's known threshold, `[0, 0, 0]` before |

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
min(60, ceil(history length / cell / 4)) nearby whole cells in its direction. No
miss means no new speculative read. Unvisited optional cells remain charged after
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
resetAt, minutes, scope, label, at, staleAfterMs, stale}`. Kind is `counter`, `balance`
or `cap`; a cap's amount is used, its remaining is limit minus amount. A zero limit
has no percentage. All money fields are canonical decimal strings of whole millionths,
quantized once from the supplier's original decimal token, with nearest rounding and
halfway values away from zero. They use signed 64-bit SQLite integers; totals use exact
integer arithmetic and never combine units. A balance has no 100%.

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

`GET /api/history` additionally accepts `unit` and `meters`: a JSON array of at most
32 logical `[sourceId, meterId]` pairs, sorted and deduplicated. Sources must be visible
on the board. `balance` resolves its internal counter pair without spending extra
selection slots. Cache keys include the selection. Without these fields the existing
window protocol is unchanged. Each chunk may carry `meterSeries`, whose entries are
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
`steps`, `topupInternal` and `topupSteps`. Amounts remain strings throughout packing.
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
never zero. Existing events carry these additive fields; no currency settings form or native
bridge command is added. Original foreign-currency history stays available through the
measurement API, and existing development-layout converted history is retained.

Reader snapshots may include `currencies`, and a private `currencies` event updates it:

```ts
{
  target: {id, name, symbol, fractionDigits},
  definitions: [{id, name, symbol, fractionDigits}],
  revision?: string,
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

The hub issues personal identities. Names or symbols never identify or merge currencies.
Private operations use existing authentication and origin guards; errors carry only
`invalid_currency` or `currency_not_found`. These operations support the future settings
section without introducing provider-specific widgets or currency controls.

A frame that cannot fit losslessly in the history budget returns `413 history_limit`.

DeepSeek connections use owner-only `POST /api/credentials` with
`{provider: "deepseek", secret, account: {kind: "new", name} | {kind: "existing", id},
confirmSameAccount?, allowUnknownExpiry?, requestId?}`. Existing account selection
requires `confirmSameAccount: true` before provider work. Replacement accepts only
`{secret, confirmSameAccount: true, allowUnknownExpiry?}`. Its API cannot verify the
owner's identity declaration. Account names are normalized private labels, unique
per owner/provider, independent of immutable UUIDs and keys. A new account creates a
new source; last-key removal preserves identity and retained history for reconnection.
`GET /api/source-accounts?provider=deepseek&limit=1..50&after=<UUID>` returns owner-only
`{accounts: [{id, provider, name, sourceId, connected}], next}` in UUID order.
`expiryKind: "unknown"` is distinct from `none` and `at`. Saving unknown expiry requires
`allowUnknownExpiry: true`; a missing consent returns
`409 {error: "credential_expiry_confirmation", expiresAt: null, expiryKind: "unknown"}`.
The owner credential DTO includes `accountId`, `accountName` and `expiryKind`.
Creation replay binds owner, provider and account selector; changed targets conflict.
A last-binding withdrawal revision and current encryption-key epoch invalidate pending
creates, replacement and polls, including resets with no credentials.

OpenRouter connections use owner-only `POST /api/credentials` with `{provider, secret,
allowNoExpiry?, requestId?}` and replacement with `{secret, allowNoExpiry?}`. An access
without expiry requires explicit `allowNoExpiry: true`; otherwise the hub returns
`409 credential_expiry_confirmation` without writing. Replacement keeps owner, provider
and source; a different account is refused. The optional creation requestId is a UUID,
replayed for the same owner/provider for 24 hours, with a tombstone after deletion.
Replacement accepts no requestId. Deleting the last own bound credential releases
that person's holding and orphan shares, preserving other holders and history.

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
