/** Accounting excludes its right edge; the chart's future horizon is never included. */
export type PeriodRange = {from: number; to: number};
export type PeriodSelection = {mode: 'live'; periodMs: number} | ({mode: 'range'} & PeriodRange);
export const MIN_PERIOD = 15 * 60_000;
export const MAX_PERIOD = 31 * 86_400_000;

/** Evidence time names what was read; evaluatedAt names the common clock commit. */
export type PeriodBasis = {
  run: string;
  revision: string;
  evaluatedAt: number;
  evidenceCut: number;
  range: PeriodRange;
};
export type PeriodSection<T> =
  | {state: 'complete'; basis: PeriodBasis; value: T}
  | {state: 'error'; error: 'history_limit' | 'history_range_invalid' | 'unavailable'};

const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function parsePeriod(value: unknown): PeriodSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.mode === 'live' && timestamp(v.periodMs) && v.periodMs >= MIN_PERIOD && v.periodMs <= MAX_PERIOD) return {mode: 'live', periodMs: v.periodMs};
  if (v.mode === 'range' && timestamp(v.from) && timestamp(v.to) && v.to - v.from >= MIN_PERIOD && v.to - v.from <= MAX_PERIOD) return {mode: 'range', from: v.from, to: v.to};
  return null;
}

/** A fixed viewing range never advances with either the clock or later evidence. */
export const evaluatedRange = (selection: PeriodSelection, evaluatedAt: number): PeriodRange => selection.mode === 'live'
  ? {from: evaluatedAt - selection.periodMs, to: evaluatedAt}
  : {from: selection.from, to: selection.to};
export const sameRange = (a: PeriodRange, b: PeriodRange) => a.from === b.from && a.to === b.to;
export const periodKey = (selection: PeriodSelection) => selection.mode === 'live' ? `live:${selection.periodMs}` : `${selection.from}-${selection.to}`;
export const intersectPeriod = (a: PeriodRange, b: PeriodRange): PeriodRange | null => {
  const from = Math.max(a.from, b.from), to = Math.min(a.to, b.to);
  return from < to ? {from, to} : null;
};
