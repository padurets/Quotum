import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import type {Stand} from './setup.js';
import {deepSeekMeasurement} from '../server/connectors/deepseek.js';

/** Consent, withdrawal/reset races and transient form replies are held by deepseek.test.ts and connections.test.ts. */
export const DEEPSEEK_SCENES=[
  {id:'cny',expect:['CNY','total-110','components','balance-only'],about:'CNY 110 with granted 10 and topped-up 100'},
  {id:'usd',expect:['USD','balance-only'],about:'a USD wallet'},
  {id:'dual',expect:['CNY','USD','separate-currencies'],about:'two currencies with independent totals'},
  {id:'zero',expect:['zero','unavailable-funds'],about:'a valid zero, not rejected access'},
  {id:'unavailable',expect:['positive','unavailable-funds'],about:'positive balance with a supplier availability warning'},
  {id:'partial',expect:['partial','stale-USD','hard-gap'],about:'valid CNY while USD is omitted'},
  {id:'stale',expect:['stale','last-good'],about:'last valid values after a transient failure'},
  {id:'rejected',expect:['private-rejected','public-unmeasured'],about:'rejected access with preserved numbers'},
  {id:'empty',expect:['no-balance','no-zero'],about:'accepted empty balances'},
  {id:'recovery',expect:['same-value-recovery','actual-anchor'],about:'same-value recovery within a grid cell'},
  {id:'work',expect:['named-account','unknown-expiry','sharing-label'],about:'another named account of the same owner'},
] as const;
export const DEEPSEEK_KEY=(index:number)=>'sk-'+(index+100).toString(16).padStart(32,'0');
export const deepSeekTuple=(currency='CNY',total='110',granted='10',topup='100')=>({currency,total_balance:total,granted_balance:granted,topped_up_balance:topup});
export function deepSeekPayload(id:string,initial=false) {
  const rows=id==='usd'?[deepSeekTuple('USD','37','7','30')]:id==='dual'||id==='partial'&&initial?[deepSeekTuple(),deepSeekTuple('USD','37','7','30')]:id==='zero'?[deepSeekTuple('USD','0','0','0')]:id==='empty'?[]:[deepSeekTuple()];
  return {is_available:id!=='zero'&&id!=='unavailable',balance_infos:rows};
}

/** The ordinary owner routes establish identity before synthetic historical observations. */
export async function seedDeepSeek(store:Store,directory:Directory,stand:Stand) {
  const owner=[...stand.people.values()][0];if(!owner)return;
  const now=Date.now(),personal=directory.boards(owner.id).find(b=>b.personal)!;
  const ids:string[]=[];
  for(const [index,scene] of DEEPSEEK_SCENES.entries()) {
    const created=await owner.post<{sourceId:string}>('/api/credentials',{provider:'deepseek',secret:DEEPSEEK_KEY(index),account:{kind:'new',name:scene.id==='cny'?'Personal':scene.id==='work'?'Work':scene.id},allowUnknownExpiry:true});
    const source=created.sourceId;ids.push(source);
    const record=(at:number,answer:unknown)=>{
      const measured=deepSeekMeasurement(answer,at),staleAfterMs=scene.id==='stale'?60_000:3*3_600_000;
      store.record(source,{...measured,staleAfterMs,meters:measured.meters.map(m=>({...m,staleAfterMs})),balanceStatus:{...measured.balanceStatus!,staleAfterMs}});
    };
    record(now-2*3_600_000,deepSeekPayload(scene.id,true));
    if(scene.id==='recovery') {
      const cell=Math.floor((now-60_000)/60_000)*60_000;
      record(cell+10,{is_available:true,balance_infos:[]});record(cell+20,deepSeekPayload(scene.id));
    }else record(now-60_000,deepSeekPayload(scene.id));
    if(scene.id==='stale'||scene.id==='rejected') {
      const code=scene.id==='stale'?'connector_failed':'credential_rejected';store.fail(source,code);
      store.db.prepare('UPDATE credentials SET last_error=? WHERE source_id=?').run(code,source);
    }
    const view=directory.view(personal.id);view.names[source]='DeepSeek '+scene.id;directory.saveView(personal.id,view,owner.id,now);
    for(const board of directory.boards(owner.id).filter(b=>!b.personal))store.share(board.id,source,owner.id,now);
  }
  // Another person may use the same private account name without sharing its identity.
  const other=[...stand.people.values()][1];
  if(other)await other.post('/api/credentials',{provider:'deepseek',secret:DEEPSEEK_KEY(0),account:{kind:'new',name:'Personal'},allowUnknownExpiry:true});
  if(stand.set.id==='money') {
    const view=directory.view(personal.id);view.hidden=view.hidden.filter(key=>!ids.some(id=>key==='source:'+id));
    const bottom=Math.max(0,...Object.values(view.layout.places).map(p=>p.y+(p.h??1)));
    for(const [index,id] of ids.entries())view.layout.places['source:'+id]={x:index%2*3,y:bottom+Math.floor(index/2),w:3};
    directory.saveView(personal.id,view,owner.id,now);
  }
}
