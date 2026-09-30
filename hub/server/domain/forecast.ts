import type {Win} from './quota.js';

/**
 * Where the recent pace of a weekly window leads: the forecast of one series, a
 * subscription's window of one kind followed through its resets of any kind (a scheduled
 * one, a free reset, a reset for everyone). A pure function of the samples, the moment and
 * what the previous forecast of the window left (`Memory`): no clock, no database, no plan
 * and no agents' work. The hub works it out (server/forecasts.ts); the board words it.
 *
 * How it goes, in short:
 * - The samples are spread over ten-minute cells: what a window spent between two samples,
 *   evenly over the time between them. A gap with no change is idle time, a gap with a rise
 *   spreads the rise over it; hours when the window was used up do not count, nor does
 *   anything before a reset whose start was not seen.
 * - The pace is how the subscription usually spends by hour of day (UTC) over the last
 *   week of counted hours, at the level of its last 24 counted hours, and with two weeks of
 *   history, how its days of the week differ (never assumed: learned from what was spent).
 * - Under a day of history it is a straight line, leaning on the window's own mean for a
 *   window whose start the series saw or that is old enough.
 * - The line runs to the reset; the verdict (runs out, or what is left) holds with
 *   hysteresis, and the moment and the share shown move only past a dead band.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CELL = 10 * MINUTE;
const CELLS_PER_HOUR = HOUR / CELL;

/** Reset times this close are one window, as `edge` has it (domain/quota.ts); a memory's window and the weekly's censoring take the same. */
const TOLERANCE = 60_000;
/** A window whose start is at most this far before a sample has not started yet: its reset time is still the sample's time plus its length. */
const STARTED_AFTER = 2 * MINUTE;
/** A series saw its window start when the start is at most this before its first sample. */
const SAW_START = 10 * MINUTE;
/** A window at or above this is used up: hours spent waiting at zero are not the pace. */
const AT_ZERO = 99.5;

/** How far back the hub reads a series (server/forecasts.ts): the history, the day-of-week factor and a day to spare. */
export const READ_MS = 23 * DAY;

/** An hour counts with at least this many of its cells counted. */
const MIN_CELLS = 3;
/** The shape of the day is taken over up to this many counted hours, at most this many days back. */
const HISTORY_HOURS = 168;
const HISTORY_DAYS = 21;
/** The level: the last day's worth of counted hours. */
const LEVEL_HOURS = 24;
/** A series with less history says nothing; with less than a day it is cold (a straight line, never "left"). */
const SILENT_HOURS = 1;
const COLD_HOURS = 24;
/** The day-of-week factor: from the last complete days, a day counting with this many hours, given this many of them; not above this level. */
const DOW_DAYS = 21;
const DOW_MIN_DAYS = 14;
const DOW_MIN_HOURS = 12;
const DOW_GUARD = 3;
/** Under this, a pace is none: a straight line of a series that spends next to nothing. */
const NO_PACE = 0.01;
/** Less than this expected over the level's hours tells nothing of the level. */
const LEAST_EXPECTED = 0.5;
/** The cold start leans on the window's own mean from this age of the window... */
const BLEND_AFTER = 30 * MINUTE;
/** ...or, for a window whose start the series did not see, from this share of its length. */
const BLEND_SHARE = 1 / 20;

/** Runs out when at most this is left at the reset, and holds while at most this. */
const ENTER = -5;
const HOLD = 2;
/** The shown moment moves only when the new one is further than the larger of an hour and this share of the time to it. */
const ZERO_BAND = 0.2;
/** The shown share moves only when the new one is further than the larger of this and this much a day to the reset. */
const LEFT_BAND = 5;
const LEFT_BAND_PER_DAY = 2.5;
/** "Left" rather than "just enough" from the larger of this and this much a day to the reset. */
const COMFY = 5;
const COMFY_PER_DAY = 5;

/** A burst: the last six hours, at least three of them counted, at least twice as fast as usual. */
const BURST_HOURS = 6;
const BURST_MIN_HOURS = 3;
const BURST_TIMES = 2;

/** One value of a series: its reset time and length, null when the provider gave none. */
export type SeriesSample = {at: number; used: number; resetAt: number | null; minutes: number | null};

/**
 * What a forecast leaves the next one of the same window (`win`, its reset time): whether it
 * ran out (`out`), the moment it showed (`Z`), the share it showed (`X`) and whether it said
 * "left" (`comfy`, null when not known).
 */
export type Memory = {win: number; out: boolean; Z: number | null; X: number | null; comfy: boolean | null};

export type ForecastState = 'none' | 'needData' | 'usedUp' | 'awaiting' | 'runsOut' | 'lasts';

/** The last six hours ran `times` as fast as usual; at that pace the window runs out at `zero`. */
export type Burst = {times: number; zero: number};

/**
 * What a forecast rests on: `hours` of history; `cold` under a day of it; `usualPerDay`,
 * what the subscription usually spends a day; `lastDay`, the last day against the usual
 * (null for a straight line); a burst of the last hours.
 */
export type Basis = {hours: number; cold: boolean; usualPerDay: number; lastDay: number | null; burst: Burst | null};

/**
 * The forecast of a series at `asOf`, about the window resetting at `resetAt`: `anchor`,
 * its last sample (when and what was left); `F`, what is left at the reset (below zero when
 * it runs out before); `zero`, where the line crosses zero; `shownZero`, the moment shown
 * when it runs out; `shownLeft`, the share shown when it lasts; `comfy`, whether that is
 * "left" rather than "just enough"; `points`, the line from the anchor to the reset, not cut
 * at zero.
 */
export type SeriesForecast = {
  state: ForecastState;
  asOf: number;
  resetAt: number | null;
  anchor: {at: number; left: number} | null;
  F: number | null;
  zero: number | null;
  shownZero: number | null;
  shownLeft: number | null;
  comfy: boolean;
  points: [number, number][] | null;
  basis: Basis | {hours: number} | null;
};

export type ForecastInput = {
  /** The series in time order, from `READ_MS` before `asOf` and the last sample before that. */
  samples: SeriesSample[];
  /** The subscription's own weekly window over the same time, when this series is a model's window. */
  plan: SeriesSample[] | null;
  /** The plan change in effect (`planSince`): nothing before it counts. */
  since: number | null;
};

type Measured = {at: number; used: number; resetAt: number; minutes: number};
type Window = {resetAt: number; minutes: number; start: number};
/** Prefix sums over the counted cells: how many (`counted`) and what they spent (`spent`). */
type Cells = {t0: number; n: number; counted: Float64Array; spent: Float64Array};
/** A counted hour: when it began and its pace, %/h. */
type Hour = {t: number; pace: number};
type Rate = number | ((t: number) => number);

/**
 * Whether a window measured at `at` had started: an idle rolling window reports "now plus
 * its length" as its reset, so it has not while its start is that moment. The board's
 * `started` (ui/lib/plan.ts), with the same tolerance: the hub's code does not reach the
 * board's, and a test checks the two agree.
 */
export function started(window: {resetAt: number | null; minutes: number | null}, at: number): boolean {
  return !!window.resetAt && !!window.minutes && window.resetAt - window.minutes * MINUTE < at - STARTED_AFTER;
}

/** Whether a sample's window had begun: something spent, or started by its time. */
const begun = (s: Measured) => s.used > 0 || started(s, s.at);

/**
 * Why a window's cells cannot count now, as its card has it: the window used up
 * (`atZero`), or a model's window while the subscription's weekly window (the one without a
 * label) is used up and resets no earlier than it (`weeklyAtZero`). Such a series gains
 * no history until a reset. Null when they count. The board tells the same by a copy.
 */
export function uncounted(windows: readonly Win[], window: Win): 'atZero' | 'weeklyAtZero' | null {
  if (window.used >= AT_ZERO) return 'atZero';
  const weekly = subscriptionWeekly(windows);
  if (!weekly || weekly.id === window.id || weekly.resetAt === null || window.resetAt === null) return null;
  return weekly.used >= AT_ZERO && weekly.resetAt >= window.resetAt - TOLERANCE ? 'weeklyAtZero' : null;
}

/**
 * The subscription's own weekly window, which a model's windows are within: the weekly one
 * without a label (Claude's and Codex's `weekly`). Antigravity labels all of its windows and
 * has none.
 */
export const subscriptionWeekly = (windows: readonly Win[]): Win | null => windows.find(w => w.kind === 'weekly' && w.label === null) ?? null;

/** Whether `b` is in the window of `a`: `edge` of domain/quota.ts without its gap and correction, a drop of used being spending of none. */
function sameWindow(a: Measured, b: Measured): boolean {
  if (b.at >= a.resetAt + TOLERANCE) return false;
  // An idle rolling window's reset drifts forward with the clock: still the same window.
  const shift = b.resetAt - a.resetAt;
  return shift >= -TOLERANCE && shift <= b.at - a.at + TOLERANCE;
}

function windowsOf(samples: Measured[]): {windows: Window[]; of: number[]} {
  const windows: Window[] = [];
  const of: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (i === 0 || !sameWindow(samples[i - 1], s)) windows.push({resetAt: s.resetAt, minutes: s.minutes, start: 0});
    // A window is where its last sample says.
    const w = windows.at(-1)!;
    w.resetAt = s.resetAt;
    w.minutes = s.minutes;
    of.push(windows.length - 1);
  }
  for (const w of windows) w.start = w.resetAt - w.minutes * MINUTE;
  return {windows, of};
}

/**
 * The ten-minute cells of a series from the hour of its first sample up to `topAt`, as
 * prefix sums over those that count: seen, not at zero, and after the series' beginning.
 * Between two samples of a window what it spent is spread evenly; across a reset, what
 * went before it is unknown unless the samples are close to its start, and the new window's
 * use is spread from its start. A model's window is also not counted while the
 * subscription's weekly window (`plan`) is used up and resets no earlier than it.
 *
 * `young`: the series' whole life is in what was read. Then, when it spent nothing before
 * the first window it saw start (not started when first seen, or starting while watched),
 * its history begins with that window: idle time between connecting a subscription and
 * first using it is not its pace. A window on a schedule, or one begun before the series
 * was first seen, keeps the idle time before its first spending.
 */
function cellsOf(samples: Measured[], windows: Window[], of: number[], plan: Measured[] | null, topAt: number, young: boolean): Cells {
  const t0 = Math.floor(samples[0].at / HOUR) * HOUR;
  const n = Math.max(Math.ceil((samples.at(-1)!.at - t0) / CELL) + 2, Math.ceil((topAt - t0) / CELL) + 1);
  const spent = new Float64Array(n);
  const seen = new Uint8Array(n);
  const zero = new Uint8Array(n);
  // The reset times of the windows that filled each cell, for the weekly's censoring.
  const resets: number[][] | null = plan ? Array.from({length: n}, () => []) : null;
  const put = (from: number, to: number, delta: number, atZero: boolean, resetAt: number) => {
    if (to <= from) {
      const i = Math.floor((to - t0) / CELL);
      spent[i] += delta;
      seen[i] = 1;
      resets?.[i].push(resetAt);
      return;
    }
    for (let i = Math.floor((from - t0) / CELL); t0 + i * CELL < to; i++) {
      const a = Math.max(from, t0 + i * CELL);
      const b = Math.min(to, t0 + (i + 1) * CELL);
      if (b <= a) continue;
      spent[i] += (delta * (b - a)) / (to - from);
      seen[i] = 1;
      if (atZero) zero[i] = 1;
      resets?.[i].push(resetAt);
    }
  };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (of[i - 1] === of[i]) {
      put(a.at, b.at, Math.max(0, b.used - a.used), a.used >= AT_ZERO, windows[of[i]].resetAt);
      continue;
    }
    const start = windows[of[i]].start;
    // A new window that began well before the previous sample: its reset time went back
    // (or the provider's window was stale), and nothing tells when its use happened.
    if (start < a.at - CELL) continue;
    const from = Math.max(a.at, Math.min(b.at, start));
    // Up to a reset right after a sample the window was idle; after a longer gap, unknown.
    if (from - a.at <= CELL) put(a.at, from, 0, a.used >= AT_ZERO, windows[of[i - 1]].resetAt);
    put(from, b.at, b.used, false, windows[of[i]].resetAt);
  }

  if (plan && resets) {
    for (let j = 1; j < plan.length; j++) {
      const p = plan[j - 1];
      const q = plan[j];
      if (p.used < AT_ZERO || !sameWindow(p, q)) continue;
      for (let i = Math.max(0, Math.floor((p.at - t0) / CELL)); i < n && t0 + i * CELL < q.at; i++) {
        if (Math.min(q.at, t0 + (i + 1) * CELL) <= Math.max(p.at, t0 + i * CELL)) continue;
        // Claude resets the weekly and a model's window together: equal times are the usual case.
        if (resets[i].some(resetAt => p.resetAt >= resetAt - TOLERANCE)) zero[i] = 1;
      }
    }
  }

  let from = 0;
  if (young) {
    const first = samples[0];
    if (!begun(first)) {
      // Seen not started: the history begins with the first window that started.
      const k = samples.findIndex(begun);
      from = k > 0 ? Math.floor((samples[k].resetAt - samples[k].minutes * MINUTE - t0) / CELL) : n;
    } else {
      // The first window the series saw start and that started; nothing spent before it, nothing before it counts.
      const j = windows.findIndex((w, index) => w.start >= first.at - SAW_START && samples.some((s, i) => of[i] === index && begun(s)));
      if (j >= 0) {
        const boundary = Math.max(0, Math.floor((windows[j].start - t0) / CELL));
        // The cell the window begins in is left out: with a start inside it, it holds the first spending already.
        let before = 0;
        for (let i = 0; i < boundary && i < n; i++) if (seen[i] && !zero[i]) before += spent[i];
        if (!(before > 0)) from = boundary;
      }
    }
  }

  const counted = new Float64Array(n + 1);
  const total = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const counts = seen[i] && !zero[i] && i >= from ? 1 : 0;
    counted[i + 1] = counted[i] + counts;
    total[i + 1] = total[i] + (counts ? spent[i] : 0);
  }
  return {t0, n, counted, spent: total};
}

/** The hour ending at cell `h`, if counted. */
function hourAt(c: Cells, h: number): Hour | null {
  const counted = c.counted[h] - c.counted[h - CELLS_PER_HOUR];
  if (counted < MIN_CELLS) return null;
  return {t: c.t0 + (h - CELLS_PER_HOUR) * CELL, pace: ((c.spent[h] - c.spent[h - CELLS_PER_HOUR]) * CELLS_PER_HOUR) / counted};
}

/** Counted hours back from cell `top` (an hour's end), newest first. */
function hoursBack(c: Cells, top: number, most: number, days: number): Hour[] {
  const hours: Hour[] = [];
  for (let h = top; h - CELLS_PER_HOUR >= 0 && hours.length < most && top - h < days * 24 * CELLS_PER_HOUR; h -= CELLS_PER_HOUR) {
    const hour = hourAt(c, h);
    if (hour) hours.push(hour);
  }
  return hours;
}

/** The mean pace of the last day's worth of counted cells before cell `top` (all there are when fewer). */
function straight(c: Cells, top: number): number {
  const need = LEVEL_HOURS * CELLS_PER_HOUR;
  let from = 0;
  if (c.counted[top] - c.counted[0] > need) {
    let low = 0;
    let high = top;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (c.counted[top] - c.counted[middle] >= need) low = middle;
      else high = middle;
    }
    from = low;
  }
  const counted = c.counted[top] - c.counted[from];
  const pace = counted > 0 ? ((c.spent[top] - c.spent[from]) * CELLS_PER_HOUR) / counted : 0;
  return pace > NO_PACE ? pace : 0;
}

const hourOfDay = (t: number) => Math.floor(t / HOUR) % 24;
/** Monday is 0: the epoch began on a Thursday. */
const dayOfWeek = (t: number) => (Math.floor(t / DAY) + 3) % 7;
const sum = (values: readonly number[]) => values.reduce((total, x) => total + x, 0);

/** How a subscription spends by hour of day (UTC), each hour leaning on the mean of all: %/h. */
function shapeOf(hours: readonly Hour[]): number[] {
  const byHour = Array.from({length: 24}, () => ({pace: 0, n: 0}));
  for (const hour of hours) {
    const k = byHour[hourOfDay(hour.t)];
    k.pace += hour.pace;
    k.n++;
  }
  const mean = hours.length ? sum(hours.map(h => h.pace)) / hours.length : 0;
  return byHour.map(k => (k.pace + mean) / (k.n + 1));
}

/**
 * How days of the week differ, from the last complete UTC days before cell `top` with
 * enough counted hours, shrunk towards 1 as far as days of the same weekday differ among
 * themselves (empirical Bayes); null with too few days.
 */
function dayFactors(c: Cells, top: number): number[] | null {
  const today = Math.floor((c.t0 + top * CELL) / DAY);
  const totals = new Map<number, {pace: number; n: number}>();
  for (let h = top; h - CELLS_PER_HOUR >= 0; h -= CELLS_PER_HOUR) {
    const day = Math.floor((c.t0 + (h - CELLS_PER_HOUR) * CELL) / DAY);
    if (day >= today) continue;
    if (day < today - DOW_DAYS) break;
    const hour = hourAt(c, h);
    if (!hour) continue;
    const total = totals.get(day) ?? {pace: 0, n: 0};
    total.pace += hour.pace;
    total.n++;
    totals.set(day, total);
  }
  const days = [...totals].filter(([, t]) => t.n >= DOW_MIN_HOURS).map(([day, t]) => ({day, pace: t.pace / t.n}));
  if (days.length < DOW_MIN_DAYS) return null;
  const average = sum(days.map(d => d.pace)) / days.length;
  if (average < 1e-6) return null;
  const byWeekday: number[][] = Array.from({length: 7}, () => []);
  for (const {day, pace} of days) byWeekday[(day + 3) % 7].push(pace / average);
  const means = byWeekday.map(v => (v.length ? sum(v) / v.length : 1));
  const present = byWeekday.flatMap((v, i) => (v.length ? [i] : []));
  let within = 0;
  let freedom = 0;
  for (const i of present) {
    for (const x of byWeekday[i]) within += (x - means[i]) ** 2;
    freedom += byWeekday[i].length - 1;
  }
  const spread = freedom > 0 ? within / freedom : 0;
  const grand = sum(present.map(i => means[i])) / present.length;
  const between = present.length > 1 ? sum(present.map(i => (means[i] - grand) ** 2)) / (present.length - 1) : 0;
  const perDay = sum(present.map(i => byWeekday[i].length)) / present.length;
  const differ = Math.max(0, between - spread / perDay);
  const factors = new Array<number>(7).fill(1);
  for (const i of present) {
    const noise = spread / byWeekday[i].length;
    const weight = differ + noise > 0 ? differ / (differ + noise) : 1;
    factors[i] = 1 + weight * (means[i] - 1);
  }
  return factors;
}

/**
 * The pace up to cell `top`: the shape of the day at the level of the last day, with the
 * day-of-week factor when the history allows and the level is not far above the usual (then
 * the weeks behind are another regime); a straight line up to cell `lineTop` while the
 * history is under a day or tells nothing of the level.
 */
function paceOf(c: Cells, top: number, lineTop: number) {
  const hours = hoursBack(c, top, HISTORY_HOURS, HISTORY_DAYS);
  const shape = shapeOf(hours);
  const usualPerDay = sum(shape);
  let actual = 0;
  let expected = 0;
  for (const hour of hours.slice(0, LEVEL_HOURS)) {
    actual += hour.pace;
    expected += shape[hourOfDay(hour.t)];
  }
  if (hours.length < LEVEL_HOURS || expected < LEAST_EXPECTED) return {rate: straight(c, lineTop) as Rate, hours, usualPerDay, lastDay: null};
  const level = actual / expected;
  const byHour = (t: number) => shape[hourOfDay(t)] * level;
  // The last day against the usual is the level of the shape alone, so both lines of the hint mean the same "usual".
  const plain = {rate: byHour as Rate, hours, usualPerDay, lastDay: level};
  if (level > DOW_GUARD) return plain;
  const factors = dayFactors(c, top);
  if (!factors) return plain;
  const usual = (t: number) => shape[hourOfDay(t)] * factors[dayOfWeek(t)];
  // The level reaches back at least a day, and until one ordinary day was expected.
  let actualDays = 0;
  let expectedDays = 0;
  for (let i = 0; i < hours.length; i++) {
    if (i >= LEVEL_HOURS && expectedDays >= usualPerDay) break;
    actualDays += hours[i].pace;
    expectedDays += usual(hours[i].t);
  }
  if (expectedDays < LEAST_EXPECTED) return plain;
  const levelDays = actualDays / expectedDays;
  return {...plain, rate: ((t: number) => usual(t) * levelDays) as Rate};
}

/** The line from what is left at `at` to the window's reset: a vertex on every hour (at every day of the window for a straight line). */
function project(window: Window, at: number, left: number, rate: Rate) {
  const points: [number, number][] = [[at, left]];
  let t = at;
  let value = left;
  let zero: number | null = null;
  while (t < window.resetAt) {
    const dayEnd = Math.min(window.resetAt, window.start + (Math.floor((t - window.start) / DAY) + 1) * DAY);
    const next = typeof rate === 'number' ? dayEnd : Math.min(dayEnd, Math.floor(t / HOUR) * HOUR + HOUR);
    const pace = typeof rate === 'number' ? rate : rate(t);
    const after = value - (pace * (next - t)) / HOUR;
    if (zero === null && after <= 0 && value > 0) zero = t + (value / pace) * HOUR;
    t = next;
    value = after;
    points.push([t, value]);
  }
  return {points, zero, F: value};
}

/**
 * The last six hours before `topAt` against the usual for those hours: the shape without
 * them, an hour's usual no less than the average hour (a little spending in a usually quiet
 * hour is no burst). Null unless twice as fast and running out before the reset at it.
 */
function burstOf(c: Cells, top: number, topAt: number, hours: Hour[], anchor: {at: number; left: number}, resetAt: number): Burst | null {
  const recent: Hour[] = [];
  for (let h = top; h > top - BURST_HOURS * CELLS_PER_HOUR && h - CELLS_PER_HOUR >= 0; h -= CELLS_PER_HOUR) {
    const hour = hourAt(c, h);
    if (hour) recent.push(hour);
  }
  if (recent.length < BURST_MIN_HOURS) return null;
  const shape = shapeOf(hours.filter(h => h.t < topAt - BURST_HOURS * HOUR));
  const average = sum(shape) / 24;
  const spent = sum(recent.map(h => h.pace));
  const expected = sum(recent.map(h => Math.max(shape[hourOfDay(h.t)], average)));
  // After a week of nothing the usual is nothing, and any spending would be infinitely fast.
  if (expected < LEAST_EXPECTED) return null;
  const times = spent / expected;
  const pace = spent / recent.length;
  if (!(pace > NO_PACE)) return null;
  const zero = anchor.at + (anchor.left / pace) * HOUR;
  return times >= BURST_TIMES && zero < resetAt ? {times, zero} : null;
}

/**
 * The forecast of a series at `asOf` (at most its last sample's hour's end is taken as
 * whole), carrying `memory` from the previous forecast of the same window.
 */
export function forecastOf({samples: all, plan, since}: ForecastInput, asOf: number, memory: Memory | null): {forecast: SeriesForecast; memory: Memory | null} {
  const quiet = (state: ForecastState, resetAt: number | null, anchor: SeriesForecast['anchor'], basis: SeriesForecast['basis'] = null) => ({
    forecast: {state, asOf, resetAt, anchor, F: null, zero: null, shownZero: null, shownLeft: null, comfy: false, points: null, basis},
    // A sample without a reset time tells nothing of the window, and must not wipe what the last forecast holds.
    memory: resetAt === null ? memory : {win: resetAt, out: false, Z: null, X: null, comfy: null},
  });

  const read = all.filter(s => s.at <= asOf && (since === null || s.at >= since));
  const last = read.at(-1);
  if (!last || last.resetAt === null || last.minutes === null) return quiet('none', null, null);
  // A sample without a reset time or length (Antigravity's Claude pool, Claude now and then) has no window to count in.
  const samples = read.filter((s): s is Measured => s.resetAt !== null && s.minutes !== null);
  const {windows, of} = windowsOf(samples);
  const window = windows.at(-1)!;
  const anchor = {at: last.at, left: 100 - last.used};
  if (asOf > window.resetAt) return quiet('awaiting', window.resetAt, anchor);
  if (anchor.left <= 0) return quiet('usedUp', window.resetAt, anchor);

  // Whole hours up to the end of the anchor's, but no later than asOf: an hour's forecast
  // stands on a sample a moment before the hour, and an instant one on a part of an hour.
  const topAt = Math.min(Math.floor(asOf / HOUR), Math.ceil(anchor.at / HOUR)) * HOUR;
  const weekly = plan?.filter((s): s is Measured => s.at <= asOf && s.resetAt !== null && s.minutes !== null) ?? null;
  // The series' first sample read, a null one too: whether its whole life was read.
  const c = cellsOf(samples, windows, of, weekly, topAt, read[0].at >= asOf - READ_MS);
  const top = Math.round((topAt - c.t0) / CELL);
  // What history there is up to the anchor, its partial cell included: a new series speaks
  // an hour after its first sample whatever the minute, and an instant forecast counts the
  // part of the hour it stands on.
  const upTo = Math.max(Math.min(c.n, Math.ceil((anchor.at - c.t0) / CELL)), top);
  const hours = (c.counted[upTo] - c.counted[0]) / CELLS_PER_HOUR;
  if (hours < SILENT_HOURS) return quiet('needData', window.resetAt, anchor, {hours});

  const pace = paceOf(c, top, upTo);
  let rate = pace.rate;
  const cold = hours < COLD_HOURS;
  if (cold && typeof rate === 'number') {
    // Under a day of history the line leans on the window's own mean: fully at first, less as the history grows.
    const elapsed = anchor.at - window.start;
    const long = Math.max(BLEND_AFTER, window.minutes * MINUTE * BLEND_SHARE);
    // A window the series saw start is its own history from the first half hour; one begun before, only once old enough to tell.
    const saw = window.start >= samples[0].at - SAW_START;
    if (elapsed >= (saw ? BLEND_AFTER : long)) {
      const weight = hours / (hours + COLD_HOURS);
      const blended = weight * rate + ((1 - weight) * last.used) / (elapsed / HOUR);
      // A young window's mean is only a floor: with whole percents it reads 0 for the first
      // hour, and would push aside a pace the series knows from before the reset.
      rate = saw && elapsed < long ? Math.max(rate, blended) : blended;
    }
  }
  const line = project(window, anchor.at, anchor.left, rate);
  const {F} = line;

  const kept = memory && Math.abs(memory.win - window.resetAt) <= TOLERANCE ? memory : null;
  const out = (line.zero !== null && F <= ENTER) || (!!kept?.out && F <= HOLD);
  let Z: number | null = null;
  if (out) {
    // Held while a little is left at the reset, the line may not reach zero before it.
    const zero = line.zero ?? window.resetAt;
    // A moment already past is not held: a new sample says it did not run out then.
    Z = kept?.out && kept.Z !== null && kept.Z > asOf ? kept.Z : null;
    if (Z === null || Math.abs(zero - Z) > Math.max(HOUR, ZERO_BAND * Math.max(0, zero - asOf))) Z = zero;
  }
  const days = (window.resetAt - asOf) / DAY;
  const X = out ? null : kept && kept.X !== null && Math.abs(F - kept.X) < Math.max(LEFT_BAND, LEFT_BAND_PER_DAY * days) ? kept.X : Math.round(F / 5) * 5;
  // "Left" holds while F stays within a day's worth of whole percents of the line, as the
  // level of a day moves F by one for every day to the reset with each percent. A cold series never says it.
  const band = Math.max(COMFY, COMFY_PER_DAY * days);
  const comfy = out || cold ? false : kept?.comfy === true ? F >= band - days : kept?.comfy === false ? F >= band + days : F >= band;
  const burst = cold ? null : burstOf(c, top, topAt, pace.hours, anchor, window.resetAt);
  return {
    forecast: {
      state: out ? 'runsOut' : 'lasts',
      asOf,
      resetAt: window.resetAt,
      anchor,
      F,
      zero: line.zero,
      shownZero: Z,
      shownLeft: X,
      comfy,
      points: line.points,
      basis: {hours, cold, usualPerDay: pace.usualPerDay, lastDay: typeof rate === 'number' ? null : pace.lastDay, burst},
    },
    memory: {win: window.resetAt, out, Z, X, comfy},
  };
}

/** A subscription's plan as it was reported from `at` on (store: `events` of kind `plan`, a row at each change). */
export type PlanChange = {at: number; plan: string};

/**
 * Since when the plan in effect at `asOf` holds, from the rows of the changes in time
 * order: null for the first plan. A change counts once it held for an hour, so a plan
 * reported otherwise for a moment starts nothing anew; one `asOf` always gives one answer.
 */
export function planSince(rows: readonly PlanChange[], asOf: number): number | null {
  const known = rows.filter(r => r.at <= asOf);
  let effective = known[0]?.plan;
  let since: number | null = null;
  for (let i = 1; i < known.length; i++) {
    const row = known[i];
    if (row.plan === effective) continue;
    const until = known[i + 1]?.at ?? asOf;
    if (until - row.at >= HOUR) {
      effective = row.plan;
      since = row.at;
    }
  }
  return since;
}
