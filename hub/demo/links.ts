import {randomUUID} from 'node:crypto';
import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import type {LinkInput} from '../server/domain/links.js';
import type {Meter} from '../server/domain/meters.js';
import {showWidgets} from '../server/domain/widgets.js';
import type {Stand} from './setup.js';

/** Conflicts, lost replies, expiry and fault recovery are held by linksApi/coverage tests. */
export const LINK_SCENES=[
  {id:'free-gap',expect:['suggestion-one','shown-dates','past-and-future-rules','unbound-api']},
  {id:'routes',expect:['subscription-api','unknown-route','manual-disagreement','inactive-mask','private-gateway','suggestion-zero','suggestion-multiple']},
  {id:'money-work',expect:['active-hour-rate','remaining-active-hours','balance-only-unsupported']},
  {id:'coverage',expect:['quota-growth-confirmed','quota-growth-partial','shared-safe-status']},
] as const;
const minute=60_000,hour=60*minute;

/** Synthetic native endpoints, declarations and reports pass through their ordinary paths. */
export async function seedLinks(store:Store,directory:Directory,stand:Stand) {
  const owner=[...stand.people.values()][0],other=[...stand.people.values()][1];if(!owner)return;
  const agent=[...stand.agents.values()].find(a=>directory.deviceByMachine(owner.id,a.machine.id));if(!agent)return;
  const device=directory.deviceByMachine(owner.id,agent.machine.id)!,now=stand.start,since=now-2*hour;
  const wallet=store.source('openrouter','demo-linked-wallet',since);
  const confirmed=store.source('claude','demo-observed-no-work',since),partial=store.source('claude','demo-incomplete-work',since);
  const ambiguous=[0,1].map(i=>store.source('deepseek','demo-ambiguous-'+i,since));
  for(const id of [wallet,confirmed,partial,...ambiguous])store.hold(id,owner.id,since);
  if(other)store.hold(partial,other.id,since);
  const create=(input:LinkInput)=>store.links.mutate(owner.id,'create',null,{...input,expectedRevision:store.links.revision(owner.id),requestId:randomUUID()},now);
  const conditional={clientId:'opencode',deviceId:device.id,route:{class:'api' as const,provider:'openrouter'},sourceId:wallet};
  create({...conditional,from:since,to:now-hour});create({...conditional,from:now+hour,to:now+2*hour});
  create({clientId:'claude',deviceId:null,route:null,sourceId:wallet,from:since,to:null});
  create({clientId:'codex',deviceId:device.id,route:null,sourceId:wallet,from:since,to:null});
  const inactive=store.source('openrouter','demo-inactive-target',since);store.hold(inactive,owner.id,since);
  create({clientId:'antigravity',deviceId:device.id,route:null,sourceId:inactive,from:since,to:null});store.release(inactive,owner.id);
  const meter=(id:string,at:number,amount:string,kind:Meter['kind']='counter'):Meter=>({id,at,amount,kind,unit:'USD',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:3*hour,stale:false});
  for(const [at,usage] of [[now-hour,'0'],[now-hour/2,'700000'],[now,'1400000']] as const)
    store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:3*hour,meters:[meter('credits',at,'15400000'),meter('usage',at,usage)],keys:[],inventoryComplete:true,inventoryError:null});
  for(const id of ambiguous)store.record(id,{type:'meters',observedAt:now,staleAfterMs:3*hour,meters:[meter('balance:USD',now,'25000000','balance')],keys:[],inventoryComplete:true,inventoryError:null});
  const quota=(source:string,at:number,used:number)=>store.record(source,{observedAt:at,plan:'',windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt:now+3*hour}],staleAfterMs:3*hour,resets:null});
  for(const id of [confirmed,partial]){quota(id,now-2*minute,10);quota(id,now,12);}
  // Fixture devices existed before these observations, including the finished witnesses.
  for(const d of directory.devices(owner.id))store.db.prepare('UPDATE devices SET created_at=? WHERE id=?').run(since,d.id);
  store.db.prepare("UPDATE meta SET value=? WHERE key='agentWorkSince'").run(String(since));
  store.creditWork(device.id,now-hour,now,[{client:'claude',source:null,origin:'terminal',startedAt:since,project:'Quotum',folder:'linked-work',identity:{kind:'stable',sessionId:'c'.repeat(32)}}]);
  const session=(id:string,clientId:string,source:object|null,route:object|null)=>({sessionId:id.repeat(32),clientId,source,route,origin:'terminal',project:'Quotum',folder:'linked-work',startedAt:new Date(since).toISOString(),working:true});
  const raw={provider:'codex',account:'demo-linked-subscription',accountName:null};
  // Supplemental account evidence accepts only supplier pseudonyms. These source rows
  // use the same pseudonym as the synthetic report, without any real account identifier.
  const account='d'.repeat(24),observed=store.source('codex',account,since);store.hold(observed,owner.id,since);quota(observed,now,20);
  raw.account=account;
  const otherAccount='a'.repeat(24),otherSubscription=store.source('antigravity',otherAccount,since);store.hold(otherSubscription,owner.id,since);quota(otherSubscription,now,20);
  agent.trackClients([
    session('1','opencode',null,{class:'api',by:'session',host:'openrouter.ai',provider:'openrouter'}),
    session('2','codex',raw,{class:'subscription',by:'session',host:null,provider:null}),
    session('3','opencode',null,{class:'api',by:'session',host:'api.deepseek.com',provider:'deepseek'}),
    session('4','opencode',null,{class:'api',by:'session',host:'api.z.ai',provider:'zai'}),
    session('5','opencode',null,{class:'api',by:'session',host:'gateway.example',provider:null}),
    session('6','antigravity',{provider:'antigravity',account:otherAccount,accountName:null},{class:'subscription',by:'session',host:null,provider:null}),
    session('7','opencode',null,{class:'unknown',by:'session',host:null,provider:null}),
  ],[{clientId:'opencode',version:'1.2.3'},{clientId:'codex',version:'1.0.0'},{clientId:'claude',version:null},{clientId:'antigravity',version:null}]);
  await agent.sessions([],now);
  // Complete witnesses use the final holding topology.
  for(const d of directory.devices(owner.id))for(const at of [now-4*minute,now-2*minute,now])store.coverage.record(d.id,owner.id,{version:1,clients:['antigravity','claude','codex','opencode'],routeDisabled:[],complete:true},at);
  const names=new Map([[wallet,'OpenRouter linked work'],[observed,'Codex observed account'],[confirmed,'Claude complete observations'],[partial,'Claude incomplete observations'],...ambiguous.map((id,i)=>[id,'DeepSeek account '+(i+1)] as [string,string])]);
  const team=stand.boards.get('team');if(team)for(const id of names.keys())store.share(team,id,owner.id,since);
  for(const board of [owner.personalBoard,...team?[team]:[]]){
    const view=showWidgets(directory.view(board),['agents','activity','budget-table','budget-history','quota-history','quota-table']);
    view.hidden=store.sources(board).filter(s=>!names.has(s.id)).map(s=>'source:'+s.id);view.names={...view.names,...Object.fromEntries(names)};
    let y=0;for(const id of names.keys())view.layout.places['source:'+id]={x:y%2*3,y:y++,w:3};
    for(const id of ['agents','activity','budget-table','budget-history','quota-history','quota-table'])view.layout.places[id]={x:0,y:y++,w:6};
    directory.saveView(board,view,owner.id,now);
  }
}
