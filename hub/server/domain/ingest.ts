import {hash, providers, type Provider} from './sources.js';
import type {Measurement, Win} from './quota.js';

/**
 * Ingest format v1 (spec/ingest-v1.md): what an agent sends. Parsing is strict; a
 * batch that does not match is refused whole, so nothing half-understood is stored.
 */
export type AgentWindow = {
  id: string;
  kind: 'session' | 'weekly' | 'other';
  minutes: number | null;
  label: string | null;
  usedPercent: number;
  resetsAt: number | null;
};

export type AgentSnapshot = {
  provider: Provider;
  account: string | null;
  plan: string | null;
  observedAt: number;
  via: string;
  client: string | null;
  staleAfterMs: number;
  windows: AgentWindow[];
};

export type AgentFailure = {provider: Provider; observedAt: number; error: string; detail: string | null};

export type AgentBatch = {
  version: 1;
  agent: string;
  machine: {id: string; name: string; os: string; arch: string};
  sentAt: number;
  snapshots: AgentSnapshot[];
  failures: AgentFailure[];
};

export const AGENT_ERRORS = ['not_logged_in', 'unsupported', 'timeout', 'invalid_output', 'failed', 'not_installed'] as const;

const LIMITS = {items: 500, windows: 32, text: 120, staleAfterMs: 24 * 3_600_000};

class Invalid extends Error {
  constructor(what: string) {
    super(`invalid_batch: ${what}`);
  }
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, what: string, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !value.length || value.length > LIMITS.text) throw new Invalid(what);
  return value;
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

function list(value: unknown, what: string, max: number): unknown[] {
  if (value === undefined) return [];
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

function parseSnapshot(value: unknown): AgentSnapshot {
  if (!isObject(value)) throw new Invalid('snapshot');
  const stale = value.staleAfterMs;
  if (!Number.isInteger(stale) || (stale as number) <= 0 || (stale as number) > LIMITS.staleAfterMs) throw new Invalid('staleAfterMs');
  const windows = list(value.windows, 'windows', LIMITS.windows).map(parseWindow);
  if (!windows.length) throw new Invalid('windows');
  return {
    provider: provider(value.provider),
    account: text(value.account, 'account', true),
    plan: text(value.plan, 'plan', true),
    observedAt: time(value.observedAt, 'observedAt')!,
    via: text(value.via, 'via')!,
    client: text(value.client, 'client', true),
    staleAfterMs: stale as number,
    windows,
  };
}

function parseFailure(value: unknown): AgentFailure {
  if (!isObject(value)) throw new Invalid('failure');
  if (!(AGENT_ERRORS as readonly unknown[]).includes(value.error)) throw new Invalid('error');
  return {
    provider: provider(value.provider),
    observedAt: time(value.observedAt, 'observedAt')!,
    error: value.error as string,
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 200) : null,
  };
}

export function parseBatch(body: unknown): AgentBatch {
  if (!isObject(body)) throw new Invalid('body');
  if (body.version !== 1) throw new Invalid('version');
  const machine = body.machine;
  if (!isObject(machine)) throw new Invalid('machine');
  const snapshots = list(body.snapshots, 'snapshots', LIMITS.items).map(parseSnapshot);
  const failures = list(body.failures, 'failures', LIMITS.items).map(parseFailure);
  return {
    version: 1,
    agent: text(body.agent, 'agent')!,
    machine: {
      id: text(machine.id, 'machine id')!,
      name: text(machine.name, 'machine name')!,
      os: text(machine.os, 'machine os')!,
      arch: text(machine.arch, 'machine arch')!,
    },
    sentAt: time(body.sentAt, 'sentAt')!,
    snapshots,
    failures,
  };
}

const KIND_LABELS = {session: '5 часов', weekly: 'Неделя'} as const;

/** How the dashboard names a window: "Неделя", "Fable · Неделя", "Gemini · 5 часов". */
export function windowLabel(w: AgentWindow): string {
  const kind = w.kind === 'other' ? (w.minutes ? `${w.minutes} мин` : 'Окно') : KIND_LABELS[w.kind];
  return w.label ? `${w.label} · ${kind}` : kind;
}

/**
 * Where a snapshot belongs. Accounts are identified by the agent's pseudonym; a
 * provider that does not name its account (Antigravity) is kept per machine.
 */
export function accountKey(snapshot: Pick<AgentSnapshot, 'account'>, machineId: string): string {
  return snapshot.account ?? `machine-${hash(machineId).slice(0, 24)}`;
}

export function toMeasurement(snapshot: AgentSnapshot): Measurement {
  const windows: Win[] = snapshot.windows.map(w => ({
    id: w.id,
    label: windowLabel(w),
    used: w.usedPercent,
    remaining: 100 - w.usedPercent,
    resetAt: w.resetsAt,
    minutes: w.minutes,
  }));
  return {
    provider: snapshot.provider,
    sourceAt: snapshot.observedAt,
    plan: snapshot.plan ?? '',
    identity: snapshot.account,
    windows,
    staleAfterMs: snapshot.staleAfterMs,
  };
}
