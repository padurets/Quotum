import {config} from '../config.js';
import type {Provider} from './sources.js';

export type Kind = 'session' | 'weekly' | 'other';

/** One quota window of one source at one point in time. */
export type Win = {
  id: string;
  label: string;
  used: number;
  remaining: number;
  resetAt: number | null;
  minutes: number | null;
};

/** Free resets of the limits an account holds: how many, and when the first expires. */
export type FreeResets = {available: number; expiresAt: number | null};

/** One measurement of a source: every window the client reported at one moment. */
export type Measurement = {
  sourceAt: number;
  plan: string;
  windows: Win[];
  /** Absent when the client does not report free resets. */
  resets?: FreeResets | null;
  /** How long this measurement stays representative; unset means `retention.freshMs`. */
  staleAfterMs?: number | null;
};

/** A stored window value. */
export type Sample = Win & {
  sourceId: string;
  provider: Provider;
  sourceAt: number;
  staleAfterMs?: number | null;
};

/** How long after a sample the next one must arrive for the two to count as continuous. */
export const staleAfter = (sample: {staleAfterMs?: number | null}) => sample.staleAfterMs ?? config.retention.freshMs;

/** What a card shows: the last measurement of a source and how the latest attempt went. */
export type SourceState = {
  id: string;
  provider: Provider;
  plan: string;
  successAt: number | null;
  attemptAt: number;
  /** `waiting` before the first measurement, else what the agent reported (spec: Failure). */
  error: string | null;
  windows: Win[];
  staleAfterMs?: number | null;
  resets?: FreeResets | null;
};

export function kindOf(minutes: number | null, label: string): Kind {
  if (minutes === 300 || /5[- ]?h/i.test(label)) return 'session';
  if (minutes === 10080 || /week/i.test(label)) return 'weekly';
  return 'other';
}

export type Edge = {
  valid: boolean;
  delta: number;
  reason: 'continuous' | 'gap' | 'other' | 'reset' | 'correction' | 'unknown-reset';
};

const RESET_TOLERANCE = 60_000;

/**
 * Whether consumption between two consecutive samples of one window is provable.
 * Only positive movement inside one uninterrupted reset window counts.
 */
export function edge(a: Sample, b: Sample): Edge {
  const no = (reason: Edge['reason']): Edge => ({valid: false, delta: 0, reason});
  if (a.sourceId !== b.sourceId || a.id !== b.id) return no('other');

  const elapsed = b.sourceAt - a.sourceAt;
  if (elapsed <= 0 || elapsed > staleAfter(a)) return no('gap');

  if (a.resetAt === null || b.resetAt === null) {
    return Math.abs(b.used - a.used) < 0.05 ? {valid: true, delta: 0, reason: 'continuous'} : no('unknown-reset');
  }
  if (b.sourceAt >= a.resetAt + RESET_TOLERANCE) return no('reset');

  // An idle rolling window reports "now + window length": its reset time drifts
  // forward with the clock. That is the same window, not a reset.
  const shift = b.resetAt - a.resetAt;
  if (shift < -RESET_TOLERANCE || shift > elapsed + RESET_TOLERANCE) return no('reset');

  if (b.used < a.used - 0.05) return no('correction');
  return {valid: true, delta: Math.max(0, b.used - a.used), reason: 'continuous'};
}

export type Point = {at: number; used: number; remaining: number; segment: number; staleAfterMs?: number | null};

/**
 * Chart continuity breaks only where data is missing; a reset is a real movement of
 * the quota and is drawn as such. Consumption uses `edge`.
 */
export function series(samples: Sample[]) {
  let consumed = 0;
  let coveredMs = 0;
  let segment = 0;
  const points: Point[] = samples.map((sample, i) => {
    if (i) {
      const previous = samples[i - 1];
      const step = edge(previous, sample);
      if (step.valid) {
        consumed += step.delta;
        coveredMs += sample.sourceAt - previous.sourceAt;
      }
      if (step.reason === 'gap') segment++;
    }
    return {at: sample.sourceAt, used: sample.used, remaining: sample.remaining, segment, staleAfterMs: sample.staleAfterMs};
  });
  return {points, consumed, coveredMs, samples: samples.length};
}

/**
 * Put a series on a shared time grid. A bucket shows the *lowest* remaining value seen
 * in it (the conservative reading). On the grid a line breaks only where a whole
 * bucket is empty; shorter hiccups are below its resolution.
 */
export function bucketize(points: Point[], bucketMs: number): Point[] {
  const buckets: Point[] = [];
  let segment = 0;
  let previous: Point | undefined;
  for (const point of points) {
    const at = Math.floor(point.at / bucketMs) * bucketMs;
    const current = buckets.at(-1);
    if (current?.at === at) {
      if (point.remaining < current.remaining) {
        current.remaining = point.remaining;
        current.used = point.used;
      }
      previous = point;
      continue;
    }
    const gap = previous ? at - Math.floor(previous.at / bucketMs) * bucketMs > Math.max(bucketMs, staleAfter(previous)) : false;
    if (current && gap) segment++;
    buckets.push({...point, at, segment});
    previous = point;
  }
  return buckets;
}
