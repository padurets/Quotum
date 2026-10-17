import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {buildApp} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import {expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import {periodValueAt} from '../domain/periodValues.js';
import {composeMeters} from '../domain/meterHistory.js';
import {deepSeekMeasurement} from '../connectors/deepseek.js';
import {config} from '../config.js';
import {periodTape} from '../periodTape.js';
import {PeriodAccounting} from '../domain/periodAccounting.js';
import type {Meter} from '../domain/meters.js';

const M=60_000,now=1_800_000_000_000,cutoff=now-config.retention.sampleDays*86_400_000;
const answer=(currency='USD')=>({is_available:true,balance_infos:[{currency,total_balance:'100',granted_balance:'0',topped_up_balance:'100'}]});
const native=(id:string,amount:string,at:number):Meter=>({id,kind:'counter',unit:'USD',amount,limit:null,at,staleAfterMs:2*M,resetAt:null,minutes:null,scope:null,label:null,stale:false});
async function fixture(t:TestContext){
  t.mock.method(Date,'now',()=>now);
  const dir=mkdtempSync(join(tmpdir(),'quotum-retention-')),file=join(dir,'db.sqlite');
  let store=new Store(file,cutoff-86_400_000),directory=new Directory(store.db);
  const user=directory.createUser('reader@example.test','Reader','unused',cutoff-86_400_000),board=directory.boards(user.id)[0].id;
  const token=newSecret('qt_s');directory.createSession(token,user.id,now,86_400_000);
  const build=()=>buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null});
  let app=await build(),sequence=0;
  t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const call=(url:string,payload?:object)=>app.inject({method:payload?'POST':'GET',url,payload,headers:{origin:'http://localhost',cookie:'quotum_session='+token}});
  const read=async(id:string,from:number,to:number,meter='balance:USD',unit='USD',currency?:string,targetBoard=board)=>{
    const scope=store.state(id).provider==='codex'?'funds':'budget';
    const response=await call(`/api/boards/${targetBoard}/period`,{version:1,selection:{mode:'range',from,to},evaluatedAt:now,values:[id],[scope]:{cell:String(M),from:String(Math.floor(from/M)*M),to:String(Math.ceil(to/M)*M),meters:JSON.stringify([[id,meter]]),unit,...(currency?{currency}:{})}});
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>());
    const part=reply[scope];if(reply.values?.state!=='complete'||part?.state!=='complete'||!part.value.tape?.fixed)throw new Error('incomplete period');
    return {value:reply.values.value[0],summary:part.value.tape.fixed.money[0],chunks:part.value.chunks};
  };
  const history=async(id:string,from:number,to:number,meter:string,unit:string,currency:string)=>{
    const query=new URLSearchParams({board,cell:String(M),from:String(from),to:String(Math.floor(to/M)*M),scope:'budget',meters:JSON.stringify([[id,meter]]),unit,currency});
    const response=await call('/api/history?'+query);assert.equal(response.statusCode,200,response.body);return composeMeters(response.json().chunks,M,from,Math.floor(to/M)*M)[0];
  };
  return {get store(){return store;},get directory(){return directory;},user,board,read,history,
    source(provider:Parameters<Store['source']>[0]='deepseek'){const id=store.source(provider,(++sequence).toString().padStart(24,'a'),cutoff-86_400_000);store.hold(id,user.id,cutoff-86_400_000);return id;},
    async reopen(legacy=false){await app.close();if(legacy){store.db.exec('ALTER TABLE meter_spans DROP COLUMN observed_from; ALTER TABLE meter_contexts DROP COLUMN observed_from; DROP TABLE board_device_sessions; DROP TRIGGER meter_pairs_source_removed; DROP TRIGGER quota_anchors_source_deleted; DROP TRIGGER coverage_device_added; DROP TRIGGER coverage_device_removed; DROP TRIGGER coverage_device_status; DROP TRIGGER coverage_holding_added; DROP TRIGGER coverage_holding_removed; DROP TRIGGER coverage_holding_changed; DROP TRIGGER coverage_device_deleted; DROP TABLE client_links; DROP TABLE link_versions; DROP TABLE link_mutations; DROP TABLE device_tracking_policy; DROP INDEX devices_by_owner; DROP INDEX readings_sparse; ALTER TABLE readings DROP COLUMN pair_anchor; DROP TABLE meter_pair_starts; DROP TABLE quota_anchors; DROP TABLE work_coverage; DROP TABLE device_tracking; DROP TABLE owner_coverage_versions; DROP TABLE device_measurement_policies; DROP TABLE source_measurement_preferences; DROP TABLE device_measurement_control; DROP TABLE measurement_mutations; DROP TABLE resource_origins; ALTER TABLE device_clients DROP COLUMN observed_at; PRAGMA user_version=23;');}store.close();store=new Store(file,now);directory=new Directory(store.db);app=await build();},
  };
}

for(const provider of ['deepseek','openrouter'] as const)test(`${provider} retention preserves recovery anchors, exact currency provenance and packed endpoint values after reopening`,async t=>{
  const h=await fixture(t),id=h.source(provider),first=cutoff-30*M,head=cutoff-11*M,last=cutoff+19*M,from=cutoff+3*M,to=cutoff+18*M+1;
  const target=h.store.currencies.create(h.user.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','1000000',cutoff-40*M);h.store.currencies.select(h.user.id,target.id);
  const observe=(at:number)=>provider==='deepseek'?h.store.record(id,deepSeekMeasurement(answer(),at)):
    h.store.record(id,{type:'meters',observedAt:at,staleAfterMs:2*M,meters:[native('credits','100000000',at),native('usage','0',at)],keys:[],inventoryComplete:true,inventoryError:null});
  observe(first);h.store.currencies.setRate(h.user.id,target.id,'USD','2000000',head-M,head-M);
  for(let at=head;at<cutoff;at+=2*M)observe(at);
  h.store.currencies.setRate(h.user.id,target.id,'USD','3000000',cutoff-M/2,cutoff-M/2);
  for(let at=cutoff+M;at<=last;at+=2*M)observe(at);
  const meter=provider==='deepseek'?'balance:USD':'balance',capture=async()=>{
    const result=await h.read(id,from,to,meter,'USD',target.id),card=result.value.meters.find(m=>m.conversion?.original.meterId===meter)!;
    assert.equal(card.amount,'200000000');assert.equal(card.at,head);assert.equal(card.conversion!.original.at,head);
    assert.equal(result.summary.end,card.amount);assert.equal(result.summary.semantics!.conversion!.original.at,head);
    const point=result.summary.points.filter(p=>p.knownFrom!<to&&p.validUntil!>=to).at(-1)!;
    assert.equal(point.value,card.amount);assert.equal(point.semantics!.conversion!.original.at,head);
    const legacy=await h.history(id,from,to,meter,'USD',target.id);assert.equal(legacy.end,card.amount);assert.equal(legacy.points.at(-1)!.semantics!.conversion!.original.at,head);
    assert.equal(result.summary.spent,provider==='deepseek'?null:'0');assert.equal(result.summary.coveredMs,to-from);
    return {card,summary:{...result.summary,points:result.summary.points.map(({segment:_segment,...point})=>point)}};
  };
  const before=await capture();h.store.currencies.context(h.user.id,{[id]:[{unit:'USD',at:last}]});
  h.store.meters.prune(cutoff);h.store.meters.prune(cutoff+2*M);await h.reopen();
  assert.deepEqual(await capture(),before);
  const actual=h.store.meters.spans(id,provider==='deepseek'?meter:'usage',0,now).at(-1)!;
  assert.equal(actual.from,cutoff+2*M);assert.equal(actual.observedFrom,head);
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM currency_bindings WHERE source_id=? AND observation_at=?').get(id,head)?.n,1);
  const nativeResult=await h.read(id,from,to,meter);assert.equal(nativeResult.summary.end,'100000000');
  const tape=periodTape(h.store,h.board,h.store.shown(h.board,[]),h.user.id,'budget',{unit:'USD',currency:target.id,meters:JSON.stringify([[id,meter]])},{from,to},'test',from,()=>{});
  const wire=JSON.parse(JSON.stringify(tape));assert.equal(wire.money[0].spans.at(-1).observedFrom,head);
  assert.equal(new PeriodAccounting(wire,null).moneySummary(id,meter,target.id,{from,to})!.end,'200000000');
});

test('finite and unlimited credit contexts keep their real heads through pruning; unknown legacy heads stay unknown until a genuine eligible sample',async t=>{
  const h=await fixture(t),head=cutoff-11*M,last=cutoff+19*M,from=cutoff+3*M,to=cutoff+18*M+1;
  const ids=(['finite','unlimited'] as const).map(status=>({id:h.source('codex'),status}));
  const observe=(id:string,status:'finite'|'unlimited',at:number)=>h.store.record(id,{observedAt:at,staleAfterMs:2*M,plan:'pro',resets:null,windows:[],balances:[{id:'balance:credits',unit:'credits:codex',status,...(status==='finite'?{amount:'0'}:{}),hasCredits:true}]});
  for(const {id,status} of ids)for(let at=head;at<=last;at+=2*M)observe(id,status,at);
  h.store.meters.prune(cutoff);h.store.meters.prune(cutoff+2*M);await h.reopen();
  for(const {id,status} of ids){const result=await h.read(id,from,to,'balance:credits','credits:codex');assert.equal(result.value.creditBalance!.at,head);assert.equal(result.value.creditBalance!.status,status);assert.equal(result.value.creditBalance!.validUntil,last+2*M+1);}
  await h.reopen(true);
  for(const {id,status} of ids){
    const before=await h.read(id,from,to,'balance:credits','credits:codex');assert.equal(before.value.creditBalance,undefined);
    const at=last+M;observe(id,status,at);observe(id,status,at+M);
    const exclusive=await h.read(id,from,last,'balance:credits','credits:codex'),after=await h.read(id,from,last+1,'balance:credits','credits:codex');
    assert.equal(exclusive.value.creditBalance,undefined);assert.equal(after.value.creditBalance!.at,last);
    const retained=periodValueAt(exclusive.value,last+1);assert.ok(retained);assert.deepEqual(retained.creditBalance,after.value.creditBalance);
  }
});

test('legacy clipped geometry and a synthetic saved binding do not acquire observation authority on migration',async t=>{
  const h=await fixture(t),id=h.source(),head=cutoff-11*M,last=cutoff+19*M,from=cutoff+3*M,to=cutoff+18*M+1;
  const target=h.store.currencies.create(h.user.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',head-M);h.store.currencies.select(h.user.id,target.id);
  for(let at=head;at<cutoff;at+=2*M)h.store.record(id,deepSeekMeasurement(answer(),at));
  h.store.currencies.setRate(h.user.id,target.id,'USD','3000000',cutoff-M/2,cutoff-M/2);
  for(let at=cutoff+M;at<=last;at+=2*M)h.store.record(id,deepSeekMeasurement(answer(),at));
  h.store.meters.prune(cutoff);h.store.currencies.binding(h.user.id,'USD',target.id,cutoff,null,id);
  await h.reopen(true);
  const span=h.store.meters.spans(id,'balance:USD',0,now)[0];assert.equal(span.from,cutoff);assert.equal(span.observedFrom,undefined);
  const result=await h.read(id,from,to,'balance:USD','USD',target.id),card=result.value.meters.find(m=>m.unit===target.id&&m.conversion?.original.meterId==='balance:USD')!;
  assert.equal(card.at,head);assert.equal(card.amount,'200000000');assert.equal(result.summary.end,'200000000');
  assert.equal((await h.history(id,from,to,'balance:USD','USD',target.id)).end,'200000000');
});

test('converted producers retain recovery heads independently of their sparse valuation rows',async t=>{
  const h=await fixture(t),id=h.source(),head=cutoff-11*M,last=cutoff+19*M,from=cutoff+3*M,to=cutoff+18*M+1;
  const quote=h.store.currencies.save({source:'ecb',base:'EUR',date:cutoff-86_400_000,fetchedAt:cutoff-86_400_000,rates:{EUR:'1000000',CNY:'1000000',USD:'2000000'}});
  for(const at of [cutoff-30*M,...Array.from({length:16},(_,i)=>head+2*M*i)]){
    h.store.record(id,deepSeekMeasurement(answer('CNY'),at));h.store.currencies.record(id,h.store.state(id).meters!.find(m=>m.id==='balance:CNY')!,'USD',quote);
  }
  h.store.meters.prune(cutoff);h.store.meters.prune(cutoff+2*M);await h.reopen();
  const meter='fx:USD:balance:CNY',span=h.store.currencies.spans(id,meter,now).at(-1)!;
  assert.equal(span.from,cutoff+2*M);assert.equal(span.observedFrom,head);assert.equal(span.to,last);
  const result=await h.read(id,from,to,meter);assert.equal(result.summary.end,'200000000');assert.equal(result.summary.semantics!.conversion!.original.at,head);
  assert.equal(h.store.currencies.readings(id,meter,0,now).length,1,'unchanged recovery does not invent a value change');
});


test('shared financial projections keep admission evidence while stripping heads before the grant after retention',async t=>{
  const h=await fixture(t),id=h.source('codex'),head=cutoff-11*M,grant=cutoff-8*M,admission=cutoff-7*M,last=cutoff+19*M;
  const observe=(at:number)=>h.store.record(id,{observedAt:at,staleAfterMs:2*M,plan:'pro',resets:null,windows:[],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'2.500000000001',hasCredits:true}]});
  observe(head);observe(head+2*M);
  const board=h.directory.createBoard('Shared',h.user.id,grant);h.store.share(board.id,id,h.user.id,grant);
  h.store.setBudget(board.id,id,h.user.id,true,h.store.sources(board.id)[0].budget!.revision,grant);
  for(let at=admission;at<=last;at+=2*M)observe(at);
  h.store.meters.prune(cutoff);h.store.meters.prune(cutoff+2*M);await h.reopen();
  const from=cutoff+3*M,to=cutoff+18*M+1,result=await h.read(id,from,to,'balance:credits','USD','USD',board.id);
  const card=result.value.meters.find(m=>m.id==='balance:credits')!;
  assert.equal(card.at,admission);assert.equal(card.amount,'2500000000001');assert.equal(card.scale,12);
  assert.equal(result.value.creditBalance!.at,admission);assert.equal(result.summary.semantics!.conversion!.original.at,admission);
  const tape=periodTape(h.store,board.id,h.store.shown(board.id,[]),h.user.id,'budget',{unit:'USD',currency:'USD',meters:JSON.stringify([[id,'balance:credits']])},{from,to},'test',from,()=>{});
  assert.ok(tape.money[0].spans.every(span=>span.observedFrom===undefined||span.observedFrom>=admission));
  assert.ok(tape.money[0].readings.every(row=>row.at>=admission));
  assert.equal(new PeriodAccounting(JSON.parse(JSON.stringify(tape)),null).moneySummary(id,'balance:credits','USD',{from,to})!.end,result.summary.end);
});

test('legacy inventory seeding uses a certified completion endpoint, never an unknown clipped head',async t=>{
  const h=await fixture(t),id=h.source('openrouter'),key='abcdef123456',tail=cutoff+7*M;
  h.store.db.prepare('INSERT INTO meter_contexts(source_id,item,from_at,to_at,stale_after_ms,payload,observed_from) VALUES (?,?,?,?,?,?,?)').run(id,'inventory',cutoff,tail,M,JSON.stringify({type:'inventory',complete:true,error:null,keys:[key],uncapped:[key]}),null);
  await h.reopen();
  const rows=h.store.db.prepare('SELECT from_at,to_at,observed_from,payload FROM meter_contexts WHERE source_id=? AND item=?').all(id,'key-cap:'+key);
  assert.equal(rows.length,1);assert.equal(rows[0].from_at,tail);assert.equal(rows[0].observed_from,tail);assert.equal(JSON.parse(String(rows[0].payload)).present,false);
  h.store.meters.prune(tail+M);await h.reopen();assert.deepEqual(h.store.db.prepare('SELECT from_at,to_at,observed_from,payload FROM meter_contexts WHERE source_id=? AND item=?').all(id,'key-cap:'+key),rows);
});
