import type {Provider} from './sources.js';
import type {KeyPart, Meter, MeterMeasurement} from './meters.js';
import type {ReportQuality,MonthlyLimit} from './reports.js';

/** A window's length as the agent classifies it (spec: Window `kind`). */
export type Kind = 'session' | 'weekly' | 'other';

/** One quota window of one source at one point in time. */
export type Win = {
  id: string;
  kind: Kind;
  /** The model pool the window covers ("Fable", "Gemini"), when the provider names one. */
  label: string | null;
  used: number;
  remaining: number;
  resetAt: number | null;
  minutes: number | null;
};

/**
 * Free resets of the limits an account holds: how many, and how many expire when (soonest
 * first, an unknown time last; empty from a client that gives only the count).
 */
export type FreeResets = {available: number; expiring: {count: number; expiresAt: number | null}[]};

/** One measurement of a source: every window the client reported at one moment. */
export type WindowMeasurement = {
  observedAt: number;
  plan: string;
  windows: Win[];
  /** How long this measurement stays representative: the next one is due before then. */
  staleAfterMs: number;
  /** Null when the client does not report free resets. */
  resets: FreeResets | null;
};
export type Measurement = WindowMeasurement | MeterMeasurement;

/** A stored window value. */
export type Sample = Win & {
  sourceId: string;
  provider: Provider;
  at: number;
  staleAfterMs: number;
};

/** What a card shows: the last measurement of a source and how the latest attempt went. */
export type SourceState = {
  id: string;
  provider: Provider;
  plan: string;
  successAt: number | null;
  /** `waiting` before the first measurement, else what the agent reported (spec: Failure). */
  error: string | null;
  windows: Win[];
  staleAfterMs: number | null;
  resets: FreeResets | null;
  meters?: Meter[];
  keys?: KeyPart[];
  inventory?: {complete: boolean; observed: number; missing: number; error: string | null};
  reportQuality?:ReportQuality[];
  reportAttemptedAt?:number;
  reportDigest?:string;
  monthlyLimit?:MonthlyLimit;
};

export type Edge = {
  valid: boolean;
  delta: number;
  reason: 'continuous' | 'gap' | 'reset' | 'correction' | 'unknown-reset';
};

const RESET_TOLERANCE = 60_000;

/**
 * Whether consumption between two consecutive samples of one window is provable.
 * Only positive movement inside one uninterrupted reset window counts.
 */
export function edge(a: Pick<Sample, 'at' | 'used' | 'resetAt' | 'staleAfterMs'>, b: Pick<Sample, 'at' | 'used' | 'resetAt' | 'staleAfterMs'>): Edge {
  const no = (reason: Edge['reason']): Edge => ({valid: false, delta: 0, reason});
  const elapsed = b.at - a.at;
  if (elapsed <= 0 || elapsed > a.staleAfterMs) return no('gap');

  if (a.resetAt === null || b.resetAt === null) {
    return Math.abs(b.used - a.used) < 0.05 ? {valid: true, delta: 0, reason: 'continuous'} : no('unknown-reset');
  }
  if (b.at >= a.resetAt + RESET_TOLERANCE) return no('reset');

  // An idle rolling window reports "now + window length": its reset time drifts
  // forward with the clock. That is the same window, not a reset.
  const shift = b.resetAt - a.resetAt;
  if (shift < -RESET_TOLERANCE || shift > elapsed + RESET_TOLERANCE) return no('reset');

  if (b.used < a.used - 0.05) return no('correction');
  return {valid: true, delta: Math.max(0, b.used - a.used), reason: 'continuous'};
}
