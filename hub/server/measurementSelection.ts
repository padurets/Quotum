import {randomUUID} from 'node:crypto';
import {admitMeasurement, type AttemptContext} from './domain/measurementPolicy.js';
import type {ClientProvider} from './domain/providers.js';
import type {Store} from './store/store.js';
import type {Directory} from './store/directory.js';
import type {Duty} from './duty.js';
import type {Cadence} from './cadence.js';

type Candidate = {device: string; provider: ClientProvider; key: string; seenAt: number; expiresAt: number};
type Command = {id: string; device: string; provider: ClientProvider; key: string; authority: string; epoch: number; mode: 'legacy' | 'contextV1'; at: number; deadline: number};
export type CandidateReason = 'eligible' | 'disabled' | 'epoch_required' | 'offline' | 'paused' | 'account_unknown' | 'revoked';

/** Current account evidence is indexed both ways; historical device_sources is never an authority. */
export class MeasurementSelection {
  private readonly candidates = new Map<string, Map<string, Candidate>>();
  private readonly devices = new Map<string, Map<string, Candidate>>();
  private readonly commands = new Map<string, Command>();
  constructor(private readonly store: Store, private readonly directory: Directory, private readonly duty: Duty, private readonly cadence: Cadence,private readonly changed:(key:string)=>void=()=>{}) {}

  observe(key: string, provider: ClientProvider, device: string, now: number, nextAskMs = 120_000, replace = true) {
    const before = this.devices.get(device)?.get(key);
    const latest=Math.max(-Infinity,...[...(this.devices.get(device)?.values()??[])].filter(candidate=>candidate.provider===provider).map(candidate=>candidate.seenAt));
    if(replace && now<latest)return false;
    if(replace && !before)this.current(device,new Map([[provider,new Set([key])]]),now);
    const command=this.commands.get(key);
    const candidate = {key, provider, device, seenAt: now, expiresAt: Math.max(now + Math.min(10*60_000, Math.max(120_000, nextAskMs))+120_000,command?.device===device?command.deadline:0)};
    let account = this.candidates.get(key); if (!account) this.candidates.set(key, account = new Map());
    account.set(device, candidate);
    let owned = this.devices.get(device); if (!owned) this.devices.set(device, owned = new Map());
    owned.set(key, candidate);
    return !before;
  }

  /** Multiplexed account groups may span batches; a singleton is evidence of a changed login. */
  current(device:string,accounts:Map<ClientProvider,Set<string>>,now:number) {
    for(const before of [...(this.devices.get(device)?.values() ?? [])]) {
      const current=accounts.get(before.provider);
      if(before.expiresAt>now && (!current || current.size!==1 || current.has(before.key)))continue;
      this.duty.release(before.key,device);
      this.cadence.withdraw(before.key,device,now);
      if(this.commands.get(before.key)?.device===device)this.commands.delete(before.key);
      this.remove(before);
      this.changed(before.key);
    }
  }

  private remove(candidate: Candidate) {
    const account = this.candidates.get(candidate.key); account?.delete(candidate.device);
    if (!account?.size) this.candidates.delete(candidate.key);
    const owned = this.devices.get(candidate.device); owned?.delete(candidate.key);
    if (!owned?.size) this.devices.delete(candidate.device);
  }

  reason(key: string, provider: ClientProvider, device: string, now: number): CandidateReason {
    if (!this.directory.deviceLive(device)) return 'revoked';
    const policy = this.store.measurementPolicies.device(device), gate = policy.collectors[provider];
    if (!policy.enabled || !gate.enabled) return 'disabled';
    if (gate.requiresEpoch && !this.store.measurementPolicies.control(device).capable) return 'epoch_required';
    const candidate = this.candidates.get(key)?.get(device);
    if (!candidate || candidate.provider !== provider) return 'account_unknown';
    if (candidate.expiresAt <= now) return 'offline';
    if (this.cadence.pausedUntil(key, device, now) !== null) return 'paused';
    return 'eligible';
  }

  preferred(source: string | null, provider: ClientProvider, key: string, now: number): string | null {
    const device = source ? this.store.measurementPolicies.preference(source).device : null;
    if (!device) return null;
    const owner = this.directory.deviceById(device)?.userId;
    return owner && this.store.holds(owner, source!) && this.reason(key, provider, device, now) === 'eligible' ? device : null;
  }

  pending(source: string, provider: ClientProvider, key: string, now: number): boolean {
    const preferred = this.preferred(source, provider, key, now);
    const holder=this.duty.holder(key);
    return preferred !== null && holder !== null && preferred !== holder && (this.duty.until(key) ?? 0)>now;
  }

  claim(source: string | null, provider: ClientProvider, key: string, device: string, active: boolean, now: number) {
    const preferred = this.preferred(source, provider, key, now), holder = this.duty.holder(key);
    if (preferred !== null) {
      if (holder !== preferred && holder !== null && this.duty.measuring(key, now)) return {measure: false, until: Math.min(this.duty.until(key)!, now+15_000)};
      if (device !== preferred) return {measure: false, until: now+60_000};
      if (holder !== null && holder !== preferred) {
        this.cadence.retainDispatched(key,holder);
        this.duty.release(key, holder);
      }
      // A preferred holder cannot lose authority merely to another candidate's activity.
    }
    return this.duty.claim(key, device, active, now);
  }

  issue(key: string, provider: ClientProvider, device: string, modern: boolean, now: number): string | undefined {
    const policy = this.store.measurementPolicies.device(device);
    const command: Command = {id: randomUUID(), key, provider, device, authority: policy.authority,
      epoch: policy.collectors[provider].epoch, mode: modern ? 'contextV1' : 'legacy', at: now, deadline: now+300_000};
    this.commands.set(key, command);
    return modern ? command.id : undefined;
  }

  acknowledges(key: string, provider: ClientProvider, device: string, at: number, context: AttemptContext | null, success: boolean): boolean {
    const command = this.commands.get(key);
    // Released successful acknowledgement also covers non-paced legacy traffic.
    if (!command) return success && context === null;
    if (command.device !== device || command.provider !== provider || at < command.at-30_000 || at>command.deadline) return false;
    if (command.mode === 'legacy') return success;
    return context?.commandId === command.id && context.authority === command.authority && context.collectorEpoch === command.epoch &&
      (success || context.target.kind === 'verified' && context.target.accountKey === key);
  }

  failureAccount(provider: ClientProvider, device: string, context: AttemptContext | null, now: number): string | null {
    if (!context || context.target.kind !== 'verified') return null;
    const key = context.target.accountKey, candidate = this.candidates.get(key)?.get(device);
    if (!candidate || candidate.provider !== provider || candidate.expiresAt <= now ||
      admitMeasurement(this.store.measurementPolicies.device(device), provider, context) !== 'accepted') return null;
    return key;
  }

  invalidate(device: string, providers?: readonly ClientProvider[]) {
    const affected = [...(this.devices.get(device)?.values() ?? [])].filter(c => !providers || providers.includes(c.provider));
    for (const c of affected) {
      this.duty.release(c.key, device);
      if (this.commands.get(c.key)?.device === device) this.commands.delete(c.key);
      this.remove(c);
    }
    return affected.map(c => c.key);
  }

  /** Existing hub maintenance also releases evidence from devices that never reconnect. */
  prune(now:number) {
    let removed=0;
    for(const account of this.candidates.values())for(const candidate of account.values()) {
      if(candidate.expiresAt>now&&this.directory.deviceLive(candidate.device))continue;
      this.duty.release(candidate.key,candidate.device);
      this.cadence.withdraw(candidate.key,candidate.device,now);
      if(this.commands.get(candidate.key)?.device===candidate.device)this.commands.delete(candidate.key);
      this.remove(candidate);this.changed(candidate.key);removed++;
    }
    return removed;
  }

  ownCandidates(user: string, source: string, provider: ClientProvider, key: string, now: number) {
    return this.directory.devices(user).map(device => ({device: device.id, reason: this.reason(key, provider, device.id, now),
      seenAt: this.candidates.get(key)?.get(device.id)?.seenAt ?? null, onDuty: this.duty.holder(key) === device.id && (this.duty.until(key) ?? 0)>now, source}));
  }
}
