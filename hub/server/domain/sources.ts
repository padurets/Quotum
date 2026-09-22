import {createHash} from 'node:crypto';

export const providers = ['claude', 'codex', 'antigravity'] as const;
export type Provider = (typeof providers)[number];

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** The board of a new hub: static ingest tokens deliver to it, and the first person to sign up takes it. */
export const DEFAULT_BOARD = 'default';

/**
 * A source is one subscription on one board. `account` says which: the pseudonym of an
 * account the provider identifies, or `<owner>/<provider>[/<name>]` for one it does not
 * (see `subscriptionKey` in domain/ingest.ts). Preferences and chart series are keyed
 * by the source id, so it never changes.
 */
export type Source = {id: string; provider: Provider; account: string};

export const sourceId = (board: string, provider: Provider, account: string) => `${provider}:${hash(`${board}\n${account}`).slice(0, 8)}`;
