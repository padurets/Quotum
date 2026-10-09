import type {DatabaseSync} from 'node:sqlite';
import {balanceDescriptor,monetaryOf} from '../domain/providers.js';
import {amount} from '../domain/amount.js';
import {balanceStatusOf,calendarSpending,spending,utcPeriods, sameMeter, validateMeter, type Meter, type MeterMeasurement, type MeterSpan, type Reading, type QuotaObservation, QUOTA_IDS} from '../domain/meters.js';
import type {SourceState} from '../domain/quota.js';
import {MeterContexts} from './meterContexts.js';
import {meterCells, type MeterGroup, type MeterSelection, type MeterSeriesCells} from '../domain/meterHistory.js';
import type {CurrencyStore} from './currencies.js';
import {conversionOrigin} from '../domain/currency.js';

type ReadingRow = {meter_id: string; at: bigint; previous_at: bigint | null; kind: Meter['kind']; unit: string; amount: bigint; amount_scale: bigint; limit_amount: bigint | null; reset_at: bigint | null; minutes: bigint | null; scope: string | null; label: string | null; stale_after_ms: bigint};
const numberOf = (value: bigint | null) => value === null ? null : Number(value);
const keyMeter = (id: string) => /^key:([0-9a-f]{12}):(?:usage|cap)$/.exec(id)?.[1] ?? null;

/** The source state and sparse exact ledger share their caller's savepoint. */
export class MeterStore {
  readonly contexts:MeterContexts;
  constructor(private readonly db: DatabaseSync,private readonly currencies:CurrencyStore) {this.contexts=new MeterContexts(db);this.contexts.seed();}

  record(source: string, previous: SourceState, measurement: MeterMeasurement): {state: SourceState; since: number|null} {
    const current = new Map((previous.meters ?? []).map(m => [m.id, {...m, stale: true}]));
    const ids = new Set<string>();
    const keyTimes = new Map(measurement.keys.map(key => [key.id, key.at]));
    let since = Infinity;
    if(measurement.balanceStatus || measurement.creditBalance)for(const old of previous.meters??[])if(balanceDescriptor(previous.provider,old.id)&&!measurement.meters.some(m=>m.id===old.id)) {
      const result=this.db.prepare('UPDATE meter_spans SET interrupted_at=? WHERE source_id=? AND meter_id=? AND interrupted_at IS NULL AND from_at=(SELECT max(from_at) FROM meter_spans WHERE source_id=? AND meter_id=?)').run(measurement.observedAt,source,old.id,source,old.id);
      if(result.changes){since=Math.min(since,measurement.observedAt);}
    }
    for (const meter of measurement.meters) {
      validateMeter(meter);
      if(meter.conversion)throw new Error('derived_provider_measurement');
      const key = keyMeter(meter.id);
      if (ids.has(meter.id) || meter.at !== (key === null ? measurement.observedAt : keyTimes.get(key) ?? measurement.observedAt)) throw new Error('invalid_meter');
      ids.add(meter.id);
      const old = current.get(meter.id);
      if (old && old.at >= meter.at) continue;
      const last = this.db.prepare('SELECT from_at,to_at,stale_after_ms,interrupted_at,hold_until FROM meter_spans WHERE source_id=? AND meter_id=? ORDER BY from_at DESC LIMIT 1').get(source, meter.id) as {from_at: number; to_at: number; stale_after_ms: number; interrupted_at:number|null;hold_until:number|null} | undefined;
      const admission = previous.provider === 'codex' && meter.id === 'balance:credits' && !!this.db.prepare('SELECT 1 FROM shares WHERE source_id=? AND budget_anchor_at IS NULL AND budget_since<=? LIMIT 1').get(source, meter.at);
      if (!old || !sameMeter(old, meter) || admission) {
        this.db.prepare('INSERT INTO readings (source_id,meter_id,at,previous_at,kind,unit,amount,limit_amount,reset_at,minutes,scope,label,stale_after_ms,amount_scale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(source, meter.id, meter.at, old?.at ?? last?.to_at ?? null, meter.kind, meter.unit, amount(meter.amount), meter.limit === null ? null : amount(meter.limit), meter.resetAt, meter.minutes, meter.scope, meter.label, meter.staleAfterMs, meter.scale ?? 6);
      }
      if (admission) this.db.prepare('UPDATE shares SET budget_anchor_at=? WHERE source_id=? AND budget_anchor_at IS NULL AND budget_since<=?').run(meter.at, source, meter.at);
      if (last && last.interrupted_at===null && last.hold_until===null && old && meter.at - last.to_at <= last.stale_after_ms && old.kind === meter.kind && old.unit === meter.unit) {
        this.db.prepare('UPDATE meter_spans SET to_at=?,stale_after_ms=? WHERE source_id=? AND meter_id=? AND from_at=?').run(meter.at, meter.staleAfterMs, source, meter.id, last.from_at);
      } else this.db.prepare('INSERT INTO meter_spans (source_id,meter_id,from_at,to_at,stale_after_ms) VALUES (?,?,?,?,?)').run(source, meter.id, meter.at, meter.at, meter.staleAfterMs);
      since = Math.min(since, last?.interrupted_at==null?old?.at??meter.at:meter.at);
      current.set(meter.id, {...meter, stale: false});
    }
    const keys = new Map((previous.keys ?? []).map(k => [k.id, {...k}]));
    const observed = new Set<string>();
    for (const key of measurement.keys) {
      if (!/^[0-9a-f]{12}$/.test(key.id) || observed.has(key.id) || !Number.isSafeInteger(key.at) || key.at < 0) throw new Error('invalid_key_part');
      observed.add(key.id);
      keys.set(key.id, {...key, presence: 'observed', missCount: 0});
    }
    // Only a producer's confirmed null cap ends it. Omission in a partial reply
    // remains unknown and preserves the last measurement.
    for(const key of measurement.uncapped??[]) {
      const id=`key:${key}:cap`;
      if(!observed.has(key)||ids.has(id))throw new Error('invalid_key_part');
      current.delete(id);
      this.db.prepare('UPDATE meter_spans SET stale_after_ms=min(stale_after_ms,max(0,?-to_at-1)) WHERE source_id=? AND meter_id=? AND from_at=(SELECT max(from_at) FROM meter_spans WHERE source_id=? AND meter_id=?)')
        .run(keyTimes.get(key)!,source,id,source,id);
    }
    for (const [id, key] of keys) if (!observed.has(id)) {
      const missCount = key.missCount + (measurement.inventoryComplete ? 1 : 0);
      if (missCount >= 2) {
        keys.delete(id);
        for (const meter of current.keys()) if (keyMeter(meter) === id) current.delete(meter);
      } else keys.set(id, {...key, presence: measurement.inventoryComplete ? 'missing' : key.presence, missCount});
    }
    const accountSuccess = previous.provider === 'openrouter' ? ids.has('credits') && ids.has('usage') : measurement.meters.some(m => !keyMeter(m.id));
    const balanceStatus=balanceStatusOf(previous.provider,previous.meters??[],measurement);
    this.contexts.observe(source,previous.provider,measurement,balanceStatus);
    const state: SourceState = {
      ...previous,
      ...(measurement.plan !== undefined ? {plan: measurement.plan} : {}),
      ...(measurement.quota ? {quota: measurement.quota} : {}),
      successAt: accountSuccess && previous.provider !== 'codex' ? measurement.observedAt : previous.successAt,
      staleAfterMs: accountSuccess && previous.provider !== 'codex' ? measurement.staleAfterMs : previous.staleAfterMs,
      error: previous.provider === 'codex' ? previous.error : accountSuccess||balanceStatus ? null : previous.error,
      ...(measurement.creditBalance ? {creditBalance:measurement.creditBalance} : {}),
      ...(balanceStatus?{balanceStatus}:{}),
      meters: [...current.values()], keys: [...keys.values()].sort((a,b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id)),
      ...(measurement.quota || previous.provider === 'codex' ? {} : {inventory: {complete: measurement.inventoryComplete, observed: observed.size, missing: [...keys.values()].filter(k => k.presence === 'missing').length, error: measurement.inventoryError}}),
    };
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?,?)').run(source, JSON.stringify(state));
    return {state, since:Number.isFinite(since)?since:null};
  }

  observeQuota(source:string,previous:SourceState,observation:QuotaObservation): {state:SourceState;since:number} {
    const at=observation.observedAt;
    if(!Number.isSafeInteger(at)||at<0||observation.quota.observedAt!==at||new Set(observation.receivedIds).size!==observation.receivedIds.length||observation.receivedIds.some(id=>!QUOTA_IDS.includes(id as typeof QUOTA_IDS[number])))throw new Error('invalid_quota_observation');
    const received=new Set(observation.receivedIds);
    for(const id of QUOTA_IDS)if(!received.has(id)) {
      this.db.prepare('UPDATE meter_spans SET hold_until=min(coalesce(hold_until,?),?) WHERE source_id=? AND meter_id=? AND from_at=(SELECT max(from_at) FROM meter_spans WHERE source_id=? AND meter_id=?)').run(at,at,source,id,source,id);
    }
    const state:SourceState={...previous,plan:observation.plan,quota:observation.quota,meters:(previous.meters??[]).map(m=>received.has(m.id)?m:{...m,stale:true}),error:received.size?null:'connector_quota_'+observation.quota.issue};
    this.db.prepare('INSERT OR REPLACE INTO state VALUES (?,?)').run(source,JSON.stringify(state));
    return {state,since:at};
  }

  /** Include one predecessor even when it predates retention: it is evidence, not a plotted point. */
  readings(source: string, meter: string, from: number, to: number): Reading[] {
    const query = this.db.prepare('SELECT * FROM readings WHERE source_id=? AND meter_id=? AND at<? AND at>=coalesce((SELECT max(at) FROM readings WHERE source_id=? AND meter_id=? AND at<?),?) ORDER BY at');
    query.setReadBigInts(true);
    return (query.all(source, meter, to, source, meter, from, from) as ReadingRow[]).map(r => ({id: r.meter_id, at: Number(r.at), previousAt: numberOf(r.previous_at), kind: r.kind, unit: r.unit, amount: r.amount.toString(), ...(r.unit === 'credits:codex' ? {scale:Number(r.amount_scale)} : {}), limit: r.limit_amount?.toString() ?? null, resetAt: numberOf(r.reset_at), minutes: numberOf(r.minutes), scope: r.scope, label: r.label, staleAfterMs: Number(r.stale_after_ms)}));
  }

  spans(source: string, meter: string, from: number, to: number): MeterSpan[] {
    const rows = this.db.prepare('SELECT from_at,to_at,stale_after_ms,interrupted_at,hold_until FROM meter_spans WHERE source_id=? AND meter_id=? AND min(coalesce(interrupted_at,9223372036854775807),coalesce(hold_until,9223372036854775807),to_at+stale_after_ms+1)>? AND from_at<=? ORDER BY from_at').all(source, meter, from, to) as {from_at: number; to_at: number; stale_after_ms: number; interrupted_at:number|null;hold_until:number|null}[];
    return rows.map(r => ({from: r.from_at, to: r.to_at, staleAfterMs: r.stale_after_ms,...(r.hold_until===null?{}:{holdUntil:r.hold_until}),...(r.interrupted_at===null?{}:{interruptedAt:r.interrupted_at})}));
  }

  calendar(source: string, now: number, asOf=now) {
    const from = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1) - 7 * 86_400_000;
    const readings=this.readings(source,'usage',from,now+1),spans=this.spans(source,'usage',0,now);
    if(asOf===now)return calendarSpending(readings,spans,now);
    const periods=utcPeriods(now);
    return {day:spending(readings,spans,periods.day,Math.max(periods.day,asOf)),week:spending(readings,spans,periods.week,Math.max(periods.week,asOf)),month:spending(readings,spans,periods.month,Math.max(periods.month,asOf))};
  }

  groups(selection: MeterSelection, from: number, to: number): MeterGroup[] {
    return selection.ids.map(([source,meter]): MeterGroup => {
      const usage = meter === 'balance' ? 'usage' : meter;
      const provider=this.db.prepare('SELECT provider FROM sources WHERE id=?').get(source)?.provider;
      const policy=monetaryOf(String(provider));
      const descriptor=balanceDescriptor(String(provider),meter);
      const conversion=conversionOrigin(meter);
      if(conversion){const native=balanceDescriptor(String(provider),conversion.meter);return {source,meter,accounting:{spending:'unavailable',topups:'unavailable'},...(native?{role:native.role}:{}),pointMode:'observation',readings:this.currencies.readings(source,meter,from,to),spans:this.currencies.spans(source,meter,to)};}
      const group = {source,meter,...(policy?{accounting:{spending:policy.spending,topups:policy.topups},...(descriptor?{role:descriptor.role}:{}),...(policy.spending==='unavailable'?{pointMode:'observation' as const}:{})}:{accounting:{spending:'unavailable' as const,topups:'unavailable' as const}}),readings:this.readings(source,usage,from,to),spans:this.spans(source,usage,0,to)};
      if (meter !== 'balance') return group;
      if (provider !== 'openrouter') return {...group,readings:this.readings(source,meter,from,to),spans:this.spans(source,meter,0,to)};
      return {...group,paired:{readings:this.readings(source,'credits',from,to),spans:this.spans(source,'credits',0,to)}};
    });
  }

  cells(selection: MeterSelection, from: number, to: number, cell: number, groups=this.groups(selection,from,to)): MeterSeriesCells[] {
    return groups.flatMap(group=>selection.nativeCurrencies?[...new Set(group.readings.map(r=>r.unit))].flatMap(unit=>meterCells(group,unit,from,to,cell)):meterCells(group,selection.unit,from,to,cell));
  }

  prune(cutoff: number): boolean {
    this.contexts.prune(cutoff);
    let changed = this.db.prepare('DELETE FROM readings WHERE at<? AND at<(SELECT max(at) FROM readings r WHERE r.source_id=readings.source_id AND r.meter_id=readings.meter_id AND r.at<?)').run(cutoff, cutoff).changes > 0;
    changed = this.currencies.prune(cutoff) || changed;
    // The last endpoint is evidence of an unchanged observation, even after the
    // current meter has been archived and its changed reading is much older.
    changed = this.db.prepare('DELETE FROM meter_spans WHERE min(coalesce(interrupted_at,9223372036854775807),coalesce(hold_until,9223372036854775807),to_at+stale_after_ms+1)<=? AND from_at<(SELECT max(from_at) FROM meter_spans s WHERE s.source_id=meter_spans.source_id AND s.meter_id=meter_spans.meter_id)').run(cutoff).changes > 0 || changed;
    // Preserve a crossing span's continuity without making its old head visible.
    changed = this.db.prepare("UPDATE meter_spans SET from_at=? WHERE from_at<? AND to_at>=? AND meter_id<>'balance:credits'").run(cutoff, cutoff, cutoff).changes > 0 || changed;
    return changed;
  }
}
