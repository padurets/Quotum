import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {HistoryPool} from '../../ui/lib/historyPool';
import {historyPoolReceiptScript} from '../historyPoolReceipt';

function fixture() {
  const reply=Promise.resolve('stand-in'),pool=new HistoryPool();let now=0;
  const context=vm.createContext({Map,Set,WeakMap,Headers,Request,URL,pool,
    location:{href:'http://fixture.invalid/'},performance:{now:()=>++now},reply,fetch:()=>reply});
  const run=(source:string)=>vm.runInContext(source,context,{timeout:3000});
  run('window=globalThis;');run(historyPoolReceiptScript());
  context.__quotumInspectHistoryPool(pool);
  run(`
    period={transport:{},retained:new Map(),valueCache:new Map(),bytes:0,
      get estimatedBytes(){return 0;},evictionCandidates(){return [];}};
    function chart(scope){
      const value={scope,active:false,interest:null,grids:new Map(),flights:new Set(),responses:new Map(),reservations:new Map(),
        missing:[15],badCalls:0,readCalls:0,targetCalls:0,
        target(){this.targetCalls++;return {cell:60,k0:1,k1:1};},plotTarget(){return this.target();},
        bad(){this.badCalls++;if(this.failure)throw this.failure;return this.missing;},
        get estimatedBytes(){let bytes=0;for(const tiles of this.grids.values())for(const tile of tiles.values())bytes+=tile.bytes;return bytes;},
        evictionCandidates(){this.target();return [...this.grids].flatMap(([cell,tiles])=>[...tiles].map(([index,tile])=>({bytes:tile.bytes,shownAt:tile.shownAt,drop(){tiles.delete(index);}})));}
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
  const saved=receipt;
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
