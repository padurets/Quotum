import {clients as knownClients,clientFor, validClientId} from './clients.js';
import {providers, type Provider} from './sources.js';
import {providerOf, type ClientProvider} from './providers.js';
import type {FreeResets, Kind, WindowMeasurement, Win} from './quota.js';
import {exactDecimal, scalarDecimal} from './amount.js';
import {attemptContext, type AttemptContext} from './measurementPolicy.js';
import type {CreditBalance, ResourceStatuses} from './resources.js';

/** Clocks within this of the hub's are taken as they are; beyond it, agent times are shifted. */
export {CLOCK_TOLERANCE_MS} from './history.js';

/**
 * Ingest format v1 (spec/ingest-v1.md): what an agent sends. Parsing is strict; a
 * batch that does not match is refused whole, so nothing half-understood is stored.
 */
export type AgentWindow = {
  id: string;
  kind: Kind;
  minutes: number | null;
  label: string | null;
  usedPercent: number;
  resetsAt: number | null;
};

export type AgentSnapshot = {
  provider: ClientProvider;
  account: string | null;
  /** A name the owner gave a subscription whose client does not identify it. */
  accountName: string | null;
  plan: string | null;
  observedAt: number;
  via: string;
  client: string | null;
  clientEvidence?: 'nativeHandshake' | 'preLaunch';
  staleAfterMs: number;
  windows: AgentWindow[];
  resets: FreeResets | null;
  resourceStatus?: ResourceStatuses;
  balances?: CreditBalance[];
  attemptContext?: AttemptContext | null;
};

export type AgentFailure = {provider: ClientProvider; observedAt: number; error: string; detail: string | null; attemptContext?: AttemptContext | null};

export type CollectionCompletion = {provider:ClientProvider;outcome:'no_new_data';completedAt:number;attemptContext:AttemptContext};
export type AccountRoster = {provider:ClientProvider;accounts:{account:string|null;accountName:string|null}[]};
export type AgentBatch = {
  version: 1;
  agent: string;
  machine: {id: string; name: string; os: string; arch: string};
  sentAt: number;
  snapshots: AgentSnapshot[];
  failures: AgentFailure[];
  completions: CollectionCompletion[];
};

export const AGENT_ERRORS = ['not_logged_in', 'unsupported', 'timeout', 'invalid_output', 'failed', 'not_installed'] as const;

const LIMITS = {items: 500, windows: 32, text: 120, staleAfterMs: 24 * 3_600_000};

/** A request that does not match the format; `what` names the first field that is wrong. */
export class Invalid extends Error {
  constructor(readonly what: string) {
    super(`invalid: ${what}`);
  }
}

/** Account pseudonyms: 24 lower-case hex characters (spec: Snapshot `account`). */
const PSEUDONYM = /^[0-9a-f]{24}$/;

function account(value: unknown): string | null {
  const given = text(value, 'account', true);
  if (given !== null && !PSEUDONYM.test(given)) throw new Invalid('account');
  return given;
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);

/** Longer than `chars` characters, as the spec and the agent count them (a character may take two UTF-16 units). */
export const longerThan = (value: string, chars: number) => value.length > chars && (value.length > 2 * chars || Array.from(value).length > chars);
const tooLong = (value: string) => longerThan(value, LIMITS.text);

function text(value: unknown, what: string, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !value.length || tooLong(value)) throw new Invalid(what);
  return value;
}

/** Optional text that may run longer than the limit: cut to it, so one long value does not lose the rest of a request. */
function cut(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.length) throw new Invalid(what);
  // By characters, as the agent cuts, not by UTF-16 units, which could split one in two.
  return Array.from(value).slice(0, LIMITS.text).join('');
}

function time(value: unknown, what: string, optional = false): number | null {
  if (optional && (value === undefined || value === null)) return null;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Invalid(what);
  return parsed;
}

function provider(value: unknown): Provider {
  if (!providers.includes(value as Provider)) throw new Invalid('provider');
  return value as Provider;
}

/** Read authority before any provider-specific fields, preserving strict client parsing. */
function clientItem(value: unknown, what: string): value is Obj & {provider: ClientProvider} {
  if (!isObject(value)) throw new Invalid(what);
  return providerOf(provider(value.provider))!.measuredBy === 'client';
}

function list(value: unknown, what: string, max: number): unknown[] {
  // An optional field may be left out or null (the spec); either way the list is empty.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Invalid(what);
  return value;
}

function parseWindow(value: unknown): AgentWindow {
  if (!isObject(value)) throw new Invalid('window');
  const used = value.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) throw new Invalid('usedPercent');
  const kind = value.kind;
  if (kind !== 'session' && kind !== 'weekly' && kind !== 'other') throw new Invalid('kind');
  const minutes = value.minutes ?? null;
  if (minutes !== null && (!Number.isInteger(minutes) || (minutes as number) <= 0)) throw new Invalid('minutes');
  return {
    id: text(value.id, 'window id')!,
    kind,
    minutes: minutes as number | null,
    label: text(value.label, 'label', true),
    usedPercent: used,
    resetsAt: time(value.resetsAt, 'resetsAt', true),
  };
}

function parseResets(value: unknown): FreeResets | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || !Number.isInteger(value.available) || (value.available as number) < 0 || (value.available as number) > 1000) {
    throw new Invalid('resets');
  }
  const available = value.available as number;
  const expiring = list(value.expiring, 'resets expiring', 50).map(group => {
    if (!isObject(group) || !Number.isInteger(group.count) || (group.count as number) < 1) throw new Invalid('resets expiring');
    return {count: group.count as number, expiresAt: time(group.expiresAt, 'resets expiring expiresAt', true)};
  });
  if (expiring.reduce((sum, group) => sum + group.count, 0) > available) throw new Invalid('resets expiring');
  // Soonest first, one group per time, the one without a time last: the dashboard lists them as they come.
  expiring.forEach((group, i) => {
    const next = expiring[i + 1];
    if (next && (group.expiresAt === null || (next.expiresAt !== null && next.expiresAt <= group.expiresAt))) throw new Invalid('resets expiring');
  });
  return {available, expiring};
}

function parseSnapshot(value: unknown): AgentSnapshot {
  if (!isObject(value)) throw new Invalid('snapshot');
  const stale = value.staleAfterMs;
  if (!Number.isInteger(stale) || (stale as number) <= 0 || (stale as number) > LIMITS.staleAfterMs) throw new Invalid('staleAfterMs');
  const windows = list(value.windows, 'windows', LIMITS.windows).map(parseWindow);
  const providerId = provider(value.provider) as ClientProvider, identity = account(value.account);
  const resets = parseResets(value.resets);
  let resourceStatus: ResourceStatuses | undefined, balances: CreditBalance[] | undefined;
  if (value.resourceStatus !== undefined) {
    const statuses = value.resourceStatus;
    if (providerId !== 'codex' || !identity || !isObject(statuses) ||
      (typeof statuses.windows !== 'string' || !['observed','missing','unsupported','invalid'].includes(statuses.windows)) ||
      (typeof statuses.resets !== 'string' || !['observed','missing','unsupported','invalid'].includes(statuses.resets))) throw new Invalid('resourceStatus');
    resourceStatus = statuses as ResourceStatuses;
    if ((statuses.windows === 'observed') !== (windows.length > 0) || (statuses.resets === 'observed') !== (resets !== null)) throw new Invalid('resourceStatus');
  }
  if (!windows.length && !resourceStatus) throw new Invalid('windows');
  if (value.balances !== undefined) {
    if (providerId !== 'codex' || !identity || !Array.isArray(value.balances) || value.balances.length > 1) throw new Invalid('balances');
    balances = value.balances.map((balance): CreditBalance => {
      if (!isObject(balance) || balance.id !== 'balance:credits' || balance.unit !== 'credits:codex' ||
        (typeof balance.status !== 'string' || !['finite','unlimited','missing','unsupported','invalid'].includes(balance.status)) ||
        (balance.hasCredits !== undefined && typeof balance.hasCredits !== 'boolean')) throw new Invalid('balances');
      let amount: string | undefined;
      if (balance.status === 'finite') {
        if (typeof balance.amount !== 'string') throw new Invalid('balance amount');
        try {amount = scalarDecimal(exactDecimal(balance.amount));} catch {throw new Invalid('balance amount');}
      } else if (balance.amount !== undefined) throw new Invalid('balance amount');
      return {id:'balance:credits', unit:'credits:codex', status:balance.status as CreditBalance['status'],
        ...(amount === undefined ? {} : {amount}), ...(balance.hasCredits === undefined ? {} : {hasCredits:balance.hasCredits as boolean})};
    });
  }
  return {
    provider: providerId,
    account: identity,
    accountName: text(value.accountName, 'accountName', true),
    plan: text(value.plan, 'plan', true),
    observedAt: time(value.observedAt, 'observedAt')!,
    via: text(value.via, 'via')!,
    client: text(value.client, 'client', true),
    ...(value.clientEvidence === 'nativeHandshake' || value.clientEvidence === 'preLaunch' ? {clientEvidence: value.clientEvidence} : {}),
    staleAfterMs: stale as number,
    windows,
    resets,
    ...(resourceStatus ? {resourceStatus} : {}),
    ...(balances ? {balances} : {}),
    ...(value.attemptContext !== undefined ? {attemptContext: attemptContext(value.attemptContext)} : {}),
  };
}

function parseFailure(value: unknown): AgentFailure {
  if (!isObject(value)) throw new Invalid('failure');
  if (!(AGENT_ERRORS as readonly unknown[]).includes(value.error)) throw new Invalid('error');
  return {
    provider: provider(value.provider) as ClientProvider,
    observedAt: time(value.observedAt, 'observedAt')!,
    error: value.error as string,
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 200) : null,
    ...(value.attemptContext !== undefined ? {attemptContext: attemptContext(value.attemptContext)} : {}),
  };
}

/** Who is sending: the part every agent request shares. */
export type AgentSender = Pick<AgentBatch, 'agent' | 'machine'>;

/** The machine an agent runs on, as every agent request describes it. */
export function parseMachine(machine: unknown): AgentBatch['machine'] {
  if (!isObject(machine)) throw new Invalid('machine');
  return {
    id: text(machine.id, 'machine id')!,
    name: text(machine.name, 'machine name')!,
    os: text(machine.os, 'machine os')!,
    arch: text(machine.arch, 'machine arch')!,
  };
}

export const parseAgent = (value: unknown) => text(value, 'agent')!;

export function parseSender(body: unknown): AgentSender {
  if (!isObject(body)) throw new Invalid('body');
  if (body.version !== 1) throw new Invalid('version');
  return {agent: parseAgent(body.agent), machine: parseMachine(body.machine)};
}

export function parseBatch(body: unknown): AgentBatch {
  const sender = parseSender(body);
  const input = body as Obj;
  return {
    version: 1,
    ...sender,
    sentAt: time(input.sentAt, 'sentAt')!,
    snapshots: list(input.snapshots, 'snapshots', LIMITS.items).filter(value => clientItem(value, 'snapshot')).map(parseSnapshot),
    completions: list(input.completions,'completions',LIMITS.items).filter(value=>clientItem(value,'completion')).map(value=>{
      if(!isObject(value)||value.outcome!=='no_new_data')throw new Invalid('completion');
      const context=attemptContext(value.attemptContext);
      if(!context)throw new Invalid('completion attemptContext');
      return {provider:value.provider as ClientProvider,outcome:'no_new_data' as const,completedAt:time(value.completedAt,'completedAt')!,attemptContext:context};
    }),
    failures: list(input.failures, 'failures', LIMITS.items).filter(value => clientItem(value, 'failure')).map(parseFailure),
  };
}

/**
 * A check-in: which subscriptions a device could measure now, and whether it is in use.
 * `paced`: the device follows the hub's pace; `minIntervalMs`: the most often it agrees
 * to measure a subscription.
 */
type ClientSubscription = {provider: ClientProvider; account: string | null; accountName: string | null; active: boolean; minIntervalMs: number | null};
type HubSubscription = {provider: Exclude<Provider, ClientProvider>; measuredBy: 'hub'};
export type Checkin = AgentSender & {
  paced: boolean;
  measurementPolicy: boolean;
  attemptContext: boolean;
  policyAck: {authority: string; revision: number} | null;
  collectors: ClientProvider[] | null;
  accountRosters:AccountRoster[];
  subscriptions: (ClientSubscription | HubSubscription)[];
};

export function parseCheckin(body: unknown): Checkin {
  const sender = parseSender(body);
  const paced = (body as Obj).paced ?? false;
  if (typeof paced !== 'boolean') throw new Invalid('paced');
  const subscriptions = list((body as Obj).subscriptions, 'subscriptions', 48).map((value): ClientSubscription | HubSubscription => {
    if (!isObject(value)) throw new Invalid('subscription');
    const id = provider(value.provider);
    if (providerOf(id)!.measuredBy === 'hub') return {provider: id as HubSubscription['provider'], measuredBy: 'hub'};
    if (!isObject(value) || typeof (value.active ?? false) !== 'boolean') throw new Invalid('subscription');
    const least = value.minIntervalMs ?? null;
    if (least !== null && (!Number.isInteger(least) || (least as number) < 60_000 || (least as number) > 86_400_000)) throw new Invalid('minIntervalMs');
    return {
      provider: id as ClientProvider,
      account: account(value.account),
      accountName: text(value.accountName, 'accountName', true),
      active: value.active === true,
      minIntervalMs: least as number | null,
    };
  });
  const input = body as Obj;
  const capabilities = isObject(input.capabilities) ? input.capabilities : {};
  const ack = isObject(input.policyAck) && typeof input.policyAck.authority === 'string' && Number.isSafeInteger(input.policyAck.revision) && (input.policyAck.revision as number) >= 0
    ? {authority: input.policyAck.authority, revision: input.policyAck.revision as number} : null;
  const collectors = Array.isArray(input.collectors) && input.collectors.length <= 16 && input.collectors.every(id=>typeof id==='string'&&providerOf(id)?.measuredBy==='client')
    ? [...new Set(input.collectors as ClientProvider[])] : null;
  const seenProviders=new Set<Provider>();
  const accountRosters:AccountRoster[]=list(input.accountRosters,'accountRosters',providers.length).flatMap(group=>{
    if(!isObject(group))throw new Invalid('accountRoster');
    const id=provider(group.provider);
    if(providerOf(id)!.measuredBy==='hub')return [];
    if(seenProviders.has(id))throw new Invalid('accountRoster provider');seenProviders.add(id);
    if(!Array.isArray(group.accounts))throw new Invalid('accountRoster accounts');
    const seen=new Set<string>();
    const accounts=list(group.accounts,'accountRoster accounts',16).map(value=>{
      if(!isObject(value))throw new Invalid('accountRoster account');
      const identity=account(value.account),name=text(value.accountName,'accountName',true);
      if(id==='antigravity'?identity!==null||!Object.hasOwn(value,'accountName'):identity===null||name!==null)throw new Invalid('accountRoster identity');
      const key=identity??name?.trim().toLowerCase()??'';
      if(seen.has(key))throw new Invalid('accountRoster duplicate');seen.add(key);
      return {account:identity,accountName:name};
    });
    return [{provider:id as ClientProvider,accounts}];
  });
  return {...sender, paced, subscriptions, accountRosters, measurementPolicy: capabilities.measurementPolicy === 1, attemptContext: capabilities.attemptContext === 1, policyAck: ack, collectors};
}

/**
 * Which subscription a snapshot belongs to. Clients that identify the account give
 * its pseudonym, the same whoever measures it; otherwise the subscription is the
 * device's person's own (optionally one of several, by the name they gave it), never
 * the machine's.
 */
export function subscriptionKey(snapshot: {account: string | null; accountName: string | null; provider: Provider}, userId: string): string {
  if (snapshot.account) return snapshot.account;
  const name = snapshot.accountName ? `/${snapshot.accountName.trim().toLowerCase()}` : '';
  return `user:${userId}/${snapshot.provider}${name}`;
}

export function toMeasurement(snapshot: AgentSnapshot): WindowMeasurement {
  const windows: Win[] = snapshot.windows.map(w => ({
    id: w.id,
    kind: w.kind,
    label: w.label,
    used: w.usedPercent,
    remaining: 100 - w.usedPercent,
    resetAt: w.resetsAt,
    minutes: w.minutes,
  }));
  return {observedAt: snapshot.observedAt, plan: snapshot.plan ?? '', windows, staleAfterMs: snapshot.staleAfterMs, resets: snapshot.resets,
    ...(snapshot.resourceStatus ? {resourceStatus:snapshot.resourceStatus} : {}), ...(snapshot.balances ? {balances:snapshot.balances} : {})};
}

/** Where an agent's session runs (spec: Reporting running agents). */
export const ORIGINS = ['terminal', 'editor', 'app'] as const;
export type Origin = (typeof ORIGINS)[number];

export type AgentSession = {
  sessionId: string | null;
  provider: ClientProvider;
  clientId?: string;
  route?: SessionRoute | null;
  account: string | null;
  accountName: string | null;
  origin: Origin;
  /** The project it works in, which its time counts under: its repository, else its folder. */
  project: string | null;
  /** Its folder, where that is not its project; an older agent sends none. */
  folder: string | null;
  startedAt: number;
  lastWorkedAt: number | null;
  working: boolean;
};

/** Every coding agent running on a machine right now. */
export type SessionRoute = {class: 'subscription' | 'api' | 'unknown'; by: 'session' | 'machine'; host: string | null; provider: string | null};
export type ClientSession = Omit<AgentSession, 'provider' | 'account' | 'accountName'> & {
  clientId: string;
  source: {provider: ClientProvider; account: string | null; accountName: string | null} | null;
};
export type DeviceClient = {clientId: string; version: string | null; observedAt?: number | null};
export type Tracking = {version:1;clients:string[];routeDisabled:string[];complete:boolean};
export type SessionReport = AgentSender & {sentAt: number; sessions: AgentSession[]; clientSessions: ClientSession[]; clients: DeviceClient[] | null;tracking:Tracking|null};

export function trackingOf(value:unknown):Tracking|null {
  if(!isObject(value)||value.version!==1||typeof value.complete!=='boolean'||!Array.isArray(value.clients)||!Array.isArray(value.routeDisabled))return null;
  const ids=(input:unknown[])=>{if(input.length>64||input.some(id=>!validClientId(id))||new Set(input).size!==input.length)return null;return (input as string[]).slice().sort();};
  const clients=ids(value.clients),routeDisabled=ids(value.routeDisabled);
  if(!clients||!routeDisabled||routeDisabled.some(id=>!knownClients.some(c=>c.id===id)))return null;
  return {version:1,clients,routeDisabled,complete:value.complete};
}

function soft<T>(read: () => T): T | null {
  try { return read(); } catch (error) { if (error instanceof Invalid) return null; throw error; }
}

export function sessionRoute(value: unknown): SessionRoute | null {
  if (!isObject(value) || (value.by !== 'session' && value.by !== 'machine')) return null;
  const kind = value.class === 'subscription' || value.class === 'api' ? value.class : 'unknown';
  const host = value.by === 'session' && typeof value.host === 'string' && value.host.length <= 253 && value.host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? value.host : null;
  return {class: kind, by: value.by, host, provider: value.by === 'session' && validClientId(value.provider) ? value.provider : null};
}


export function parseSessions(body: unknown): SessionReport {
  const sender = parseSender(body);
  const input = body as Obj;
  const tracking=trackingOf(input.tracking);
  let complete=true;
  const ids = new Set<string>();
  const sessions = list(input.sessions, 'sessions', 200).filter(value => {const kept=clientItem(value, 'session');complete&&=kept;return kept;}).map(value => {
    if (!isObject(value)) throw new Invalid('session');
    const sessionId = value.sessionId ?? null;
    if (sessionId !== null) {
      if (typeof sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(sessionId) || ids.has(sessionId)) throw new Invalid('sessionId');
      ids.add(sessionId);
    }
    if (!(ORIGINS as readonly unknown[]).includes(value.origin)) throw new Invalid('origin');
    if (typeof value.working !== 'boolean') throw new Invalid('working');
    return {
      sessionId,
      provider: provider(value.provider) as ClientProvider,
      clientId: clientFor(provider(value.provider) as ClientProvider),
      route: sessionRoute(value.route),
      account: account(value.account),
      accountName: text(value.accountName, 'accountName', true),
      origin: value.origin as Origin,
      project: cut(value.project, 'project'),
      folder: cut(value.folder, 'folder'),
      startedAt: time(value.startedAt, 'startedAt')!,
      lastWorkedAt: time(value.lastWorkedAt, 'lastWorkedAt', true),
      working: value.working,
    };
  });
  const clientSessions: ClientSession[] = [];
  if (Array.isArray(input.clientSessions)) for (const value of input.clientSessions) {
    if (sessions.length + clientSessions.length >= 200) {complete=false;break;}
    if (!isObject(value) || !validClientId(value.clientId) || !(ORIGINS as readonly unknown[]).includes(value.origin) || typeof value.working !== 'boolean') {complete=false;continue;}
    const startedAt = soft(() => time(value.startedAt, 'startedAt'));
    if (startedAt === null) {complete=false;continue;}
    const sessionId = typeof value.sessionId === 'string' && /^[0-9a-f]{32}$/.test(value.sessionId) ? value.sessionId : null;
    if (sessionId !== null && ids.has(sessionId)) {complete=false;continue;}
    if(value.sessionId!==undefined&&value.sessionId!==null&&sessionId===null)complete=false;
    if (sessionId !== null) ids.add(sessionId);
    const source = isObject(value.source) ? soft(() => {
      const candidate = value.source as Obj;
      const id = provider(candidate.provider);
      if (providerOf(id)?.measuredBy !== 'client') return null;
      return {provider: id as ClientProvider, account: account(candidate.account), accountName: text(candidate.accountName, 'accountName', true)};
    }) : null;
    if(value.source!==undefined&&value.source!==null&&source===null)complete=false;
    if(value.route!==undefined&&value.route!==null&&sessionRoute(value.route)===null)complete=false;
    clientSessions.push({clientId: value.clientId, sessionId, source, route: sessionRoute(value.route),
      origin: value.origin as Origin, working: value.working, startedAt,
      project: soft(() => cut(value.project, 'project')), folder: soft(() => cut(value.folder, 'folder')),
      lastWorkedAt: soft(() => time(value.lastWorkedAt, 'lastWorkedAt', true)),
    });
  }
  let inventory: DeviceClient[] | null = null;
  if (Array.isArray(input.clients)) {
    inventory = [];
    const seen = new Set<string>();
    for (const value of input.clients) {
      if (inventory.length >= 64) break;
      if (!isObject(value) || !validClientId(value.clientId) || seen.has(value.clientId)) continue;
      seen.add(value.clientId);
      const version = typeof value.version === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/.test(value.version) ? value.version : null;
      inventory.push({clientId: value.clientId, version, ...(value.observedAt !== undefined ? {observedAt:soft(()=>time(value.observedAt,'client observedAt'))} : {})});
    }
  }
  if(input.clientSessions!==undefined&&!Array.isArray(input.clientSessions))complete=false;
  if(tracking)tracking.complete&&=complete&&[...sessions,...clientSessions].every(s=>tracking.clients.includes(s.clientId!));
  return {...sender, sentAt: time(input.sentAt, 'sentAt')!, sessions, clientSessions, clients: inventory,tracking};
}
