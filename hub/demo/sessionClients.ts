import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import {showWidgets} from '../server/domain/widgets.js';
import {accountOf,cards,HOUR,MIN} from './model.js';
import type {Stand} from './setup.js';

/** Supplementary clients keep the released mapped-session fixture and Atlas intact. */
export async function seedSessionClients(store:Store,directory:Directory,stand:Stand) {
  const owner=stand.people.get('ana')!,start=stand.start;
  const primary=cards(stand.set).find(card=>card.id==='sessions-codex-pro')!,secondary=cards(stand.set).find(card=>card.id==='sessions-claude-max')!;
  const source=stand.sources.get(primary.id)!,other=stand.sources.get(secondary.id)!;
  const contexts=[
    {machine:'laptop',client:'opencode',id:'e'.repeat(32),source:null,from:start-90*MIN,to:start-75*MIN,current:true},
    {machine:'retained-device',client:'opencode',id:'f'.repeat(32),source,from:start-7*HOUR,to:start-6*HOUR,current:false},
    {machine:'workstation',client:'review-assistant',id:'d'.repeat(32),source:other,from:start-90*MIN,to:start-60*MIN,current:true},
    {machine:'workstation',client:'review-assistant',id:'a'.repeat(32),source:null,from:start-8*HOUR,to:start-7*HOUR,current:false},
  ];
  for(const machine of new Set(contexts.map(context=>context.machine))) {
    const agent=stand.agents.get(machine),device=agent?directory.devices(owner.id).find(device=>device.machineId===agent.machine.id)!:directory.saveDevice({userId:owner.id,machine:{id:'retained-review-device',name:'Disconnected review laptop',os:'linux',arch:'x86_64'},agent:'quotum-demo/1',tokenId:null},start-8*HOUR);
    const current=contexts.filter(context=>context.machine===machine&&context.current).map(context=>({clientId:context.client,sessionId:context.id,
      source:context.source?{provider:secondary.provider,...accountOf(secondary)}:null,origin:'terminal',project:'quotum',folder:'mixed-client-review',startedAt:new Date(context.from).toISOString(),lastWorkedAt:new Date(context.to).toISOString(),working:false}));
    agent?.trackClients(current,[{clientId:'opencode',version:'1.2.3'},{clientId:'review-assistant',version:'0.1.0'}]);
    // The next Live report sends both the unchanged mapped list and these clients.
    for(const context of contexts.filter(context=>context.machine===machine))store.creditWork(device.id,context.from,context.to,[{client:context.client,source:context.source,origin:'terminal',project:'quotum',folder:'mixed-client-review',startedAt:context.from,identity:{kind:'stable',sessionId:context.id}}]);
    if(machine==='retained-device')directory.revokeDevice(owner.id,device.id,start);
  }
  for(const [key,board] of stand.boards) {
    if(['sessions-only','both','off','hidden','historical'].includes(key))directory.saveView(board,showWidgets(directory.view(board),['agents','activity']),owner.id,start);
    if(key==='quota-only'||key==='off')for(const device of store.sessionDevices(board,owner.id))store.setDeviceSessions(board,device.id,owner.id,false,device.revision,start);
    if(key==='historical')store.db.prepare('UPDATE shares SET shared_at=? WHERE board_id=?').run(start-HOUR,board);
  }
}
