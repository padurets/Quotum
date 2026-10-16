import {randomUUID} from 'node:crypto';
import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import type {Stand} from './setup.js';
import {accountOf,cards,snapshot} from './model.js';

/** The fleet scene changes control intent through the same guarded public writes as the UI. */
export async function seedMeasurementDevices(_store:Store,_directory:Directory,stand:Stand) {
  const owner=stand.people.get('ana')!,card=cards(stand.set)[0],account=accountOf(card);
  const versions=['quotum/0.6.9','quotum/0.8.0-rc.1','fixture'];
  const agents=[...stand.agents.values()];
  for(const [index,agent] of agents.entries()) {
    agent.reportedVersion=versions[index] ?? 'quotum/0.7.0';
    agent.trackClients([],[{clientId:'codex',version:index===2?null:'1.2.3',observedAt:new Date(stand.start-60_000).toISOString()}]);
    await agent.sessions([],stand.start);
    await agent.checkin([{provider:'codex',...account,minIntervalMs:3*3_600_000}]);
    await agent.checkin([{provider:'codex',...account,minIntervalMs:3*3_600_000}]);
  }
  const credits=(status:string)=>[{id:'balance:credits',unit:'credits:codex',status,...(status==='finite'?{amount:'1.2300'}:{})}];
  const observed=(offset:number,extra:object)=>({...snapshot(card,stand.start,offset,3*3_600_000),staleAfterMs:3*3_600_000,client:'1.2.3',...extra});
  await stand.agents.get('laptop')!.ingest([observed(-2000,{resets:{available:2},balances:credits('finite')})],[],Date.now());
  await stand.agents.get('desktop')!.ingest([observed(-1000,{windows:[],resourceStatus:{windows:'missing',resets:'missing'},balances:credits('finite')})],[],Date.now());
  await stand.agents.get('backup')!.ingest([observed(0,{resets:{available:2},balances:credits('missing'),client:'1.2.4'})],[],Date.now());
  const local=stand.agents.get('local-only')!;local.configuredCollectors=['claude'];await local.checkin([]);
  const view=await owner.get<{devices:{id:string;reported:string;policy:{revision:number}}[];sources:{source:string;preference:{revision:number};candidates:{device:string;reason:string}[]}[]}>('/api/devices?measurement=1');
  const desktop=view.devices.find(device=>device.reported==='desktop')!,backup=view.devices.find(device=>device.reported==='backup')!;
  await owner.post(`/api/devices/${desktop.id}/measurement-policy`,{operationId:randomUUID(),expectedRevision:desktop.policy.revision,desired:{enabled:false,collectors:{claude:true,codex:true,antigravity:true}}});
  for(const [offset,enabled] of [false,true].entries())await owner.post(`/api/devices/${backup.id}/measurement-policy`,{operationId:randomUUID(),expectedRevision:backup.policy.revision+offset,desired:{enabled:true,collectors:{claude:true,codex:enabled,antigravity:true}}});
  stand.agents.get('backup')!.measurementControl=false;
  await stand.agents.get('backup')!.checkin([]);
  const source=view.sources[0],candidate=source.candidates.find(candidate=>candidate.reason==='eligible'&&candidate.device!==backup.id&&candidate.device!==desktop.id)!;
  await owner.post(`/api/sources/${source.source}/measurement-preference`,{operationId:randomUUID(),expectedRevision:source.preference.revision,desired:candidate.device});
}
