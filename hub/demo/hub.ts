/** Explicit demo composition replaces the connector before the ordinary hub starts. */
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {DEEPSEEK_SCENES,DEEPSEEK_KEY,deepSeekPayload,demoRates} from './deepseek.js';
import {QUOTA_KEY,QUOTA_SCENES,quotaFixture} from './quotas.js';
import {MONEY_KEY} from './money.js';
import {readFileSync} from 'node:fs';
const root=path.resolve(process.cwd(),'dist','server');
const load=(name:string)=>import(pathToFileURL(path.join(root,name)).href);
const {connectors}=await load('connectors/registry.js') as typeof import('../server/connectors/registry.js');
const {ConnectorTransport}=await load('connectors/transport.js') as typeof import('../server/connectors/transport.js');
const {openRouter,decodeOpenRouter}=await load('connectors/openrouter.js') as typeof import('../server/connectors/openrouter.js');
const {Limiter}=await load('session.js') as typeof import('../server/session.js');
// Catalogue setup connects more than ten synthetic keys in one burst. Ordinary
// hub limits are exercised by credentials.test.ts; this realm accepts fixture keys only.
const blocked=Limiter.prototype.blocked;
Limiter.prototype.blocked=function(key:string){return key.startsWith('user:')||key.startsWith('ip:')?false:blocked.call(this,key);};
const {SecretError}=await load('secrets/crypto.js') as typeof import('../server/secrets/crypto.js');
const workspace='550e8400-e29b-41d4-a716-446655440000';
const secondWorkspace='550e8400-e29b-41d4-a716-446655440001';
const expiry=new Date(Date.now()+86_400_000).toISOString();
const distantExpiry=new Date(Date.now()+14*86_400_000).toISOString();
let observed=Date.now();
const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
const identified=new Map<number,number>();
transport.send=async(operation,secret,query={})=>{
  const index=Array.from({length:8},(_,i)=>MONEY_KEY(i)).indexOf(secret.toString('ascii'));
  if(index<0)throw new SecretError('credential_invalid');
  type Control={credits?:number;usage?:number;at?:number};
  let control:Control|null=null;
  if(index===1)try{control=JSON.parse(readFileSync(path.join(process.env.QUOTUM_DATA_DIR!,'money-control.json'),'utf8')) as Control;}catch{/* The ordinary demo has no benchmark control. */}
  observed=control?.at??Date.now();
  if(operation==='key') {
    const count=(identified.get(index)??0)+1;identified.set(index,count);
    if(index===2&&count>1)throw new SecretError('credential_revoked');
    if(index===3&&count>1)throw new SecretError('credential_expired');
    return {data:{is_management_key:true,expires_at:index===7?null:index===0?distantExpiry:expiry,organization_id:null,creator_user_id:'demo-money-'+index}};
  }
  if(operation==='credits')return decodeOpenRouter(JSON.stringify({data:{total_credits:control?.credits??(index===5?10:70),total_usage:control?.usage??(index===5?15:33)}}));
  if(operation==='workspaces')return {data:[{id:workspace},...(index===1?[{id:secondWorkspace}]:[])],total_count:index===1?2:1};
  if(operation==='keys') {
    const total=index===1?57:2;
    const rows:Array<Record<string,unknown>>=Array.from({length:total},(_,k)=>({hash:(index*100+k+1).toString(16).padStart(64,'0'),name:`${k%2?'workstation':'laptop'}-${k+1}`,workspace_id:index===1&&k%2?secondWorkspace:workspace,disabled:k===1,expires_at:null,include_byok_in_limit:k===0,limit:index===5?0:15,limit_remaining:index===5?0:12,limit_reset:'monthly',usage:7,usage_daily:.1,usage_weekly:1,usage_monthly:3}));
    if(index===1)rows.push({...rows[0],hash:'f'.repeat(64),usage:'invalid'});
    return decodeOpenRouter(JSON.stringify({data:rows.filter(r=>r.workspace_id===(query.workspace_id??workspace)).slice(Number(query.offset),Number(query.offset)+100)}));
  }
  throw new SecretError('connector_destination_invalid');
};
(connectors as Map<string,import('../server/connectors/registry.js').Connector>).set('openrouter',openRouter(transport,()=>observed));
const {deepSeek}=await load('connectors/deepseek.js') as typeof import('../server/connectors/deepseek.js');
const deepTransport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}}),deepCounts=new Map<number,number>();
let deepObserved=Date.now();
const initialAt=Date.now()-3*3_600_000;
deepTransport.send=async(operation,secret)=>{
  const index=DEEPSEEK_SCENES.findIndex((_,i)=>DEEPSEEK_KEY(i)===secret.toString('ascii'));
  if(operation!=='balance'||index<0)throw new SecretError('credential_invalid');
  const count=(deepCounts.get(index)??0)+1;deepCounts.set(index,count);
  const scene=DEEPSEEK_SCENES[index].id;
  if(count>1&&scene==='rejected')throw new SecretError('credential_rejected');
  if(count>1&&scene==='stale')throw new SecretError('connector_failed');
  deepObserved=count===1?initialAt:Date.now();
  return deepSeekPayload(scene,count===1);
};
(connectors as Map<string,import('../server/connectors/registry.js').Connector>).set('deepseek',deepSeek(deepTransport,()=>deepObserved));
const {rateSources}=await load('currencies/ecb.js') as typeof import('../server/currencies/ecb.js');
(rateSources as Map<string,import('../server/currencies/ecb.js').RatesReader>).set('ecb',async()=>demoRates(Date.now()));
const {zai,decodeZai}=await load('connectors/zai.js') as typeof import('../server/connectors/zai.js');
const quotaTransport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}}),quotaStart=Date.now();
quotaTransport.send=async(_operation,secret)=>{
  const index=QUOTA_SCENES.findIndex((_,i)=>QUOTA_KEY(i)===secret.toString('ascii'));
  if(index<0)throw new SecretError('credential_auth_rejected');
  const count=(identified.get(100+index)??0)+1;identified.set(100+index,count);
  if(index===10&&count>1)throw new SecretError('credential_auth_rejected');
  if(index===11&&count>1)throw new SecretError('credential_unreadable');
  return decodeZai(JSON.stringify(quotaFixture(index,quotaStart)));
};
(connectors as Map<string,import('../server/connectors/registry.js').Connector>).set('zai',zai(quotaTransport));
await load('index.js');
