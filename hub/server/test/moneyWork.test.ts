import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {composeMoneyWorkPrepared, moneyWorkRate, type MoneyWork} from '../domain/moneyWork.js';
import {drain} from '../domain/prepare.js';
import type {Meter} from '../domain/meters.js';
import {HistoryTiles,HistoryLimit} from '../history.js';
import {DatabaseSync} from 'node:sqlite';
import {STEPS} from '../store/schema.js';
import {centralFixture,at} from './centralFixture.js';

const start=Date.UTC(2026,8,1),minute=60_000;
const meter=(id:string,at:number,value:string):Meter=>({id,at,amount:value,kind:'counter',unit:'USD',stale:false,staleAfterMs:45*minute,limit:null,resetAt:null,minutes:null,scope:null,label:null});

test('a standalone budget-work GET credits a quiet linked device before its first history read',async t=>{
  let now=at;t.mock.method(Date,'now',()=>now);const h=await centralFixture();
  try{
    const source=h.store.source('openrouter','quiet-linked-wallet',at);h.store.hold(source,h.owner.id,at);h.store.share(h.board,source,h.owner.id,at);
    h.store.links.mutate(h.owner.id,'create',null,{clientId:'opencode',deviceId:h.device.id,route:null,sourceId:source,from:at,to:null,expectedRevision:'0',requestId:randomUUID()},at);
    h.hub.ingest.live.report(h.device.id,h.owner.id,[{clientId:'opencode',source:null,sessionId:'a'.repeat(32),origin:'terminal',project:'Quiet',folder:null,startedAt:at,sentStartedAt:at,lastWorkedAt:null,working:true,device:{id:h.device.id,name:'Laptop'}}],at);
    assert.equal(h.store.db.prepare('SELECT count(*) n FROM agent_work').get()!.n,0);
    now=at+6*minute;
    const query=new URLSearchParams({board:h.board,cell:String(minute),from:String(at),to:String(now),scope:'budget',unit:'USD',meters:JSON.stringify([[source,'balance']]),work:'1'});
    const response=await h.call('GET','/api/history?'+query);assert.equal(response.statusCode,200,response.body);
    const work=drain(composeMoneyWorkPrepared(response.json().chunks,minute,at,now))[0];assert.equal(work.activeMs,200_000);
    assert.equal(h.store.db.prepare('SELECT count(*) n FROM agent_work').get()!.n,1);
  }finally{await h.app.close();h.store.close();}
});
function fixture(file:string,times:number[]) {
  let store=new Store(file,start);const directory=new Directory(store.db),owner=directory.createUser('owner@example.com','Owner','fixture',start),board=directory.boards(owner.id).find(b=>b.personal)!.id;
  const source=store.source('openrouter','fixture',start),device=directory.saveDevice({userId:owner.id,machine:{id:'fixture',name:'Laptop',os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},start).id;
  store.hold(source,owner.id,start);
  for(const time of times){const at=start+time*minute;store.record(source,{type:'meters',observedAt:at,staleAfterMs:45*minute,meters:[meter('usage',at,time===60?'6000000':'0'),meter('credits',at,'60000000')],keys:[],inventoryComplete:true,inventoryError:null});}
  store.creditWork(device,start,start+60*minute,[{client:'opencode',source:null,origin:'terminal',project:'Project',folder:'',startedAt:start,identity:{kind:'stable',sessionId:'a'.repeat(32)}}]);
  store.links.mutate(owner.id,'create',null,{clientId:'opencode',deviceId:device,route:null,sourceId:source,from:start,to:null,expectedRevision:'0',requestId:randomUUID()},start);
  store.close();store=new Store(file,start+61*minute);
  const read=(from=start+10*minute,to=start+61*minute,cell=minute):MoneyWork=>{
    const chunks=new HistoryTiles(store).read(board,cell,from,to,to,store.authorizedSources(board),{ids:[[source,'balance']],unit:'USD'},'budget',undefined,true).map(json=>JSON.parse(json));
    return drain(composeMoneyWorkPrepared(chunks,cell,from,to))[0];
  };
  return {store,source,board,owner:owner.id,device,read};
}

test('dense native pair reads share the request ceiling even when their financial JSON is sparse',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'quotum-pair-budget-')),h=fixture(path.join(root,'db.sqlite'),Array.from({length:3000},(_,i)=>i/60));
  const tiles=new HistoryTiles(h.store,128*1024),from=start,to=start+50*minute,shown=h.store.authorizedSources(h.board),selection={ids:[[h.source,'balance']] as [string,string][],unit:'USD'};
  try{
    assert.ok(tiles.read(h.board,minute,from,to,to,shown,selection,'budget').length);
    assert.throws(()=>tiles.read(h.board,minute,from,to,to,shown,selection,'budget',undefined,true),HistoryLimit);
    assert.ok(tiles.read(h.board,minute,from,to,to,shown,selection,'budget').length,'a refused work reservation releases all staging');
    assert.ok(new HistoryTiles(h.store).read(h.board,minute,from,to,to,shown,selection,'budget',undefined,true).length,'the same native evidence fits the ordinary shared budget');
  }finally{h.store.close();rmSync(root,{recursive:true,force:true});}
});

test('accepted unchanged native endpoints survive reopen and distinguish equal sparse histories',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'quotum-pairs-'));
  const a=fixture(path.join(root,'a.sqlite'),[0,20,40,60]),b=fixture(path.join(root,'b.sqlite'),[0,40,60]);
  try {
    assert.deepEqual(a.store.meters.readings(a.source,'usage',0,start+61*minute),b.store.meters.readings(b.source,'usage',0,start+61*minute));
    assert.deepEqual(a.store.meters.spans(a.source,'usage',0,start+61*minute),b.store.meters.spans(b.source,'usage',0,start+61*minute));
    assert.deepEqual(a.store.meters.pairReadings(a.source,'usage',0,start+61*minute).readings.map(r=>r.at),[0,20,40,60].map(t=>start+t*minute));
    const one=a.read(),two=b.read();assert.equal(one.eligibleActiveMs,40*minute);assert.equal(one.spent,'6000000');
    assert.deepEqual(moneyWorkRate(one,'54000000'),{rate:'9000000',remainingMs:String(6*3_600_000),status:'estimate'});
    assert.equal(two.eligibleActiveMs,20*minute);assert.equal(moneyWorkRate(two,'54000000').status,'insufficient');
    assert.equal(one.activeMs,50*minute);
    const coarse=a.read(start+10*minute,start+61*minute,10*minute);assert.equal(coarse.spent,one.spent);assert.equal(coarse.eligibleActiveMs,one.eligibleActiveMs);
  }finally{a.store.close();b.store.close();rmSync(root,{recursive:true,force:true});}
});

test('pair capture is source-counter only, rejects duplicate and rolled back endpoints, and keeps both retention predecessors',()=>{
  const store=new Store(':memory:',start),source=store.source('openrouter','fixture',start);
  const record=(time:number,value='0')=>{const at=start+time*minute;store.record(source,{type:'meters',observedAt:at,staleAfterMs:45*minute,meters:[meter('usage',at,value),meter('credits',at,'60000000')],keys:[],inventoryComplete:true,inventoryError:null});};
  try {
    record(0);record(20);record(40);record(40);record(60,'6000000');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM readings WHERE pair_anchor=1').get()?.n,2);
    store.db.exec('BEGIN IMMEDIATE');record(80,'6000000');store.db.exec('ROLLBACK');
    assert.equal(store.meters.pairReadings(source,'usage',0,start+90*minute).readings.length,4);
    store.meters.prune(start+50*minute);
    assert.deepEqual(store.meters.pairReadings(source,'usage',0,start+90*minute).readings.map(r=>r.at),[0,40,60].map(t=>start+t*minute));
    assert.deepEqual(store.meters.readings(source,'usage',0,start+90*minute).map(r=>r.at),[0,60].map(t=>start+t*minute));
    const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT at FROM readings WHERE source_id=? AND meter_id=? AND pair_anchor=0 AND at<?').all(source,'usage',start+90*minute);
    assert.ok(JSON.stringify(plan).includes('readings_sparse'));
  }finally{store.close();}
});

test('exact rate uses active union and distinguishes insufficient work, no spending and stale balance',()=>{
  const value:MoneyWork={source:'source',unit:'USD',activeMs:3_600_000,agentMs:7_200_000,spent:'9007199254740993',duringWork:'9007199254740993',eligibleActiveMs:3_600_000,eligibleAgentMs:7_200_000,coveredMs:3_600_000,knownFrom:start,partial:false,estimate:true};
  assert.equal(moneyWorkRate(value,'90071992547409930').rate,value.spent);assert.equal(moneyWorkRate(value,'90071992547409930').remainingMs,'36000000');
  assert.equal(moneyWorkRate(value,'90071992547409930',true).remainingMs,null);
  assert.equal(moneyWorkRate({...value,spent:'0'},'1000').status,'zero');assert.equal(moneyWorkRate({...value,spent:'0'},'1000').remainingMs,null);
  assert.equal(moneyWorkRate({...value,eligibleActiveMs:29*minute},'1000').status,'insufficient');
  assert.equal(moneyWorkRate({...value,eligibleActiveMs:0},'0').remainingMs,'0');
});

test('upgrading sparse history establishes a new fence without reconstructing old heartbeat timestamps',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'quotum-legacy-pairs-')),file=path.join(root,'legacy.sqlite'),source='openrouter:legacy';
  const db=new DatabaseSync(file);db.exec(STEPS.slice(0,22).join('\n'));db.exec('PRAGMA user_version=22');
  db.prepare('INSERT INTO sources (id,provider,account,created_at) VALUES (?,?,?,?)').run(source,'openrouter','legacy',start);
  db.prepare('INSERT INTO readings (source_id,meter_id,at,previous_at,kind,unit,amount,limit_amount,reset_at,minutes,scope,label,stale_after_ms,amount_scale) VALUES (?,?,?,NULL,?,?,?,NULL,NULL,NULL,NULL,NULL,?,6)').run(source,'usage',start,'counter','USD',0,45*minute);
  db.prepare('INSERT INTO meter_spans (source_id,meter_id,from_at,to_at,stale_after_ms) VALUES (?,?,?,?,?)').run(source,'usage',start,start+40*minute,45*minute);
  db.prepare('INSERT INTO state VALUES (?,?)').run(source,JSON.stringify({id:source,provider:'openrouter',plan:'',windows:[],resets:null,error:null,successAt:start+40*minute,staleAfterMs:45*minute,meters:[meter('usage',start+40*minute,'0')]}));db.close();
  const store=new Store(file,start+60*minute);
  try {
    assert.equal(store.meters.pairReadings(source,'usage',0,start+61*minute).knownFrom,null);
    const at=start+60*minute;store.record(source,{type:'meters',observedAt:at,staleAfterMs:45*minute,meters:[meter('usage',at,'6000000'),meter('credits',at,'60000000')],keys:[],inventoryComplete:true,inventoryError:null});
    const dense=store.meters.pairReadings(source,'usage',0,start+61*minute);
    assert.equal(dense.knownFrom,at);assert.deepEqual(dense.readings.map(r=>r.at),[start,at]);assert.equal(dense.readings[1].previousAt,start+40*minute);
    assert.equal(store.meters.calendar(source,at).month.amount,'6000000','legacy financial spending is preserved');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('closed work tiles reattribute on correction while pure financial tiles and the ledger remain identical',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'quotum-work-cache-')),f=fixture(path.join(root,'fixture.sqlite'),[0,20,40,60]);
  try {
    const second=f.store.source('openrouter','second',start);f.store.hold(second,f.owner,start);
    const history=new HistoryTiles(f.store),selection={ids:[[f.source,'balance']] as [string,string][],unit:'USD' as const},shown=f.store.authorizedSources(f.board),end=start+120*minute;
    const read=(work:boolean)=>history.read(f.board,minute,start,end,end,shown,selection,'budget',undefined,work);
    const financial=read(false),old=read(true),ledger=f.store.db.prepare('SELECT * FROM agent_work').all();assert.deepEqual(read(true),old);
    const rule=f.store.links.list(f.owner)[0];f.store.links.mutate(f.owner,'correct',rule.id,{...rule,sourceId:second,expectedRevision:'1',requestId:randomUUID()},end);
    const changed=read(true);assert.notDeepEqual(changed,old);assert.deepEqual(read(false),financial);assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_work').all(),ledger);
    const values=drain(composeMoneyWorkPrepared(changed.map(json=>JSON.parse(json)),minute,start,end));assert.equal(values[0].activeMs,0);assert.equal(values[0].spent,'6000000');assert.equal(moneyWorkRate(values[0],'54000000').status,'insufficient');
  }finally{f.store.close();rmSync(root,{recursive:true,force:true});}
});
