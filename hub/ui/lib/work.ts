import {num} from './format';
import type {Line} from './lines';
import type {SeriesWork} from './types';

const HOUR = 3_600_000;
/**
 * Under this much agent work while measured, a pace per hour of it says little: a limit
 * told in whole percents (Codex) jumps it twofold. As long as a window's forecast waits.
 */
export const WORK_PACE_FROM = 30 * 60_000;
/**
 * A pace slower than this (percent per hour of work) spends nothing worth foreseeing: the
 * hundreds of hours it would last say nothing, and the pace itself reads "≈ 0".
 */
export const MIN_RATE = 0.05;
/** What an hour of work spends, in percent, the same in its cell and in the forecast's tooltip: one too small to foresee from reads "≈ 0". */
export const perWorkText = (value: number) => (value > 0 && value < MIN_RATE ? '≈ 0' : num(value, 1));
/** The pace is taken over less work than the hours shown when it had less than this share of them: a few minutes at the edges of the measurements do not count. */
const BASIS_SHARE = 0.9;

/** The table's columns about agent work, the same in a period up to now and in a range. */
export const WORK_COLUMNS = ['work', 'perwork', 'workleft', 'during'] as const;
export type WorkColumn = (typeof WORK_COLUMNS)[number];

/**
 * Why a cell has no number: how agents worked is not known in the period (`unknown`), none
 * of the agents the board shows worked (`none`), too little of their work was measured to
 * tell a pace (`short`), nothing was spent (`nospend`), or too little per hour of work to
 * foresee anything (`slow`).
 */
export type WorkReason = 'unknown' | 'none' | 'short' | 'nospend' | 'slow';

/**
 * A cell about agent work: a number (milliseconds of work, percent per hour of work, or
 * percent of the spending), work enough to last beyond the window's reset (`untilReset`,
 * milliseconds of work left), or why there is none.
 */
export type WorkCell = {value: number} | {untilReset: number} | {none: WorkReason};

/**
 * A window's cells about agent work over the period: how long agents worked on its
 * subscription (`work`), what it spent per hour of their work (`perwork`), how long they
 * can go on working at that pace on what is `remaining` (`workleft`), and how much of the
 * spending fell into steps between measurements they worked in (`during`). The pace and
 * the share are taken over the work within steps whose spending is known, and need half an
 * hour of it.
 * `resetInMs`, how long until the window's reset, only in a period up to now: work that
 * lasts beyond it lasts to the reset.
 */
export function workCells(work: SeriesWork, remaining: number, resetInMs: number | null): Record<WorkColumn, WorkCell> {
  if (work.ms === null) {
    const unknown = {none: 'unknown'} as const;
    return {work: unknown, perwork: unknown, workleft: unknown, during: unknown};
  }
  const during: WorkCell = work.consumed > 0 ? {value: (work.duringWork / work.consumed) * 100} : {none: 'nospend'};
  // With no work at all, all of the spending went elsewhere; with work mostly in gaps between
  // measurements, whose spending is not known, the share would say 0 of work that was there.
  if (!work.ms) return {work: {none: 'none'}, perwork: {none: 'none'}, workleft: {none: 'none'}, during};
  const short = {none: 'short'} as const;
  if (work.coveredMs < WORK_PACE_FROM) return {work: {value: work.ms}, perwork: short, workleft: short, during: short};
  const pace = work.consumed / (work.coveredMs / HOUR);
  const leftMs = (remaining / pace) * HOUR;
  const workleft: WorkCell =
    work.consumed <= 0 ? {none: 'nospend'} : pace < MIN_RATE ? {none: 'slow'} : resetInMs !== null && leftMs >= resetInMs ? {untilReset: leftMs} : {value: leftMs};
  return {work: {value: work.ms}, perwork: {value: pace}, workleft, during};
}

/**
 * A line's cells about agent work (`workCells`), null for none. Over a range, which is in
 * the past, what is left is what was left at its last measurement; over a period up to
 * now, what is left now, and the window's reset (`resetAt`) is ahead while it is after `now`.
 */
export function lineWork(line: Pick<Line, 'work' | 'current' | 'remainingAtEnd'>, range: boolean, resetAt: number | null, now: number): Record<WorkColumn, WorkCell> | null {
  const remaining = range ? line.remainingAtEnd : line.current;
  // A line on the table has measurements, so it has an end; one without is not foreseen.
  if (!line.work || remaining === null) return null;
  return workCells(line.work, remaining, range ? null : resetAt !== null && resetAt > now ? resetAt - now : null);
}

/**
 * What the tooltips of a window's work cells add: since when its work is known, when that
 * is after the period begins (`since`); how much work the pace is taken over, when that is
 * notably less than the hours shown (`basis`).
 */
export function workNotes(work: SeriesWork, periodFrom: number): {since: number | null; basis: number | null} {
  return {
    since: work.ms !== null && work.from > periodFrom ? work.from : null,
    basis: work.ms && work.coveredMs >= WORK_PACE_FROM && work.coveredMs < BASIS_SHARE * work.ms ? work.coveredMs : null,
  };
}
