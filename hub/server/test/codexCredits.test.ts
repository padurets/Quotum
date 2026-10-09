import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AMOUNT_MAX, exactDecimal, scalarDecimal} from '../domain/amount.js';
import {convertBy} from '../domain/currency.js';
import {parseBatch, toMeasurement} from '../domain/ingest.js';
import {composeMeters} from '../domain/meterHistory.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {displayMeter} from '../domain/currencyPresentation.js';

const iso = (at: number) => new Date(at).toISOString();
const snapshot = (at: number, extra: Record<string,unknown> = {}) => ({provider:'codex',account:'a'.repeat(24),observedAt:iso(at),via:'codex/app-server',plan:'pro',staleAfterMs:1000,
  windows:[{id:'weekly',kind:'weekly',usedPercent:10}],...extra});
const batch = (snapshots: unknown[]) => ({version:1,agent:'test',machine:{id:'test',name:'Test',os:'linux',arch:'x86_64'},sentAt:iso(100),snapshots});
const balance = (amount: string) => [{id:'balance:credits',unit:'credits:codex',status:'finite',amount,hasCredits:false}];
const rich = {windows:[],resourceStatus:{windows:'missing',resets:'missing'}};

test('native credit decimals retain significant precision and round only after the complete valuation', () => {
  const scalar = exactDecimal('1234.5678912000');
  assert.deepEqual(scalar,{amount:'12345678912',scale:7});
  assert.equal(scalarDecimal(scalar),'1234.5678912');
  assert.deepEqual(exactDecimal('-0.000'),{amount:'0',scale:0});
  assert.equal(exactDecimal(AMOUNT_MAX.toString()).amount,AMOUNT_MAX.toString());
  assert.equal(exactDecimal('-'+AMOUNT_MAX).amount,'-'+AMOUNT_MAX);
  for (const value of ['0.0000000000000000001','1e3','NaN','+1','01',' 1','1.',(AMOUNT_MAX+1n).toString(),'1'.repeat(129)]) assert.throws(() => exactDecimal(value),/amount|scale/,value);
  const tiny = exactDecimal('0.0000166');
  assert.equal(convertBy(tiny.amount,[{from:'1000000',to:'30000'}],tiny.scale),'0');
  assert.equal(convertBy('2500',[{from:'1000000',to:'40000'}],0),'100000000');
});

test('rich wire states require supplier identity and reject contradictory fields before writes', () => {
  const accepted = parseBatch(batch([snapshot(10,{...rich,balances:balance('1.2300')})])).snapshots[0];
  assert.equal(accepted.balances?.[0].amount,'1.23');
  for (const change of [
    {account:null}, {provider:'claude'}, {resourceStatus:{windows:['missing'],resets:'missing'}},
    {resourceStatus:{windows:'observed',resets:'missing'}}, {balances:[{...balance('1')[0],status:'unlimited'}]},
    {balances:balance('0.0000000000000000001')}, {balances:[...balance('1'),...balance('2')]},
  ]) assert.throws(() => parseBatch(batch([snapshot(10,{...rich,balances:balance('1'),...change})])));
  assert.throws(() => parseBatch(batch([snapshot(10,{windows:[]})])));
  assert.equal(parseBatch(batch([snapshot(10,{provider:'deepseek',balances:'ignored'})])).snapshots.length,0);
});

test('quotas, resets and credits accept independent watermarks without changing each other or transport backwards', () => {
  const store = new Store(':memory:',1), id = store.source('codex','a'.repeat(24),1);
  const record = (at:number,extra:Record<string,unknown>={}) => store.record(id,toMeasurement(parseBatch(batch([snapshot(at,extra)])).snapshots[0]));
  try {
    record(10,{resets:{available:2},balances:balance('1234.5678912000')});
    record(30);
    assert.equal(store.state(id).meters?.[0].at,10);
    assert.equal(store.state(id).resets?.available,2);
    const late = record(25,{...rich,balances:balance('1.23')});
    assert.equal(late.accepted,true); assert.equal(late.delivery,false);
    assert.equal(store.state(id).successAt,30);
    assert.equal(store.state(id).delivery?.at,30);
    assert.equal(store.state(id).meters?.[0].at,25);
    assert.equal(record(25,{...rich,balances:balance('99')}).accepted,false);
    assert.equal(store.state(id).meters?.[0].amount,'123');
    assert.equal(store.meters.readings(id,'balance:credits',0,100)[0].scale,7);
  } finally {store.close();}
});

test('status-only begins no quota success and interrupted equal balances preserve exclusive gaps without spending', () => {
  const store = new Store(':memory:',1), id = store.source('codex','a'.repeat(24),1);
  const record = (at:number,status:string,amount?:string) => store.record(id,toMeasurement(parseBatch(batch([snapshot(at,{...rich,balances:[{id:'balance:credits',unit:'credits:codex',status,...(amount===undefined?{}:{amount})}]} )])).snapshots[0]));
  try {
    assert.equal(record(1,'missing').accepted,true);
    assert.equal(store.state(id).successAt,null);
    assert.equal(record(1,'missing').accepted,false);
    record(10,'finite','1.2300'); record(15,'finite','1.23'); record(20,'unlimited'); record(30,'finite','1.23');
    assert.equal(store.state(id).successAt,null);
    assert.equal(store.meters.readings(id,'balance:credits',0,100).length,1);
    const selection = {unit:'credits:codex',ids:[[id,'balance:credits'] as [string,string]]};
    for (const cell of [1,10,25,100]) {
      const meterSeries = store.meters.cells(selection,0,100,cell);
      const history = composeMeters([{from:0,meterSeries}],cell,0,100)[0];
      assert.equal(history.spent,null); assert.equal(history.topup,null);
      assert.equal(history.points.some(p => p.at < 30 && (p.validUntil ?? Infinity) > 20),false);
      assert.equal(history.points.some(p => p.at === 30),true);
      assert.equal(history.points.some(p => p.at === 10 && p.validUntil === Math.min(20,Math.floor(10/cell)*cell+cell)),true);
    }
  } finally {store.close();}
});

test('a failed mixed write rolls back quota samples, resource state and monetary notifications', () => {
  const store = new Store(':memory:',1), id = store.source('codex','a'.repeat(24),1);
  let notifications = 0;
  store.onMonetaryRecord(() => notifications++);
  try {
    const measurement = toMeasurement(parseBatch(batch([snapshot(10,{balances:balance('1')})])).snapshots[0]);
    store.db.exec("CREATE TRIGGER reject_credit BEFORE INSERT ON readings BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    assert.throws(() => store.record(id,measurement),/test rollback/);
    assert.equal(store.state(id).successAt,null);
    assert.equal(store.db.prepare('SELECT count(*) n FROM samples').get()?.n,0);
    assert.equal(notifications,0);
  } finally {store.close();}
});

test('credit default, private override and reset value new anchors while preserving earlier assignments', () => {
  const store=new Store(':memory:',1),directory=new Directory(store.db);
  const alice=directory.createUser('a@example.com','Alice','fixture',1).id,bob=directory.createUser('b@example.com','Bob','fixture',1).id;
  const source=store.source('codex','a'.repeat(24),1),currency=store.currencies;
  const observe=(at:number) => {
    store.record(source,toMeasurement(parseBatch(batch([snapshot(at,{balances:balance('2500')})])).snapshots[0]));
    return store.state(source).meters![0];
  };
  const show=(owner:string,at:number) => displayMeter(observe(at),source,currency.context(owner,{[source]:[{unit:'credits:codex',at}]}))!;
  try {
    assert.equal(show(alice,10).amount,'100000000');
    assert.equal(currency.manage(alice).builtins?.[0].pairs[0].rate,'40000');
    currency.setRate(alice,'credits:codex','USD','30000',20,20,'basePerUnit');
    assert.equal(show(alice,30).amount,'75000000');
    assert.equal(show(bob,30).amount,'100000000');
    assert.equal(show(alice,30).conversion?.original.scale,0);
    assert.equal(convertBy('2500',currency.binding(alice,'credits:codex','USD',10,null,source)!,0),'100000000');
    currency.defaultRate(alice,'credits:codex',40);
    assert.equal(show(alice,50).amount,'100000000');
    assert.equal(convertBy('2500',currency.binding(alice,'credits:codex','USD',30,null,source)!,0),'75000000');
    assert.equal(store.meters.readings(source,'balance:credits',0,100).length,1);
    assert.equal(currency.manage(bob).personal.length,0);
    assert.throws(()=>currency.select(alice,'credits:codex'),/invalid_currency/);
    assert.throws(()=>currency.archive(alice,'credits:codex',undefined,60),/invalid_currency/);
    assert.equal(currency.binding(alice,'credits:zai','USD',60),null);
    currency.save({source:'fixture',base:'EUR',date:0,fetchedAt:60,validUntil:null,rates:{EUR:'1000000',USD:'2000000'}});
    const personal=currency.create(alice,{name:'Points',symbol:'PT',fractionDigits:2},'EUR','3000000',60);
    const path=currency.binding(alice,'credits:codex',personal.id,70)!;
    assert.equal(path.length,3);
    assert.equal(convertBy('2500',path,0),'150000000');
  } finally {store.close();}
});

test('financial grants force one durable admission heartbeat and never backfill an older sample', () => {
  const store=new Store(':memory:',1),directory=new Directory(store.db),owner=directory.createUser('a@example.com','Alice','fixture',1).id;
  const board=directory.createBoard('Shared',owner,1),source=store.source('codex','a'.repeat(24),1);
  store.hold(source,owner,1);
  const observe=(at:number)=>store.record(source,toMeasurement(parseBatch(batch([snapshot(at,{balances:balance('1.23')})])).snapshots[0]));
  try {
    observe(10);store.share(board.id,source,owner,20);
    const grant=store.sources(board.id)[0].budget!;
    assert.equal(grant.enabled,false);
    const enabled=store.setBudget(board.id,source,owner,true,grant.revision,20);
    assert.equal(enabled.anchor,null);
    observe(30);observe(40);observe(50);
    assert.equal(store.sources(board.id)[0].budget?.anchor,30);
    assert.deepEqual(store.meters.readings(source,'balance:credits',0,60).map(r=>r.at),[10,30]);
    const chunks=store.cells(board.id,10,20,50,{now:50,scope:'budget',meters:{unit:'credits:codex',ids:[[source,'balance:credits']]}});
    assert.equal(composeMeters(chunks,10,20,50)[0].points[0].at,30);
    assert.throws(()=>store.setBudget(board.id,source,owner,false,grant.revision,55),/share_conflict/);
    const disabled=store.setBudget(board.id,source,owner,false,enabled.revision,55);
    const again=store.setBudget(board.id,source,owner,true,disabled.revision,60);
    assert.equal(again.anchor,null);
    assert.equal(store.cells(board.id,10,20,50,{now:60,scope:'budget',meters:{unit:'credits:codex',ids:[[source,'balance:credits']]}}).flatMap(c=>c.meterSeries??[]).length,0);
  } finally {store.close();}
});


test('coarse credit cells and retention preserve each native scale and original span anchor',()=>{
  const store=new Store(':memory:',1),id=store.source('codex','a'.repeat(24),1);
  const record=(at:number,amount:string)=>store.record(id,toMeasurement(parseBatch(batch([snapshot(at,{balances:balance(amount)})])).snapshots[0]));
  try {
    record(10,'1234.5678912000');record(20,'1.2');record(30,'7');
    const selection={unit:'credits:codex',ids:[[id,'balance:credits'] as [string,string]]};
    const packed=store.meters.cells(selection,0,100,100),history=composeMeters([{from:0,meterSeries:packed}],100,0,100)[0];
    assert.deepEqual(history.points.map(p=>[p.at,p.value,p.semantics?.scale]),[[10,'12345678912',7],[20,'12',1],[30,'7',0]]);
    assert.equal(history.startScale,7);assert.equal(history.endScale,0);
    store.meters.prune(25);assert.equal(store.meters.spans(id,'balance:credits',0,100)[0].from,10);
    const retained=store.meters.readings(id,'balance:credits',25,100);assert.equal(retained[0].at,20);assert.equal(retained[0].scale,1);
  }finally{store.close();}
});
