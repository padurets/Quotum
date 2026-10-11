import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openAIPlatform,decodeOpenAI} from '../connectors/openai.js';
import {ConnectorTransport,ConnectorStatus,organizationProof} from '../connectors/transport.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Credentials} from '../secrets/credentials.js';
import {SecretKey} from '../secrets/crypto.js';
import {startSecrets} from '../secrets/start.js';
import {composeMeters} from '../domain/meterHistory.js';
import {validateMeter} from '../domain/meters.js';
import {displayHistory} from '../currencies/history.js';
import type {Chunk} from '../domain/history.js';

const start=Date.UTC(2026,9,1),day=86_400_000,secret=Buffer.from('sk-admin-'+'a'.repeat(40));
const bucket=(index:number,value=5)=>({object:'bucket',start_time:(start+index*day)/1000,end_time:(start+(index+1)*day)/1000,results:[{object:'organization.costs.result',amount:{currency:'usd',value}}]});
const page=(data:unknown[])=>({object:'page',data,has_more:false,next_page:null});
const limit={object:'organization.spend_limit',threshold_amount:10000,currency:'USD',interval:'month',enforcement:{status:'inactive'}};
function adapter(read:(op:string,query:Readonly<Record<string,string>>)=>unknown,now=()=>start+2*day+1000) {
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  transport.send=async(op,_bytes,query={})=>({organization:'org-Fixture',data:decodeOpenAI(JSON.stringify(read(op,query)))});
  return openAIPlatform(transport,now);
}

test('a poll aggregates only the current reported month into one exact current meter',async()=>{
  const queries:Readonly<Record<string,string>>[]=[];
  const c=adapter((op,query)=>{if(op==='limit')return limit;queries.push(query);return query.page?page([bucket(1,7)]):{...page([bucket(0)]),has_more:true,next_page:'cursor +/='};});
  try {
    const result=await c.identify(secret),m=result.measurement!;
    assert.equal(m.meters.length,1);assert.equal(m.meters[0].id,'usage');assert.equal(m.meters[0].amount,'12000000');
    assert.equal(m.meters[0].kind,'counter');assert.equal(m.meters[0].resetAt,Date.UTC(2026,10,1));
    assert.equal(m.observedAt,start+2*day+1000);assert.equal(m.monthlyLimit!.value!.amount,'100000000');
    assert.equal(queries[0].start_time,String(start/1000));assert.equal(queries[0].limit,'31');assert.equal(queries[1].page,'cursor +/=');
    assert.equal(result.expiryKind,'unknown');assert.equal(result.expiresAt,null);
    assert.equal(JSON.stringify(result).includes('org-Fixture'),false);assert.equal('reports' in m,false);
  }finally{c.transport.close();}
});

test('all month decimal tokens round once, preserving negative net adjustments and large integers',async()=>{
  for(const [values,expected] of [[[0.0000003,0.0000003],'1'],[[-0.0000003,-0.0000003],'-1'],[[5,-1],'4000000']] as const) {
    const c=adapter(op=>op==='costs'?page(values.map((value,i)=>bucket(i,value))):limit);
    try{assert.equal((await c.identify(secret)).measurement!.meters[0].amount,expected);}finally{c.transport.close();}
  }
  const c=adapter(op=>op==='costs'?page([bucket(0)]):limit),send=c.transport.send.bind(c.transport);
  c.transport.send=async(op,key,query={},signal)=>op==='costs'?{organization:'org-Fixture',data:decodeOpenAI(JSON.stringify(page([bucket(0)])).replace('"value":5','"value":9007199254.740993'))}:send(op,key,query,signal);
  try{assert.equal((await c.identify(secret)).measurement!.meters[0].amount,'9007199254740993');}finally{c.transport.close();}
});

test('incomplete, invalid or conflicting replies never publish a partial monthly value',async()=>{
  for(const data of [page([{...bucket(0),results:[]}]),page([bucket(0),{...bucket(1),results:[{amount:{value:'invalid',currency:'usd'}}]}]),page([bucket(0),bucket(0,6)]),page([{...bucket(0),results:[{object:'organization.costs.result',amount:{value:5,currency:'eur'}}]}])]) {
    const c=adapter(op=>op==='costs'?data:limit);
    try{assert.deepEqual((await c.identify(secret)).measurement!.meters,[]);}finally{c.transport.close();}
  }
  const c=adapter((op,query)=>{if(query.page)throw new ConnectorStatus(429,'7200');return op==='costs'?{...page([bucket(0)]),has_more:true,next_page:'next'}:limit;});
  try{const result=await c.identify(secret);assert.deepEqual(result.measurement!.meters,[]);assert.equal(result.attempt!.outcome,'transient');assert.ok(result.attempt!.retryNotBefore!>=Date.now()+7199000);}finally{c.transport.close();}
});

test('an optional limit failure retains the current expense sample without inventing a limit',async()=>{
  const c=adapter(op=>{if(op==='limit')throw new ConnectorStatus(404,null);return page([bucket(0,0)]);});
  try{const result=await c.identify(secret);assert.equal(result.measurement!.meters[0].amount,'0');assert.equal(result.measurement!.monthlyLimit!.value,null);assert.equal(result.attempt!.outcome,'degraded');}finally{c.transport.close();}
});

test('unknown key expiry requires consent; same organization rotation retains source and other organization is refused',async()=>{
  const store=new Store(':memory:',start),directory=new Directory(store.db),owner=directory.createUser('costs@fixture.example','Costs','unused',start);
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,7).toString('base64url'))),storage=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const c=adapter(op=>op==='costs'?page([bucket(0)]):limit),credentials=new Credentials(store,key,storage,new Map([[c.id,c]]));
  try {
    await assert.rejects(credentials.create(owner.id,c.id,secret.toString()),/credential_expiry_confirmation/);
    const first=await credentials.create(owner.id,c.id,secret.toString(),{allowUnknownExpiry:true});
    const second=await credentials.replace(owner.id,first.id,'sk-admin-'+'b'.repeat(40),{allowUnknownExpiry:true});
    assert.equal(first.sourceId,second.sourceId);assert.equal(second.expiryKind,'unknown');
    c.transport.send=async()=>({organization:'org-Other',data:decodeOpenAI(JSON.stringify(page([])))});
    await assert.rejects(credentials.replace(owner.id,first.id,secret.toString(),{allowUnknownExpiry:true}),/credential_account_mismatch/);
    assert.equal(credentials.list(owner.id)[0].sourceId,first.sourceId);
    const raw=JSON.stringify(store.state(first.sourceId!));assert.equal(raw.includes(secret.toString()),false);assert.equal(raw.includes('org-Fixture'),false);
  }finally{c.transport.close();store.close();}
});

test('only one exact organization header proves identity',()=>{
  assert.equal(organizationProof(['OpenAI-Organization','org-Fixture']),'org-Fixture');
  for(const raw of [[],['openai-organization',' org'],['openai-organization','org','OPENAI-ORGANIZATION','org'],['openai-organization','x'.repeat(257)]])assert.equal(organizationProof(raw),null);
});

test('our sparse samples keep the baseline, reread, corrections, missing value and month reset semantics',async()=>{
  const store=new Store(':memory:',start),source=store.source('openai_platform','a'.repeat(24),start);
  let at=start+2*day+1000,value=7,missing=false;
  const c=adapter(op=>op==='costs'?page(missing?[]:[{...bucket(Math.floor((at-start)/day),value),start_time:Math.floor(at/day)*day/1000,end_time:(Math.floor(at/day)*day+day)/1000}]):limit,()=>at);
  const record=async()=>store.record(source,(await c.identify(secret)).measurement!);
  try {
    const first=at;await record();at+=60000;await record();
    assert.equal(store.meters.readings(source,'usage',0,at+1).length,1);
    at+=60000;value=3;await record();at+=60000;value=5;await record();
    assert.equal(store.meters.calendar(source,at).month.amount,'2000000');
    const last=at;at+=60000;missing=true;await record();
    assert.equal(store.state(source).meters![0].amount,'5000000');assert.equal(store.state(source).meters![0].stale,true);
    assert.equal(store.state(source).meters![0].at,last);
    assert.ok(store.meters.spans(source,'usage',first,at).some(s=>s.interruptedAt===at));
    missing=false;at=Date.UTC(2026,10,1)+60000;value=10;await record();
    assert.equal(store.meters.calendar(source,at).month.amount,null,'the first new-month sample is only a baseline');
    assert.deepEqual(store.meters.calendar(source,at).month.unlocated,[],'the old month never becomes a cross-period delta');
    assert.equal(store.meters.spans(source,'usage',first,at).length,2);
    at+=60000;value=12;await record();assert.equal(store.meters.calendar(source,at).month.amount,'2000000');
    assert.equal(store.meters.readings(source,'usage',0,at+1)[0].at,first,'history begins at our first poll');
    const m=store.state(source).meters![0];validateMeter({...m,amount:'-1000000'});assert.throws(()=>validateMeter({...m,amount:'-1000000',resetAt:null}));
  }finally{c.transport.close();store.close();}
});

test('an old monthly value is unavailable after its exclusive deadline without a new poll',async()=>{
  const reset=Date.UTC(2026,10,1),at=reset-60000,c=adapter(op=>op==='costs'?page([bucket(30,5)]):limit,()=>at);
  const store=new Store(':memory:',at),source=store.source('openai_platform','a'.repeat(24),at);
  try {
    store.record(source,(await c.identify(secret)).measurement!);
    const chunks=[{from:reset,meterSeries:store.meters.cells({unit:'USD',ids:[[source,'usage']]},reset,reset+60000,60000)}];
    assert.deepEqual(composeMeters(chunks,60000,reset,reset+60000),[]);
  }finally{c.transport.close();store.close();}
});

test('nearby monthly samples start separate spans and cannot credit a larger new-month baseline',async()=>{
  const reset=Date.UTC(2026,10,1),store=new Store(':memory:',reset-60000),source=store.source('openai_platform','a'.repeat(24),reset-60000);
  let at=reset-60000,value=5;
  const c=adapter(op=>op==='costs'?page([{...bucket(0,value),start_time:Math.floor(at/day)*day/1000,end_time:(Math.floor(at/day)*day+day)/1000}]):limit,()=>at);
  try {
    store.record(source,(await c.identify(secret)).measurement!);at=reset+60000;value=10;
    store.record(source,(await c.identify(secret)).measurement!);at+=60000;value=12;
    store.record(source,(await c.identify(secret)).measurement!);
    assert.equal(store.meters.spans(source,'usage',reset-60000,at).length,2);
    const summary=store.meters.calendar(source,at).month;
    assert.equal(summary.amount,'2000000');assert.deepEqual(summary.unlocated,[]);
    const history=composeMeters([{from:reset,meterSeries:store.meters.cells({unit:'USD',ids:[[source,'usage']]},reset,at+60000,60000)}],60000,reset,at+60000);
    assert.equal(history[0].spent,'2000000');assert.deepEqual(history[0].unlocated,[]);
    assert.equal(history[0].start,'10000000');
    assert.ok(history[0].points.every(p=>p.at>=reset+60000),'the gap before the first new-month sample has no value');
  }finally{c.transport.close();store.close();}
});

test('configured threshold cents are exact and optional access loss does not publish fresh costs',async()=>{
  for(const [spelling,expected] of [['1e4','100000000'],['10000.0','100000000'],['0','0'],['0.0000001',null],['-1',null]]) {
    const c=adapter(op=>op==='costs'?page([bucket(0)]):limit),send=c.transport.send.bind(c.transport);
    c.transport.send=async(op,key,query={},signal)=>op==='limit'?{organization:'org-Fixture',data:decodeOpenAI('{"object":"organization.spend_limit","threshold_amount":'+spelling+',"currency":"USD","interval":"month","enforcement":{"status":"enforcing"}}')}:send(op,key,query,signal);
    try{assert.equal((await c.identify(secret)).measurement!.monthlyLimit!.value?.amount??null,expected);}finally{c.transport.close();}
  }
  const c=adapter(op=>{if(op==='limit')throw new ConnectorStatus(401,null);return page([bucket(0)]);});
  try{await assert.rejects(c.identify(secret),/credential_access_invalid/);}finally{c.transport.close();}
});

test('a sampling round crossing the month boundary cannot publish the old month as current',async()=>{
  const reset=Date.UTC(2026,10,1);let now=reset-1000;
  const c=adapter(op=>{if(op==='costs')now=reset+1000;return op==='costs'?page([bucket(30)]):limit;},()=>now);
  try{assert.deepEqual((await c.identify(secret)).measurement!.meters,[]);}finally{c.transport.close();}
});

test('common currency conversion presents monthly observations without changing native accounting',async()=>{
  const at=start+2*day+1000,store=new Store(':memory:',start),directory=new Directory(store.db);
  const owner=directory.createUser('currency-costs@fixture.example','Costs','unused',start),source=store.source('openai_platform','a'.repeat(24),start);
  const c=adapter(op=>op==='costs'?page([bucket(0,10)]):limit,()=>at);
  try {
    store.record(source,(await c.identify(secret)).measurement!);
    store.currencies.save({source:'ecb',base:'EUR',date:start+2*day,fetchedAt:at,rates:{EUR:'1000000',USD:'2000000'}});
    store.currencies.select(owner.id,'EUR');
    const chunks:Chunk[]=[{from:at-1000,to:at+60000,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[],meterSeries:store.meters.cells({unit:'USD',ids:[[source,'usage']]},at-1000,at+60000,60000)}];
    const converted=displayHistory(chunks,store.currencies,owner.id,'EUR',60000),history=composeMeters(converted,60000,at-1000,at+60000);
    assert.equal(history[0].unit,'EUR');assert.equal(history[0].end,'5000000');
    assert.equal(store.state(source).meters![0].amount,'10000000');
    const state=store.state(source),context=store.currencies.context(owner.id,{[source]:[{unit:'USD',at},{unit:'USD',at:state.monthlyLimit!.valueAt!}]});
    assert.equal(context.sources[source].length,1,'the threshold shares its observation currency binding');
  }finally{c.transport.close();store.close();}
});
