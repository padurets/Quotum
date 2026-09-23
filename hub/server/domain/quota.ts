import type {Provider} from './sources.js';

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

/** Free resets of the limits an account holds: how many, and when the first expires. */
export type FreeResets = {available: number; expiresAt: number | null};

/** One measurement of a source: every window the client reported at one moment. */
export type Measurement = {
  observedAt: number;
  plan: string;
  windows: Win[];
  /** How long this measurement stays representative: the next one is due before then. */
  staleAfterMs: number;
  /** Null when the client does not report free resets. */
  resets: FreeResets | null;
};

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
export function edge(a: Sample, b: Sample): Edge {
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

export type Point = {at: number; used: number; remaining: number; segment: number; staleAfterMs: number};

/**
 * The samples of one window of one source, in time order: chart points and the
 * consumption `edge` can prove. The line breaks only where data is missing; a reset is
 * a real movement of the quota and is drawn as such.
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
        coveredMs += sample.at - previous.at;
      }
      if (step.reason === 'gap') segment++;
    }
    return {at: sample.at, used: sample.used, remaining: sample.remaining, segment, staleAfterMs: sample.staleAfterMs};
  });
  // What was left at the first and the last measurement: a selected period is read from its edges.
  return {points, consumed, coveredMs, samples: samples.length, remainingAtStart: samples[0]?.remaining ?? null, remainingAtEnd: samples.at(-1)?.remaining ?? null};
}

/**
 * Puts a series on a shared time grid. A cell shows the *lowest* remaining value seen
 * in it (the conservative reading). On the grid a line breaks only where a whole cell
 * is empty; shorter hiccups are below its resolution.
 */
export function onGrid(points: Point[], cellMs: number): Point[] {
  const cells: Point[] = [];
  let segment = 0;
  let previous: Point | undefined;
  for (const point of points) {
    const at = Math.floor(point.at / cellMs) * cellMs;
    const current = cells.at(-1);
    if (current?.at === at) {
      if (point.remaining < current.remaining) {
        current.remaining = point.remaining;
        current.used = point.used;
      }
      previous = point;
      continue;
    }
    const gap = previous ? at - Math.floor(previous.at / cellMs) * cellMs > Math.max(cellMs, previous.staleAfterMs) : false;
    if (current && gap) segment++;
    cells.push({...point, at, segment});
    previous = point;
  }
  return cells;
}
