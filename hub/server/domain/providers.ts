/** Public provider capabilities, shared by the hub, dashboard and background reader. */
export const catalogue = [
  {id: 'claude', name: 'Claude', color: '#de7b5b', logoAsset: 'claude', order: 0, measuredBy: 'client', meterKinds: ['window'], resets: true, clientId: 'claude'},
  {id: 'codex', name: 'Codex', color: '#6897f0', logoAsset: 'codex', order: 1, measuredBy: 'client', meterKinds: ['window'], resets: true, clientId: 'codex'},
  {id: 'antigravity', name: 'Antigravity', color: '#d271b3', logoAsset: 'antigravity', order: 2, measuredBy: 'client', meterKinds: ['window'], resets: false, clientId: 'antigravity'},
  {id: 'openrouter', name: 'OpenRouter', color: '#c8ff00', logoAsset: 'openrouter', order: 3, measuredBy: 'hub', meterKinds: ['counter', 'balance', 'cap'], resets: false, connectorId: 'openrouter'},
  {id:'openai_platform',name:'OpenAI Platform',color:'#71c8ae',logoAsset:'codex',order:4,measuredBy:'hub',meterKinds:['reported','cap'],resets:false,connectorId:'openai_platform'},
] as const;

export type Provider = (typeof catalogue)[number]['id'];
export type ClientProvider = Extract<(typeof catalogue)[number], {measuredBy: 'client'}>['id'];
export type ResetProvider = Extract<(typeof catalogue)[number], {resets: true}>['id'];
export const providers = catalogue.map(p => p.id);
export const clientProviders = catalogue.filter(p => p.measuredBy === 'client').map(p => p.id);
export const resetProviders = catalogue.filter(p => p.resets).map(p => p.id);
export const providerOf = (id: string) => catalogue.find(p => p.id === id);
