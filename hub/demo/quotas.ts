import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import type {Stand} from './setup.js';
import {ConnectorTransport} from '../server/connectors/transport.js';
import {Credentials,SecretKey,startSecrets} from '../server/secrets/index.js';
import {decodeZai,mapZai,zai} from '../server/connectors/zai.js';

/** Stable quota states; confirmations and replacement races are held by tests. */
export const QUOTA_SCENES=[
  {id:'zero',expect:['credit-zero','reset-unknown'],about:'real zero usage with reported credit allowances'},
  {id:'used',expect:['credit-40-20','independent-caps'],about:'five-hour and weekly quota remaining in credits'},
  {id:'near',expect:['credit-critical'],about:'a subscription near its quota limit'},
  {id:'exhausted',expect:['credit-exhausted'],about:'usage exceeding a reported allowance'},
  {id:'closed',expect:['credit-closed'],about:'zero allowance without a percentage'},
  {id:'missing',expect:['quota-partial','quota-missing'],about:'weekly only, with the last five-hour reading stale'},
  {id:'mixed',expect:['quota-partial','quota-unsupported'],about:'valid credits beside unsupported legacy quotas'},
  {id:'unsupported',expect:['quota-unsupported'],about:'unsupported generation with last valid values retained'},
  {id:'empty',expect:['quota-empty'],about:'an authenticated answer without quotas'},
  {id:'invalid',expect:['quota-invalid'],about:'malformed quota data, preserving the last valid readings'},
  {id:'auth-rejected',expect:['private-auth-rejected','public-unmeasured'],about:'a rejected key with an unknown cause'},
  {id:'storage-unavailable',expect:['private-storage-unavailable','public-unmeasured'],about:'saved access unavailable without erasing values'},
] as const;
export const QUOTA_KEY=(i:number)=>`demo-quota-${i}.synthetic-key`;
export function quotaFixture(index:number,at:number) {
  const scene=QUOTA_SCENES[index]?.id;
  const five={type:'CREDIT_LIMIT',unit:3,number:5,usage:2000,currentValue:scene==='zero'?0:scene==='near'?1900:scene==='exhausted'?2100:800};
  const week={type:'CREDIT_LIMIT',unit:6,number:1,usage:10000,currentValue:scene==='zero'?0:2000,nextResetTime:at+3*86400000};
  const limits=scene==='missing'?[week]:scene==='mixed'?[five,week,{type:'TIME_LIMIT'}]:scene==='unsupported'?[{type:'TOKENS_LIMIT'}]:scene==='empty'?[]:scene==='invalid'?[{...five,currentValue:'invalid'}]:scene==='closed'?[{...five,usage:0,currentValue:0},week]:[five,week];
  return {code:200,success:true,data:{level:'lite',limits}};
}

/** Synthetic access and measurements use the ordinary credential and quota paths. */
export async function seedQuotas(store:Store,directory:Directory,stand:Stand) {
  const owner=[...stand.people.values()][0];if(!owner)return;
  const now=Date.now(),ids:string[]=[];
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,31).toString('base64url')));
  const report=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  transport.send=async(_operation,secret)=>{
    const index=QUOTA_SCENES.findIndex((_,i)=>QUOTA_KEY(i)===secret.toString('ascii'));
    return decodeZai(JSON.stringify(quotaFixture(index,now)));
  };
  const credentials=new Credentials(store,key,report,new Map([['zai',zai(transport)]]));
  // Only the interactive samples need live hub jobs. Static edge cases are seeded
  // through the credential service, without spending the HTTP mutation budget.
  for(let i=0;i<QUOTA_SCENES.length;i++) {
    const scene=QUOTA_SCENES[i],connected=i<2?await owner.post<{id:string;sourceId:string}>('/api/credentials',{provider:'zai',secret:QUOTA_KEY(i),allowUnknownExpiry:true}):await credentials.create(owner.id,'zai',QUOTA_KEY(i),{allowUnknownExpiry:true});
    const source=connected.sourceId!;ids.push(source);
    // Add historical readings before the live connection's latest outcome.
    store.db.prepare('DELETE FROM state WHERE source_id=?').run(source);
    store.db.prepare('DELETE FROM readings WHERE source_id=?').run(source);
    store.db.prepare('DELETE FROM meter_spans WHERE source_id=?').run(source);
    for(let at=now-3*3600000;at<now;at+=3600000) {
      const result=mapZai(decodeZai(JSON.stringify(quotaFixture(1,now))),at);
      result.measurement!.staleAfterMs=3*3600000;
      result.measurement!.meters=result.measurement!.meters.map(m=>({...m,staleAfterMs:3*3600000}));
      store.quotaObservation(source,result.quotaObservation!,result.measurement);
    }
    const current=mapZai(decodeZai(JSON.stringify(quotaFixture(i,now))),now);
    if(current.measurement){current.measurement.staleAfterMs=3*3600000;current.measurement.meters=current.measurement.meters.map(m=>({...m,staleAfterMs:3*3600000}));}
    store.quotaObservation(source,current.quotaObservation!,current.measurement);
    if(scene.id==='auth-rejected'||scene.id==='storage-unavailable') {
      const code=scene.id==='auth-rejected'?'credential_auth_rejected':'credential_unreadable';
      store.db.prepare('UPDATE credentials SET last_error=?,unreadable=? WHERE id=?').run(code,scene.id==='storage-unavailable'?1:0,connected.id);store.fail(source,code);
    }
    const personal=directory.boards(owner.id).find(b=>b.personal)!,view=directory.view(personal.id);view.names[source]=`z.ai ${scene.id}`;directory.saveView(personal.id,view,owner.id,now);
    for(const board of directory.boards(owner.id).filter(b=>!b.personal))store.share(board.id,source,owner.id,now);
  }
  transport.close();
  if(stand.set.id==='quotas') {
    const personal=directory.boards(owner.id).find(b=>b.personal)!,view=directory.view(personal.id);
    view.hidden=store.sources(personal.id).filter(s=>!ids.includes(s.id)).map(s=>'source:'+s.id);view.shown=[];
    ids.forEach((id,i)=>{view.layout.places['source:'+id]={x:i%2*3,y:i,w:3};});directory.saveView(personal.id,view,owner.id,now);
  }
}
