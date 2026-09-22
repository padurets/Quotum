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

export type Measurement = {
  provider: Provider;
  sourceAt: number;
  plan: string;
  identity: string | null;
  windows: Win[];
};

/** A stored window value. `scope` is the identity segment it belongs to. */
export type Sample = Win & {sourceId: string; provider: Provider; scope: string; sourceAt: number; observedAt: number};

export type Confidence = 'provider' | 'local-profile' | 'local-id-token' | 'credential-boundary' | 'unknown';

export type SourceState = {
  id: string;
  provider: Provider;
  accountKey: string;
  plan: string;
  confidence: Confidence;
  scope: string;
  successAt: number | null;
  attemptAt: number;
  error: string | null;
  windows: Win[];
};

export function kindOf(minutes: number | null, label: string): Kind {
  if (minutes === 300 || /5[- ]?h|5 час/i.test(label)) return 'session';
  if (minutes === 10080 || /week|недел/i.test(label)) return 'weekly';
  return 'other';
}

export type Edge = {
  valid: boolean;
  delta: number;
  reason: 'continuous' | 'gap' | 'scope' | 'reset' | 'correction' | 'unknown-reset';
};

const RESET_TOLERANCE = 60_000;

/**
 * Whether consumption between two consecutive samples of one window is provable.
 * Only positive movement inside one uninterrupted reset window counts.
 */
export function edge(a: Sample, b: Sample): Edge {
  const no = (reason: Edge['reason']): Edge => ({valid: false, delta: 0, reason});
  if (a.sourceId !== b.sourceId || a.scope !== b.scope || a.id !== b.id) return no('scope');

  const elapsed = b.sourceAt - a.sourceAt;
  if (elapsed <= 0 || elapsed > config.retention.freshMs) return no('gap');

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

export type Point = {at: number; used: number; remaining: number; segment: number; scope: string};

/**
 * Chart continuity breaks only where data is missing or the account changed; a reset
 * is a real movement of the quota and is drawn as such. Consumption uses `edge`.
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
      if (step.reason === 'gap' || step.reason === 'scope') segment++;
    }
    return {at: sample.sourceAt, used: sample.used, remaining: sample.remaining, segment, scope: sample.scope};
  });
  return {points, consumed, coveredMs, samples: samples.length};
}

/**
 * Put a series on a shared time grid. A bucket shows the *lowest* remaining value seen
 * in it (the conservative reading). On the grid a line breaks only where a whole
 * bucket is empty or the account changed; shorter hiccups are below its resolution.
 */
export function bucketize(points: Point[], bucketMs: number): Point[] {
  const buckets: Point[] = [];
  let segment = 0;
  for (const point of points) {
    const at = Math.floor(point.at / bucketMs) * bucketMs;
    const current = buckets.at(-1);
    if (current?.at === at && point.scope === current.scope) {
      if (point.remaining < current.remaining) {
        current.remaining = point.remaining;
        current.used = point.used;
      }
      continue;
    }
    if (current && (at - current.at > Math.max(bucketMs, config.retention.freshMs) || point.scope !== current.scope)) segment++;
    buckets.push({...point, at, segment});
  }
  return buckets;
}
