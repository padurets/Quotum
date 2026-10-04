/** Public provider capabilities, shared by the hub, dashboard and background reader. */
export const catalogue = [
  {id: 'claude', name: 'Claude', color: '#de7b5b', logoAsset: 'claude', order: 0, measuredBy: 'client', funding: 'subscription', meterKinds: ['window'], resets: true, clientId: 'claude'},
  {id: 'codex', name: 'Codex', color: '#6897f0', logoAsset: 'codex', order: 1, measuredBy: 'client', funding: 'subscription', meterKinds: ['window'], resets: true, clientId: 'codex'},
  {id: 'antigravity', name: 'Antigravity', color: '#d271b3', logoAsset: 'antigravity', order: 2, measuredBy: 'client', funding: 'subscription', meterKinds: ['window'], resets: false, clientId: 'antigravity'},
  {id: 'zai', funding: 'subscription', name: 'z.ai', color: '#f0f0f0', logoAsset: 'zai', order: 4, measuredBy: 'hub', meterKinds: ['cap'], resets: false, connectorId: 'zai'},
  {id: 'openrouter', funding: 'wallet', name: 'OpenRouter', color: '#c8ff00', logoAsset: 'openrouter', order: 3, measuredBy: 'hub', meterKinds: ['counter', 'balance', 'cap'], resets: false, connectorId: 'openrouter'},
] as const;

export type Provider = (typeof catalogue)[number]['id'];
export type ClientProvider = Extract<(typeof catalogue)[number], {measuredBy: 'client'}>['id'];
export type ResetProvider = Extract<(typeof catalogue)[number], {resets: true}>['id'];
export const providers = catalogue.map(p => p.id);
export const clientProviders = catalogue.filter(p => p.measuredBy === 'client').map(p => p.id);
export const resetProviders = catalogue.filter(p => p.resets).map(p => p.id);
export const providerOf = (id: string) => catalogue.find(p => p.id === id);
