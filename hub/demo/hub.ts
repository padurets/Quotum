/** Explicit demo composition replaces the connector before the ordinary hub starts. */
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {MONEY_KEY} from './money.js';
import {readFileSync} from 'node:fs';
const root=path.resolve(process.cwd(),'dist','server');
const load=(name:string)=>import(pathToFileURL(path.join(root,name)).href);
const {connectors}=await load('connectors/registry.js') as typeof import('../server/connectors/registry.js');
const {ConnectorTransport}=await load('connectors/transport.js') as typeof import('../server/connectors/transport.js');
const {openRouter,decodeOpenRouter}=await load('connectors/openrouter.js') as typeof import('../server/connectors/openrouter.js');
const {SecretError}=await load('secrets/crypto.js') as typeof import('../server/secrets/crypto.js');
const workspace='550e8400-e29b-41d4-a716-446655440000';
const secondWorkspace='550e8400-e29b-41d4-a716-446655440001';
const expiry=new Date(Date.now()+86_400_000).toISOString();
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
    return {data:{is_management_key:true,expires_at:index===7?null:expiry,organization_id:null,creator_user_id:'demo-money-'+index}};
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
await load('index.js');
