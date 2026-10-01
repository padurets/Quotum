import {amount, isUnit, type Unit} from './amount.js';

export type MeterKind = 'counter' | 'balance' | 'cap';
export type MeterSemantics = {limit: string | null; resetAt: number | null; minutes: number | null; scope: string | null; label: string | null};
export type Meter = MeterSemantics & {id: string; kind: MeterKind; unit: Unit; amount: string; at: number; staleAfterMs: number; stale: boolean};
export type KeyPart = {
  id: string; name: string | null; disabled: boolean; expiresAt: number | null; includeByok: boolean;
  at: number; staleAfterMs: number; presence: 'observed' | 'missing'; missCount: number;
  periods: {day: string | null; week: string | null; month: string | null};
};
export type MeterMeasurement = {type: 'meters'; observedAt: number; staleAfterMs: number; meters: Meter[]; keys: KeyPart[]; inventoryComplete: boolean; inventoryError: string | null};
export type Reading = Omit<Meter, 'stale'> & {previousAt: number | null};
export type MeterSpan = {from: number; to: number; staleAfterMs: number};
export type ExceptionalStep = {from: number; to: number; amount: string; evidence: 'continuous' | 'gap' | 'estimate'};
export type SpendSummary = {from: number; to: number; amount: string | null; complete: boolean; knownFrom: number | null; uncertain: boolean; unlocated: ExceptionalStep[]};
export type CalendarSpend = {day: SpendSummary; week: SpendSummary; month: SpendSummary};

export function validateMeter(meter: Meter): void {
  if (!/^[A-Za-z0-9:_-]{1,120}$/.test(meter.id) || !['counter', 'balance', 'cap'].includes(meter.kind) || !isUnit(meter.unit)) throw new Error('invalid_meter');
  const value = amount(meter.amount);
  if (meter.kind !== 'balance' && value < 0n || meter.kind === 'cap' && meter.limit === null || meter.kind !== 'cap' && meter.limit !== null) throw new Error('invalid_meter');
  if (meter.limit !== null && amount(meter.limit) < 0n) throw new Error('invalid_meter');
  if (!Number.isSafeInteger(meter.at) || meter.at < 0 || !Number.isSafeInteger(meter.staleAfterMs) || meter.staleAfterMs <= 0 || meter.staleAfterMs > 86_400_000) throw new Error('invalid_meter');
  if (meter.resetAt !== null && (!Number.isSafeInteger(meter.resetAt) || meter.resetAt < 0) || meter.minutes !== null && (!Number.isSafeInteger(meter.minutes) || meter.minutes <= 0)) throw new Error('invalid_meter');
}

export const semanticsOf = (m: MeterSemantics): MeterSemantics => ({limit: m.limit, resetAt: m.resetAt, minutes: m.minutes, scope: m.scope, label: m.label});
export const sameMeter = (a: Meter, b: Meter) => a.kind === b.kind && a.unit === b.unit && a.amount === b.amount && JSON.stringify(semanticsOf(a)) === JSON.stringify(semanticsOf(b));
export const plottedAmount = (m: Pick<Meter, 'kind' | 'amount' | 'limit'>) => m.kind === 'cap' ? (amount(m.limit!) - amount(m.amount)).toString() : m.amount;

/** Keep a positive movement's original interval even when its timing is unknown. */
export function meterStep(a: Reading, b: Reading, spans: readonly MeterSpan[]): ExceptionalStep | null {
  if (a.kind !== b.kind || a.unit !== b.unit || b.at <= a.at || b.kind === 'cap') return null;
  const delta = b.kind === 'balance' ? amount(a.amount) - amount(b.amount) : amount(b.amount) - amount(a.amount);
  if (delta <= 0n) return null;
  const from = b.previousAt ?? a.at;
  const continuous = spans.some(s => s.from <= from && s.to >= b.at);
  return {from, to: b.at, amount: delta.toString(), evidence: b.kind === 'balance' ? 'estimate' : continuous ? 'continuous' : 'gap'};
}

/** Inclusion in a period is independent of evidence that the observations are continuous. */
export const locatedIn = (step: ExceptionalStep, from: number, to: number) => step.evidence === 'continuous' && step.from >= from && step.to <= to;

export function spending(readings: readonly Reading[], spans: readonly MeterSpan[], from: number, to: number): SpendSummary {
  let known = 0n;
  const unlocated: ExceptionalStep[] = [];
  for (let i = 1; i < readings.length; i++) {
    const step = meterStep(readings[i - 1], readings[i], spans);
    if (!step || step.to < from || step.to > to) continue;
    if (locatedIn(step, from, to)) known += BigInt(step.amount); else unlocated.push(step);
  }
  const first = readings[0]?.at ?? Infinity;
  const knownFrom = spans.filter(s => s.to >= from && s.from <= to).reduce((start, s) => Math.min(start, Math.max(from, s.from, first)), Infinity);
  const complete = spans.some(s => s.from <= from && s.to >= to) && first <= from;
  return {from, to, amount: knownFrom < to ? known.toString() : null, complete, knownFrom: Number.isFinite(knownFrom) ? knownFrom : null, uncertain: unlocated.length > 0, unlocated};
}

export function utcPeriods(now: number): {day: number; week: number; month: number} {
  const date = new Date(now);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return {day, week: day - ((date.getUTCDay() + 6) % 7) * 86_400_000, month: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)};
}

export function calendarSpending(readings: readonly Reading[], spans: readonly MeterSpan[], now: number): CalendarSpend {
  const p = utcPeriods(now);
  return {day: spending(readings, spans, p.day, now), week: spending(readings, spans, p.week, now), month: spending(readings, spans, p.month, now)};
}
