import {createHash} from 'node:crypto';
import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import {shareConnectorScene, type Stand} from './setup.js';
import type {Meter,KeyPart} from '../server/domain/meters.js';
import type {Provider} from '../server/domain/providers.js';

/** Durable monetary states; connecting/no-expiry consent and in-flight replacement are transient UI tests. */
export const MONEY_SCENES=[
  {id:'wallet',expect:['balance','counter-spend','topup'],about:'balance and spending, with a top-up kept apart'},
  {id:'keys',expect:['key-cap','pagination','inventory-partial'],about:'57 keys, caps, two workspaces and a partial traversal'},
  {id:'revoked',expect:['private-revoked','public-unmeasured'],about:'preserved amounts with owner-only access failure'},
  {id:'expired',expect:['private-expired','public-unmeasured'],about:'expired management access'},
  {id:'gap',expect:['unlocated-spend','retained-baseline'],about:'first increase after a gap longer than retention'},
  {id:'negative',expect:['negative-balance','zero-cap'],about:'negative wallet and a closed key limit'},
  {id:'unknown',expect:['neutral-provider'],about:'unknown provider with no percentage capability'},
  {id:'no-expiry',expect:['private-no-expiry'],about:'working management access without an expiry or a warning'},
] as const;
export const MONEY_KEY=(index=0)=>'sk-or-v1-'+(index+1).toString(16).padStart(64,'0');
export const accountOfMoney=(index:number)=>createHash('sha256').update('quotum/account/v1\nopenrouter\ndemo-money-'+index).digest('hex').slice(0,24);
const keyId=(index:number)=>createHash('sha256').update(index.toString(16).padStart(64,'0')).digest('hex').slice(0,12);
const meter=(id:string,at:number,amount:string):Meter=>({id,kind:'counter',unit:'USD',amount,at,staleAfterMs:3*3_600_000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null});

/** Only synthetic measured data is seeded; no user access or provider is consulted. */
export async function seedMoney(store:Store,directory:Directory,stand:Stand) {
  const owner=[...stand.people.values()][0],now=Date.now();
  const accounts:string[]=[];
  if(!owner)return;
  for(let index=0;index<MONEY_SCENES.length;index++) {
    const scene=MONEY_SCENES[index];
    if(scene.id==='unknown') {
      const source=store.source('future-provider' as Provider,'demo-neutral',now);store.hold(source,owner.id,now);accounts.push(source);continue;
    }
    const source=store.source('openrouter',accountOfMoney(index),now);
    accounts.push(source);
    const total=scene.id==='negative'?'10':'70',usage=scene.id==='negative'?'15':'33';
    const sample=(at:number,credits:string,spent:string,keysCount=2)=>{
      const keys:KeyPart[]=Array.from({length:keysCount},(_,k)=>({id:keyId(index*100+k+1),name:`${k%2?'workstation':'laptop'}-${k+1}`,disabled:k===1,expiresAt:null,includeByok:k===0,at,staleAfterMs:3*3_600_000,presence:'observed',missCount:0,periods:{day:'100000',week:'1000000',month:'3000000'}}));
      const meters=[meter('credits',at,(BigInt(credits)*1_000_000n).toString()),meter('usage',at,(BigInt(spent)*1_000_000n).toString()),...keys.flatMap(key=>[ {...meter(`key:${key.id}:usage`,at,'7000000'),label:key.name}, {...meter(`key:${key.id}:cap`,at,scene.id==='negative'?'0':'3000000'),kind:'cap' as const,limit:scene.id==='negative'?'0':'15000000',resetAt:Date.UTC(new Date(at).getUTCFullYear(),new Date(at).getUTCMonth()+1,1),minutes:31*1440,scope:'monthly',label:key.name}])];
      store.record(source,{type:'meters',observedAt:at,staleAfterMs:3*3_600_000,meters,keys,inventoryComplete:scene.id!=='keys',inventoryError:scene.id==='keys'?'connector_inventory_partial':null});
    };
    if(scene.id==='gap')sample(now-100*86_400_000,total,'30',0);
    else {sample(now-3*3_600_000,scene.id==='negative'?total:'50',scene.id==='negative'?usage:'30',scene.id==='keys'?57:2);sample(now-2*3_600_000,total,usage,scene.id==='keys'?57:2);}
    sample(now-60_000,total,usage,scene.id==='keys'?57:2);
    const connected=await owner.post<{id:string}>('/api/credentials',{provider:'openrouter',secret:MONEY_KEY(index),allowNoExpiry:true});
    if(scene.id==='expired')store.db.prepare('UPDATE credentials SET expires_at=? WHERE id=?').run(now-1,connected.id);
    if(scene.id==='expired'||scene.id==='revoked') {store.fail(source,'credential_'+scene.id);store.db.prepare('UPDATE credentials SET last_error=? WHERE id=?').run('credential_'+scene.id,connected.id);}
    const personal=directory.boards(owner.id)[0];
    const view=directory.view(personal.id);
    view.names[source]='OpenRouter '+scene.id;
    directory.saveView(personal.id,view,owner.id,now);
    shareConnectorScene(store,stand,source,owner.id,now);
  }
  if(stand.set.id==='money') {
    const personal=directory.boards(owner.id).find(board=>board.personal)!;
    const sources=store.sources(personal.id),view=directory.view(personal.id);
    const native=['claude','codex','antigravity'].map(provider=>sources.find(source=>{
      const state=store.state(source.id);return source.provider===provider&&!state.error&&state.windows.some(w=>w.kind==='session')&&state.windows.some(w=>w.kind==='weekly');
    })?.id).filter((id):id is string=>!!id);
    const order=[native[0],accounts[0],native[1],accounts[1],native[2],...accounts.slice(2)].filter((id):id is string=>!!id);
    const selected=new Set(order);
    view.hidden=sources.filter(source=>!selected.has(source.id)).map(source=>'source:'+source.id);
    view.shown=[];view.windows=[];
    for(const [index,id] of order.entries())view.layout.places['source:'+id]={x:index%2*3,y:index,w:3};
    directory.saveView(personal.id,view,owner.id,now);
  }
}
