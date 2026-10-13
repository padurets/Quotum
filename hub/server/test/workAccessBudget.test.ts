import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {centralFixture,at} from './centralFixture.js';
import {HistoryTiles,HistoryLimit} from '../history.js';
import {Events} from '../events.js';
import {PeriodReader} from '../periodRead.js';
import {readHistory,ReadError} from '../historyRead.js';
import {Store} from '../store/store.js';
import {PeriodAccounting} from '../domain/periodAccounting.js';
const M=60_000,H=60*M;

async function fixture(t:TestContext,ceiling?:number,devices=1){
 t.mock.method(Date,'now',()=>at+2*H);const h=await centralFixture(),events=new Events(h.hub,undefined,{now:()=>at+2*H,after:()=>()=>{}},null),tiles=new HistoryTiles(h.store,ceiling),period=new PeriodReader(h.hub,tiles,events);
 t.after(async()=>{events.close();await h.app.close();h.store.close();});
 const source=h.store.source('codex','a'.repeat(24),at-M);h.store.hold(source,h.owner.id,at-M);h.store.share(h.board,source,h.owner.id,at-M);
 h.store.record(source,{observedAt:at+15*M,plan:'',staleAfterMs:H,resets:null,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:10,remaining:90,resetAt:at+3*H}]});
 h.store.creditWork(h.device.id,at+10*M,at+20*M,[{source,client:'codex',origin:'terminal',project:'P',folder:'',startedAt:at,identity:{kind:'stable',sessionId:'b'.repeat(32)}}]);
 for(let i=1;i<devices;i++)h.directory.saveDevice({userId:h.owner.id,machine:{id:'extra-machine-'+i,name:'Saved '+i,os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},at-M);
 const calls:boolean[]=[],capture=h.store.workAccess.bind(h.store);t.mock.method(h.store,'workAccess',(...args:Parameters<Store['workAccess']>)=>{calls.push(!!args[2]);return capture(...args);});
 const quota={cell:String(M),from:String(at),to:String(at+H)},body={version:1,selection:{mode:'live',periodMs:2*H},evaluatedAt:at+2*H,sessions:{},quota};
 return {...h,events,tiles,period,source,calls,quota,body};
}

test('composite quota, closed tile keys, metadata and tape share one reserved access snapshot',async t=>{
 const h=await fixture(t);let cells=0;const read=h.store.cells.bind(h.store);t.mock.method(h.store,'cells',(...args:Parameters<Store['cells']>)=>{cells++;return read(...args);});
 for(let i=0;i<2;i++){h.calls.length=0;const reply=JSON.parse(h.period.read(h.board,h.owner.id,h.body));assert.equal(reply.sessions.state,'complete');assert.equal(reply.quota.state,'complete');assert.deepEqual(h.calls,[true],'closed cache hits and misses reuse exactly the captured reserved map');}
 assert.equal(cells,1,'the second read remains a closed tile hit');
 h.calls.length=0;const standalone=JSON.parse(readHistory(h.hub,h.tiles,h.events,h.board,h.owner.id,h.quota));assert.ok(standalone.known.sessions!==null);assert.deepEqual(h.calls,[true],'standalone metadata and cells share their bounded capture');
});

test('a failed work capture errors every dependent section without fallback allocation and releases independent siblings',async t=>{
 const h=await fixture(t,5000,101),budget={...h.quota,unit:'USD',meters:'[]'};
 const reply=JSON.parse(h.period.read(h.board,h.owner.id,{...h.body,quota:{...h.quota,cells:'skip'},budget}));assert.deepEqual(h.calls,[true],'failure cannot rebuild an unreserved snapshot');
 for(const scope of ['sessions','quota'])assert.deepEqual(reply[scope],{state:'error',error:'history_limit'},scope);
 assert.equal(reply.budget.state,'complete');assert.equal(JSON.parse(h.period.read(h.board,h.owner.id,{...h.body,sessions:undefined,quota:undefined,budget})).budget.state,'complete','all failed reservations release on exit');
 h.calls.length=0;assert.throws(()=>readHistory(h.hub,h.tiles,h.events,h.board,h.owner.id,h.quota),(e:unknown)=>e instanceof ReadError&&e.statusCode===413&&e.code==='history_limit');assert.deepEqual(h.calls,[true]);
 h.calls.length=0;assert.throws(()=>h.tiles.read(h.board,M,at,at+H,at+2*H,h.store.shown(h.board,[])),HistoryLimit);assert.deepEqual(h.calls,[true],'direct closed-tile reads also honor the request ceiling');
 const reservation=h.tiles.reservation();try{reservation.add(5000);}finally{reservation.close();}
});

for(const overflow of [false,true])test(`actual database changes revalidate work through a reserved current snapshot ${overflow?'and fail bounded':'before retrying a revoke'}`,async t=>{
 const ceiling=overflow?10_000:32*1024*1024,h=await fixture(t,ceiling),original=PeriodAccounting.prepare;let changes=0;
 t.mock.method(PeriodAccounting,'prepare',function*(...args:Parameters<typeof original>){
   if(changes++===0)setImmediate(()=>{
     const policy=h.store.sessionDevices(h.board,h.owner.id)[0];h.store.setDeviceSessions(h.board,h.device.id,h.owner.id,false,policy.revision,at+2*H);
     if(overflow)for(let i=0;i<100;i++)h.directory.saveDevice({userId:h.owner.id,machine:{id:'late-machine-'+i,name:'Late '+i,os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},at+2*H);
   });
   const until=performance.now()+12;do{yield;}while(performance.now()<until);return yield*original(...args);
 });
 const body={...h.body,selection:{mode:'range',from:at,to:at+H},quota:{...h.quota,cells:'skip'}};
 if(overflow)await assert.rejects(h.period.readAsync(h.board,h.owner.id,body),(e:unknown)=>e instanceof ReadError&&e.statusCode===413&&e.code==='history_limit');
 else{const result=JSON.parse(await h.period.readAsync(h.board,h.owner.id,body));assert.equal(result.sessions.state,'complete');assert.deepEqual(result.sessions.value.refs,[],'revoked captured access is never reused by the current guard');}
 assert.ok(h.calls.length>=2);assert.ok(h.calls.every(Boolean),'each actual-change revalidation is bounded');const reservation=h.tiles.reservation();try{reservation.add(ceiling);}finally{reservation.close();}
});
