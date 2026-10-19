import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {HistoryStore,type HistoryEnv} from '../lib/history';
import {HistoryPool} from '../lib/historyPool';
import {PeriodTransport,type PeriodIntent} from '../lib/periodTransport';
import {expandHistory,tileEnd,tileOf,type Chunk} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodRequest,type PeriodReply} from '../../server/domain/periodRead';

const M=60_000,H=60*M,NOW=Date.parse('2026-09-26T12:23:00Z');
const flush=async()=>{for(let i=0;i<180;i++)await Promise.resolve();};
const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');
const readLine=source.split('\n').find(line=>line.trimStart().startsWith('read:'));assert.ok(readLine);

/** Actual readers and the production adapter share a pool; only HTTP and time stand still. */
async function fixture(holdPreparation=false){
  const pool=new HistoryPool();let closed=false,generation=1,finish:(()=>void)|undefined;
  const basis={run:'run',revision:'1',evaluatedAt:NOW,evidenceCut:NOW,range:{from:NOW-H,to:NOW}};
  const query={cell:String(M),from:String(NOW-H),to:String(NOW)};
  type Send={body:PeriodRequest;signal:AbortSignal;settled:boolean;answer():void;fail():void};
  const sends:Send[]=[];
  const intent=():PeriodIntent|null=>closed?null:({board:'b',generation,revision:generation,resourceGeneration:1,request:{version:1,selection:{mode:'range',...basis.range},evaluatedAt:NOW,quota:query}});
  const transport=new PeriodTransport(pool,intent,async(_reply,captured)=>{if(holdPreparation&&captured.generation===3)await new Promise<void>(resolve=>{finish=resolve;});},async(_board,body,signal)=>new Promise((resolve,reject)=>{
    const ordinal=sends.length;
    sends.push({body,signal,settled:false,answer(){
      this.settled=true;const reply:PeriodReply={basis};
      for(const scope of PERIOD_SCOPES){
        const part=body[scope];if(!part)continue;const cell=Number(part.cell),from=Number(part.from),to=Number(part.to),chunks:Chunk[]=[];
        for(let at=from;at<to;){const end=Math.min(to,tileEnd(tileOf(at,cell),cell));chunks.push({from:at,to:end,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[]});at=end;}
        reply[scope]={state:'complete',basis,value:{run:'run',now:NOW,historyStart:0,known:{work:0,sources:{s:0}},chunks,meta:'m',tape:{cursor:'c'+ordinal,from,cut:to,replaceFrom:from,quota:[],money:[]}}};
      }
      resolve(reply);
    },fail(){this.settled=true;reject(new Error('offline'));}});
  }));
  const reader=(scope:'quota'|'budget')=>{
    const context={read:null as unknown as HistoryEnv['read'],boardPeriod:{transport},scope,family:'budget',pan:{get:()=>null},expandHistory};
    runInNewContext(ts.transpileModule('globalThis.read=({'+readLine+'}).read;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
    return new HistoryStore({read:context.read,now:()=>NOW,preparations:null,setTimeout:()=>({}),clearTimeout:()=>{},dropTimeRange:()=>{}},undefined,scope,pool);
  };
  const quota=reader('quota'),budget=reader('budget');
  const start=async(store:HistoryStore)=>{store.choose('1h',{from:NOW-H,to:NOW-5*M});store.open('b');store.hello('run');store.snapshot(['s'],['s w']);await flush();};
  const active=()=>sends.filter(row=>!row.settled&&!row.signal.aborted);
  const close=async()=>{closed=true;quota.close();budget.close();transport.reset();finish?.();for(const send of sends)if(!send.settled)send.answer();await flush();};
  try{
    transport.change();await flush();sends[0].answer();await flush();assert.equal(pool.activeFlights,0);
    generation=2;quota.setWorkFilter('A');await start(quota);transport.change();await flush();
    const old=active()[0];assert.ok(old);assert.equal(pool.activeFlights,1);
    generation=3;quota.setWorkFilter('B');transport.change();await flush();
    return {pool,transport,quota,budget,start,active,old,sends,finish:()=>finish?.(),preparing:()=>!!finish,close};
  }catch(error){await close();throw error;}
}

for(const outcome of ['reply','failure'] as const)test(`a coalesced native HTTP keeps its borrowed slot through ${outcome} across a work edit and another reader`,async()=>{
  const h=await fixture();
  try{
    await h.start(h.budget);assert.equal(h.old.signal.aborted,false,'current native evidence remains useful');
    assert.ok(h.active().length<=2,'the retained response and new reads share the same two slots');
    assert.equal(h.pool.activeFlights,2);
    if(outcome==='reply')h.old.answer();else h.old.fail();await flush();assert.ok(h.active().length<=2);
    for(let i=0;h.active().length;i++){assert.ok(i<20);for(const send of h.active())send.answer();await flush();assert.ok(h.active().length<=2);}
    assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,h.quota.estimatedBytes+h.budget.estimatedBytes);
    assert.equal(h.quota.get().error,undefined);assert.equal(h.budget.get().error,undefined);
  }finally{await h.close();assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,0);}
});

test('reset keeps a cancelled borrowed slot until the late recipient settles',async()=>{
  const h=await fixture(true);
  try{
    h.old.answer();await flush();assert.equal(h.preparing(),true);
    h.quota.close();h.transport.reset();assert.equal(h.pool.activeFlights,1,'recipient preparation still owns the borrowed transport');
    h.finish();await flush();assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,0);
  }finally{await h.close();}
});
