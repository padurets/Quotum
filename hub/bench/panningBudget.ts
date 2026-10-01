import {percentile} from './budget.js';

export type PanReading = {
  period: string; series: number; charts: number; rate: number;
  frames: number[]; latency: number[]; inputs: number; updated: number;
  peakFlights: number; maxTiles: number; duplicateReads: number;
  pushesDuring: number; pushesAfter: number; expectedPushes: number;
  forbiddenMutations: number; coldReads: number; undimmed: boolean;
  segments?: Record<string, {count: number; p95: number; max: number}>;
  outliers?: {ms: number; segment: string; pending: number; requests: number}[];
};

/** Empty callbacks, missing input samples and an idle chart can never pass a frame budget. */
export function panningProblems(reading: PanReading): string[] {
  const found: string[] = [];
  if (reading.series < 12 || reading.charts !== 2 || reading.rate !== 4) found.push('panning needs two visible charts, twelve real series and CPU throttle ×4');
  if (reading.frames.length < 30 || reading.updated < 30 || reading.inputs === 0 || reading.latency.length !== reading.inputs) found.push('panning did not measure every input reaching an updated chart frame');
  if (!(percentile(reading.frames, .95) <= 34)) found.push(`${reading.period} moving-frame p95 exceeds 34 ms`);
  if (!(percentile(reading.frames, .99) <= 50)) found.push(`${reading.period} moving-frame p99 exceeds 50 ms`);
  if (!(percentile(reading.latency, .95) <= 34)) found.push(`${reading.period} input-to-updated-frame p95 exceeds 34 ms`);
  if (reading.peakFlights > 2 || reading.maxTiles > 8 || reading.duplicateReads) found.push('panning history flights exceed their cap or overlap');
  if (reading.pushesDuring || reading.pushesAfter !== reading.expectedPushes) found.push('panning did not commit exactly once per completed changed gesture');
  if (reading.forbiddenMutations) found.push('panning changed cards, header, agents, table or activity totals while moving');
  if (!reading.undimmed || !reading.coldReads) found.push('panning did not exercise an undimmed unread edge');
  return found;
}
