import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store/store.js';
import {sumDecimals} from '../domain/amount.js';
import {REPORT_DAY,composeReportsPrepared,reportSummary,reportAllowance} from '../domain/reports.js';
import {drain} from '../domain/prepare.js';
import type {MeterMeasurement} from '../domain/meters.js';
import {openAIPlatform,decodeOpenAI} from '../connectors/openai.js';
import {ConnectorTransport,ConnectorStatus,organizationProof} from '../connectors/transport.js';
import {SecretKey} from '../secrets/crypto.js';
import {startSecrets} from '../secrets/start.js';
import {Credentials} from '../secrets/credentials.js';
import {Directory} from '../store/directory.js';

const start=Date.UTC(2026,9,1),day=REPORT_DAY;
function measurement(at:number,values:readonly (readonly [number,string])[],partial=false):MeterMeasurement {
  return {type:'meters',observedAt:at,staleAfterMs:300000,meters:[],keys:[],inventoryComplete:true,inventoryError:null,reports:{status:partial?'partial':'ok',observedAt:at,error:partial?'connector_status':null,requestFrom:start,requestTo:start+3*day,traversalComplete:!partial,intervals:values.map(([index,amount])=>({meterId:'costs',unit:'USD',from:start+index*day,to:start+(index+1)*day,amount,observedAt:at}))},monthlyLimit:{status:'ok',observedAt:at,error:null,value:{amount:'100000000',unit:'USD',enforcement:'enforcing'}}};
}
test('reports replace daily values, retain signed corrections and never spend a reread',()=>{
  const store=new Store(':memory:',start+3*day),source=store.source('openai_platform','a'.repeat(24),start+3*day);
  try {
    let at=start+2*day+1000;
    store.record(source,measurement(at,[[0,'5000000'],[1,'7000000']]));
    const rows=()=>store.reports.intervals(source,'costs','USD',start,start+3*day);
    const sum=()=>reportSummary(rows(),store.reports.quality(source)[0],start,start+2*day,at);
    assert.equal(sum().amount,'12000000');const revisions=rows();
    store.record(source,measurement(++at,[[0,'5000000'],[1,'7000000']]));
    assert.deepEqual(rows(),revisions);assert.equal(sum().amount,'12000000');
    store.record(source,measurement(++at,[[0,'4000000'],[1,'7000000']]));assert.equal(sum().amount,'11000000');
    store.record(source,measurement(++at,[[0,'4000000'],[1,'7000000'],[2,'3000000']]));
    assert.equal(reportSummary(rows(),undefined,start,start+3*day,at).amount,'14000000');
    store.record(source,measurement(++at,[[0,'-1000000']]));assert.equal(sum().amount,'6000000');
    assert.equal(store.historyStart(at),start,'backfilled reports predate hub creation');
    assert.equal(store.meters.readings(source,'costs',0,at+1).length,0,'reported costs are never counter observations');
  }finally{store.close();}
});
test('cached numeric reports lose and regain confirmation without any numeric history touch',()=>{
  const store=new Store(':memory:',start),source=store.source('openai_platform','a'.repeat(24),start);
  const touches:number[]=[],noop=()=>{};store.setObserver({touchSources:noop,touchBoards:noop,touchUser:noop,touchHub:noop,history:(_s,from)=>touches.push(from),dropSessions:noop,dropMember:noop,dropBoard:noop});
  try {
    let at=start+day+1000;
    store.record(source,measurement(at,[[0,'5000000'],[1,'7000000']]));
    const cached=store.reports.intervals(source,'costs','USD',start,start+2*day);touches.length=0;
    store.record(source,measurement(++at,[[0,'5000000']],true));
    const partial=reportSummary(cached,store.state(source).reportQuality![0],start,at,at,true);
    assert.equal(partial.amount,'12000000');assert.equal(partial.confirmed,false);
    assert.equal(reportAllowance(store.reports.calendar(source,at),store.state(source).monthlyLimit,at)?.remaining,null);
    store.record(source,measurement(++at,[[0,'5000000'],[1,'7000000']]));
    assert.equal(reportSummary(cached,store.state(source).reportQuality![0],start,at,at,true).confirmed,true);
    assert.deepEqual(touches,[],'quality-only confirmation cannot reload numerical tiles');
    store.record(source,measurement(++at,[[0,'5000000'],[1,'6000000']]));
    assert.equal(reportSummary(cached,store.state(source).reportQuality![0],start,at,at,true).confirmed,false,'old7 cannot be confirmed by new6 metadata');
    assert.equal(touches[0],start+day);
  }finally{store.close();}
});
test('original daily reports deduplicate across tiles and keep subday overlaps unallocated',()=>{
  const row={from:start,to:start+day,amount:'8000000',valueObservedAt:start+day,revision:1};
  const series={source:'s',meter:'costs',kind:'reported' as const,unit:'USD',intervals:[row]};
  const composed=drain(composeReportsPrepared([{reportSeries:[series]},{reportSeries:[series]}],start,start+day));
  assert.equal(composed[0].intervals.length,1);
  assert.equal(reportSummary(composed[0].intervals,undefined,start,start+day,start+day).amount,'8000000');
  const clipped=reportSummary(composed[0].intervals,undefined,start+3600000,start+7200000,start+day);
  assert.equal(clipped.amount,null);assert.deepEqual(clipped.overlapping,[row]);
  assert.equal(sumDecimals(['0.0000003','0.0000003']).toString(),'1');
  assert.equal(sumDecimals(['-0.0000003','-0.0000003']).toString(),'-1');
  assert.throws(()=>sumDecimals(['9223372036854.775808']),/overflow/);
});
const secret=Buffer.from('sk-admin-'+'a'.repeat(40));
const bucket=(index:number,value=5)=>({object:'bucket',start_time:(start+index*day)/1000,end_time:(start+(index+1)*day)/1000,results:[{object:'organization.costs.result',amount:{currency:'usd',value}}]});
function adapter(read:(op:string,query:Readonly<Record<string,string>>)=>unknown,now=()=>start+2*day+1000) {
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  transport.send=async(op,_bytes,query={})=>{const raw=read(op,query);return {organization:'org-Fixture',data:decodeOpenAI(JSON.stringify(raw))};};
  return openAIPlatform(transport,now);
}
const limit={object:'organization.spend_limit',threshold_amount:10000,currency:'USD',interval:'month',enforcement:{status:'inactive'}};
test('OpenAI parses daily costs and integer cents independently and proves unknown key expiry',async()=>{
  const c=adapter(op=>op==='costs'?{object:'page',data:[bucket(0),bucket(1,7)],has_more:false,next_page:null}:limit);
  try{const result=await c.identify(secret);assert.equal(result.expiryKnown,false);assert.equal(result.expiresAt,null);assert.equal(result.measurement!.monthlyLimit!.value!.amount,'100000000');assert.equal(result.measurement!.reports!.intervals[1].amount,'7000000');assert.equal(JSON.stringify(result).includes('org-Fixture'),false);}finally{c.transport.close();}
});
test('certified partial pages retain retry disposition and optional permission does not lose access',async()=>{
  const first={object:'page',data:[bucket(0)],has_more:true,next_page:'page cursor+/='};
  const c=adapter((op,query)=>{if(query.page)throw new ConnectorStatus(429,'7200');return op==='costs'?first:limit;});
  try{const result=await c.identify(secret);assert.equal(result.attempt!.outcome,'transient');assert.ok(result.attempt!.retryNotBefore!>=Date.now()+7199000);assert.equal(result.measurement!.reports!.status,'partial');assert.equal(result.measurement!.reports!.intervals.length,1);}finally{c.transport.close();}
  const d=adapter(op=>{if(op==='limit')throw new ConnectorStatus(403,null);return {...first,has_more:false,next_page:null};});
  try{const result=await d.identify(secret);assert.equal(result.attempt!.outcome,'degraded');assert.equal(result.measurement!.reports!.status,'ok');assert.equal(result.measurement!.monthlyLimit!.status,'unavailable');}finally{d.transport.close();}
});
test('a proven organization preserves rotations, rejects another org and records separate expiry consent',async()=>{
  const store=new Store(':memory:'),directory=new Directory(store.db),owner=directory.createUser('report@fixture.example','Reports','unused',Date.now());
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,7).toString('base64url'))),report=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const c=adapter(op=>op==='costs'?{object:'page',data:[bucket(0)],has_more:false,next_page:null}:limit,Date.now);
  const credentials=new Credentials(store,key,report,new Map([['openai_platform',c]]));
  try {
    await assert.rejects(credentials.create(owner.id,c.id,secret.toString()),/credential_expiry_unknown_confirmation/);
    const first=await credentials.create(owner.id,c.id,secret.toString(),{allowNoExpiry:true});
    const second=await credentials.replace(owner.id,first.id,'sk-admin-'+'b'.repeat(40),{allowNoExpiry:true});
    assert.equal(first.sourceId,second.sourceId);assert.equal(second.expiryKnown,false);
    c.transport.send=async()=>({organization:'org-Other',data:decodeOpenAI(JSON.stringify({object:'page',data:[],has_more:false,next_page:null}))});
    await assert.rejects(credentials.replace(owner.id,first.id,secret.toString(),{allowNoExpiry:true}),/credential_account_mismatch/);
    assert.equal(credentials.list(owner.id)[0].sourceId,first.sourceId);
  }finally{c.transport.close();store.close();}
});
test('only one exact organization header proves identity',()=>{
  assert.equal(organizationProof(['OpenAI-Organization','org-Fixture']),'org-Fixture');
  for(const raw of [[],['openai-organization',' org'],['openai-organization','org','OPENAI-ORGANIZATION','org'],['openai-organization','x'.repeat(257)]])assert.equal(organizationProof(raw),null);
});

test('a daily report crossing retention remains whole overlap evidence without pre-cutoff spending',()=>{
  const row={from:start,to:start+day,amount:'8000000',valueObservedAt:start+day,revision:1};
  const summary=reportSummary([row],undefined,start,start+day,start+90*day+day/2);
  assert.equal(summary.amount,null);assert.deepEqual(summary.overlapping,[row]);assert.equal(summary.complete,false);
});

test('integer cents accept exact exponent spellings and reject even sub-micro fractional cents',async()=>{
  for(const [token,expected] of [['1e4','100000000'],['10000.0','100000000'],['0','0'],['0.0000001',null],['-1',null]]) {
    const c=adapter(op=>op==='costs'?{object:'page',data:[bucket(0)],has_more:false,next_page:null}:limit);
    const send=c.transport.send.bind(c.transport);c.transport.send=async(op,key,query={},signal)=>op==='limit'?{organization:'org-Fixture',data:decodeOpenAI('{"object":"organization.spend_limit","threshold_amount":'+token+',"currency":"USD","interval":"month","enforcement":{"status":"enforcing"}}')}:send(op,key,query,signal);
    try{assert.equal((await c.identify(secret)).measurement!.monthlyLimit!.value?.amount??null,expected);}finally{c.transport.close();}
  }
});
test('a malformed repeated day preserves its prior value and carries a transient attempt',async()=>{
  const malformed={...bucket(0),results:[{object:'organization.costs.result',amount:{currency:'usd',value:'invalid'}}]};
  const c=adapter(op=>op==='costs'?{object:'page',data:[bucket(0),malformed],has_more:false,next_page:null}:limit);
  try{const result=await c.identify(secret);assert.equal(result.measurement!.reports!.intervals.length,0);assert.equal(result.attempt!.outcome,'transient');assert.equal(result.attempt!.safeCode,'connector_invalid_response');}finally{c.transport.close();}
});

test('a monthly organization allowance cannot use a single-currency subtotal of mixed costs',()=>{
  const store=new Store(':memory:',start),source=store.source('openai_platform','a'.repeat(24),start),at=start+43200000;
  try{const m=measurement(at,[[0,'5000000']]);m.reports!.intervals.push({...m.reports!.intervals[0],unit:'CNY',amount:'7000000'});store.record(source,m);
    const calendar=store.reports.calendar(source,at);assert.deepEqual(calendar.map(c=>[c.unit,c.month.amount]),[['CNY','7000000'],['USD','5000000']]);
    const allowance=reportAllowance(calendar,store.state(source).monthlyLimit,at);assert.equal(allowance?.limit,'100000000');assert.equal(allowance?.remaining,null);assert.equal(store.state(source).meters?.some(m=>m.id==='monthly'),false);
  }finally{store.close();}
});

test('monthly sums beyond one SQLite amount preserve reports and exact allowance without a cap reading',()=>{
  const store=new Store(':memory:',start),source=store.source('openai_platform','a'.repeat(24),start),at=start+day+1000;
  try{store.record(source,measurement(at,[[0,'9000000000000000000'],[1,'9000000000000000000']]));const allowance=reportAllowance(store.reports.calendar(source,at),store.state(source).monthlyLimit,at);
    assert.equal(allowance?.remaining,'-17999999999900000000');assert.equal(store.state(source).meters?.some(m=>m.id==='monthly'),false);assert.equal(store.reports.intervals(source,'costs','USD',0,at+day).length,2);
  }finally{store.close();}
});
test('authentication lost at the optional limit preserves costs and stops that access',async()=>{
  const c=adapter(op=>{if(op==='limit')throw new ConnectorStatus(401,null);return {object:'page',data:[bucket(0)],has_more:false,next_page:null};});
  try{await assert.rejects(c.identify(secret),/credential_access_invalid/);const expected={account:'0'.repeat(24),expiresAt:null};const verified=adapter(op=>op==='costs'?{object:'page',data:[bucket(0)],has_more:false,next_page:null}:limit);const found=await verified.identify(secret);verified.transport.close();expected.account=found.account;const result=await c.measure(secret,expected);assert.equal(result.attempt?.outcome,'access_lost');assert.equal(result.measurement?.reports?.intervals.length,1);}finally{c.transport.close();}
});
