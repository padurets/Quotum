import {drain, type Preparation} from './prepare';
import type {ForecastBasis, SeriesForecast, Win} from './types';
import type {Line} from './lines';
import type {Resets} from './resets';
import {PLAN_TOLERANCE, planAt, started, type WeeklyPlan} from './plan';
import {IN_HOURS_UNDER, countdown, countdownChangesAt, earliest, num, rateText, shareText, stamp} from './format';
import {t} from '../i18n';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A pace slower than this (percent per hour) spends nothing worth foreseeing. */
const MIN_RATE = 0.01;
/** How far (points) from spending all of it by the reset a five-hour window still counts as just enough, either way: shares come in whole percents. */
const ON_PACE = 5;
/** Reset times this close are one window, as the hub has it. */
const TOLERANCE = 60_000;
/** A window at or above this is used up: the hub counts none of its time. */
const AT_ZERO = 99.5;
/** "Left" is said from this share: the share shown holds within a dead band, and may stand at 0. */
const LEAST_LEFT = 5;

/**
 * Where a window leads, as the table's last column says it, and in which tone: nothing to
 * say (`none`), a rolling window not started yet (`idle`), too little history to tell
 * (`needData`, and for a weekly window why: `hour`, less than an hour of it; `atZero`, its
 * window used up; `weeklyAtZero`, its subscription's weekly window used up), the hub
 * working it out anew (`renewing`) or failing to (`unavailable`), its reset gone by
 * unmeasured (`awaiting`), used up, due to have run out already at `at` with no
 * measurement since (`pastZero`), runs out at `at`, just enough, or `left` points left at
 * the reset. A five-hour window also tells its pace since it started (`rate`, %/h).
 */
export type NeedData = 'hour' | 'atZero' | 'weeklyAtZero';
export type Outlook =
  | {key: 'none' | 'idle' | 'renewing' | 'unavailable' | 'awaiting'; tone: ''}
  | {key: 'needData'; tone: ''; why?: NeedData}
  | {key: 'usedUp'; tone: 'v-crit'}
  | {key: 'pastZero'; at: number; tone: ''}
  | {key: 'runsOut'; at: number; inMs: number; tone: 'v-crit' | 'v-warn'; rate?: number}
  | {key: 'pace'; tone: ''; rate?: number}
  | {key: 'left'; left: number; tone: ''; rate?: number};

/**
 * What a window's cell weighs besides the window and its forecast: its card's windows (a
 * model's window is used up with its subscription's weekly one), its free resets, and a
 * reset for everyone announced that no measurement has seen yet (`announcedOf`).
 */
export type Context = {windows: readonly Win[]; freeResets: number; announced: number | null};

const NONE: Outlook = {key: 'none', tone: ''};
const IDLE: Outlook = {key: 'idle', tone: ''};
const RENEWING: Outlook = {key: 'renewing', tone: ''};
const AWAITING: Outlook = {key: 'awaiting', tone: ''};

/**
 * Why a window's time cannot count towards its forecast now, as its card has it: the
 * hub's `uncounted` (server/domain/forecast.ts), copied, as the hub's code and the board's
 * do not reach each other; a test checks the two agree.
 */
export function uncounted(windows: readonly Win[], window: Win): 'atZero' | 'weeklyAtZero' | null {
  if (window.used >= AT_ZERO) return 'atZero';
  const weekly = windows.find(w => w.kind === 'weekly' && w.label === null);
  if (!weekly || weekly.id === window.id || weekly.resetAt === null || window.resetAt === null) return null;
  return weekly.used >= AT_ZERO && weekly.resetAt >= window.resetAt - TOLERANCE ? 'weeklyAtZero' : null;
}

/**
 * The reset for everyone a provider's tracker announced for a time, when no measurement
 * has seen it yet (made at `measuredAt`, before it): until one does, the limit may well
 * be back sooner than a forecast says. A banked reset is one to use later, not a reset.
 * The news is read as the hub tells it, whatever this browser shows of it.
 */
export function announcedOf(resets: Resets | null | undefined, provider: string, measuredAt: number | null): number | null {
  const scheduled = provider === 'claude' || provider === 'codex' ? resets?.[provider]?.scheduled : null;
  if (!scheduled || scheduled.scheduledFor === null || scheduled.kind === 'banked' || measuredAt === null) return null;
  return measuredAt < scheduled.scheduledFor ? scheduled.scheduledFor : null;
}

const isBasis = (basis: SeriesForecast['basis']): basis is ForecastBasis => !!basis && 'cold' in basis;

/** A share a day as the tooltip says it: roughly, but "< 1" under half a point and "0" for none. */
const perDay = (value: number) => {
  const text = shareText(value);
  return text === '< 1' || value === 0 ? text : `~${text}`;
};

/** A weekly window's forecast line as moments: [time, left], from its anchor to the reset. */
export const lineOf = (ahead: SeriesForecast): [number, number][] =>
  ahead.points && ahead.anchor ? ahead.points.map(([minutes, left]): [number, number] => [ahead.anchor!.at + minutes * MINUTE, left]) : [];

function* linePrepared(ahead: SeriesForecast): Preparation<[number, number][]> {
  const result: [number, number][] = [];
  if (ahead.points && ahead.anchor) for (const [minutes, left] of ahead.points) {result.push([ahead.anchor.at + minutes * MINUTE, left]); yield;}
  return result;
}

/** Value of a line at `at`, within it. */
function* valuePrepared(points: [number, number][], at: number): Preparation<number> {
  for (let i = 1; i < points.length; i++) {
    yield;
    const [t0, v0] = points[i - 1];
    const [t1, v1] = points[i];
    if (at <= t1) return t1 === t0 ? v1 : v0 + ((v1 - v0) * (at - t0)) / (t1 - t0);
  }
  return points.at(-1)![1];
}

/** The first moment a line reaches zero, or null when it lasts until its end. */
function* zeroPrepared(points: [number, number][]): Preparation<number | null> {
  for (let i = 1; i < points.length; i++) {
    yield;
    const [t0, v0] = points[i - 1];
    const [t1, v1] = points[i];
    if (v1 <= 0) return v0 <= 0 ? t0 : t0 + ((t1 - t0) * v0) / (v0 - v1);
  }
  return null;
}

/**
 * A weekly window's line as the chart draws it. Within its hour the hub's forecast stands on
 * the sample of the hour's start: when the card has measured since, the line starts at its
 * last value and goes on in the same shape, moved by as much, so it neither starts above nor
 * below what the card says. Its zero is the moved line's; the moment the table says stays
 * the hub's.
 */
export function* weeklyLinePrepared(ahead: SeriesForecast, left: number, measuredAt: number | null): Preparation<{points: [number, number][]; zero: number | null}> {
  const points = yield* linePrepared(ahead);
  if (!points.length || measuredAt === null || measuredAt <= points[0][0] || measuredAt >= points.at(-1)![0]) return {points, zero: ahead.zero};
  const by = left - (yield* valuePrepared(points, measuredAt));
  const moved: [number, number][] = [[measuredAt, left]];
  for (const [t, value] of points) {if (t > measuredAt) moved.push([t, value + by]); yield;}
  return {points: moved, zero: yield* zeroPrepared(moved)};
}

/** Louder than a warning only when nothing may bring the limit back first: never in a series' first day, with free resets to use, or before an announced reset. */
const capped = (ahead: SeriesForecast, at: number, context: Context) =>
  (isBasis(ahead.basis) && ahead.basis.cold) || context.freeResets > 0 || (context.announced !== null && context.announced < at);

/**
 * A weekly window as the hub foresees it. What depends on the clock is the board's: the
 * tone, how soon, a moment passed with no measurement since. While the hub's forecast is of
 * another window, or of none, it is working it out anew on the measurement the card shows.
 */
function weekly(live: Win & {resetAt: number}, measuredAt: number, now: number, ahead: SeriesForecast | null, context: Context): Outlook {
  if (ahead?.state === 'none' && ahead.failed) return {key: 'unavailable', tone: ''};
  if (!ahead || ahead.state === 'none' || ahead.resetAt === null || Math.abs(ahead.resetAt - live.resetAt) > TOLERANCE) return RENEWING;
  switch (ahead.state) {
    case 'needData':
      return {key: 'needData', tone: '', why: uncounted(context.windows.length ? context.windows : [live], live) ?? 'hour'};
    case 'usedUp':
    case 'awaiting':
      // The card has something left before its reset: the hub works it out again on that measurement.
      return RENEWING;
    case 'runsOut': {
      const at = ahead.shownZero!;
      // The moment came with no measurement since: it probably ran out. With one since, the hub works it out again.
      if (at <= now) return measuredAt < at ? {key: 'pastZero', at, tone: ''} : RENEWING;
      const loud = at - now < (live.resetAt - now) / 2 && !capped(ahead, at, context);
      return {key: 'runsOut', at, inMs: at - now, tone: loud ? 'v-crit' : 'v-warn'};
    }
    case 'lasts':
      return ahead.comfy && ahead.shownLeft !== null && ahead.shownLeft >= LEAST_LEFT ? {key: 'left', left: ahead.shownLeft, tone: ''} : {key: 'pace', tone: ''};
  }
}

/** How long a five-hour window must have run before its pace means something: half an hour, or a twentieth of the window. */
const forecastFrom = (minutes: number) => Math.max(30 * MINUTE, (minutes * MINUTE) / 20);

/**
 * A five-hour window, as it always was: at its pace since it started (idle hours too), from
 * the moment it was measured to its reset, a straight line not clamped at zero.
 */
function session(live: Win & {resetAt: number; minutes: number}, measuredAt: number, now: number): {outlook: Outlook; points?: [number, number][]; zero?: number | null} {
  if (measuredAt - (live.resetAt - live.minutes * MINUTE) < forecastFrom(live.minutes)) return {outlook: {key: 'needData', tone: ''}};
  const rate = (100 - live.remaining) / ((measuredAt - (live.resetAt - live.minutes * MINUTE)) / HOUR);
  const falls = rate > MIN_RATE ? rate : 0;
  const points: [number, number][] = [
    [measuredAt, live.remaining],
    [live.resetAt, live.remaining - (falls * (live.resetAt - measuredAt)) / HOUR],
  ];
  const zero = zeroOf(points);
  // The moment is absolute: a measurement some time ago foresees it as well until then.
  if (zero !== null && zero <= now) return {outlook: {key: 'pastZero', at: zero, tone: ''}};
  const left = points[1][1];
  const shown = {points, zero};
  if (Math.abs(left) < ON_PACE) return {outlook: {key: 'pace', tone: '', rate}, ...shown};
  if (left <= -ON_PACE && zero !== null) return {outlook: {key: 'runsOut', at: zero, inMs: zero - now, tone: zero - now < (live.resetAt - now) / 2 ? 'v-crit' : 'v-warn', rate}, ...shown};
  return {outlook: {key: 'left', left, tone: '', rate}, ...shown};
}

/** What the card says at once, before any forecast: its reset gone by, used up, no reset time, not started. */
function known(live: Win | undefined, measuredAt: number | null, now: number): Outlook | null {
  // A reset gone by, not measured since: what is left, used up or not, is known again from the next measurement.
  if (live?.resetAt && live.resetAt <= now) return AWAITING;
  if (live && live.remaining <= 0) return {key: 'usedUp', tone: 'v-crit'};
  if (!live?.resetAt || !live.minutes || measuredAt === null || live.resetAt <= measuredAt) return NONE;
  // An idle rolling window starts with its first use; one used and not `started` yet has only just started.
  if (!started(live, measuredAt) && live.used === 0) return IDLE;
  return null;
}

/**
 * Where a window leads, whatever period is on screen. A weekly window as the hub foresees
 * it from the recent pace of its series (`ahead`, its part of the hub's `forecast`), judged
 * against its reset; a five-hour window by its own pace since it started. Counted from the
 * moment the window was measured (`measuredAt`), so numbers gone stale foresee the same
 * moment; `now` only says whether it has come and how soon it is.
 */
export function outlook(live: Win | undefined, measuredAt: number | null, now: number, ahead: SeriesForecast | null, context: Context): Outlook {
  const said = known(live, measuredAt, now);
  if (said) return said;
  const window = live as Win & {resetAt: number; minutes: number};
  return window.kind === 'weekly' ? weekly(window, measuredAt!, now, ahead, context) : session(window, measuredAt!, now).outlook;
}

/**
 * When `outlook` reads otherwise as time passes: the window resets (then it waits for a
 * measurement, used up or not), the moment it runs out comes, how soon ticks over
 * (`countdown`), or it comes near enough to say so louder unless something caps its tone.
 * "Left" and "just enough" are the hub's to change, with a new forecast; an announced
 * reset caps the tone until a measurement sees it, not until its time.
 */
export function outlookChangesAt(live: Win | undefined, measuredAt: number | null, now: number, ahead: SeriesForecast | null, context: Context): number | null {
  const said = outlook(live, measuredAt, now, ahead, context);
  if (said.key === 'awaiting') return null;
  const reset = live?.resetAt ?? null;
  const moments: (number | null)[] = [reset];
  if (said.key === 'runsOut') {
    moments.push(said.at, countdownChangesAt(said.at, now));
    const quiet = live!.kind === 'weekly' ? capped(ahead!, said.at, context) : false;
    // Louder once it runs out in less than half the time left to the reset.
    if (said.tone === 'v-warn' && !quiet) moments.push(Math.floor(2 * said.at - reset!) + 1);
  } else if (live?.kind !== 'weekly' && said.key !== 'none' && said.key !== 'usedUp' && said.key !== 'idle' && said.key !== 'pastZero') {
    // A five-hour window's straight line reaches zero, as foreseen, when it does.
    const zero = session(live as Win & {resetAt: number; minutes: number}, measuredAt!, now).zero;
    moments.push(zero === null || zero === undefined ? null : Math.ceil(zero));
  }
  return earliest(...moments.map(at => (at !== null && at > now ? at : null)));
}

/**
 * Where the plan's end falls on a weekly window's forecast, for its tooltip: when a plan
 * the board's owner chose for it ends before the reset, still ahead (`at`), what the line
 * has left then (`left`) and whether it runs out before (`before`).
 */
export type PlanEnd = {at: number; left: number; before: boolean};

export function planEndOf(live: Win | undefined, measuredAt: number | null, now: number, plan: WeeklyPlan | null, ahead: SeriesForecast | null): PlanEnd | null {
  if (!plan || !live?.resetAt || !ahead?.points) return null;
  const point = planAt(live, measuredAt, now, plan);
  if (!point?.weekly || point.done || point.deadline >= live.resetAt) return null;
  const line = lineOf(ahead);
  if (!line.length || point.deadline <= line[0][0]) return null;
  return {at: point.deadline, left: valueAt(line, point.deadline), before: ahead.zero !== null && ahead.zero <= point.deadline};
}

/** When the cell reads otherwise as time passes: its outlook (`outlookChangesAt`), or the end of the plan its tooltip tells of, while it does. */
export function cellChangesAt(live: Win | undefined, measuredAt: number | null, now: number, ahead: SeriesForecast | null, context: Context, plan: WeeklyPlan | null): number | null {
  const said = outlook(live, measuredAt, now, ahead, context).key;
  const told = said === 'runsOut' || said === 'pace' || said === 'left';
  const end = told && live?.kind === 'weekly' ? (planEndOf(live, measuredAt, now, plan, ahead)?.at ?? null) : null;
  return earliest(outlookChangesAt(live, measuredAt, now, ahead, context), end !== null && end > now ? end : null);
}

/** A number of times as shown, to a tenth, and its plural form picked by that, not by the number behind it. */
const times = (value: number) => ({count: Math.round(value * 10) / 10, times: num(value, 1)});

/**
 * The last column's words, whether a burst marks them (an arrow beside them, its size in
 * the tooltip), and the tooltip, a part a line; its colour is the outlook's tone.
 */
export function outlookText(said: Outlook, live: Win | undefined, ahead: SeriesForecast | null, context: Context, planEnd: PlanEnd | null): {text: string; burst: boolean; title: string[]} {
  const quiet = (title: string[] = []) => ({text: '—', burst: false, title});
  switch (said.key) {
    case 'none':
      return quiet();
    case 'idle':
    case 'awaiting':
    case 'renewing':
    case 'unavailable':
      return quiet([t(`forecast.${said.key}`)]);
    case 'needData':
      return quiet([t(said.why === 'atZero' ? 'forecast.needAtZero' : said.why === 'weeklyAtZero' ? 'forecast.needWeeklyAtZero' : said.why === 'hour' ? 'forecast.needHour' : 'forecast.needData')]);
    case 'pastZero':
      return quiet([t('forecast.pastZero', {time: stamp(said.at)}), t('forecast.awaiting')]);
    case 'usedUp':
      return {text: t('forecast.usedUp'), burst: false, title: []};
  }
  const text = said.key === 'runsOut' ? t('forecast.runsOut', {time: countdown(said.inMs)}) : said.key === 'pace' ? t('forecast.pace') : t('forecast.left', {value: num(said.left)});
  const title: string[] = [];
  if (said.key === 'runsOut') title.push(t('forecast.runsOutAt', {time: stamp(said.at)}));
  if (live?.kind !== 'weekly' || !ahead) {
    if (said.rate !== undefined) title.push(t('forecast.rate', {rate: rateText(said.rate)}));
    return {text, burst: false, title};
  }
  const basis = isBasis(ahead.basis) ? ahead.basis : null;
  if (basis?.cold) title.push(basis.hours < 2 ? t('forecast.coldHour') : t('forecast.cold', {count: Math.floor(basis.hours)}));
  else if (basis) {
    title.push(t('forecast.usual', {value: perDay(basis.usualPerDay)}));
    const x = basis.lastDay;
    if (x !== null) {
      if (x < 0.1) title.push(t('forecast.lastDayQuiet'));
      else if (x > 1.1) title.push(t('forecast.lastDayMore', times(x)));
      else if (x < 0.9) title.push(t('forecast.lastDayLess', times(1 / x)));
    }
  }
  const burst = basis?.burst ?? null;
  if (burst) title.push(t('forecast.burst', times(burst.times)), t('forecast.burstAt', {time: stamp(burst.zero)}));
  if (ahead.anchor && ahead.resetAt !== null && ahead.resetAt > ahead.anchor.at) {
    // By the hour as the countdown turns to hours: a day's worth over part of one would read as more than there is.
    const until = ahead.resetAt - ahead.anchor.at;
    title.push(
      until < IN_HOURS_UNDER
        ? t('forecast.allowedHourly', {rate: rateText(ahead.anchor.left / (until / HOUR))})
        : t('forecast.allowed', {value: perDay(ahead.anchor.left / (until / DAY))}),
    );
  }
  if (planEnd) {
    const time = stamp(planEnd.at);
    title.push(planEnd.before ? t('forecast.planRunsOut', {time}) : Math.abs(planEnd.left) < ON_PACE ? t('forecast.planOnPace', {time}) : t('forecast.planLeft', {time, value: num(planEnd.left)}));
  }
  if (context.freeResets > 0) title.push(t('forecast.freeResets', {count: context.freeResets}));
  if (context.announced !== null && live.resetAt !== null && context.announced < live.resetAt) title.push(t('forecast.announced', {time: stamp(context.announced)}));
  return {text, burst: !!burst, title};
}

/**
 * The forecast as a line over [from, to]: from the window's last value to zero or to the
 * reset, whichever comes first, cut at the edges. A weekly window's is the hub's line from
 * the card's last value (`weeklyLine`; it may end high above zero at the reset while the
 * series is new: the cell is cautious, the line shows where the first hours lead); a
 * five-hour window's, its straight line. `zero` is where the line reaches zero, when the
 * table says it runs out; `at`, the moment the table says; `until`, when the table no
 * longer says where the window leads and the line is drawn no more. Null for a window
 * without a forecast.
 */
export function* forecastLinePrepared(
  live: Win | undefined,
  measuredAt: number | null,
  now: number,
  ahead: SeriesForecast | null,
  context: Context,
  from: number,
  to: number,
): Preparation<{points: [number, number][]; zero: number | null; at: number | null; until: number} | null> {
  const said = outlook(live, measuredAt, now, ahead, context);
  if (said.key !== 'runsOut' && said.key !== 'pace' && said.key !== 'left') return null;
  const weekly = live!.kind === 'weekly' ? yield* weeklyLinePrepared(ahead!, live!.remaining, measuredAt) : null;
  const whole = weekly ? weekly.points : session(live as Win & {resetAt: number; minutes: number}, measuredAt!, now).points!;
  if (!whole.length) return null;
  const zero = weekly ? weekly.zero : yield* zeroPrepared(whole);
  const end = Math.min(zero ?? live!.resetAt!, live!.resetAt!);
  const points: [number, number][] = [];
  for (const point of whole) {if (point[0] < end) points.push(point); yield;}
  points.push([end, Math.max(0, yield* valuePrepared(whole, end))]);
  const runsOut = said.key === 'runsOut' && zero !== null;
  // Drawn until the reset, or the moment the table says it runs out if sooner (a five-hour line, until it reaches zero).
  const until = Math.min(live!.resetAt!, said.key === 'runsOut' ? said.at : weekly ? Infinity : end);
  return {points: yield* clipPrepared(points, from, to), zero: runsOut ? zero : null, at: runsOut ? said.at : null, until};
}

/** A line of [time, value] cut to [from, to], with its ends where it crosses them. */
export function* clipPrepared(points: [number, number][], from: number, to: number): Preparation<[number, number][]> {
  if (!points.length || points[0][0] > to || points.at(-1)![0] < from) return [];
  const [begin, end] = [Math.max(from, points[0][0]), Math.min(to, points.at(-1)![0])];
  const result: [number, number][] = [[begin, yield* valuePrepared(points, begin)]];
  for (const point of points) {if (point[0] > begin && point[0] < end) result.push(point); yield;}
  result.push([end, yield* valuePrepared(points, end)]);
  return result;
}

/** What a line spent over the period: points, nothing while measured (`unused`), or unknown. */
export type Spent = {key: 'points'; value: number} | {key: 'unused'} | {key: 'unknown'};

export const spentOf = (line: Pick<Line, 'consumed' | 'coveredMs'>): Spent =>
  line.consumed > 0 ? {key: 'points', value: line.consumed} : line.coveredMs ? {key: 'unused'} : {key: 'unknown'};

/**
 * The plan's column: what it expects to be left now, and how far the window is from
 * it (positive: behind the plan, a reserve), marked when it is `notable`. A limit used up
 * is past any plan.
 */
export type PlanCell = {remaining: number; delta: number; notable: boolean};

export function planCell(live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null): PlanCell | null {
  const plan = live ? planAt(live, measuredAt, now, weekly) : null;
  if (!plan || !live) return null;
  const delta = live.remaining > 0 ? live.remaining - plan.remaining : 0;
  return {remaining: plan.remaining, delta, notable: Math.abs(delta) >= PLAN_TOLERANCE};
}

/**
 * The table's columns after the window's name, which the board's owner turns on and off:
 * over a period up to now, and over a range. They go from what is left, through what was
 * spent and what agents worked for it, to where it leads: by the time on the clock and by
 * hours of agent work. What they spent, and the columns about agent work, are the same in
 * both, so turning one off turns it off in both.
 */
export const LIVE_COLUMNS = ['now', 'plan', 'spent', 'work', 'agenthours', 'perwork', 'during', 'forecast', 'workleft'] as const;
export const RANGE_COLUMNS = ['start', 'end', 'spent', 'pace', 'work', 'agenthours', 'perwork', 'during', 'workleft'] as const;
export type ForecastColumn = (typeof LIVE_COLUMNS)[number] | (typeof RANGE_COLUMNS)[number];

/**
 * Room for the widest heading or value in either language, measured on the demo board,
 * and the least room a window's name gets (`limit`), which wraps beyond it. On a widget as
 * wide as the board every column on by default fits; with agent-hours or the share while active as well,
 * they may not, which is why those columns are off until the owner turns them on.
 */
export const FORECAST_WIDTHS: Record<ForecastColumn | 'limit', number> = {
  limit: 180,
  now: 72,
  plan: 74,
  spent: 142,
  work: 145,
  agenthours: 106,
  perwork: 166,
  during: 165,
  forecast: 220,
  workleft: 146,
  start: 82,
  end: 74,
  pace: 122,
};

/**
 * What the outer columns take beyond their budgets: they keep the panel's padding at the
 * widget's edges (22) rather than a cell's (10), on either side.
 */
export const FORECAST_EDGES = 2 * (22 - 10);

/** A table where the chosen columns fit the widget, otherwise a list of rows. */
export function forecastLayout(columns: readonly ForecastColumn[], width: number): 'table' | 'list' {
  return columns.reduce((sum, column) => sum + FORECAST_WIDTHS[column], FORECAST_WIDTHS.limit + FORECAST_EDGES) <= width ? 'table' : 'list';
}

function valueAt(...args: Parameters<typeof valuePrepared>): number {return drain(valuePrepared(...args));}
function zeroOf(...args: Parameters<typeof zeroPrepared>): number | null {return drain(zeroPrepared(...args));}
export function weeklyLine(...args: Parameters<typeof weeklyLinePrepared>): {points: [number, number][]; zero: number | null} {return drain(weeklyLinePrepared(...args));}
export function forecastLine(...args: Parameters<typeof forecastLinePrepared>) {return drain(forecastLinePrepared(...args));}
export function clip(...args: Parameters<typeof clipPrepared>): [number, number][] {return drain(clipPrepared(...args));}
