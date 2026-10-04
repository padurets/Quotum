import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeOpenRouter,openRouter} from '../connectors/openrouter.js';
import {ConnectorStatus,ConnectorTransport} from '../connectors/transport.js';
import {SecretError} from '../secrets/crypto.js';
import {Store} from '../store/store.js';
import {publicSourceState} from '../projection.js';

const now=Date.parse('2026-10-01T12:00:00Z');
const secret=Buffer.from('sk-or-v1-'+'a'.repeat(64));
const workspace='550e8400-e29b-41d4-a716-446655440000';
const current={data:{is_management_key:true,expires_at:'2026-10-02T12:00:00Z',organization_id:null,creator_user_id:'private-person',label:secret.toString()}};
const key=(i:number,extra:object={})=>({hash:i.toString(16).padStart(64,'0'),name:'laptop-'+i,workspace_id:workspace,disabled:false,expires_at:null,limit:15,limit_remaining:15,limit_reset:'monthly',include_byok_in_limit:true,usage:7.370123456,usage_daily:0,usage_weekly:0,usage_monthly:0,byok_usage:20,label:secret.toString(),creator_user_id:'never-keep',...extra});
type Read=(operation:string,query:Readonly<Record<string,string>>)=>unknown;
function connector(read:Read=()=>undefined) {
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  transport.send=async(operation,bytes,query={})=>{
    assert.equal(bytes.toString(),secret.toString());
    const override=read(operation,query);
    const value=override??(operation==='key'?current:operation==='credits'?{data:{total_credits:50,total_usage:37.104969129}}:operation==='workspaces'?{data:[{id:workspace,name:'private-workspace',created_by:'never-keep'}],total_count:1}:{data:[key(1),key(2)]});
    return decodeOpenRouter(typeof value==='string'?value:JSON.stringify(value));
  };
  return openRouter(transport,()=>now);
}

test('OpenRouter verifies management authority, stable organization identity and exact account credits',async()=>{
  const c=connector(),id=await c.identify(secret);
  assert.equal(id.account.length,24);assert.equal(id.expiresAt,now+86_400_000);
  assert.equal(id.measurement?.meters.find(m=>m.id==='usage')?.amount,'37104969');
  assert.equal(JSON.stringify(id).includes('private-person'),false);
  const org=(creator:string)=>connector(op=>op==='key'?{data:{...current.data,organization_id:'org-private',creator_user_id:creator}}:undefined);
  assert.equal((await org('one').identify(secret)).account,(await org('two').identify(secret)).account);
  assert.notEqual((await org('one').identify(secret)).account,id.account);
  await assert.rejects(connector(op=>op==='key'?{data:{...current.data,is_management_key:false,is_provisioning_key:true}}:undefined).identify(secret),/credential_wrong_type/);
});

test('a monthly key cap uses authoritative remainder rather than lifetime usage and scrubs supplier echoes',async()=>{
  const c=connector(op=>op==='keys'?{data:[key(1,{name:secret.toString().toUpperCase()}),key(2,{limit:0,limit_remaining:0}),key(3,{limit:10,limit_remaining:-1,disabled:true})]}:undefined);
  const id=await c.identify(secret),answer=await c.measure(secret,id);
  const measurement=answer.measurement!;
  assert.equal(measurement.inventoryComplete,true);assert.equal(measurement.keys.length,3);
  const caps=measurement.meters.filter(m=>m.kind==='cap');
  assert.deepEqual(caps.map(m=>[m.amount,m.limit]),[['0','15000000'],['0','0'],['11000000','10000000']]);
  assert.ok(caps.every(m=>m.resetAt===Date.parse('2026-11-01T00:00:00Z')&&m.minutes===31*1440));
  assert.equal(measurement.keys[0].name,null);assert.equal(measurement.keys[0].includeByok,true);
  const output=JSON.stringify(answer);
  for(const privateValue of [secret.toString(),'never-keep','private-person','private-workspace',key(1).hash])assert.equal(output.includes(privateValue),false);
});

test('workspace traversal and key pages are bounded; a malformed key preserves valid neighbors and account counters',async()=>{
  const offsets:string[]=[];
  const c=connector((op,query)=>{
    if(op==='keys'){
      offsets.push(query.offset);
      return {data:query.offset==='0'?Array.from({length:100},(_,i)=>key(i+1)):[key(101),key(102,{usage:'invalid'})]};
    }
  });
  const id=await c.identify(secret),answer=await c.measure(secret,id);
  assert.deepEqual(offsets,['0','100']);assert.equal(answer.measurement?.keys.length,101);
  assert.equal(answer.measurement?.inventoryComplete,false);
  assert.equal(answer.measurement?.meters.find(m=>m.id==='credits')?.amount,'50000000');
  const partial=connector(op=>{if(op==='workspaces')throw new SecretError('connector_timeout');});
  const initial=await partial.identify(secret),result=await partial.measure(secret,initial);
  assert.equal(result.measurement?.inventoryComplete,false);assert.equal(result.measurement?.keys.length,2);
});

test('repeated pages cannot loop and access errors distinguish stored expiry without supplier messages',async()=>{
  const repeated=connector(op=>op==='keys'?{data:Array.from({length:100},(_,i)=>key(i+1))}:undefined);
  const id=await repeated.identify(secret),round=await repeated.measure(secret,id);
  assert.equal(round.measurement?.inventoryComplete,false);assert.equal(round.measurement?.keys.length,100);
  for(const [expiry,code] of [[now-1,'credential_expired'],[now+1,'credential_revoked']] as const) {
    const revoked=connector(()=>{throw new ConnectorStatus(401,secret.toString());});
    await assert.rejects(revoked.measure(secret,{account:id.account,expiresAt:expiry}),new RegExp(code));
  }
  await assert.rejects(connector(op=>op==='key'?{data:{...current.data,organization_id:'different'}}:undefined).measure(secret,id),/credential_account_mismatch/);
});

test('the decoder uses original decimal tokens and invalid precision fails only its field',()=>{
  const parsed=decodeOpenRouter('{"data":{"total_credits":9007199254.740993,"total_usage":0.1000005,"usage":1e309,"name":"kept text"}}') as {data:Record<string,unknown>};
  assert.deepEqual(parsed.data,{total_credits:'9007199254740993',total_usage:'100001',usage:null,name:'kept text'});
  const status=new ConnectorStatus(429,'36000');assert.equal(status.retryAfterMs,3_600_000);
  assert.equal(new ConnectorStatus(429,secret.toString()).retryAfterMs,null);
});

test('normalizing a supplier name cannot reconstruct a management secret',async()=>{
  const c=connector(op=>op==='keys'?{data:[key(1,{name:'sk\u0000-or-v1-'+'a'.repeat(64)}),key(2,{name:'ordinary\u0000 name'})]}:undefined);
  const answer=await c.measure(secret,await c.identify(secret));
  assert.equal(answer.measurement!.keys[0].name,null);
  assert.equal(answer.measurement!.keys[1].name,'ordinary name');
  assert.equal(JSON.stringify(answer).includes(secret.toString()),false);
  const store=new Store(':memory:',now);
  try {
    const source=store.source('openrouter',answer.account,now);store.record(source,answer.measurement!);
    assert.equal(JSON.stringify(publicSourceState(store.state(source))).includes(secret.toString()),false);
    assert.equal(store.state(source).keys?.[0].name,null);
  }finally{store.close();}
});

test('an inventory rate limit preserves counters and stops the traversal with its retry delay',async()=>{
  for(const failAt of ['workspaces','keys']) {
    const calls:string[]=[];
    const c=connector(op=>{
      calls.push(op);
      if(op===failAt)throw new ConnectorStatus(429,'3600');
      if(op==='workspaces')return {data:[{id:workspace},{id:'550e8400-e29b-41d4-a716-446655440001'}],total_count:2};
    });
    const id=await c.identify(secret);calls.length=0;
    const answer=await c.measure(secret,id);
    assert.equal(answer.retryAfterMs,3_600_000);
    assert.equal(answer.measurement?.inventoryComplete,false);
    assert.equal(answer.measurement?.meters.find(m=>m.id==='usage')?.amount,'37104969');
    assert.deepEqual(calls,failAt==='keys'?['key','credits','workspaces','keys']:['key','credits','workspaces']);
  }
});

test('the round deadline keeps successful counters without aborting the caller lifecycle',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const caller=new AbortController(),transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  let inventory=false;
  transport.send=async(op,_secret,_query,signal)=>{
    if(op==='key')return current;
    if(op==='credits')return {data:{total_credits:'50000000',total_usage:'9000000'}};
    inventory=true;
    return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new SecretError('connector_cancelled')),{once:true}));
  };
  const c=openRouter(transport,()=>now),id=await c.identify(secret);
  const pending=c.measure(secret,id,caller.signal);
  for(let i=0;i<10&&!inventory;i++)await Promise.resolve();
  assert.equal(inventory,true);t.mock.timers.tick(60_000);
  const answer=await pending;
  assert.equal(answer.measurement?.meters.find(m=>m.id==='usage')?.amount,'9000000');
  assert.equal(answer.measurement?.inventoryComplete,false);
  assert.equal(caller.signal.aborted,false);
});
