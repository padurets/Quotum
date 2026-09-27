import type {Counted} from './probe.js';

/** The counters of `Performance.getMetrics` the benchmark reads, by name. */
export type Metrics = Record<string, number>;

/** How much of the page's work a count of parts adds up to, and where. */
export type Tally = {
  /** Outside anything that shows time: what an idle page must not do at all. */
  outside: number;
  /** Where outside what shows time, by region (`card:<id>`, `header`, `agents`, `analytics`, `page`). */
  outsideBy: Record<string, number>;
  /** Parts that show time: how many, and the most any one of them did. */
  timeNodes: number;
  timeMax: number;
};

export function tally(counted: Counted[]): Tally {
  const outsideBy: Record<string, number> = {};
  let outside = 0;
  let timeNodes = 0;
  let timeMax = 0;
  for (const part of counted) {
    if (part.time) {
      timeNodes++;
      timeMax = Math.max(timeMax, part.count);
    } else {
      outside += part.count;
      outsideBy[part.region] = (outsideBy[part.region] ?? 0) + part.count;
    }
  }
  return {outside, outsideBy, timeNodes, timeMax};
}

/**
 * The page's own script time per second of the window, in milliseconds: Chrome's
 * `ScriptDuration` (seconds) less the time the probe took, which the page would not spend.
 */
export function scriptPerSecond(before: Metrics, after: Metrics, instrumentMs: number, seconds: number): number {
  const script = ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000;
  return (script - instrumentMs) / seconds;
}

/** The change of a counter over the window. */
export const delta = (before: Metrics, after: Metrics, name: string) => (after[name] ?? 0) - (before[name] ?? 0);

/** Rounded for the report: what the benchmark prints is read by people and compared across runs. */
export const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
