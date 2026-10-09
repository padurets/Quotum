import {advanceWindow, batchCandidates, sameWindow, type AttentionEvents, type Candidate, type Invalidation, type QuotaCandidate, type WindowLedger, type WindowSample} from './domain/attention.js';
import type {WindowMeasurement as Measurement, SourceState} from './domain/quota.js';
import type {ResetProvider, ResetStatus} from './domain/resets.js';
import type {Store} from './store/store.js';
import {trouble} from './touches.js';

/** Transactional event consumption. Only committed candidates leave this service. */
export class Attention {
  private live = new Set<string>();
  private healthy = new Set<ResetProvider>();
  onEvents: (events: AttentionEvents) => void = () => {};
  constructor(private readonly store: Store, private readonly startedAt: number) {}

  begin() {
    const live = new Set(this.live);
    const candidates: QuotaCandidate[] = [];
    const invalidations = new Map<string, Invalidation>();
    const invalidate = (sourceId: string, windowId: string, at: number) => {
      invalidations.set(JSON.stringify([sourceId, windowId]), {sourceId, windowId, at});
    };
    return {
      unavailable: (source: SourceState, at: number) => {
        live.delete(source.id);
        for (const window of source.windows) invalidate(source.id, window.id, at);
        for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].sourceId === source.id) candidates.splice(i, 1);
      },
      record: (source: SourceState, measurement: Measurement, now: number) => {
        const postStart = measurement.observedAt >= this.startedAt;
        const fresh = postStart && now - measurement.observedAt <= 60_000;
        const observing = live.has(source.id) && fresh && source.error === null && (!source.resources?.windows || source.resources.windows.status === 'observed');
        for (const old of source.windows) {
          if (!measurement.windows.some(w => w.id === old.id)) invalidate(source.id, old.id, measurement.observedAt);
        }
        for (const window of measurement.windows) {
          const row = this.store.db.prepare('SELECT payload FROM attention_windows WHERE source_id = ? AND window_id = ?').get(source.id, window.id) as {payload: string} | undefined;
          const previous = row ? readLedger(row.payload) : null;
          const sample = {...window, at: measurement.observedAt, staleAfterMs: measurement.staleAfterMs};
          const {ledger, event, boundary} = advanceWindow(previous, sample, observing && previous !== null && previous.previous.at >= this.startedAt && source.windows.some(w => w.id === window.id));
          if (boundary) invalidate(source.id, window.id, sample.at);
          this.store.db.prepare('INSERT OR REPLACE INTO attention_windows VALUES (?, ?, ?, ?, ?)').run(source.id, window.id, ledger.cycle, sample.at, JSON.stringify(ledger));
          if (event && previous) candidates.push({
            id: `${source.id}/${window.id}/${ledger.cycle}/${event}`, kind: event, at: now,
            observedFrom: previous.previous.at, observedAt: sample.at, sourceId: source.id, windowId: window.id,
            provider: source.provider, name: '', window: {kind: window.kind, label: window.label, minutes: window.minutes}, remaining: window.remaining, resetAt: window.resetAt,
          });
        }
        if (postStart) live.add(source.id);
        // A batch speaks about its last value, even when the last step was only a correction.
        for (let i = candidates.length - 1; i >= 0; i--) {
          const c = candidates[i];
          if (c.sourceId !== source.id) continue;
          const w = measurement.windows.find(w => w.id === c.windowId);
          const boundary = invalidations.get(JSON.stringify([c.sourceId, c.windowId]));
          if (!w || !sameWindow(c.window, w) || (boundary && c.observedAt < boundary.at)) candidates.splice(i, 1);
          else candidates[i] = {...c, remaining: w.remaining, resetAt: w.resetAt};
        }
      },
      committed: () => {
        this.live = live;
        this.publish(batchCandidates(candidates), [...invalidations.values()]);
      },
    };
  }

  /** One selected tracker result per provider. Recovery is always a silent baseline. */
  announcement(provider: ResetProvider, status: ResetStatus | undefined, ok: boolean, now: number) {
    const wasHealthy = this.healthy.has(provider);
    if (!ok) { this.healthy.delete(provider); return; }
    this.healthy.add(provider);
    const scheduled = status?.scheduled;
    if (!scheduled) return;
    const row = this.store.db.prepare('SELECT last_announced_at AS at, payload FROM attention_announcements WHERE provider = ?').get(provider) as {at: number; payload: string} | undefined;
    let seen: string[] = [];
    let valid = true;
    if (row) {
      try { const data: unknown = JSON.parse(row.payload); if (!Array.isArray(data) || data.length > 64 || !data.every(v => typeof v === 'string')) throw new Error(); seen = data; }
      catch { valid = false; trouble(new Error('invalid_attention_announcements')); }
    }
    if (row && scheduled.at < row.at) return;
    const normalized = new URL(scheduled.url); normalized.hash = '';
    const id = `${provider}/${normalized.href}/${scheduled.at}`;
    if (row?.at !== scheduled.at) seen = [];
    if (seen.includes(id)) return;
    const full = seen.length >= 64;
    if (!full) seen.push(id);
    this.store.db.prepare('INSERT OR REPLACE INTO attention_announcements VALUES (?, ?, ?)').run(provider, scheduled.at, JSON.stringify(seen));
    if (wasHealthy && valid && !full) this.publish([{id, kind: 'announcement', at: now, provider, scheduledFor: scheduled.scheduledFor, resetKind: scheduled.kind, credit: status!.credit, url: scheduled.url}]);
  }

  private publish(candidates: Candidate[], invalidations: Invalidation[] = []) {
    if (!candidates.length && !invalidations.length) return;
    try { this.onEvents({candidates, invalidations}); } catch (error) { trouble(error); }
  }
}

function readLedger(payload: string): WindowLedger | null {
  try {
    const value = JSON.parse(payload) as WindowLedger;
    const w: WindowSample = value.previous;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.cycle) || value.cycle < 0 || typeof value.consumedLow !== 'boolean' || typeof value.consumedCritical !== 'boolean' ||
      !w || !['session', 'weekly', 'other'].includes(w.kind) || (w.label !== null && typeof w.label !== 'string') ||
      ![w.at, w.used, w.remaining, w.staleAfterMs].every(Number.isFinite) || w.staleAfterMs <= 0 ||
      (w.resetAt !== null && !Number.isFinite(w.resetAt)) || (w.minutes !== null && !Number.isFinite(w.minutes))) throw new Error();
    return value;
  } catch { trouble(new Error('invalid_attention_window')); return null; }
}
