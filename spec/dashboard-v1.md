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

No link, frame or cross-site request can set `Quotum-Stream`, while the page's own
`fetch` does without a preflight: so only the hub's page takes a reader's place, also on
plain http, where browsers send no `Sec-Fetch-Site`. `HEAD` opens nothing.

A stream is answered `200` with `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-store`, `X-Accel-Buffering: no` and `Connection: close`, besides the
security headers of every answer.

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
| `snapshot` | `{board, view, historyStart, sources, sessions, cadence, mine, boards, resets}` | Second: the board for this reader. |
| `board` | `{board: {id, name, personal}}` | The board was renamed. |
| `view` | `{view}` | The board's view was saved. |
| `lineup` | `{sources: string[]}` | The board's sources, in order, changed. |
| `card` | a card | A source's state changed. |
| `sessions` | `{id, sessions}` | The agents running on a source, on the machines of its people on this board, changed. |
| `cadence` | `{id, cadence}` | When a source is measured next, or why, changed. |
| `mine` | `{sources: string[]}` | Which sources of the board the reader's devices measure changed. |
| `boards` | `{boards}` | The reader's boards changed: made, deleted, renamed, joined, left. |
| `history` | `{sources: string[], since}` | These sources have measurements taken at `since` or later that the chart has not shown. |
| `resets` | `{resets, trackers, past}` | The reset trackers' news changed. |
| `ping` | `{now}` | Every `heartbeatMs`, with the hub's clock. |
| `bye` | `{reason}` | Last: the hub lets the reader go (see below). |

In a `snapshot`, `sources` are the cards of the board's sources in its order; `sessions`
and `cadence` are by source id, for those sources only. `board` is `{id, name,
personal}`; the reader's role is in `boards`, each `{id, name, personal, role}`, as it is
theirs alone. `resets` is what `GET /api/resets` answers. `historyStart` is when the
board's history begins as of the snapshot; `GET /api/history` tells it later.

A card is `{id, provider, plan, successAt, error, stale, windows, resets, owners,
staleAfterMs}`: as the overview's sources, without `sessions`, `cadence` and `mine`.
`stale` is the hub's to say, and it says so: a card sent when its numbers get too old.

Each event carries its part whole; the page puts it in place of what it had. What changes
at the same moment goes out together, in this order: `board`, `view`, the sources'
`card`, `sessions` and `cadence` (sources new to the board before `lineup`), `lineup`,
`mine`, `boards`, `history`, `resets`. A part goes out only when it differs from what the
reader last got; a change reaches the page within a tenth of a second. What changes with
time alone (a card going stale, a machine's list of agents no longer shown, a holder
falling silent, a past reset leaving the history) goes out when it does.

`bye` tells why the reader is let go, and the connection ends:

| `reason` | Why | What the page does |
|---|---|---|
| `unauthorized` | The session ended: signed out, a new password, expired. | Signs in again. |
| `gone` | The board was deleted, or the reader is no longer on it. | Opens another board. |
| `restart` | The hub stops. | Connects again in a few seconds. |
| `limit` | A newer reader took its place, or it fell 256 KiB behind. | Connects again, not sooner than in 30 seconds. |

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

## Privacy

A reader hears exactly what the board's snapshot gives them: the same people, the same
cards, the same agents as the dashboard shows them, and of other boards only the list of
their own. What is theirs alone, which sources their devices measure and their role on
each board, goes to their streams only. Events carry no secrets, no email addresses and
no session ids.

While a board is read, the hub keeps in memory what its readers last got of each part,
and a lease's events until it is asked; it writes nothing of them to disk. A board nobody
reads costs nothing.
