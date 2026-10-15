import {percentile} from './budget.js';

export type PanReading = {
  initiator: 'quota' | 'session' | 'activity' | 'budget' | 'funds'; period: string; series: number; budgetSeries: number; fundsSeries: number; sessionSeries:number;  charts: number; rate: number;
  frames: number[]; latency: number[]; inputs: number; updated: number;
  chartUpdates: number[]; synchronized: boolean;
  peakFlights: number; maxTiles: number; duplicateReads: number;
  pushesDuring: number; pushesAfter: number; expectedPushes: number;
  forbiddenMutations: number; coldReads: number; undimmed: boolean; sizeStable: boolean;
  edgeSeries: {stage:'wheel'|'drag';series:number;sessionSeries:number;budgetSeries:number;fundsSeries:number}[];
  wheelGapMs:number;
  segments?: Record<string, {count: number; p95: number; max: number}>;
  outliers?: {ms: number; segment: string; pending: number; requests: number}[];
  responses?: {ms: number; queued: number; processed: number; segment: string; requests: number}[];
  mutationSamples?: {segment:string;surface:string;tag:string;type:string;attribute:string|null;measurement:boolean;panning:boolean}[];
};

/** Empty callbacks, missing input samples and an idle chart can never pass a frame budget. */
export function panningProblems(reading: PanReading): string[] {
  const found: string[] = [];
  const label = `${reading.initiator}/${reading.period}`;
  if (reading.series < 12 || reading.budgetSeries < 12 || reading.fundsSeries < 12 || reading.sessionSeries<12 || reading.charts !== 5 || reading.rate !== 4) found.push('panning needs five visible charts, twelve real series per resource family and CPU throttle ×4');
  if (reading.edgeSeries?.length!==2 || !['wheel','drag'].every(stage=>reading.edgeSeries.some(edge=>edge.stage===stage)) || reading.edgeSeries.some(edge=>[edge.series,edge.sessionSeries,edge.budgetSeries,edge.fundsSeries].some(count=>!Number.isFinite(count)||count<12))) found.push('panning lost twelve real series at an unread or rebuilt history edge');
  if(!Number.isFinite(reading.wheelGapMs)||reading.wheelGapMs>=200)found.push('native wheel input did not stay continuous');
  if (reading.frames.length < 30 || reading.updated < 30 || reading.inputs === 0 || reading.latency.length !== reading.inputs) found.push('panning did not measure every input reaching an updated chart frame');
  if (reading.chartUpdates.length !== 5 || reading.chartUpdates.some(count => count < 30) || !reading.synchronized) found.push('panning did not move all five charts on the same time frame');
  if (!(percentile(reading.frames, .95) <= 34)) found.push(`${label} moving-frame p95 exceeds 34 ms`);
  if (!(percentile(reading.frames, .99) <= 50)) found.push(`${label} moving-frame p99 exceeds 50 ms`);
  if (!(percentile(reading.latency, .95) <= 34)) found.push(`${label} input-to-updated-frame p95 exceeds 34 ms`);
  if (reading.peakFlights > 2 || reading.maxTiles > 8 || reading.duplicateReads) found.push('panning history flights exceed their cap or overlap');
  if (reading.pushesDuring || reading.pushesAfter !== reading.expectedPushes) found.push('panning did not commit exactly once per completed changed gesture');
  if (reading.forbiddenMutations) found.push('panning changed cards, header, agents, table or activity totals while moving');
  if (!reading.undimmed || !reading.coldReads) found.push('panning did not exercise an undimmed unread edge');
  if (!reading.sizeStable) found.push('panning resized a chart while moving or completing its range');
  return found;
}
