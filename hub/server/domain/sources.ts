import {sha256} from './auth.js';

export const providers = ['claude', 'codex', 'antigravity'] as const;
export type Provider = (typeof providers)[number];

/**
 * A source is one subscription, kept once on the hub however many devices measure it.
 * `account` says which: the pseudonym of an account the provider identifies, or
 * `user:<id>/<provider>[/<name>]` for one it does not, which is then its owner's (see
 * `subscriptionKey` in domain/ingest.ts). Views and chart series are keyed by the
 * source id, so it never changes.
 */
export type Source = {id: string; provider: Provider; account: string};

export const sourceId = (provider: Provider, account: string) => `${provider}:${sha256(account).slice(0, 12)}`;
