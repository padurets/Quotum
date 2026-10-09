import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import {showWidgets} from '../server/domain/widgets.js';
import type {Stand} from './setup.js';

/** Private synthetic work uses the same contextual ledger and report transport. */
export async function seedClients(store: Store, directory: Directory, stand: Stand) {
  const owner = [...stand.people.values()][0], agent = [...stand.agents.values()][0];
  if (!owner || !agent) return;
  const start = stand.start, since = start - 2*3_600_000;
  const session = {clientId:'opencode',sessionId:'e'.repeat(32),source:null,origin:'terminal',project:'Quotum',folder:'machine-clients',startedAt:new Date(since).toISOString(),working:true};
  const clients = [{clientId:'opencode',version:'1.2.3'},{clientId:'codex',version:null}];
  agent.trackClients([session],clients); await agent.sessions([],start);
  const device = directory.devices(owner.id).find(d=>d.machineId===agent.machine.id)!;
  store.db.prepare("UPDATE meta SET value=? WHERE key='agentWorkSince'").run(String(since));
  store.creditWork(device.id,since,start,[{client:'opencode',source:null,origin:'terminal',project:'Quotum',folder:'machine-clients',startedAt:since,identity:{kind:'stable',sessionId:session.sessionId}}]);
  const view=showWidgets(directory.view(owner.personalBoard),['agents','activity']);
  view.layout.places.agents={x:0,y:0,w:6};view.layout.places.activity={x:0,y:0,w:6};
  directory.saveView(owner.personalBoard,view,owner.id,start);
}
