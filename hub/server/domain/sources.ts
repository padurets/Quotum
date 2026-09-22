import {sha256} from './auth.js';

export const providers = ['claude', 'codex', 'antigravity'] as const;
export type Provider = (typeof providers)[number];

/**
 * A source is one subscription on one board. `account` says which: the pseudonym of an
 * account the provider identifies, or `<owner>/<provider>[/<name>]` for one it does not
 * (see `subscriptionKey` in domain/ingest.ts). Preferences and chart series are keyed
 * by the source id, so it never changes.
 */
export type Source = {id: string; provider: Provider; account: string};

export const sourceId = (board: string, provider: Provider, account: string) => `${provider}:${sha256(`${board}\n${account}`).slice(0, 12)}`;
