import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../store/store.js';
import {STEPS} from '../store/schema.js';
import {deepSeekMeasurement} from '../connectors/deepseek.js';
import type {KeyPart,Meter,MeterMeasurement} from '../domain/meters.js';

const answer=(available=true)=>({is_available:available,balance_infos:[{currency:'USD',total_balance:'110',granted_balance:'10',topped_up_balance:'100'}]});
const meter=(id:string,at:number):Meter=>({id,at,kind:'counter',unit:'USD',amount:'1000000',staleAfterMs:300_000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null});
const key=(at:number):KeyPart=>({id:'111111111111',name:'Laptop',disabled:false,expiresAt:null,includeByok:false,at,staleAfterMs:300_000,presence:'observed',missCount:0,periods:{day:'4000000',week:'6000000',month:'7000000'},byokUsage:{total:'9007199254740993',day:'2',week:'3',month:null},createdAt:1,updatedAt:2});
const observation=(at:number,keys:KeyPart[]):MeterMeasurement=>({type:'meters',observedAt:at,staleAfterMs:300_000,meters:[meter('credits',at),meter('usage',at),...keys.map(k=>meter('key:'+k.id+':usage',k.at))],keys,inventoryComplete:true,inventoryError:null,inventoryAt:Math.max(at,...keys.map(k=>k.at))+1});

test('funds status survives restart, is sparse on heartbeat and retains status-only empty reads',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'quotum-contexts-')),file=path.join(dir,'db.sqlite');
  let store=new Store(file,1);
  try {
    const source=store.source('deepseek','1'.repeat(24),1);
    store.record(source,deepSeekMeasurement(answer(false),1));store.record(source,deepSeekMeasurement(answer(false),2));
    assert.equal(store.meters.contexts.history(source,'inventory',0,10).length,0,'balance-only API does not report a key inventory');
    assert.deepEqual(store.meters.contexts.history(source,'funds',0,10).map(c=>[c.from,c.to]),[[1,2]]);
    store.record(source,deepSeekMeasurement(answer(true),3));
    store.record(source,deepSeekMeasurement({is_available:true,balance_infos:[]},4));
    store.close();store=new Store(file,5);
    const contexts=store.meters.contexts.history(source,'funds',0,10);
    assert.deepEqual(contexts.map(c=>c.value.type==='funds'&&[c.value.isAvailable,c.value.partial,c.value.issues]),[[false,false,[]],[true,false,[]],[true,true,['currency_missing','empty_balances']]]);
    assert.equal(store.state(source).successAt,3);assert.equal(store.meters.readings(source,'balance:USD',0,10).length,1);
    assert.equal(store.meters.readings(source,'granted:USD',0,10)[0].amount,'10000000');
    assert.equal(store.meters.readings(source,'topped_up:USD',0,10)[0].amount,'100000000');
    store.record(source,deepSeekMeasurement(answer(false),2));assert.equal(store.meters.contexts.history(source,'funds',0,10).length,3);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('key context keeps periods, UTC scope, BYOK and properties even after key archival',()=>{
  const store=new Store(':memory:',1),edge=Date.parse('2026-10-06T00:00:00Z');
  try {
    const source=store.source('openrouter','2'.repeat(24),1),first=key(edge-5000);
    store.record(source,observation(edge-10_000,[first]));
    store.record(source,observation(edge-9000,[{...first,at:edge-4000}]));
    assert.equal(store.meters.contexts.history(source,'key:'+first.id,0,edge+10000).length,1);
    const second={...first,at:edge+5000,disabled:true};store.record(source,observation(edge-1000,[second]));
    store.record(source,observation(edge+10_000,[]));store.record(source,observation(edge+20_000,[]));
    assert.equal(store.state(source).keys?.length,0);
    const history=store.meters.contexts.history(source,'key:'+first.id,0,edge+30_000),a=history[0].value,b=history[1].value;
    assert.equal(history.length,2);assert.equal(a.type,'key');assert.equal(b.type,'key');
    if(a.type!=='key'||b.type!=='key')throw new Error('wrong context');
    assert.equal(a.periodFrom.day,edge-86_400_000);assert.equal(b.periodFrom.day,edge);
    assert.deepEqual(b.periods,second.periods);assert.equal(b.byokUsage.total,'9007199254740993');assert.equal(b.byokUsage.month,null);
    assert.equal(b.createdAt,1);assert.equal(b.updatedAt,2);assert.equal(b.disabled,true);
    assert.equal(history[1].from,second.at,'key page time is independent of account time');
    assert.equal(store.meters.contexts.history(source,'inventory',edge+20_000,edge+30_000).at(-1)?.value.type,'inventory');
  }finally{store.close();}
});

test('context and numeric state roll back together when an archive write fails',()=>{
  const store=new Store(':memory:',1);
  try {
    const source=store.source('deepseek','3'.repeat(24),1),before=store.state(source);
    store.db.exec("CREATE TRIGGER reject_context BEFORE INSERT ON meter_contexts BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.throws(()=>store.record(source,deepSeekMeasurement(answer(),1)));
    assert.deepEqual(store.state(source),before);assert.equal(store.meters.readings(source,'balance:USD',0,10).length,0);
    assert.equal(store.meters.contexts.history(source,'funds',0,10).length,0);
    store.db.exec('DROP TRIGGER reject_context');store.record(source,deepSeekMeasurement(answer(),1));
    assert.equal(store.meters.contexts.history(source,'funds',0,10).length,1);
  }finally{store.close();}
});

test('upgrading seeds only the last known safe context with its original timestamp',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'quotum-context-upgrade-')),file=path.join(dir,'db.sqlite');
  const db=new DatabaseSync(file),status={isAvailable:false,at:20,staleAfterMs:204000,partial:false,issues:[]};
  try {
    for(const step of STEPS.slice(0,10))db.exec(step);
    db.exec('PRAGMA user_version=10');
    db.prepare('INSERT INTO state VALUES (?,?)').run('deepseek:fixture',JSON.stringify({id:'deepseek:fixture',provider:'deepseek',balanceStatus:status,meters:[],keys:[],private:'SUPPLIER_CANARY'}));
  }finally{db.close();}
  const store=new Store(file,100);
  try {
    const context=store.meters.contexts.history('deepseek:fixture','funds',0,30)[0];
    assert.equal(context.from,20);assert.equal(context.to,20);assert.equal(JSON.stringify(context).includes('SUPPLIER_CANARY'),false);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('retention keeps a crossing span and one baseline without making an old fact fresh',()=>{
  const store=new Store(':memory:',1);
  try {
    const source=store.source('deepseek','4'.repeat(24),1);
    store.record(source,deepSeekMeasurement(answer(false),1));store.record(source,deepSeekMeasurement(answer(false),80));
    store.record(source,deepSeekMeasurement(answer(true),100));store.record(source,deepSeekMeasurement(answer(true),300));
    store.meters.contexts.prune(200);
    const rows=store.meters.contexts.history(source,'funds',200,400);
    assert.equal(rows.at(-1)?.from,200);assert.equal(rows.at(-1)?.to,300);
    store.meters.contexts.prune(1_000_000);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM meter_contexts WHERE source_id=? AND item='funds'").get(source)?.n,1);
    assert.equal(store.meters.contexts.history(source,'funds',1_000_000,1_000_010).length,0);
  }finally{store.close();}
});
