import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PeriodIndex} from '../lib/periodIndex';
import {packSamples,retainSamplesPrepared,sampleCount} from '../../server/domain/periodTape';
import {drain} from '../lib/prepare';
import {spentOf} from '../lib/forecast';
import {num} from '../lib/format';
import {setLocale,t} from '../i18n';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import type {Line} from '../lib/lines';
import type {TimedCell} from '../components/TableCell';

test('spending reads keep exact prefix totals without decoding availability or reading work',context=>{
  const observations=[
    {at:.125,used:10.1,resetAt:null,staleAfterMs:1000},
    {at:100.125,used:10.2,resetAt:200.125,staleAfterMs:1000},
    {at:200.125,used:0,resetAt:400.125,staleAfterMs:1000},
    {at:300.125,used:0,resetAt:400.125,staleAfterMs:1000},
  ];
  const work={anchor:0,knownFrom:17,cut:1000,refs:[{ref:'r',source:'s',device:{id:'d',name:'D'},origin:'terminal' as const,project:null,folder:null,startedAt:0}],spans:[[0,17,1000] as [number,number,number]]};
  for(const samples of [packSamples(observations),new Float64Array(packSamples(observations)),drain(retainSamplesPrepared(packSamples(observations)))]){
    const curves=new PeriodIndex(work).curves,curve=curves.groups.source.get('s')!;
    const accounting=new PeriodAccounting({from:0,cut:1000,replaceFrom:0,cursor:'c',money:[],quota:[{source:'s',window:'w',samples}]},work,curves);
    for(const range of [{from:0,to:100.125},{from:.125,to:200.125},{from:100.125,to:400.125},{from:200.125,to:400.125},{from:1000,to:2000}]){
      const full=accounting.quotaSummary('s','w',range)!;
      assert.deepEqual(accounting.quotaSpendingSummary('s','w',range),{consumed:full.consumed,coveredMs:full.coveredMs});
    }
    let reads=0;const read=curve.read.bind(curve);
    context.mock.method(curve,'read',(...args:Parameters<typeof read>)=>{reads++;return read(...args);});
    accounting.quotaSummary('s','w',{from:17,to:1000});assert.equal(reads,2);reads=0;
    let decoded=0;
    if('columns' in samples){const used=samples.columns[1];Object.defineProperty(samples.columns,1,{get(){decoded++;return used;}});}
    assert.deepEqual(accounting.quotaSpendingSummary('s','w',{from:200.125,to:400.125}),{consumed:0,coveredMs:100});
    assert.equal(reads,0);assert.equal(decoded,0);
    assert.equal(accounting.quotaSpendingSummary('missing','w',{from:0,to:1000}),undefined);
  }
});

test('selected work cannot reuse a supplier curve across a different knowledge boundary',()=>{
  const work={anchor:0,knownFrom:17,cut:1000,refs:[{ref:'r',source:'s',device:{id:'d',name:'D'},origin:'terminal' as const,project:null,folder:null,startedAt:0}],spans:[[0,17,1000] as [number,number,number]]};
  const curves=new PeriodIndex(work).curves;
  const tape={from:0,cut:1000,replaceFrom:0,cursor:'c',money:[],quota:[{source:'s',window:'w',samples:packSamples([{at:0,used:10,resetAt:null,staleAfterMs:2000},{at:1000,used:20,resetAt:null,staleAfterMs:2000}])}]};
  const supplier={groups:{source:curves.groups.source},knownFrom:17,available:true};
  const accounting=drain(PeriodAccounting.prepare(tape,{...work,knownFrom:500},curves,undefined,undefined,undefined,supplier));
  const value=accounting.quotaSummary('s','w',{from:0,to:1000})!;
  assert.equal(value.work!.ms,983);assert.equal(value.work!.agentMs,983);
  assert.deepEqual(value.selectedWork,{from:500,ms:500,agentMs:500});
});

const source=readFileSync(new URL('../components/Forecast.tsx',import.meta.url),'utf8');
const first=source.indexOf('    const lineAt='),last=source.indexOf('    const rangeCells=',first);
const cellStart=source.indexOf('      spent: {time:'),cellEnd=source.indexOf('\n      forecast:',cellStart);
const textStart=source.indexOf('const spentText ='),textEnd=source.indexOf('\n',textStart);
assert.ok(first>=0&&last>first&&cellStart>last&&cellEnd>cellStart&&textStart>=0);
const cellContext={exports:{} as {make:(boardPeriod:any,line:Line,history:{range:string},range?:boolean)=>TimedCell},spentOf,num,t};
runInNewContext(ts.transpileModule(`${source.slice(textStart,textEnd)}
export function make(boardPeriod:any,line:Line,history:any,range=false){${source.slice(first,last)}return (${source.slice(cellStart+'      spent: '.length,cellEnd).replace(/,$/,'')});}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,cellContext);
const make=cellContext.exports.make;

test('actual spending cells keep text, deadlines and captured fallbacks through live retirement',async context=>{
  context.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,clocked:true,periodName:'24h'}),period=24*H,start=NOW-period;
  const source=h.store.source('codex','d'.repeat(24),start-H);h.store.hold(source,h.alice.id,start-H);
  const base={sourceId:source,windowId:'w',consumed:777,coveredMs:0} as Line;
  const full=new Proxy(h.period,{get(target,key){const value=key==='quotaSpendingAt'?target.quotaAt:Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const check=()=>{
    for(const locale of ['en','ru'] as const){setLocale(locale,false);
      const selected=make(h.period,base,{range:'24h'}),reference=make(full,base,{range:'24h'});
      for(const at of [h.clock.hubNow(),h.clock.hubNow()+1,h.clock.hubNow()+M,h.clock.hubNow()+5*M]){
        assert.equal(selected.at(at).content,reference.at(at).content);
        assert.equal(selected.changesAt(at),reference.changesAt(at));
      }
    }
  };
  try{
    for(const at of [start+M,start+2*M,start+3*M,NOW-2*M])h.store.record(source,{observedAt:at,plan:'',resets:null,staleAfterMs:2*period,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17+(at-start)/M*.01,remaining:83-(at-start)/M*.01,resetAt:NOW+period}]});
    h.events.flush();await flush();check();
    const before=h.period.tapes.get('quota'),row=before.tape.quota.find((row:any)=>row.source===source),requests=h.requests.length;
    assert.equal(sampleCount(row.samples),4);
    assert.equal(h.period.quotaSpendingAt(base,NOW,'different-range'),base);
    const missing={...base,windowId:'missing'};assert.equal(h.period.quotaSpendingAt(missing,NOW,'24h'),missing);
    h.advance(NOW+2*M+501);await flush();check();
    assert.equal(sampleCount(h.period.tapes.get('quota').tape.quota.find((row:any)=>row.source===source).samples),3);
    assert.equal(h.requests.length,requests,'time-only retirement needs no history read');
    h.selectRange({from:NOW-period,to:NOW});await flush();
    assert.equal(h.period.quotaSpendingAt(base,NOW),base,'fixed accounting retains its captured line');
    const fixed=make({quotaSpendingAt:()=>{throw new Error('fixed cell read live accounting');}},base,{range:'fixed'},true);
    assert.equal(fixed.at(NOW).content,t('table.points',{value:num(777,1)}));
  }finally{setLocale('en',false);await h.close();}
  assert.equal(h.period.quotaSpendingAt(base,NOW),base,'a closed board retains no live accounting');
});
