/** Public provider capabilities, shared by the hub, dashboard and background reader. */
export const catalogue = [
  {id: 'claude', name: 'Claude', color: '#de7b5b', logoAsset: 'claude', order: 0, measuredBy: 'client', meterKinds: ['window'], resets: true, clientId: 'claude'},
  {id: 'codex', name: 'Codex', color: '#6897f0', logoAsset: 'codex', order: 1, measuredBy: 'client', meterKinds: ['window'], resets: true, clientId: 'codex'},
  {id: 'antigravity', name: 'Antigravity', color: '#d271b3', logoAsset: 'antigravity', order: 2, measuredBy: 'client', meterKinds: ['window'], resets: false, clientId: 'antigravity'},
  {id: 'openrouter', name: 'OpenRouter', color: '#c8ff00', logoAsset: 'openrouter', order: 3, measuredBy: 'hub', meterKinds: ['counter', 'balance', 'cap'], resets: false, connectorId: 'openrouter', monetary:{spending:'counter',topups:'counter',balances:[{meterId:'balance',unit:'USD',role:'total'}]}},
  {id:'deepseek',name:'DeepSeek',color:'#4d6bfe',logoAsset:'deepseek',order:4,measuredBy:'hub',meterKinds:['balance'],resets:false,connectorId:'deepseek',monetary:{spending:'unavailable',topups:'unavailable',balances:[
    {meterId:'balance:CNY',unit:'CNY',role:'total'},{meterId:'granted:CNY',unit:'CNY',role:'granted'},{meterId:'topped_up:CNY',unit:'CNY',role:'toppedUp'},
    {meterId:'balance:USD',unit:'USD',role:'total'},{meterId:'granted:USD',unit:'USD',role:'granted'},{meterId:'topped_up:USD',unit:'USD',role:'toppedUp'},
  ]}},
] as const;

export type Provider = (typeof catalogue)[number]['id'];
export type ClientProvider = Extract<(typeof catalogue)[number], {measuredBy: 'client'}>['id'];
export type ResetProvider = Extract<(typeof catalogue)[number], {resets: true}>['id'];
export const providers = catalogue.map(p => p.id);
export const clientProviders = catalogue.filter(p => p.measuredBy === 'client').map(p => p.id);
export const resetProviders = catalogue.filter(p => p.resets).map(p => p.id);
export const providerOf = (id: string) => catalogue.find(p => p.id === id);

export const monetaryOf=(provider:string)=>{const p=providerOf(provider);return p&&'monetary' in p?p.monetary:null;};
export const balanceDescriptor=(provider:string,meter:string)=>monetaryOf(provider)?.balances.find(b=>b.meterId===meter)??null;
