import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {CurrencyStore} from '../store/currencies.js';
import {convertBy} from '../domain/currency.js';
import {deepSeekMeasurement} from '../connectors/deepseek.js';
import {displayHistory} from '../currencies/history.js';
import {Currencies} from '../currencies/service.js';
import {composeMeters} from '../domain/meterHistory.js';

function fixture(){const store=new Store(':memory:',1),directory=new Directory(store.db),owner=directory.createUser('currency@example.com','Owner','fixture',1),other=directory.createUser('other@example.com','Other','fixture',1);return {store,owner:owner.id,other:other.id};}
const fields={name:'Points',symbol:'PT',fractionDigits:2};

test('currency lifecycle is owner scoped, atomic for the selected target and identical after reopening the store',()=>{
  const {store,owner,other}=fixture();try {
    const c=store.currencies,target=c.create(owner,fields,'USD','2000000',1);c.select(owner,target.id);
    const revision=c.registryRevision(owner),pin=c.binding(owner,'USD',target.id,10)!;
    assert.throws(()=>c.archive(owner,target.id,undefined,30),/currency_selected/);assert.equal(c.registryRevision(owner),revision);
    for(const replacement of [target.id,'personal:'+'f'.repeat(24)])assert.throws(()=>c.archive(owner,target.id,replacement,30));
    assert.equal(c.preference(owner).id,target.id);
    assert.throws(()=>c.update(other,target.id,fields),/currency_not_found/);assert.equal(c.manage(other).personal.length,0);
    c.update(owner,target.id,{...fields,name:'Changed',fractionDigits:0});assert.deepEqual(c.binding(owner,'USD',target.id,10),pin);
    c.archive(owner,target.id,'EUR',30);assert.equal(c.preference(owner).id,'EUR');assert.equal(new CurrencyStore(store.db).preference(owner).id,'EUR');
    assert.throws(()=>c.select(owner,target.id),/currency_archived/);assert.throws(()=>c.setRate(owner,target.id,'USD','3000000',40,40),/currency_archived/);
    assert.deepEqual(c.binding(owner,'USD',target.id,10),pin);assert.equal(c.binding(owner,'USD',target.id,40),null);
    c.restore(owner,target.id);assert.equal(c.preference(owner).id,'EUR');assert.equal(c.definition(owner,target.id).fractionDigits,0);
  }finally{store.close();}
});

test('stops cannot resurrect an older price, while legal backdated rates recover only real missing anchors',()=>{
  const {store,owner}=fixture();try {
    const c=store.currencies,target=c.create(owner,fields,'USD','2000000',1),q=c.rates(owner,target.id)[0];
    const before=c.binding(owner,'USD',target.id,10,null,'source')!;c.stopRate(owner,target.id,'USD',q.id,20);
    assert.equal(c.binding(owner,'USD',target.id,25,null,'source'),null);
    c.setRate(owner,target.id,'USD','2000000',40,40);const after=c.binding(owner,'USD',target.id,45,null,'source')!;
    assert.equal(convertBy('1000000',before),'2000000');assert.equal(convertBy('1000000',after),'2000000');
    assert.equal(c.binding(owner,'USD',target.id,25,null,'source'),null);assert.equal(store.db.prepare('SELECT count(*) n FROM currency_bindings').get()?.n,2);
    c.setRate(owner,target.id,'USD','3000000',24,50);assert.equal(convertBy('1000000',c.binding(owner,'USD',target.id,25,null,'source')!),'3000000');
    assert.equal(store.db.prepare('SELECT count(*) n FROM currency_unavailable_observations').get()?.n,0);assert.deepEqual(c.binding(owner,'USD',target.id,10,null,'source'),before);
    assert.throws(()=>c.stopRate(owner,target.id,'USD',q.id,60),/currency_conflict/);
  }finally{store.close();}
});

test('retention preserves a stopped decision for an unbound retained native predecessor',()=>{
  const {store,owner}=fixture();try {
    const c=store.currencies,target=c.create(owner,fields,'USD','2000000',1),q=c.rates(owner,target.id)[0],source=store.source('deepseek','1'.repeat(24),1);
    c.stopRate(owner,target.id,'USD',q.id,30);
    store.record(source,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:'100',granted_balance:'0',topped_up_balance:'100'}]},35));
    c.setRate(owner,target.id,'USD','4000000',40,40);c.prune(50);
    assert.equal(new CurrencyStore(store.db).binding(owner,'USD',target.id,35,null,source),null);
  }finally{store.close();}
});

test('unchanged observations retain an exclusive hole after packing and currency history conversion',()=>{
  const {store,owner}=fixture();try {
    const c=store.currencies,target=c.create(owner,fields,'USD','2000000',1),source=store.source('deepseek','2'.repeat(24),1);c.select(owner,target.id);
    const observe=(at:number)=>{store.record(source,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:'100',granted_balance:'0',topped_up_balance:'100'}]},at));c.context(owner,{[source]:[{unit:'USD',at}]});};
    observe(10);c.stopRate(owner,target.id,'USD',c.rates(owner,target.id)[0].id,30);observe(35);c.setRate(owner,target.id,'USD','4000000',40,40);observe(50);
    const chunks=[{from:0,to:60,series:[],activity:{devices:{},sources:{},projects:{},sessions:[],cells:[]},resets:[],grants:[],meterSeries:store.meters.cells({unit:'USD',ids:[[source,'balance:USD']]},0,60,60)}];
    const result=displayHistory(chunks,c,owner,target.id,60,(_source,_meter,until)=>until>=50?50:until>=35?35:until>=10?10:null);
    const observations=result[0].meterSeries![0].cells[0][5]!.observations!;
    assert.ok(observations,'two disjoint intervals need explicit observations');
    assert.deepEqual(observations.map(point=>[point.at,point.validUntil,point.value]),[[10,35,'200000000'],[50,60,'400000000']]);
    const points=composeMeters(result,60,0,60)[0].points;assert.ok(points.length);
  }finally{store.close();}
});

test('a collapsed observation cell cannot retain native amounts from discarded segments',()=>{
  const {store,owner}=fixture();try {
    const c=store.currencies,target=c.create(owner,fields,'USD','2000000',1),source=store.source('deepseek','4'.repeat(24),1);
    c.stopRate(owner,target.id,'USD',c.rates(owner,target.id)[0].id,20);
    const series={source,meter:'balance:USD',unit:'USD',kind:'balance' as const,pointMode:'observation' as const,semantics:null,cells:[[0,'3000000',null,null,1,{pointOffsetMs:50,validUntil:60,open:'1000000',observations:[{at:10,validUntil:20,value:'1000000'},{at:30,validUntil:40,value:'2000000'},{at:50,validUntil:60,value:'3000000'}]}] as import('../domain/meterHistory.js').MeterCell]};
    const chunks=[{from:0,to:60,series:[],activity:{devices:{},sources:{},projects:{},sessions:[],cells:[]},resets:[],grants:[],meterSeries:[series]}];
    const result=displayHistory(chunks,c,owner,target.id,60,(_source,_meter,until)=>until>=50?50:until>=30?30:10)[0].meterSeries![0];
    assert.equal(result.cells[0][1],'2000000');assert.equal(result.cells[0][5]!.observations,undefined);
    assert.equal(result.cells[0][5]!.validUntil,20);assert.equal(result.cells[0][5]!.pointOffsetMs,10);
  }finally{store.close();}
});

test('mutation receipts precede CAS, survive a new store and never replay a different command or owner',()=>{
  const {store,owner,other}=fixture();try {
    const c=store.currencies,mutation={requestId:randomUUID(),expectedRevision:c.registryRevision(owner)},body={...fields,base:'USD',rate:'2000000',...mutation};
    const create=()=>c.mutation(owner,'create',body,mutation,true,201,()=>c.create(owner,fields,'USD','2000000',1),100);
    const first=create();assert.deepEqual(create(),first);assert.equal(c.manage(owner).personal.length,1);assert.equal(c.registryRevision(owner),'1');
    const reopened=new CurrencyStore(store.db);assert.deepEqual(reopened.mutation(owner,'create',body,mutation,true,201,()=>{throw new Error('duplicate');},100),first);
    assert.throws(()=>c.mutation(owner,'edit',body,mutation,true,200,()=>null,100),/mutation_conflict/);
    assert.throws(()=>c.mutation(owner,'create',{...body,requestId:randomUUID()},{...mutation,requestId:randomUUID()},true,201,()=>null,100),/currency_conflict/);
    assert.equal(c.mutation(other,'create',body,mutation,true,201,()=>c.create(other,fields,'USD','3000000',1),100).body.symbol,'PT');
  }finally{store.close();}
});

test('owner-wide path revisions cover a private bridge for a standard display currency',()=>{
  const {store,owner}=fixture();try {
    const c=store.currencies,target=c.create(owner,fields,'USD','2000000',1);c.select(owner,'EUR');const old=c.context(owner).revision;
    assert.equal(c.binding(owner,'USD','EUR',10,null,'source'),null);c.setRate(owner,target.id,'EUR','4000000',0,20);
    assert.notEqual(c.context(owner).revision,old);assert.equal(convertBy('1000000',c.binding(owner,'USD','EUR',10,null,'source')!),'500000');
    const revision=c.context(owner).revision;c.update(owner,target.id,{...fields,symbol:'P'});assert.equal(c.context(owner).revision,revision);
    c.archive(owner,target.id,undefined,30);assert.notEqual(c.context(owner).revision,revision);assert.equal(c.binding(owner,'USD','EUR',35,null,'source'),null);
  }finally{store.close();}
});

test('retained rate pages have owner and currency scope and active capacity excludes archives',()=>{
  const {store,owner,other}=fixture();try {
    const c=store.currencies,target=c.create(owner,fields,'USD','2000000',1);
    for(let n=1;n<=130;n++)c.setRate(owner,target.id,'USD',String(2000000+n),n,n);
    let before:string|undefined,seen:number[]=[];
    do{const page=c.rateHistory(owner,target.id,before,32,200);seen.push(...page.changes.map(change=>change.sequence));before=page.nextCursor??undefined;}while(before);
    assert.equal(seen.length,131);assert.equal(new Set(seen).size,131);
    const cursor=c.rateHistory(owner,target.id,undefined,1,200).nextCursor!;
    assert.throws(()=>c.rateHistory(other,target.id,cursor,1),/currency_not_found/);
    const another=c.create(owner,fields,'USD','1000000',1);assert.throws(()=>c.rateHistory(owner,another.id,cursor,1),/invalid_currency/);
    for(let n=2;n<64;n++)c.create(owner,fields,'USD','1000000',1);
    assert.throws(()=>c.create(owner,fields,'USD','1000000',1),/currency_limit/);
    c.archive(owner,another.id,undefined,200);c.create(owner,fields,'USD','1000000',1);
    assert.throws(()=>c.restore(owner,another.id),/currency_limit/);assert.equal(c.manage(owner).personal.length,65);
  }finally{store.close();}
});


test('deferred reference fetching cannot coalesce away an unavailable native heartbeat',async()=>{
  const {store,owner}=fixture(),service=new Currencies(store,async()=>{throw new Error('no reference needed');},()=>100);
  try {
    const c=store.currencies,target=c.create(owner,fields,'USD','2000000',1),source=store.source('deepseek','3'.repeat(24),1);store.hold(source,owner,1);c.select(owner,target.id);service.start();
    const observe=(at:number)=>store.record(source,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:'100',granted_balance:'0',topped_up_balance:'100'}]},at));
    observe(10);c.stopRate(owner,target.id,'USD',c.rates(owner,target.id)[0].id,20);observe(25);c.setRate(owner,target.id,'USD','2000000',40,40);observe(45);
    assert.equal(store.db.prepare('SELECT observation_at FROM currency_unavailable_observations WHERE owner_id=? AND source_id=?').get(owner,source)?.observation_at,25);
    assert.equal(c.binding(owner,'USD',target.id,25,null,source),null);
  }finally{await service.stop();store.close();}
});

test('management summarizes current pairs without resurrecting stopped or superseded prices',()=>{
  const {store,owner,other}=fixture();try {
    const c=store.currencies,target=c.create(owner,fields,'USD','2000000',1);
    c.create(other,fields,'USD','99000000',1);
    const latest=c.setRate(owner,target.id,'USD','3000000',20,20);
    c.setRate(owner,target.id,'USD','4000000',10,30);
    c.setRate(owner,target.id,'EUR','2500000',15,30);
    assert.deepEqual(c.manage(owner).personal[0].pairs,[{base:'EUR',rate:'2500000'},{base:'USD',rate:'3000000'}]);
    c.stopRate(owner,target.id,'USD',latest.id,40);
    c.archive(owner,target.id,undefined,50);
    const summary=new CurrencyStore(store.db).manage(owner).personal[0];
    assert.equal(summary.archivedAt,50);assert.deepEqual(summary.pairs,[{base:'EUR',rate:'2500000'},{base:'USD',rate:null}]);
    assert.deepEqual(c.manage(other).personal[0].pairs,[{base:'USD',rate:'99000000'}]);
  }finally{store.close();}
});
