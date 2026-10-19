import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodTransport,fetchPeriod,type PeriodIntent} from '../lib/periodTransport';
import {HistoryPool} from '../lib/historyPool';
import {encodeSamples} from '../../server/domain/periodTape';
import type {PeriodReply} from '../../server/domain/periodRead';

const basis={run:'r',revision:'1',evaluatedAt:10_000_000,evidenceCut:10_000_000,range:{from:0,to:10_000_000}};
const query={cell:'1',from:'0',to:'10000000'};
const samples=encodeSamples(Array.from({length:10_000},(_,i)=>({at:i*1000,used:50+i%2,resetAt:null,staleAfterMs:300_000})));
const flush=async()=>{for(let i=0;i<150;i++)await Promise.resolve();await new Promise(resolve=>setTimeout(resolve,10));};
const until=async(check:()=>unknown)=>{for(let i=0;i<150;i++){await flush();if(check())return;}throw new Error('native ownership did not settle');};

async function fixture(t:TestContext,headroom?:number,hold=false){
  const pool=new HistoryPool();let generation=1,calls=0,pinned=0,release!:()=>void,finish:(()=>void)|undefined;
  let original:PeriodReply|undefined,late:PeriodReply|undefined,charged=0;
  pool.register({get estimatedBytes(){return pinned;},evictionCandidates:()=>[]});
  const reply=(large=false):PeriodReply=>({basis,quota:{state:'complete',basis,value:{now:basis.evaluatedAt,run:'r',meta:'m',chunks:[],tape:{cursor:large?'c2':'c1',from:0,cut:basis.evaluatedAt,replaceFrom:0,
    quota:large?[{source:'claude:a',window:'w',samplesEncoding:'delta',samples}]:[],money:[],...(large?{fixed:{range:basis.range,cell:1,money:[],quota:[{sourceId:'claude:a',windowId:'w',consumed:0,coveredMs:0,remainingAtStart:50,remainingAtEnd:50,staleAfterMs:300_000,points:[],work:null,selectedWork:{from:0,ms:1,agentMs:1}}]}}:{})}}}});
  t.mock.method(globalThis,'fetch',async()=>{const call=++calls;if(call===2)await new Promise<void>(resolve=>{release=resolve;});return new Response(JSON.stringify(reply(call===2)),{headers:{'content-type':'application/json'}});});
  const intent=():PeriodIntent=>({board:'b',generation,revision:generation,resourceGeneration:1,request:{version:1,selection:{mode:'range',...basis.range},evaluatedAt:basis.evaluatedAt,quota:query}});
  const transport=new PeriodTransport(pool,intent,async(value,_intent,reserve)=>{
    if(value.quota?.state!=='complete'||value.quota.value.tape?.cursor!=='c2')return;
    late=value;if(hold){assert.equal(reserve!(4096),true);await new Promise<void>(resolve=>{finish=resolve;});}
  },async(board,body,signal,reserve)=>{const value=await fetchPeriod(board,body,signal,reserve);if(calls===2){original=value;charged=pool.estimatedBytes;if(headroom!==undefined)pinned=pool.budget-charged-headroom;}return value;});
  t.after(async()=>{pinned=0;transport.reset();release?.();finish?.();await flush();});
  transport.change();await until(()=>calls===1&&pool.activeFlights===0);
  generation=2;const drawing=transport.read('quota',query).then(value=>({value}),error=>({error}));transport.change();await until(()=>release);
  generation=3;transport.change();await flush();release();
  return {pool,transport,drawing,settled:()=>until(()=>!!late),original:()=>original!,late:()=>late!,charged:()=>charged,finish:()=>finish?.()};
}

test('a late native view shares numeric evidence and leaves the captured chart reply intact',async t=>{
  const h=await fixture(t);await h.settled();const result=await h.drawing;
  const original=h.original().quota!,late=h.late().quota!;assert.equal(original.state,'complete');assert.equal(late.state,'complete');
  if(original.state!=='complete'||late.state!=='complete')throw new Error('missing native evidence');
  assert.equal(late.value.tape!.quota,original.value.tape!.quota,'the native sample arrays are borrowed, not serialized into another copy');
  assert.equal(late.value.tape!.fixed!.quota[0].selectedWork,undefined);
  assert.deepEqual(original.value.tape!.fixed!.quota[0].selectedWork,{from:0,ms:1,agentMs:1});
  assert.ok('value' in result);assert.equal(result.value.chunks,original.value.chunks);
});

test('a late native view refuses metadata growth before entering its recipient when the pool is pinned',async t=>{
  const h=await fixture(t,16),result=await h.drawing;
  assert.ok('error' in result);assert.equal(result.error.code,'history_limit');assert.equal(h.late(),undefined);
});

test('a cancelled late native preparation keeps the original reservation until its recipient settles',async t=>{
  const h=await fixture(t,undefined,true);await h.settled();
  assert.ok(h.pool.estimatedBytes>=h.charged()+4096,'the captured decoded reply remains owned beside recipient staging');
  h.transport.reset();assert.ok(h.pool.estimatedBytes>=h.charged()+4096);
  h.finish();const result=await h.drawing;await flush();
  assert.ok('error' in result);assert.equal(result.error.name,'AbortError');assert.equal(h.pool.estimatedBytes,0);
});
