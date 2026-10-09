import type {ClientProvider} from './providers.js';

/** Clients are executables; only three of them have subscription collectors. */
export const clients = [
  {id: 'claude', name: 'Claude Code', provider: 'claude'},
  {id: 'codex', name: 'Codex', provider: 'codex'},
  {id: 'antigravity', name: 'Antigravity', provider: 'antigravity'},
  {id: 'opencode', name: 'OpenCode', provider: null},
] as const;

export const clientFor = (provider: ClientProvider): string => clients.find(c => c.provider === provider)!.id;
export const clientName = (id: string): string => clients.find(c => c.id === id)?.name ?? id;
export const validClientId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
