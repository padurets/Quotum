import {createHash} from 'node:crypto';

export const providers = ['claude', 'codex', 'antigravity'] as const;
export type Provider = (typeof providers)[number];

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * A *source* is one provider account we collect from. Today every provider has a
 * single account (`accountKey: 'default'`), but ids, storage and the API are already
 * keyed by source, so a second Claude subscription only needs another source row —
 * no change to history, preferences or chart identity of the existing ones.
 */
export type Source = {id: string; provider: Provider; accountKey: string; label: string};

export const DEFAULT_ACCOUNT = 'default';

/** Stable, human-readable id. Preferences and chart series are keyed by it. */
export function sourceId(provider: Provider, accountKey = DEFAULT_ACCOUNT): string {
  return accountKey === DEFAULT_ACCOUNT ? provider : `${provider}:${accountKey}`;
}

export function parseSourceId(id: string): {provider: Provider; accountKey: string} | null {
  const [provider, accountKey = DEFAULT_ACCOUNT] = id.split(':');
  return providers.includes(provider as Provider) ? {provider: provider as Provider, accountKey} : null;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export function describeSource(provider: Provider, accountKey = DEFAULT_ACCOUNT): Source {
  return {
    id: sourceId(provider, accountKey),
    provider,
    accountKey,
    label: accountKey === DEFAULT_ACCOUNT ? PROVIDER_LABELS[provider] : `${PROVIDER_LABELS[provider]} · ${accountKey}`,
  };
}
