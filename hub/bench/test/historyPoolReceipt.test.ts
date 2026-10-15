import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {HistoryPool} from '../../ui/lib/historyPool';
import {PeriodTransport} from '../../ui/lib/periodTransport';
import {historyPoolReceiptScript} from '../historyPoolReceipt';

function fixture(realTransport=false) {
  const reply=Promise.resolve('stand-in'),pool=new HistoryPool();let now=0;
  const actualTransport=realTransport?new PeriodTransport(pool,()=>null,()=>{},async()=>{throw Error('no HTTP expected');}):null;
  const context=vm.createContext({actualTransport,Map,Set,WeakMap,Headers,Request,URL,pool,
    location:{href:'http://fixture.invalid/'},performance:{now:()=>++now},reply,fetch:()=>reply});
  const run=(source:string)=>vm.runInContext(source,context,{timeout:3000});
  run('window=globalThis;');run(historyPoolReceiptScript());
  context.__quotumInspectHistoryPool(pool);
  run(`
    transport={calls:[],read(scope,query,signal){if(this!==transport)throw transport.error;this.calls.push([scope,query,signal]);if(this.failure)throw this.failure;return reply;}};
    if(actualTransport)transport=actualTransport;
    period={transport,retained:new Map(),valueCache:new Map(),bytes:0,
      get estimatedBytes(){return 0;},evictionCandidates(){return [];}};
    function chart(scope,family=scope){
      const value={scope,active:false,interest:null,grids:new Map(),flights:new Set(),responses:new Map(),reservations:new Map(),
        missing:[15],badCalls:0,readCalls:0,targetCalls:0,
        target(){this.targetCalls++;return {cell:60,k0:1,k1:1};},plotTarget(){return this.target();},
        bad(){this.badCalls++;if(this.failure)throw this.failure;return this.missing;},
        get estimatedBytes(){let bytes=0;for(const tiles of this.grids.values())for(const tile of tiles.values())bytes+=tile.bytes;return bytes;},
        evictionCandidates(){this.target();return [...this.grids].flatMap(([cell,tiles])=>[...tiles].map(([index,tile])=>({bytes:tile.bytes,shownAt:tile.shownAt,drop(){tiles.delete(index);}})));}
      };
      const env={read(board,cell,from,to){if(this!==env)throw Error('receiver');value.readCalls++;const query={cell,from,to};return transport.read.call(value.receiver??transport,value.readScope??family,query,value.signal);}};
      value.env=env;return value;
    }
    quota=chart('quota');budget=chart('budget');funds=chart('budget','funds');
    for(const value of [period,quota,budget,funds])pool.register(value);
    flight={role:'visible'};
  `);
  return {context,pool,run,read:()=>context.__quotumHistoryPoolReceipt.read()};
}

test('late cache failures survive a full seed without changing pool or read results', async()=>{
  const h=fixture();
  h.run("for(const value of [quota,budget,funds])value.env.read('synthetic',60,0,60);pool.request(period.transport,flight,()=>{},()=>{});");
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
  assert.equal(h.context.budget.badCalls,1);assert.equal(h.context.budget.readCalls,2);
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
  assert.equal(receipt.attached,true);assert.equal(receipt.registrationOrderQualified,false,'no transport call has yet been observed');
  assert.equal(receipt.lastCheckpoint,false);assert.equal(receipt.status,'insufficient-evidence');
});


test('actual synchronous binding qualifies all families without a production Env flag',()=>{
 const h=fixture();
 h.run(`
  query={secret:'do-not-record'};signal={secret:'do-not-record'};
  originalTransport=period.transport.read;
  sameResults=[quota,budget,funds].map(value=>value.env.read('secret-board',60,0,60)===reply);
  __quotumHistoryPoolReceipt.mark(2,3);
 `);
 assert.deepEqual(Array.from(h.context.sameResults),[true,true,true]);
 const receipt=h.read();assert.equal(receipt.status,'complete');
 assert.deepEqual(JSON.parse(JSON.stringify(receipt.members.slice(1).map((m:{transportBound:boolean;transportScope:string|null;bindingMismatch:boolean})=>[m.transportBound,m.transportScope,m.bindingMismatch]))),[[true,'quota',false],[true,'budget',false],[true,'funds',false]]);
 assert.equal(h.context.budget.env.sharedTransport,undefined);
 const json=JSON.stringify(receipt);assert.ok(!json.includes('secret-board'));assert.ok(!json.includes('do-not-record'));
});

for(const wrong of ['wrongscope','unbound','wrongreceiver','latercorrect'])test(`binding control ${wrong} cannot mark a receipt complete`,()=>{
 const h=fixture();
 h.run(`for(const value of [quota,funds])value.env.read('synthetic',60,0,60);`);
 if(wrong==='wrongscope')h.run(`budget.readScope='not-a-public-scope';budget.env.read('synthetic',60,0,60);`);
 if(wrong==='unbound')h.run(`budget.env.read=()=>reply;budget.env.read();`);
 if(wrong==='wrongreceiver')h.run(`transport.error=new Error('receiver identity');budget.receiver={};try{budget.env.read('synthetic',60,0,60);}catch(error){sameReceiverError=error===transport.error;}`);
 if(wrong==='latercorrect')h.run(`budget.readScope='quota';budget.env.read('synthetic',60,0,60);budget.readScope='budget';budget.env.read('synthetic',60,0,60);`);
 h.run(`__quotumHistoryPoolReceipt.mark(2,3);`);
 const receipt=h.read();assert.equal(receipt.status,'insufficient-evidence');assert.equal(receipt.registrationOrderQualified,false);
 if(wrong==='wrongreceiver')assert.equal(h.context.sameReceiverError,true);
 assert.ok(!JSON.stringify(receipt).includes('not-a-public-scope'));
 assert.ok(!JSON.stringify(receipt).includes('do-not-record'));
});

test('both reader and transport preserve their original Promise, arguments, receiver and thrown error',()=>{
 const h=fixture();
 h.run(`
  preserved=budget.env.read('synthetic',60,11,22)===reply;
  transportArgumentIdentity=transport.calls.at(-1)[1];query={secret:'do-not-record'};signal={secret:'do-not-record'};directResult=period.transport.read('quota',query,signal)===reply;exactArguments=transport.calls.at(-1)[1]===query&&transport.calls.at(-1)[2]===signal;
  sameNumbers=transportArgumentIdentity.cell===60&&transportArgumentIdentity.from===11&&transportArgumentIdentity.to===22;
  original=new Error('transport original error');transport.failure=original;
  sameTransportThrow=false;try{budget.env.read('synthetic',60,0,60);}catch(error){sameTransportThrow=error===original;}
  transport.failure=null;transport.error=new Error('transport receiver error');
  sameDirectReceiverThrow=false;try{period.transport.read.call({},'quota',{},null);}catch(error){sameDirectReceiverThrow=error===transport.error;}
  sameReaderReceiverThrow=false;try{budget.env.read.call({},'synthetic',60,0,60);}catch(error){sameReaderReceiverThrow=error.message==='receiver';}
 `);
 for(const key of ['preserved','sameNumbers','directResult','exactArguments','sameTransportThrow','sameDirectReceiverThrow','sameReaderReceiverThrow'])assert.equal(h.context[key],true,key);
});


test('current production PeriodTransport binds quota, wallet and subscription funds without Env flags',async()=>{
 const h=fixture(true),controller=new AbortController();
 h.context.signal=controller.signal;
 h.run(`for(const value of [quota,budget,funds])value.signal=signal;actualResults=[quota,budget,funds].map(value=>value.env.read('synthetic',60,0,60));__quotumHistoryPoolReceipt.mark(2,3);`);
 const settled=Promise.allSettled(Array.from(h.context.actualResults));
 const receipt=h.read();assert.equal(receipt.status,'complete');assert.equal(receipt.registrationOrderQualified,true);
 assert.deepEqual(JSON.parse(JSON.stringify(receipt.members.slice(1).map((m:{transportScope:string|null})=>m.transportScope))),['quota','budget','funds']);
 assert.equal(h.context.transport.queue.length,3);
 controller.abort();await settled;assert.equal(h.context.transport.queue.length,0);
});
