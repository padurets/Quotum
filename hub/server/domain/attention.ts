import type {Win} from './quota.js';
import type {Provider} from './sources.js';

export type Level = 'ok' | 'warn' | 'crit';
/** One traffic light for the board and the desktop. */
export const level = (remaining: number): Level => (remaining < 10 ? 'crit' : remaining <= 30 ? 'warn' : 'ok');

export type WindowSample = Win & {at: number; staleAfterMs: number};
/** Evidence of recovery; continuity is deliberately a separate question. */
export const earlyReset = (a: Pick<WindowSample, 'resetAt' | 'used'>, b: Pick<WindowSample, 'at' | 'used'>) =>
  a.resetAt !== null && b.at < a.resetAt - 60_000 && a.used - b.used > 5;
export function resetEvidence(a: WindowSample, b: WindowSample): boolean {
  return earlyReset(a, b) || (a.resetAt !== null && b.resetAt !== null && b.at >= a.resetAt - 60_000 && b.resetAt > b.at && b.resetAt - a.resetAt > b.at - a.at + 60_000);
}

export type WindowLedger = {schemaVersion: 1; cycle: number; previous: WindowSample; consumedLow: boolean; consumedCritical: boolean};
export type QuotaKind = 'low' | 'critical' | 'reset';
export const sameWindow = (a: Pick<Win, 'kind' | 'label' | 'minutes'>, b: Pick<Win, 'kind' | 'label' | 'minutes'>) =>
  a.kind === b.kind && a.label === b.label && a.minutes === b.minutes;
export function advanceWindow(previous: WindowLedger | null, sample: WindowSample, live: boolean): {ledger: WindowLedger; event: QuotaKind | null; boundary: boolean} {
  const same = previous && sameWindow(previous.previous, sample);
  const reset = same && sample.at > previous.previous.at && resetEvidence(previous.previous, sample);
  const continuous = same && sample.at > previous.previous.at && sample.at - previous.previous.at <= previous.previous.staleAfterMs;
  const ledger: WindowLedger = {
    schemaVersion: 1, cycle: (previous?.cycle ?? 0) + (reset || (previous && !same) ? 1 : 0), previous: sample,
    consumedLow: same && !reset ? previous.consumedLow : false,
    consumedCritical: same && !reset ? previous.consumedCritical : false,
  };
  const severity = level(sample.remaining);
  let event: QuotaKind | null = null;
  if (live && continuous) {
    if (reset) event = 'reset';
    else if (severity === 'crit' && !ledger.consumedCritical) event = 'critical';
    else if (severity === 'warn' && !ledger.consumedLow) event = 'low';
  }
  if (severity !== 'ok') ledger.consumedLow = true;
  if (severity === 'crit') ledger.consumedCritical = true;
  return {ledger, event, boundary: !(live && continuous) || !!reset};
}

export type QuotaCandidate = {
  id: string; kind: QuotaKind; at: number; observedFrom: number; observedAt: number;
  sourceId: string; windowId: string; provider: Provider; name: string;
  window: Pick<Win, 'kind' | 'label' | 'minutes'>; remaining: number; resetAt: number | null;
};
export type AnnouncementCandidate = {
  id: string; kind: 'announcement'; at: number; provider: Provider; scheduledFor: number | null;
  resetKind: 'regular' | 'banked' | null; credit: {name: string; url: string}; url: string;
};
export type Candidate = QuotaCandidate | AnnouncementCandidate;
/** No candidate observed before this boundary may survive a delivery queue. */
export type Invalidation = {sourceId: string; windowId: string; at: number};
export type AttentionEvents = {candidates: Candidate[]; invalidations: Invalidation[]};
export type AttentionState = {
  boardId: string; level: Level | null; quality: 'current' | 'partial' | 'unavailable';
  minimum: {sourceId: string; windowId: string; remaining: number} | null;
};

/** One current message per window in a delivery; consumed thresholds stay consumed. */
export function batchCandidates(candidates: QuotaCandidate[]): QuotaCandidate[] {
  const byWindow = new Map<string, QuotaCandidate>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.sourceId, candidate.windowId]);
    const prior = byWindow.get(key);
    if (!prior || candidate.kind === 'reset') byWindow.set(key, candidate);
    else if (prior.kind === 'reset') byWindow.set(key, {...candidate, id: prior.id, kind: 'reset', observedFrom: prior.observedFrom});
    else if (candidate.kind === 'critical' || prior.kind !== 'critical') byWindow.set(key, candidate);
  }
  return [...byWindow.values()];
}
