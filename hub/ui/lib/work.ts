import {t, type Key} from '../i18n';
import {duration, num, rateText, shareText, stamp, workAbout, workHours} from './format';
import type {Line} from './lines';
import type {SeriesWork} from './types';

const HOUR = 3_600_000;
/**
 * Under this much agent work while measured, a pace per hour of it says little: a limit
 * told in whole percents (Codex) jumps it twofold. As long as a window's forecast waits.
 */
export const WORK_PACE_FROM = 30 * 60_000;
/**
 * A pace slower than this (percent per hour of work) reads "≈ 0" (`rateText`), and the
 * hundreds of hours it would last name no number: past a reset or a whole window they are
 * told only as lasting to it, and where neither bounds them, past `UNBOUNDED_MS`, nothing
 * is foreseen. Hours short of all that are named at any pace.
 */
export const MIN_RATE = 0.05;
/** Where neither a reset nor a window's length bounds the hours of work left, a pace under `MIN_RATE` names none past a week of them. */
const UNBOUNDED_MS = 7 * 24 * HOUR;
/** Under this share of the spending during work, most of it went elsewhere and an hour of work looks dearer than it is. */
const LOW_SHARE = 50;
/** The pace is taken over less work than the hours shown when it had less than this share of them: a few minutes at the edges of the measurements do not count. */
const BASIS_SHARE = 0.9;

/** The table's columns about agent work, the same in a period up to now and in a range. */
export const WORK_COLUMNS = ['work', 'perwork', 'workleft', 'during'] as const;
export type WorkColumn = (typeof WORK_COLUMNS)[number];

/**
 * Why a cell has no number: how agents worked is not known in the period (`unknown`), none
 * of the agents the board shows worked (`none`), too little of their work was measured to
 * tell a pace (`short`), nothing was spent (`nospend`), too little per hour of work to
 * foresee anything where neither a reset nor a window's length bounds it (`slow`), or what
 * is left is not known since the window's reset went by unmeasured (`awaiting`).
 */
export type WorkReason = 'unknown' | 'none' | 'short' | 'nospend' | 'slow' | 'awaiting';

/**
 * A cell about agent work: a number (milliseconds of work, percent per hour of work, or
 * percent of the spending), work enough to last beyond the window's reset (`untilReset`,
 * milliseconds of work left), or beyond a whole window where no reset time stops it first
 * (`outlasts`, with the window's length), nothing left to work on (`usedUp`), or why there is none.
 */
export type WorkCell = {value: number} | {untilReset: number} | {outlasts: number; windowMs: number} | {usedUp: true} | {none: WorkReason};

/** What a dash's tooltip says why: a reason, or one about the whole period told since when work is known. */
export type DashText = Exclude<WorkReason, 'unknown'> | 'noneSince' | 'nospendSince';

/**
 * What the tooltip of a dash says (`text`), and since when work is known as a line of its
 * own (`knownFrom`). Where work is known from later than the period begins (`since`), a
 * reason about the whole period (none worked, nothing spent) is told since then instead: the
 * spending before is in the period's, and the work before is not known.
 */
export function dashOf(reason: Exclude<WorkReason, 'unknown'>, since: number | null): {text: DashText; knownFrom: number | null} {
  if (since !== null && (reason === 'none' || reason === 'nospend')) return {text: `${reason}Since`, knownFrom: null};
  // Waiting for a measurement is not about the work known.
  return {text: reason, knownFrom: reason === 'awaiting' ? null : since};
}

/**
 * A window's cells about agent work over the period: how long agents worked on its
 * subscription (`work`), what it spent per hour of their work (`perwork`), how long they
 * can go on working at that pace on what is `remaining` (`workleft`), and how much of the
 * spending fell into steps between measurements they worked in (`during`). The pace and
 * the share are taken over the work within steps whose spending is known, and need half an
 * hour of it.
 * `resetInMs`, how long until the window's reset, only in a period up to now: work that
 * lasts beyond it lasts to the reset. So does work that would outlast a whole window
 * (`windowMs`, its length), where no reset time comes first: over a range, or a reset not told.
 */
export function workCells(work: SeriesWork, remaining: number, resetInMs: number | null, windowMs: number | null = null): Record<WorkColumn, WorkCell> {
  if (work.ms === null) {
    const unknown = {none: 'unknown'} as const;
    return {work: unknown, perwork: unknown, workleft: unknown, during: unknown};
  }
  // Nothing left is what the forecast says, however the work went.
  const usedUp = remaining <= 0 ? ({usedUp: true} as const) : null;
  const none = {none: 'none'} as const;
  if (!work.ms) return {work: none, perwork: none, workleft: usedUp ?? none, during: none};
  const during: WorkCell = work.consumed > 0 ? {value: (work.duringWork / work.consumed) * 100} : {none: 'nospend'};
  // With work mostly in gaps between measurements, whose spending is not known, the share would say 0 of work that was there.
  const short = {none: 'short'} as const;
  if (work.coveredMs < WORK_PACE_FROM) return {work: {value: work.ms}, perwork: short, workleft: usedUp ?? short, during: short};
  const pace = work.consumed / (work.coveredMs / HOUR);
  const leftMs = (remaining / pace) * HOUR;
  // Short of a reset, a whole window or a week where neither bounds it, however slow the pace, that is worth its number.
  const workleft: WorkCell =
    usedUp ??
    (work.consumed <= 0
      ? {none: 'nospend'}
      : resetInMs !== null && leftMs >= resetInMs
        ? {untilReset: leftMs}
        : windowMs !== null && leftMs >= windowMs
          ? {outlasts: leftMs, windowMs}
          : pace < MIN_RATE && resetInMs === null && windowMs === null && leftMs >= UNBOUNDED_MS
            ? {none: 'slow'}
            : {value: leftMs});
  return {work: {value: work.ms}, perwork: {value: pace}, workleft, during};
}

/**
 * A line's cells about agent work (`workCells`), null for none. Over a range, which is in
 * the past, what is left is what was left at its last measurement; over a period up to
 * now, what is left now, and the window's reset (`resetAt`) is ahead while it is after
 * `now`: one already past, not measured since, leaves what is left unknown until it is.
 */
export function lineWork(line: Pick<Line, 'work' | 'current' | 'remainingAtEnd' | 'minutes'>, range: boolean, resetAt: number | null, now: number): Record<WorkColumn, WorkCell> | null {
  const remaining = range ? line.remainingAtEnd : line.current;
  // A line on the table has measurements, so it has an end; one without is not foreseen.
  if (!line.work || remaining === null) return null;
  const cells = workCells(line.work, remaining, range ? null : resetAt !== null && resetAt > now ? resetAt - now : null, line.minutes ? line.minutes * 60_000 : null);
  // A window used up too, as the forecast by time says it; where none of the agents worked, that is what it says.
  const reset = !range && resetAt !== null && resetAt <= now;
  return reset && line.work.ms !== null ? {...cells, workleft: {none: line.work.ms ? 'awaiting' : 'none'}} : cells;
}

/**
 * What the tooltips of a window's work cells add: since when its work is known, when that
 * is after the period begins (`since`); how much work the pace and the share are taken over,
 * when that is notably less than the hours shown (`basis`); and the share of the spending
 * during work, when under half of it (`share`, percent), whether its column shows or not:
 * the pace and what it foresees count the rest against the work.
 */
export function workNotes(work: SeriesWork, periodFrom: number): {since: number | null; basis: number | null; share: number | null} {
  const measured = !!work.ms && work.coveredMs >= WORK_PACE_FROM;
  const share = measured && work.consumed > 0 ? (work.duringWork / work.consumed) * 100 : null;
  return {
    since: work.ms !== null && work.from > periodFrom ? work.from : null,
    basis: measured && work.coveredMs < BASIS_SHARE * work.ms! ? work.coveredMs : null,
    // As its line tells it, rounded: a share that reads as half is not told as under it.
    share: share !== null && Math.round(share) < LOW_SHARE ? share : null,
  };
}

/** Why a cell about agent work is a dash. */
const REASONS: Record<DashText, Key> = {
  none: 'work.none',
  noneSince: 'work.noneSince',
  short: 'work.short',
  nospend: 'work.noSpend',
  nospendSince: 'work.noSpendSince',
  slow: 'work.slow',
  awaiting: 'forecast.awaiting',
};

/**
 * What a cell about agent work reads, with a tooltip of a part a line: what an hour of work
 * spent for the forecast (`perWork`), how much work that and the share are taken over, that
 * the share is an upper bound, that little of the spending came during work, since when
 * work is known, or why there is no number. `resetAt` is the window's, which work lasting
 * beyond it names.
 */
export function workText(column: WorkColumn, cell: WorkCell, work: SeriesWork, periodFrom: number, resetAt: number | null, perWork: number | null): {content: string; title?: string} {
  const notes = workNotes(work, periodFrom);
  const known = (at: number | null) => (at !== null ? [t('work.since', {time: stamp(at)})] : []);
  if ('none' in cell) {
    if (cell.none === 'unknown') return {content: '—', title: t('work.unknown', {time: stamp(work.from)})};
    const dash = dashOf(cell.none, notes.since);
    return {content: '—', title: [t(REASONS[dash.text], {time: notes.since === null ? '' : stamp(notes.since)}), ...known(dash.knownFrom)].join('\n')};
  }
  const paced = column === 'perwork' || column === 'workleft';
  // A pace that reads "≈ 0": past a reset or a window it names no hours, only that they last.
  const slow = perWork !== null && perWork > 0 && perWork < MIN_RATE;
  const lines = [
    // Beside hours it foresees, "≈ 0" would read as lasting for ever: the tooltip says how small it is.
    ...(column === 'workleft' && perWork !== null ? [slow ? t('work.basisUnder', {value: num(MIN_RATE, 2)}) : t('work.basis', {value: rateText(perWork)})] : []),
    ...(column !== 'work' && notes.basis !== null ? [t('work.basisMeasured', {time: workHours(notes.basis)})] : []),
    ...(paced && notes.share !== null ? [notes.share === 0 ? t('work.noShare') : t('work.lowShare', {value: shareText(notes.share)})] : []),
    ...(column === 'during' ? [t('work.upperBound')] : []),
    ...known(notes.since),
  ];
  // Nothing left, whatever is known of the work: as the forecast by time says it, with nothing to add.
  if ('usedUp' in cell) return {content: t('work.usedUp')};
  if ('untilReset' in cell) {
    const reset = stamp(resetAt!);
    return {content: t('work.untilReset'), title: [slow ? t('work.untilResetSlow', {reset}) : t('work.untilResetHint', {time: workAbout(cell.untilReset), reset}), ...lines].join('\n')};
  }
  if ('outlasts' in cell) {
    const length = duration(cell.windowMs);
    return {content: t('work.untilReset'), title: [slow ? t('work.outlastsSlow', {window: length}) : t('work.outlastsHint', {time: workAbout(cell.outlasts), window: length}), ...lines].join('\n')};
  }
  const content =
    column === 'work'
      ? workHours(cell.value)
      : column === 'perwork'
        ? t('table.perHour', {value: rateText(cell.value)})
        : column === 'workleft'
          ? t('work.left', {time: workAbout(cell.value)})
          : t('work.during', {value: shareText(cell.value)});
  return {content, title: lines.join('\n') || undefined};
}
