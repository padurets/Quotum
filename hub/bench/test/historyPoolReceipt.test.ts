import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {HistoryPool} from '../../ui/lib/historyPool';
import {safeEvidence} from '../evidence';
import {historyPoolReceiptScript,historyPoolCriticalReceiptScript} from '../historyPoolReceipt';

function fixture(critical=false) {
  const reply=Promise.resolve('stand-in'),pool=new HistoryPool();let now=0;
  const context=vm.createContext({Map,Set,WeakMap,WeakRef,Headers,Request,URL,pool,
    location:{href:'http://fixture.invalid/'},performance:{now:()=>{if(critical)throw Error('unexpected timing observation');return ++now;}},reply,fetch:()=>reply});
  const run=(source:string)=>vm.runInContext(source,context,{timeout:3000});
  run('window=globalThis;getterCalls=0;jsonCalls=0;');
  if(critical)run('const stringify=JSON.stringify;JSON.stringify=function(...args){jsonCalls++;return stringify.apply(this,args);};');
  run(critical?historyPoolCriticalReceiptScript():historyPoolReceiptScript());
  context.__quotumInspectHistoryPool(pool);
  run(`
    period={transport:{},retained:new Map(),valueCache:new Map(),bytes:0,
      get estimatedBytes(){getterCalls++;if(this.failure)throw this.failure;return 0;},evictionCandidates(){return [];}};
    function chart(scope){
      const value={scope,active:false,interest:null,grids:new Map(),flights:new Set(),responses:new Map(),reservations:new Map(),
        missing:[15],badCalls:0,readCalls:0,targetCalls:0,
        target(){this.targetCalls++;return {cell:60,k0:1,k1:1};},plotTarget(){return this.target();},
        bad(){this.badCalls++;if(this.failure)throw this.failure;return this.missing;},
        get estimatedBytes(){getterCalls++;let bytes=0;for(const tiles of this.grids.values())for(const tile of tiles.values())bytes+=tile.bytes;return bytes;},
        evictionCandidates(){this.target();return [...this.grids].flatMap(([cell,tiles])=>[...tiles].map(([index,tile])=>({bytes:tile.bytes,shownAt:tile.shownAt,drop(){tiles.delete(index);value.dropNested?.();return reply;}})));}
      };
      const env={sharedTransport:true,read(){if(this!==env)throw Error('receiver');value.readCalls++;return reply;}};
      value.env=env;return value;
    }
    quota=chart('quota');budget=chart('budget');funds=chart('budget');
    for(const value of [period,quota,budget,funds])pool.register(value);
    flight={role:'visible'};
  `);
  return {context,pool,run,read:()=>context.__quotumHistoryPoolReceipt.read()};
}

test('late cache failures survive a full seed without changing pool or read results', async()=>{
  const h=fixture();
  h.run('pool.request(period.transport,flight,()=>{},()=>{});');
  await Promise.resolve();
  h.run(`
    for(let i=0;i<9608;i++)if(pool.reserve(flight,i%8)!==true)throw Error('reserve result');
    refused=pool.reserve(flight,pool.budget+1);
    budget.grids.set(60,new Map([[0,{from:0,to:60,readFrom:0,readTo:60,validTo:60,bytes:100,shownAt:0}]]));
    accepted=pool.reserve(flight,pool.budget-50);
    result=budget.bad({cell:60,k0:0,k1:1});sameArray=result===budget.missing;
    sameRead=budget.env.read('synthetic',60,0,60)===reply;
    sameFetch=fetch('/api/boards/synthetic/period',{headers:{'x-quotum-bench-attempt':'b1:34'}})===reply;
    __quotumHistoryPoolReceipt.mark(2,3);
  `);
  const receipt=h.read();
  assert.equal(receipt.status,'complete');
  for(const key of ['omitted','errors','nearOmitted','summaryOmitted','snapshotOmitted'])assert.equal(receipt[key],0,key);
  assert.equal(receipt.reserveCalls,9610);
  assert.equal(receipt.ordinaryByFlight[0].ordinaryAccepted,9608);
  assert.equal(h.context.refused,false);assert.equal(h.context.accepted,true);
  assert.equal(h.context.budget.grids.get(60).size,0);
  assert.equal(h.context.sameArray,true);assert.equal(h.context.sameRead,true);assert.equal(h.context.sameFetch,true);
  assert.equal(h.context.budget.badCalls,1);assert.equal(h.context.budget.readCalls,1);
  const refused=receipt.entries.find((entry:{kind:string;accepted?:boolean})=>entry.kind==='reserve-critical'&&entry.accepted===false);
  assert.equal(refused.owner.kind,'transport');
  const dropped=receipt.entries.find((entry:{kind:string})=>entry.kind==='drop-after');
  assert.equal(dropped.complete,true);assert.equal(dropped.removed.length,1);
  assert.equal(dropped.removed[0][9],100);assert.equal(dropped.removed[0][11],false);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt.entries.find((entry:{kind:string})=>entry.kind==='drop-before').target)),{kind:'target',cell:60,from:60,to:120});
  assert.equal(receipt.entries.filter((entry:{kind:string})=>entry.kind==='register').length,4);
  assert.equal(receipt.entries.find((entry:{kind:string})=>entry.kind==='http').attemptId,'b1:34');
  const saved=safeEvidence(receipt) as typeof receipt;
  assert.equal(saved.status,'complete');
  assert.equal(saved.entries.find((entry:{kind:string})=>entry.kind==='http').attemptId,'b1:34');
  assert.ok(Buffer.byteLength(JSON.stringify(saved))<1024*1024);
});

test('observer errors preserve production return and thrown error identities',()=>{
  const h=fixture();
  h.run(`
    original=new Error('stand-in');budget.failure=original;
    sameError=false;try{budget.bad({cell:60,k0:0,k1:1});}catch(error){sameError=error===original;}
    budget.failure=null;Object.defineProperty(budget,'interest',{get(){throw Error('observer');}});
    sameReturn=budget.bad({cell:60,k0:0,k1:1})===budget.missing;
    __quotumHistoryPoolReceipt.mark(2,3);
  `);
  assert.equal(h.context.sameError,true);assert.equal(h.context.sameReturn,true);
  assert.equal(h.context.budget.badCalls,2);
  const receipt=h.read();assert.ok(receipt.errors>0);assert.equal(receipt.status,'insufficient-evidence');
});

test('an incomplete input family cannot produce a complete receipt',()=>{
  const h=fixture();const receipt=h.read();
  assert.equal(receipt.attached,true);assert.equal(receipt.registrationOrderQualified,true);
  assert.equal(receipt.lastCheckpoint,false);assert.equal(receipt.status,'insufficient-evidence');
});

test('critical receipts distinguish unknown reservations from chart staging owners',()=>{
  const h=fixture(true);
  h.run(`
    pool.reserve(flight,pool.budget+1);
    staging={role:'visible'};budget.flights.add(staging);pool.reserve(staging,pool.budget+1);
    __quotumHistoryPoolReceipt.mark(2,3);
  `);
  const receipt=h.read();
  assert.equal(receipt.status,'critical-scope-complete');
  assert.equal(receipt.nearRows.length,2);
  assert.equal(receipt.nearRows[0][7],null);
  assert.equal(receipt.nearRows[0][8],0);
  assert.equal(receipt.nearRows[1][7],receipt.members[2].id);
  assert.equal(receipt.nearRows[1][8],3);
});

test('critical receipts preserve late eviction and freshness after ordinary reservations',async()=>{
  const h=fixture(true);
  h.run('pool.request(period.transport,flight,()=>{},()=>{});');
  await Promise.resolve();
  h.run('for(let i=0;i<9608;i++)if(pool.reserve(flight,i%8)!==true)throw Error("reserve result");');
  assert.equal(h.context.getterCalls,9608*4);
  assert.equal(h.context.jsonCalls,0);
  const prefix=h.read();
  assert.equal(prefix.status,'insufficient-evidence');
  assert.equal(prefix.ordinary.status,'unobserved');
  assert.equal(prefix.ordinary.reserveCalls,9608);
  assert.equal(prefix.ownerLookups,0);assert.equal(prefix.weakIdsCreated,4);
  assert.equal(prefix.nearRows.length,0);assert.equal(prefix.tiles.length,0);
  assert.equal(h.context.getterCalls,9608*4);
  h.run(`
    refused=pool.reserve(flight,pool.budget+1);
    budget.grids.set(60,new Map([[0,{from:0,to:60,readFrom:0,readTo:60,validTo:60,bytes:100,shownAt:0,writeSeq:17}]]));
    accepted=pool.reserve(flight,pool.budget-50);
    sameArray=budget.bad({cell:60,k0:0,k1:1})===budget.missing;
    sameRead=budget.env.read('synthetic',60,0,60)===reply;
    __quotumHistoryPoolReceipt.mark(2,3);
  `);
  const receipt=h.read();
  assert.equal(receipt.status,'critical-scope-complete');
  for(const key of ['omitted','errors','nearOmitted','tileOmitted','depthOmitted'])assert.equal(receipt[key],0,key);
  assert.equal(receipt.chargeCalls,9610);assert.equal(h.context.getterCalls,9610*4);
  assert.equal(h.context.refused,false);assert.equal(h.context.accepted,true);
  assert.equal(h.context.sameArray,true);assert.equal(h.context.sameRead,true);
  const before=receipt.entries.find((entry:{kind:string})=>entry.kind==='drop-before');
  assert.deepEqual(Array.from(before.row.slice(6,10)),[1,60,60,120]);
  const after=receipt.entries.find((entry:{kind:string})=>entry.kind==='drop-after');
  assert.equal(after.row[2],true);assert.equal(after.values.length,1);
  const tile=receipt.tiles.find((value:number[])=>value[2]===after.values[0]);
  assert.equal(tile[10],60);assert.equal(tile[13],false);assert.equal(tile[14],17);
  assert.equal((safeEvidence(receipt) as typeof receipt).status,'critical-scope-complete');
});

test('critical receipts preserve errors and outer attribution during reentrant eviction',()=>{
  const h=fixture(true);
  h.run(`
    original=new Error('original getter');period.failure=original;
    sameError=false;try{pool.reserve(flight,0);}catch(error){sameError=error===original;}
    period.failure=null;
    budget.dropNested=()=>{inner=pool.reserve({role:'visible'},0);};
    budget.grids.set(60,new Map([[0,{from:0,to:60,readFrom:0,readTo:60,validTo:60,bytes:100,shownAt:0,writeSeq:23}]]));
    outer=pool.reserve(flight,pool.budget-50);__quotumHistoryPoolReceipt.mark(2,3);
  `);
  const receipt=h.read();
  assert.equal(h.context.sameError,true);assert.equal(receipt.chargeThrows,1);
  assert.equal(h.context.outer,true);assert.equal(h.context.inner,true);
  assert.equal(receipt.depthOmitted,0);assert.equal(receipt.errors,0);
  const drop=receipt.entries.find((entry:{kind:string})=>entry.kind==='drop-before');
  assert.equal(drop.row[1],2);
  assert.equal(receipt.nearRows.find((value:number[])=>value[0]===2)[6],1);
});

test('critical tile limits cannot qualify an incomplete freshness snapshot',()=>{
  const h=fixture(true);
  h.run(`
    const tiles=new Map();for(let i=0;i<2048;i++)tiles.set(i,{from:i*60,to:(i+1)*60,readFrom:i*60,readTo:(i+1)*60,validTo:(i+1)*60,bytes:1,shownAt:0,writeSeq:i+1});
    budget.grids.set(60,tiles);__quotumHistoryPoolReceipt.mark(2,3);
  `);
  const receipt=h.read();
  assert.ok(receipt.tileOmitted>0);
  assert.equal(receipt.status,'insufficient-evidence');
  assert.ok(receipt.tiles.length<=receipt.tileLimit);
  assert.ok(receipt.tileBytes<=receipt.tileByteLimit);
  assert.equal(h.context.budget.grids.get(60).size,2048);
});
