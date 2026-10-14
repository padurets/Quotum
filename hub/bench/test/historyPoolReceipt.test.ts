import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {HistoryPool} from '../../ui/lib/historyPool';
import {HistoryStore} from '../../ui/lib/history';
import {PeriodTransport} from '../../ui/lib/periodTransport';
import type {PeriodScope} from '../../server/domain/periodRead';
import {Preparations} from '../../ui/lib/prepare';
import {ApiError} from '../../ui/lib/http';
import {expandHistory,tileOf,type HistoryAnswer} from '../../server/domain/history';
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

// The new controls execute the real store, tile preparation and transport; no copied cache planner.
const WATCH_CELL=7200000,WATCH_FROM=1790640000000,WATCH_TO=1791072000000;
const CONTROL_NOW=WATCH_FROM+30*86400000;
type Entry={id:number;kind:string;row:any[];values:any[]};
function actualFixture(){
  const pool=new HistoryPool(),jobs:(()=>void)[]=[],micro:(()=>void)[]=[],timers=new Map<object,()=>void>();let quantum=0,sendError:unknown=null,currentScope:PeriodScope='funds',nested:(()=>void)|null=null;
  const preparations=new Preparations({now:()=>++quantum,post:run=>jobs.push(run)});
  const sent:{body:any;resolve:(reply:any)=>void;reject:(error:unknown)=>void;done:boolean}[]=[];
  const transport=new PeriodTransport(pool,()=>({board:'synthetic',generation:1,revision:1,request:{version:1,selection:{mode:'live',periodMs:30*86400000},evaluatedAt:CONTROL_NOW}}),()=>{},(_board,body)=>new Promise((resolve,reject)=>{
    const call={body,resolve,reject,done:false};sent.push(call);
    call.done=true;if(sendError)reject(sendError);else resolve(answer(body));
  }));
  const transportSpy=transport as any,oldRead=transport.read;let originalError:unknown=null,lastTransportPromise:unknown=null,transportReceiver:unknown=null,transportArgs:unknown[]=[];
  transportSpy.read=function(...args:unknown[]){transportReceiver=this;transportArgs=args;if(originalError)throw originalError;const value=oldRead.apply(this,args as any);lastTransportPromise=value;return value;};
  const context=vm.createContext({Map,Set,WeakMap,WeakRef,Headers,Request,URL,location:{href:'http://fixture.invalid/'},performance:{now:()=>{throw Error('unexpected timing observation');}}});
  vm.runInContext('window=globalThis;',context);vm.runInContext(historyPoolCriticalReceiptScript(),context);context.__quotumInspectHistoryPool(pool);
  const period={transport,retained:new Map(),valueCache:new Map(),get estimatedBytes(){return 0;},evictionCandidates(){return [];}};pool.register(period);
  let lastEnvPromise:unknown=null,envReceiver:unknown=null;
  const make=(scope:'quota'|'budget',family:'quota'|'budget'|'funds')=>{
    const env:any={sharedTransport:true,preparations,schedule:(run:()=>void)=>micro.push(run),now:()=>CONTROL_NOW,elapsedNow:()=>0,
      setTimeout:(run:()=>void)=>{const key={};timers.set(key,run);return key;},clearTimeout:(key:object)=>timers.delete(key),dropTimeRange:()=>{throw Error('unexpected range rejection');},
      read:function(_board:string,cell:number,from:number,to:number,signal:AbortSignal,meters:any,metadata:any,owner:any,...extra:any[]){
        envReceiver=this;if(nested&&family==='funds'){const run=nested;nested=null;run();}const query={cell:String(cell),from:String(from),to:String(to),...(meters?{unit:meters.unit,meters:JSON.stringify(meters.ids)}:{})};
        const value=(transport as any).read(family==='funds'?currentScope:family,query,signal,owner,...extra).then((reply:HistoryAnswer)=>expandHistory(reply,metadata));lastEnvPromise=value;return value;
      }};
    const store=new HistoryStore(env,undefined,scope,pool);store.setActive(false);store.choose('30d',null);store.open('synthetic');store.hello('run');store.snapshot(['fund'],[],0);return store;
  };
  const quota=make('quota','quota'),funds=make('budget','funds'),budget=make('budget','budget');
  // Register funds before budget: an ordinal-based funds guess would identify the wrong store.
  funds.setMeters({unit:'USD',ids:[['fund','balance']]});
  function answer(body:any){
    const parts:any={};for(const scope of ['quota','budget','funds'])if(body[scope]){
      const query=body[scope],cell=Number(query.cell),from=Number(query.from),to=Number(query.to);
      parts[scope]={state:'complete',value:{run:'run',now:CONTROL_NOW,historyStart:0,known:{work:0,sources:{fund:0}},chunks:[{from,to,series:[],meterSeries:Array.from({length:12},(_,i)=>({source:'fund-'+i,meter:'balance',kind:'balance',unit:'USD',semantics:null,cells:[[0,'9000000','0','0',cell]]})),activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[]}]}};
    }return parts;
  }
  const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
  const step=async()=>{await flush();micro.shift()?.();jobs.shift()?.();await flush();};
  const settle=async()=>{for(let i=0;i<4000;i++){await step();if(!micro.length&&!jobs.length&&!pool.activeFlights&&!sent.some(s=>!s.done))return;}throw Error('finite real store preparation did not settle');};
  const direct=(owner:any,extra?:unknown)=>((funds as any).env.read('synthetic',WATCH_CELL,WATCH_FROM,WATCH_TO,undefined,(funds as any).meters,(funds as any).meta,owner,...(extra===undefined?[]:[extra])));
  const read=()=>context.__quotumHistoryPoolReceipt.read();
  const tile=()=>((funds as any).grids.get(WATCH_CELL)?.get(tileOf(WATCH_FROM,WATCH_CELL)));
  const close=()=>{for(const store of [quota,funds,budget])store.close();preparations.dispose();assert.equal(preparations.size,0);assert.equal(jobs.every(run=>typeof run==='function'),true);jobs.length=0;micro.length=0;assert.equal(timers.size,0);assert.equal(pool.activeFlights,0);};
  return {pool,context,quota,funds,budget,transport,preparations,jobs,sent,step,settle,direct,read,tile,close,
    nested(run:()=>void){nested=run;},fail(value:unknown){sendError=value;},scope(value:PeriodScope){currentScope=value;},error(value:unknown){originalError=value;},
    identities:()=>({lastEnvPromise,lastTransportPromise,envReceiver,transportReceiver,transportArgs})};
}
const stateRows=(receipt:any,id:number)=>receipt.entries.filter((e:Entry)=>e.kind==='watched-tile'&&e.row[0]===id) as Entry[];
const memberId=(h:ReturnType<typeof actualFixture>,scope:number)=>h.read().watched.members.find((m:any)=>m.semanticScope===scope)?.id;

test('watched actual committed tile survives same-range and live-range-live choices',async()=>{
  const h=actualFixture();try{
    h.funds.setActive(true);await h.settle();const tile=h.tile();assert.ok(tile);assert.ok(tile.writeSeq>0);assert.ok(tile.readFrom<=WATCH_FROM&&tile.readTo>=WATCH_TO&&tile.validTo>=WATCH_TO);
    const seq=tile.writeSeq,epoch=(h.funds as any).epoch,reads=h.sent.length;
    h.context.__quotumHistoryPoolReceipt.mark(0,0);
    h.funds.choose('30d',null);await h.settle();h.funds.choose('30d',{from:CONTROL_NOW-30*86400000,to:CONTROL_NOW});await h.settle();h.funds.choose('30d',null);await h.settle();
    assert.equal(h.tile(),tile);assert.equal(h.tile().writeSeq,seq);assert.equal((h.funds as any).epoch,epoch);assert.equal(h.sent.length,reads);
    h.context.__quotumHistoryPoolReceipt.mark(2,3);const receipt=h.read(),id=memberId(h,3);assert.ok(id);assert.notEqual(id,4,'actual funds scope must not depend on registration ordinal');
    assert.equal(receipt.watched.status,'observed-state-transitions');assert.equal(receipt.watched.omitted,0);assert.equal(JSON.stringify(safeEvidence(receipt.watched)),JSON.stringify(receipt.watched));
    assert.ok(stateRows(receipt,id).some(e=>e.row[6]===true&&e.row[8]>0&&e.row[9]<=WATCH_FROM&&e.row[10]>=WATCH_TO&&e.row[11]>=WATCH_TO));
  }finally{h.close();}
});

test('watched real history_limit clears a committed tile without candidate drop',async()=>{
  const h=actualFixture();try{
    h.funds.setActive(true);await h.settle();assert.ok(h.tile()?.writeSeq>0);h.context.__quotumHistoryPoolReceipt.mark(0,0);const id=memberId(h,3);assert.ok(id);
    h.fail(new ApiError(413,'history_limit'));h.funds.news(WATCH_FROM);await h.settle();h.context.__quotumHistoryPoolReceipt.mark(2,3);const receipt=h.read();
    assert.equal(h.tile(),undefined);assert.equal((h.funds as any).historyLimit,true);assert.equal(receipt.entries.filter((e:Entry)=>e.kind==='drop-after').length,0);
    const cleared=stateRows(receipt,id).find(e=>e.row[1]===7&&e.row[5]===true&&e.row[6]===false&&e.values[2]===true);assert.ok(cleared,'real limit method clears the actual prior committed tile');
  }finally{h.close();}
});

test('watched pending cancelled real preparation never becomes a committed seed',async()=>{
  const h=actualFixture();try{
    h.funds.setActive(true);
    for(let i=0;i<60&&!h.jobs.length;i++)await h.step();
    assert.ok(h.sent.length,'the real transport must start');assert.ok(h.preparations.size>0,'an actual preparation remains pending');
    h.funds.setActive(false);await h.settle();h.context.__quotumHistoryPoolReceipt.mark(0,0);const receipt=h.read(),id=memberId(h,3);assert.ok(id);
    assert.ok(!h.tile()||h.tile().writeSeq===0);assert.ok(!stateRows(receipt,id).some(e=>e.row[6]===true&&e.row[8]>0));
  }finally{h.close();}
});

test('watched scope is unknown before actual handoff and conflicts remain unqualified',async()=>{
  const h=actualFixture();try{
    const before=h.read();assert.ok(before.watched.members.every((m:any)=>m.semanticScope===0));
    const unknown=h.direct(undefined);await h.settle();await unknown;const unqualified=h.read();assert.ok(unqualified.watched.members.every((m:any)=>m.semanticScope===0));assert.equal(unqualified.entries.filter((e:Entry)=>e.kind==='watched-read-scope').length,0);
    const unknownRow=unqualified.entries.find((e:Entry)=>e.kind==='watched-tile'&&e.row[0]===3);assert.ok(unknownRow);assert.equal(unknownRow.row[3],0);
    h.funds.setActive(true);await h.settle();h.funds.setActive(false);h.scope('budget');
    const owner={finished:Promise.resolve(),role:()=>'visible',cancel:()=>{}};const result=h.direct(owner);assert.equal(result,h.identities().lastEnvPromise);await h.settle();await result;
    const receipt=h.read();assert.ok(receipt.watched.members.some((m:any)=>m.semanticScope===4));
    const conflict=receipt.entries.find((e:Entry)=>e.kind==='watched-read-scope'&&e.row[3]===4);assert.ok(conflict);assert.equal(conflict.row[2],2);assert.equal(unknownRow.row[3],0,'later family evidence cannot rewrite an earlier unknown handoff');
  }finally{h.close();}
});

test('watched original receivers, extra arguments, Promise and error identities survive',async()=>{
  const h=actualFixture();try{
    const owner={finished:Promise.resolve(),role:()=>'visible',cancel:()=>{}},extra={marker:1};const value=h.direct(owner,extra);
    assert.equal(value,h.identities().lastEnvPromise);assert.equal(h.identities().envReceiver,(h.funds as any).env);assert.equal(h.identities().transportReceiver,h.transport);assert.equal(h.identities().transportArgs[4],extra);
    await h.settle();await value;
    const error=new Error('original');h.error(error);assert.throws(()=>h.direct(owner),e=>e===error);h.error(null);
    const before=h.read(),own=before.watched.members.find((m:any)=>m.semanticScope===3).id;
    const oldEpoch=(h.budget as any).epoch;(h.funds as any).setMeters.call(h.budget,{unit:'USD',ids:[['peer','balance']]});
    assert.ok((h.budget as any).epoch>oldEpoch);const after=h.read();assert.ok(after.watched.errors>before.watched.errors);assert.equal(after.watched.status,'insufficient-evidence');
    assert.ok(!after.entries.slice(before.entries.length).some((e:Entry)=>e.kind==='watched-tile'&&e.row[0]===own&&e.row[1]===4),'foreign receiver must not create a funds setter reason');
    Object.defineProperty(h.funds,'historyLimit',{configurable:true,get(){throw error;}});assert.equal(h.funds.hello('getter-test'),undefined);const promise=h.direct(owner);assert.equal(promise,h.identities().lastEnvPromise);Object.defineProperty(h.funds,'historyLimit',{configurable:true,writable:true,value:false});await h.settle();await promise;assert.ok(h.read().watched.errors>after.watched.errors);
  }finally{h.close();}
});

test('watched entry-byte saturation is explicit even below its own row cap',async()=>{
  const h=actualFixture();try{
    const q=h.quota as any,target={cell:WATCH_CELL,k0:0,k1:0};
    // Real bad() and the existing snapshots fill entryByteLimit; no watched mutation is fabricated.
    for(let i=0;i<1000;i++)q.bad(target);
    const before=h.read();assert.ok(before.omitted>0);assert.equal(before.watched.omitted,0);assert.ok(before.watched.changes<64);
    h.funds.hello('next-run');const after=h.read();assert.ok(after.watched.omitted>0);assert.equal(after.watched.status,'insufficient-evidence');assert.ok(after.watched.changes<64);
  }finally{h.close();}
});


test('watched nested actual env reads restore the outer owner and query context',async()=>{
  const h=actualFixture();try{
    const innerOwner={finished:Promise.resolve(),role:()=>'visible',cancel:()=>{}},outerOwner={finished:Promise.resolve(),role:()=>'visible',cancel:()=>{}};let inner:Promise<unknown>|null=null;
    h.nested(()=>{inner=(h.budget as any).env.read('synthetic',WATCH_CELL,WATCH_FROM+WATCH_CELL,WATCH_TO,undefined,undefined,undefined,innerOwner);});
    const outer=h.direct(outerOwner);await h.settle();await inner;await outer;
    const rows=h.read().entries.filter((e:Entry)=>e.kind==='watched-read-scope');assert.equal(rows.length,2);assert.equal(rows[0].row[2],2);assert.equal(rows[1].row[2],3);assert.notEqual(rows[0].row[0],rows[1].row[0]);assert.notEqual(rows[0].row[7],rows[1].row[7]);assert.equal(rows[0].row[5],WATCH_FROM+WATCH_CELL);assert.equal(rows[1].row[5],WATCH_FROM);assert.ok(rows[0].row[1]>rows[1].row[1]);
  }finally{h.close();}
});

test('watched absence after an unhooked real not_found clear is only an observation',async()=>{
  const h=actualFixture();try{
    h.funds.setActive(true);await h.settle();assert.ok(h.tile()?.writeSeq>0);h.context.__quotumHistoryPoolReceipt.mark(0,0);const id=memberId(h,3);assert.ok(id);
    h.fail(new ApiError(404,'not_found'));h.funds.news(WATCH_FROM);await h.settle();h.context.__quotumHistoryPoolReceipt.mark(2,3);const receipt=h.read(),rows=stateRows(receipt,id);
    assert.equal(h.tile(),undefined);assert.equal((h.funds as any).historyLimit,false);assert.ok(rows.some(e=>e.row[6]===true&&e.row[8]>0));assert.ok(rows.some(e=>e.row[1]===0&&e.row[6]===false));assert.equal(receipt.watched.publicationTimestampObserved,false);assert.equal(receipt.watched.unobservedPublicationOrClearPossible,true);assert.equal(receipt.watched.CausalPass,false);
  }finally{h.close();}
});
