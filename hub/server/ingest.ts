import type {Attention} from './attention.js';
import {secretKind} from './domain/auth.js';
import {CLOCK_TOLERANCE_MS, Invalid, parseBatch, parseCheckin, parseSessions, parseSender, subscriptionKey, toMeasurement, type AgentSender} from './domain/ingest.js';
import {parseActivity} from './domain/activity.js';
import {ActivityIngest} from './activity.js';
import {deliveryOf,quotaObservation} from './domain/quota.js';
import {Forecasts} from './forecasts.js';
import {Sessions} from './sessions.js';
import {ACTIVE_WITHIN_MS, type Cadence, type Signals, type Why} from './cadence.js';
import type {Duty} from './duty.js';
import {clientProviders as providers, type Provider} from './domain/providers.js';
import type {Device, Directory, Token} from './store/directory.js';
import type {Store} from './store/store.js';
import {afterCommit, tell, type Touches} from './touches.js';
import {admitMeasurement, type MeasurementPolicy} from './domain/measurementPolicy.js';
import {MeasurementSelection} from './measurementSelection.js';
import type {ClientProvider} from './domain/providers.js';

export type IngestResult = {accepted: number; duplicates: number; failures: number; policySuppressed?: number; device: {id: string}};

/** What a device is told of each subscription; a device following the hub's pace also learns whether it is on duty and when to ask again. */
export type CheckinResult = {
  subscriptions: {provider: Provider; measure: boolean; until: string; onDuty?: boolean; askInMs?: number; nextInMs?: number; commandId?: string; accountKey?: string}[];
  policy?: MeasurementPolicy;
};

/** Who is delivering: a device with its own token, or a machine with its person's machine token. */
export type Credential = {kind: 'device'; device: Device} | {kind: 'token'; token: Token};

/** Why a known agent is refused: its device or token was disconnected, or the machine is connected with a code already. */
export class IngestError extends Error {
  constructor(readonly code: 'device_revoked' | 'device_conflict') {
    super(code);
  }
}

/**
 * Measurements pushed by agents (ingest format v1). A batch is parsed whole, then
 * stored in one transaction. Every batch comes from one device of one person; its
 * snapshots are filed under subscriptions kept once on the hub, so one account measured
 * by many devices, of one person or several, is one source, held by each of them.
 */
export class Ingest {
  /** The coding agents running on the devices right now. */
  readonly live: Sessions;
  readonly activity:ActivityIngest;
  /** Where the recent pace of each weekly window leads, one forecast per window for every board and /api/overview. */
  readonly forecasts: Forecasts;
  private observer: Touches | null = null;
  attention: Attention | null = null;
  readonly measurementSelection: MeasurementSelection;

  constructor(
    private readonly store: Store,
    private readonly directory: Directory,
    private readonly duty: Duty,
    private readonly cadence: Cadence,
  ) {
    this.live = new Sessions(store);
    this.activity=new ActivityIngest(store,this.live);
    this.forecasts = new Forecasts(store);
    this.measurementSelection = new MeasurementSelection(store, directory, duty, cadence,key=>{
      const sources=providers.flatMap(provider=>this.store.findSource(provider,key)??[]);
      for(const source of sources)this.notifyMeasurementOwners(source,false);
      tell(this.observer,o=>o.touchSources(sources));
    });
  }

  /** Tells `observer` which sources every delivery, check-in and list of agents touches (events of open dashboards). */
  setObserver(observer: Touches) {
    this.observer = observer;
  }

  /** The credential of an `Authorization` header; 'revoked' for a disconnected device or a revoked token. */
  authenticate(header: string | undefined): Credential | 'revoked' | null {
    const secret = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
    if (!secret) return null;
    switch (secretKind(secret)) {
      case 'qt_d': {
        const found = this.directory.deviceBySecret(secret);
        if (!found) return null;
        return found.revoked ? 'revoked' : {kind: 'device', device: found};
      }
      case 'qt_m': {
        const found = this.directory.tokenBySecret(secret);
        if (!found) return null;
        return found.revoked ? 'revoked' : {kind: 'token', token: found};
      }
      default:
        return null;
    }
  }

  accept(credential: Credential, body: unknown, now = Date.now()): IngestResult {
    const batch = parseBatch(body);
    // An agent whose clock is off: its times are moved by the difference, measured at sending.
    const skew = Math.abs(now - batch.sentAt) > CLOCK_TOLERANCE_MS ? now - batch.sentAt : 0;
    // A measurement from the future would hide every real one after it as a duplicate.
    const future = [...batch.snapshots, ...batch.failures].find(item => item.observedAt + skew > now + CLOCK_TOLERANCE_MS);
    if (future) throw new Invalid('observedAt');

    const attention = this.attention?.begin();
    const accepted = this.directory.transaction(() => {
      const device = this.device(credential, batch, now);
      const result: IngestResult = {accepted: 0, duplicates: 0, failures: 0, device: {id: device.id}};
      const policy = this.store.measurementPolicies.device(device.id);
      // Every source the batch is about: its pace and its holder's duty move even when nothing new is recorded.
      const touched = new Set<string>();
      const evidenceGroups=new Map<ClientProvider,Set<string>>();

      for (const snapshot of [...batch.snapshots].sort((a, b) => a.observedAt - b.observedAt)) {
        if (admitMeasurement(policy, snapshot.provider, snapshot.attemptContext ?? null) !== 'accepted') {
          result.policySuppressed = (result.policySuppressed ?? 0)+1;
          continue;
        }
        const observedAt = snapshot.observedAt + skew;
        const account = subscriptionKey(snapshot, device.userId);
        const source = this.store.source(snapshot.provider, account, now);
        touched.add(source);
        this.store.hold(source, device.userId, now);
        this.store.seenDevice(device.id, snapshot.provider, source, now);
        const previous = this.store.state(source);
        const measurement = {...toMeasurement(snapshot), observedAt};
        const recorded = this.store.record(source, measurement);
        const acknowledge = this.measurementSelection.acknowledges(account, snapshot.provider, device.id, observedAt, snapshot.attemptContext ?? null, true);
        if (recorded.accepted) this.store.recordOrigins(source, device.id, snapshot, previous, observedAt);
        if (recorded.accepted) this.notifyMeasurementOwners(source);
        if (recorded.accepted) result.accepted++; else result.duplicates++;
        if (recorded.windows) attention?.record(previous, measurement, now);
        if (recorded.unavailable) attention?.unavailable(previous, observedAt);
        if(recorded.delivery){let group=evidenceGroups.get(snapshot.provider);if(!group)evidenceGroups.set(snapshot.provider,group=new Set());group.add(account);}
        afterCommit(() => {
          const evidence=recorded.delivery ? this.measurementSelection.observe(account, snapshot.provider, device.id, observedAt,120_000,evidenceGroups.get(snapshot.provider)!.size===1) : null;
          this.cadence.settleRefresh(account, this.refreshDuty(account), now);
          let onDuty = false;
          if (recorded.delivery) {
            this.cadence.refreshResult(account, device.id, observedAt, true, now);
            if (evidence?.current && evidence.expiresAt>now && this.cadence.canRenewDuty(account, device.id, observedAt) && this.measurementSelection.configured(device.id,snapshot.provider,now)) {
              this.duty.delivered(account, device.id, observedAt, snapshot.staleAfterMs, now, acknowledge);
              onDuty = this.duty.holder(account) === device.id;
            }else if(acknowledge&&!this.measurementSelection.configured(device.id,snapshot.provider,now))this.duty.acknowledge(account,device.id,observedAt);
          } else if (acknowledge) this.duty.acknowledge(account, device.id, observedAt);
          this.cadence.settleRefresh(account, this.refreshDuty(account), now);
          if (recorded.delivery) this.cadence.delivered(account,device.id,recorded.windows ? snapshot.windows : null,observedAt,snapshot.staleAfterMs,this.signals(source,account,now).inUse,now,onDuty,acknowledge);
          else if (recorded.accepted) this.cadence.observed(account,device.id,recorded.windows ? snapshot.windows : null,observedAt,this.signals(source,account,now).inUse,now,acknowledge);
          else if (acknowledge) this.cadence.acknowledge(account,device.id,observedAt);
          this.measurementSelection.releaseUnconfigured(account,snapshot.provider,now);
        });
      }

      for (const failure of batch.failures) {
        if (admitMeasurement(policy, failure.provider, failure.attemptContext ?? null) !== 'accepted') {
          result.policySuppressed = (result.policySuppressed ?? 0)+1;
          continue;
        }
        const at = failure.observedAt + skew;
        this.store.deviceFailed(device.id, failure.provider, failure.error, failure.detail, at);
        this.directory.measurementsChanged(device.userId);
        const key = this.measurementSelection.failureAccount(failure.provider, device.id, failure.attemptContext ?? null, now);
        if (!key) continue;
        const source = this.store.findSource(failure.provider, key);
        const acknowledge = this.measurementSelection.acknowledges(key, failure.provider, device.id, at, failure.attemptContext ?? null, false);
        const refreshAcknowledged=this.measurementSelection.acknowledgesRefreshFailure(key,failure.provider,device.id,at,failure.attemptContext??null);
        const known=key&&this.store.findSource(failure.provider,key);
        const failureFloor=known?deliveryOf(this.store.state(known))?.at??-Infinity:-Infinity;
        if (key&&at>failureFloor) afterCommit(() => {
          this.cadence.settleRefresh(key, this.refreshDuty(key), now);
          if (this.cadence.failed(key, device.id, failure.error, at, acknowledge)) {
            if(source)this.notifyMeasurementOwners(source,false);
            if (acknowledge && this.duty.failed(key, device.id, at)) this.cadence.released(key, device.id);
            if (refreshAcknowledged) this.cadence.refreshResult(key, device.id, at, false, now);
          }
          this.cadence.settleRefresh(key, this.refreshDuty(key), now);
        });
        const paused = key && this.store.findSource(failure.provider, key);
        if (paused) touched.add(paused);
        if (source) touched.add(source);
        if (!source) continue;
        const state = this.store.state(source);
        // Another device may measure the same account fine; only a source gone quiet shows the problem.
        const delivery = deliveryOf(state);
        if (delivery && at - delivery.at <= delivery.staleAfterMs) continue;
        this.store.fail(source, failure.error);
        result.failures++;
      }
      // Heard from, the device is not silent: nor are the subscriptions it holds, those its
      // measurements just handed it included, and delivers nothing for now.
      afterCommit(() => {
      const held = this.cadence.keysOf([device.id]).filter(key => this.duty.holder(key) === device.id && providers.some(provider => {
        if (!this.store.findSource(provider,key)) return false;
        const gate=policy.collectors[provider];
        return policy.enabled && gate.enabled && (!gate.requiresEpoch || [...batch.snapshots,...batch.failures].some(outcome=>outcome.provider===provider && admitMeasurement(policy,provider,outcome.attemptContext??null)==='accepted'));
      }));
      for (const key of held) this.cadence.settleRefresh(key, this.refreshDuty(key), now);
      this.cadence.heard(device.id, held, now);
      for (const source of held.flatMap(key => providers.flatMap(provider => this.store.findSource(provider, key) ?? []))) touched.add(source);
      // Waiting protection uses the whole batch's accepted data and bounded evidence of contact.
      for (const source of touched) this.protect(source, this.store.account(source)!, now);
      tell(this.observer, o => o.touchSources([...touched]));
      });
      return result;
    });
    attention?.committed();
    return accepted;
  }

  /**
   * Tells a device which of its subscriptions to measure now and when to ask again for the
   * rest. A device following the hub's pace measures a subscription it is on duty for only
   * when its pace says so, and does not take duty while it waits out its failures.
   */
  checkin(credential: Credential, body: unknown, now = Date.now()): CheckinResult {
    const request = parseCheckin(body);
    const device = this.device(credential, request, now);
    const policy = this.store.measurementPolicies.device(device.id);
    const configured=this.measurementSelection.configure(device.id,request.collectors,now);
    if(configured.changed)this.directory.measurementsChanged(device.userId);
    for(const {key,provider} of configured.accounts) {
      const source=this.store.findSource(provider,key);
      if(source)this.notifyMeasurementOwners(source,false);
    }
    const confirmation=this.store.measurementPolicies.confirm(device.id, request.measurementPolicy && request.attemptContext, request.policyAck?.revision ?? null, request.policyAck?.authority ?? null);
    if (confirmation.changed) this.directory.measurementsChanged(device.userId);
    // Capability changes affect existing account candidates even without a subscription directive.
    if (confirmation.capabilityChanged) for(const {key,provider} of this.measurementSelection.candidateAccounts(device.id)) {
      const source=this.store.findSource(provider,key);
      if(source)this.notifyMeasurementOwners(source,false);
    }
    const currentAccounts=new Map<ClientProvider,Set<string>>();
    for(const subscription of request.subscriptions) {
      if('measuredBy' in subscription)continue;
      let accounts=currentAccounts.get(subscription.provider);
      if(!accounts)currentAccounts.set(subscription.provider,accounts=new Set());
      accounts.add(subscriptionKey(subscription,device.userId));
    }
    this.measurementSelection.current(device.id,currentAccounts,now);
    const iso = (ms: number) => new Date(ms).toISOString();
    // Asking moves the pace and who is on duty, which the board shows.
    tell(this.observer, o => o.touchSources(request.subscriptions.flatMap(s => 'measuredBy' in s ? [] : this.store.findSource(s.provider, subscriptionKey(s, device.userId)) ?? [])));
    return {
      ...(request.measurementPolicy ? {policy} : {}),
      subscriptions: request.subscriptions.map(s => {
        if ('measuredBy' in s) return {provider: s.provider, measure: false, onDuty: false, askInMs: 86_400_000, until: iso(now + 86_400_000)};
        if (!policy.enabled || !policy.collectors[s.provider].enabled || policy.collectors[s.provider].requiresEpoch && !request.attemptContext) {
          return {provider: s.provider, measure: false, onDuty: false, askInMs: 60_000, until: iso(now+60_000)};
        }
        const key = subscriptionKey(s, device.userId);
        const source = this.store.findSource(s.provider, key);
        const before=this.measurementSelection.state(source,s.provider,key,now);
        const reply=(()=>{
          if (this.measurementSelection.observe(key, s.provider, device.id, now,120_000,false).changed) this.directory.measurementsChanged(device.userId);
          this.restoreFixed(source, key, now);
          this.cadence.settleRefresh(key, this.refreshDuty(key), now);
          this.cadence.capability(key, device.id, request.paced, s.minIntervalMs, now);
          this.protect(source, key, now);
          this.cadence.settleRefresh(key, this.refreshDuty(key), now);
          if (!request.paced) {
            const directive = this.measurementSelection.claim(source, s.provider, key, device.id, s.active, now);
            this.cadence.settleRefresh(key, this.refreshDuty(key), now);
            return {provider: s.provider, measure: directive.measure, until: iso(directive.until)};
          }
          const paused = this.cadence.pausedUntil(key, device.id, now);
          const holder = this.duty.holder(key);
          const leased = (this.duty.until(key) ?? 0) > now;
          if (paused !== null && !(holder === device.id && leased)) {
            // Another device measures it, or none does until this one's pause is over.
            const askInMs = Math.ceil(Math.min(paused - now, 10 * 60_000));
            return {provider: s.provider, measure: false, onDuty: !(holder !== null && holder !== device.id && leased), askInMs, until: iso(now + askInMs)};
          }
          const directive = this.measurementSelection.claim(source, s.provider, key, device.id, s.active, now);
          this.cadence.settleRefresh(key, this.refreshDuty(key), now);
          if (!directive.measure) {
            return {provider: s.provider, measure: false, onDuty: false, askInMs: directive.until - now, until: iso(directive.until)};
          }
          const answer = this.cadence.answer(key, device.id, s.provider, now, s.minIntervalMs, this.signals(source, key, now));
          if (answer.measure) this.duty.asked(key, device.id, now);
          const commandId = answer.measure ? this.measurementSelection.issue(key, s.provider, device.id, request.attemptContext, now) : undefined;
          this.protect(source, key, now);
          return {provider: s.provider, ...answer, ...(request.attemptContext ? {accountKey:key} : {}), ...(commandId ? {commandId} : {}), until: iso(now + answer.askInMs)};
        })();
        // Every allowed wait keeps its account evidence until the next requested contact.
        this.measurementSelection.observe(key, s.provider, device.id, now, Date.parse(reply.until)-now,false);
        const after=this.measurementSelection.state(source,s.provider,key,now);
        if(source&&(before.holder!==after.holder||before.pending!==after.pending))this.notifyMeasurementOwners(source,false);
        return reply;
      }),
    };
  }

  /**
   * When a subscription is measured next and why, while its holder follows the hub's pace
   * (null otherwise), and the first moment that may change with nothing new told to the
   * hub: the pace's own (Cadence.viewChangesAt), or the subscription no longer in use.
   */
  nextMeasurement(source: string, key: string, now: number): {value: {next: number; why: Why} | null; changesAt: number | null} {
    const holder = this.duty.holder(key);
    const until = this.duty.until(key);
    if (holder === null || until === null || until <= now || !this.directory.deviceLive(holder)) return {value: null, changesAt: null};
    const signals = this.signals(source, key, now);
    const value = this.cadence.view(key, holder, now, signals);
    const boundary = this.cadence.viewChangesAt(key, holder, now, signals);
    const own = value === null ? boundary : Math.min(boundary ?? Infinity, until);
    if (value === null || !signals.inUse) return {value, changesAt: own};
    const activeAt = this.duty.activeAt(key);
    const ends = [
      own,
      this.live.workingChangesAt(source, now),
      activeAt !== null && activeAt + ACTIVE_WITHIN_MS >= now ? activeAt + ACTIVE_WITHIN_MS + 1 : null,
    ].filter((at): at is number => at !== null);
    return {value, changesAt: ends.length ? Math.min(...ends) : null};
  }

  private refreshDuty(key: string) {
    const holder = this.duty.holder(key);
    const retained=this.cadence.retainedDevice(key);
    return {holder, until: this.duty.until(key), live: holder !== null && this.directory.deviceLive(holder),retainedLive:retained!==null&&this.directory.deviceLive(retained)};
  }

  refresh(source: string, now: number) {
    const key = this.store.account(source)!;
    const value = this.cadence.refresh(key, this.refreshDuty(key), now);
    const provider = this.store.state(source).provider;
    if (providers.includes(provider as typeof providers[number]) && this.measurementSelection.pending(source, provider as typeof providers[number], key, now)) {
      return {...value, value: {...value.value, unavailable: 'handover_pending' as const}};
    }
    return value;
  }

  requestRefresh(source: string, now: number) {
    if (this.refresh(source, now).value.unavailable === 'handover_pending') return {status: 'unavailable' as const, reason: 'handover_pending'};
    const key = this.store.account(source)!;
    const result = this.cadence.requestRefresh(key, this.refreshDuty(key), deliveryOf(this.store.state(source))?.at ?? null, now);
    this.measurementSelection.bindRefresh(key);
    tell(this.observer, o => o.touchSources([source]));
    return result;
  }

  /** Frequency writes update duty synchronously before any reader or competing check-in can see them. */
  frequencyChanged(source: string, now: number) {
    const key = this.store.account(source)!;
    this.restoreFixed(source, key, now);
    this.protect(source, key, now);
    tell(this.observer, o => o.touchSources([source]));
  }

  preferenceChanged(source: string) {
    // Intent waits for the next pull; it neither renews a lease nor moves a dispatched request.
    afterCommit(() => {
      this.notifyMeasurementOwners(source);
      tell(this.observer, o => o.touchSources([source]));
    });
  }

  participationChanged(device: string, collectors: ClientProvider[], now: number) {
    afterCommit(() => {
    const keys = this.measurementSelection.invalidate(device, collectors);
    for (const key of keys) this.cadence.withdraw(key, device, now);
    const sources = keys.flatMap(key => providers.flatMap(provider => this.store.findSource(provider,key) ?? []));
    tell(this.observer, o => o.touchSources(sources));
    });
  }

  private notifyMeasurementOwners(source: string, metadata = true) {
    for (const row of this.store.db.prepare('SELECT user_id FROM holders WHERE source_id=?').all(source)) this.directory.measurementsChanged(String(row.user_id),metadata);
  }

  measurementSources(user: string, now: number) {
    const personal=this.directory.boards(user).find(board=>board.personal);
    const names=personal ? this.directory.view(personal.id).names : {};
    return this.store.held(user).filter(source => providers.includes(source.provider as ClientProvider)).map(source => {
      const key = this.store.account(source.id)!, provider = source.provider as ClientProvider;
      const preference = this.store.measurementPolicies.preference(source.id);
      const state=this.store.state(source.id);
      const {holder,pending}=this.measurementSelection.state(source.id,provider,key,now);
      const own = preference.device !== null && this.directory.deviceById(preference.device)?.userId === user;
      const producer = (origin: {device:string;at:number;client:string|null;evidence:string|null} | null): {device?:string;name?:string;at:number;client?:string|null;evidence?:string|null;external?:boolean} | null => {
        if (!origin) return null;
        const device = this.directory.deviceById(origin.device);
        return device?.userId === user ? {...origin,name:device.label ?? device.name} : {external:true,at:origin.at};
      };
      return {source:source.id,provider,label:names[source.id] ?? (key.startsWith(`user:${user}/${provider}/`) ? key.slice(`user:${user}/${provider}/`.length) : null),
        duty:holder===null ? 'none' as const : this.directory.deviceById(holder)?.userId===user ? 'own' as const : 'external' as const,
        preference:{revision:preference.revision,kind:preference.device === null ? 'auto' as const : 'preferred' as const,device:own ? preference.device : null},
        pending,
        candidates:this.measurementSelection.ownCandidates(user,source.id,provider,key,now),
        origins:this.store.resourceOrigins(source.id).map(origin=>{
          const observation=origin.resource==='funds'?state.creditBalance:quotaObservation(state,origin.resource==='resets'?'resets':'windows');
          const status: 'observed'|'finite'|'unlimited'|'missing'|'unsupported'|'invalid'|'unknown'=observation?.status ?? 'unknown';
          return {...origin,status,stale:observation ? now-observation.at>observation.staleAfterMs : true,staleAt:observation ? observation.at+observation.staleAfterMs : null,valueOrigin:producer(origin.valueOrigin),observationOrigin:producer(origin.observationOrigin)};
        })};
    });
  }

  private protect(source: string | null, key: string, now: number) {
    const holder = this.duty.holder(key);
    if (holder === null) return;
    const plan = this.directory.deviceLive(holder) ? this.cadence.waitingLease(key, holder, now, this.signals(source, key, now)) : null;
    this.duty.schedule(key, plan == null ? plan : plan.until, plan?.extend);
  }

  private restoreFixed(source: string | null, key: string, now: number) {
    if (source === null || this.store.measureInterval(source) === null) return;
    const state = this.store.state(source);
    const delivery = deliveryOf(state);
    if (delivery) this.cadence.restore(key, delivery.at, delivery.staleAfterMs, state.successAt === null ? null : state.windows, now);
  }

  /** What the hub knows of a subscription now: its windows, and whether it is in use on any machine. */
  private signals(source: string | null, key: string, now: number): Signals {
    const activeAt = this.duty.activeAt(key);
    const state = source ? this.store.state(source) : null;
    const fresh = state?.successAt != null && state.staleAfterMs != null && now-state.successAt <= state.staleAfterMs && (!state.resources?.windows || state.resources.windows.status === 'observed');
    return {
      windows: fresh ? state!.windows : [],
      measureIntervalMs: source ? this.store.measureInterval(source) : null,
      inUse: (source !== null && this.live.working(source, now)) || (activeAt !== null && now - activeAt <= ACTIVE_WITHIN_MS),
    };
  }

  /** Devices taken off the hub: their agents stop showing at once. */
  forget(devices: string[], now = Date.now()) {
    for (const device of devices) this.measurementSelection.invalidate(device);
    for (const key of this.cadence.keysOf(devices)) this.cadence.settleRefresh(key, this.refreshDuty(key), now);
    const keys = this.cadence.forget(devices, now);
    const sources = [
      ...devices.flatMap(device => [...this.live.sourcesOf(device), ...providers.flatMap(provider => this.store.deviceSource(device, provider) ?? [])]),
      ...keys.flatMap(key => providers.flatMap(provider => this.store.findSource(provider, key) ?? [])),
    ];
    this.live.forget(devices);
    tell(this.observer, o => o.touchSources([...new Set(sources)]));
  }

  /** Completed intervals retain their captured evidence; presence never extends their credit. */
  observedActivity(credential:Credential,body:unknown,now=Date.now()) {
    const request=parseActivity(body);
    return this.directory.transaction(()=>{
      const device=this.device(credential,request,now),before=this.live.sourcesOf(device.id,now);
      const result=this.activity.accept(device,request,now);
      if(request.op==='hello'||result.presenceAccepted||'coverage' in result&&result.coverage)afterCommit(()=>{
        const sources=[...new Set([...before,...this.live.sourcesOf(device.id,now),...('coverage' in result&&result.coverage?this.store.held(device.userId).map(s=>s.id):[])])];
        tell(this.observer,o=>o.touchSources(sources));
      });
      return result;
    });
  }

  sessions(credential: Credential, body: unknown, now = Date.now()): {accepted: number;activitySuppressed?:number;requiredActivityProtocol?:number} {
    const sender=parseSender(body);
    return this.directory.transaction(()=>{
      const resolved=this.device(credential,sender,now);
      // The persisted capability is checked before any activity-specific parsing.
      if(this.activity.required(resolved.id)){
        const input=body as Record<string,unknown>;
        const sentAt=typeof input.sentAt==='string'?Date.parse(input.sentAt):NaN;
        const skew=Number.isFinite(sentAt)&&Math.abs(now-sentAt)>CLOCK_TOLERANCE_MS?now-sentAt:0;
        const inventory=parseSessions({...input,sentAt:new Date(now).toISOString(),sessions:[],clientSessions:[],tracking:null}).clients;
        if(inventory!==null)this.directory.saveDeviceClients(resolved.id,resolved.userId,inventory.map(client=>({...client,observedAt:!Number.isFinite(sentAt)||client.observedAt==null?null:Math.min(now,client.observedAt+skew)})),now);
        const count=(value:unknown)=>Array.isArray(value)?Math.min(200,value.length):0;
        return {accepted:0,activitySuppressed:Math.min(200,count(input.sessions)+count(input.clientSessions)),requiredActivityProtocol:1};
      }
      return this.legacySessions(resolved,body,now);
    });
  }

  /**
   * Which coding agents run on a device now. A session is filed under the subscription
   * it names, else under the one this device last delivered for its provider; one the
   * hub does not know, or its person does not hold, keeps that raw binding. Board
   * projections admit device sessions independently and redact undisclosed funding.
   */
  private legacySessions(device: Device, body: unknown, now: number): {accepted: number} {
    const report = parseSessions(body);
    const skew = Math.abs(now - report.sentAt) > CLOCK_TOLERANCE_MS ? now - report.sentAt : 0;
    return this.directory.transaction(() => {
      const name = device.label ?? device.name;
      const legacy = report.sessions.map(({provider, account, accountName, ...session}) => {
        const source = account || accountName ? this.store.findSource(provider, subscriptionKey({provider, account, accountName}, device.userId)) : this.store.deviceSource(device.id, provider);
        return {...session, clientId: session.clientId ?? provider, source,
          accountBy: account || accountName ? 'login' as const : source ? 'inferred' as const : null};
      });
      const supplemental = report.clientSessions.map(({source, ...session}) => ({...session,
        source: source ? this.store.findSource(source.provider, subscriptionKey(source, device.userId)) : null,
        accountBy: source ? 'login' as const : null,
      }));
      const sessions = [...legacy, ...supplemental].map(session => {
        const startedAt = Math.min(now, session.startedAt + skew);
        const lastWorkedAt = session.lastWorkedAt === null ? null : Math.max(startedAt, Math.min(now, session.lastWorkedAt + skew));
        return {...session, startedAt, sentStartedAt: session.startedAt, lastWorkedAt, device: {id: device.id, name}};
      });
      if (report.clients !== null) this.directory.saveDeviceClients(device.id, device.userId, report.clients.map(client=>({...client,observedAt:client.observedAt==null?null:Math.min(now,client.observedAt+skew)})), now);

      const before = this.live.sourcesOf(device.id, now).filter(source => this.store.holds(device.userId, source));
      this.live.report(device.id, device.userId, sessions, now);
      const tracking=this.store.coverage.record(device.id,device.userId,report.tracking,now);
      if(tracking.policy)afterCommit(()=>this.store.links.onChange?.(device.userId));
      tell(this.observer, o => o.touchSources([...new Set([...before, ...this.live.sourcesOf(device.id, now),...(tracking.coverage?this.store.held(device.userId).map(s=>s.id):[])])]));
      return {accepted: sessions.length};
    });
  }

  /**
   * The device a request comes from. A device token names it; with a machine token the
   * machine joins its person on first contact. A machine disconnected by hand cannot
   * come back with the token it had, but a new token (after rotating a leaked one)
   * takes it back.
   */
  private device(credential: Credential, sender: AgentSender, now: number): Device {
    if (credential.kind === 'device') {
      this.directory.touchDevice(credential.device.id, sender.machine, sender.agent, now);
      return credential.device;
    }
    const {token} = credential;
    const existing = this.directory.deviceByMachine(token.userId, sender.machine.id);
    // A machine connected with a code keeps its own token; a machine token cannot take it over.
    if (existing?.byCode && !existing.revoked) throw new IngestError('device_conflict');
    if (existing?.revoked && existing.tokenId === token.id) throw new IngestError('device_revoked');
    this.directory.touchToken(token.id, now);
    return this.directory.saveDevice({userId: token.userId, machine: sender.machine, agent: sender.agent, tokenId: token.id}, now);
  }
}
