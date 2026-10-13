import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PageClock} from '../lib/clock';
import {workHours} from '../lib/format';
import {periodTextChangesAt} from '../lib/periodClock';
import {lineWork,workText,workLeftChangesAt,WORK_COLUMNS,type WorkColumn} from '../lib/work';
import {formatLocale,setLocale} from '../i18n';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import {evaluatedRange,periodKey} from '../../server/domain/period';
import {packWorkPrepared,workPreparationBytes,mergeWorkPrepared} from '../../server/domain/periodWork';
import {packSamples,retainSamplesPrepared,sampleBytes,mergeTapePrepared} from '../../server/domain/periodTape';
import {drain} from '../lib/prepare';
import * as retention from '../../server/domain/periodRetention';
import {fixture,flush,NOW,H} from './periodRuntimeFixture';
import type {Cell,TimedCell} from '../components/AnalyticsTable';
import type {Line} from '../lib/lines';

const code=(file:string)=>readFileSync(new URL(file,import.meta.url),'utf8');
const compile=(body:string)=>ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const region=(body:string,from:string,to:string)=>body.slice(body.indexOf(from),body.indexOf(to,body.indexOf(from)));
const cellSource=region(code('../components/Forecast.tsx'),'    const lineAt=','    const workCells:');
const hookSource=code('../lib/clock.ts').slice(code('../lib/clock.ts').indexOf('export function useClock('));
const timedSource=region(code('../components/AnalyticsTable.tsx'),'function Timed(','\nconst shown =');
const cellContext={exports:{} as {make:(period:any,line:Line,history:{range:string;since:number},column:WorkColumn,resetAt:number|null)=>TimedCell},lineWork,workText,workLeftChangesAt,formatLocale,WeakRef};
runInNewContext(compile(`export function make(boardPeriod:any,line:Line,history:any,column:WorkColumn,resetAt:number|null){const range=false;${cellSource}return timed(column);}`),cellContext);
const make=cellContext.exports.make;
const plain=(value:Cell):Cell=>JSON.parse(JSON.stringify(value));
const line=(source:string):Line=>({sourceId:source,windowId:'w',current:83,remainingAtEnd:83,work:null,minutes:10080} as Line);

/** The production hook and Timed render share persistent refs; effects wait for commit. */
function consumer(now:()=>number) {
  let cursor=0,effects:(()=>void)[]=[];
  const slots:any[]=[],dues:{now:number;at:number|null}[]=[];
  const clock=new PageClock({now,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
  const slot=(create:()=>any)=>{const at=cursor++;return slots[at]??(slots[at]=create());};
  const context={exports:{} as {Timed:(props:{cell:TimedCell;render:(shown:Cell,time:string)=>{shown:Cell;time:string}})=>{shown:Cell;time:string}},
    clock:{...clock,watch:clock.watch.bind(clock),subscribe:clock.subscribe.bind(clock),due:(_watch:unknown,at:number|null,stamp:number)=>dues.push({now:stamp,at})},hubNow:clock.hubNow,
    useState:(initial:()=>unknown)=>[slot(initial)],useRef:(current:unknown)=>slot(()=>({current})),useSyncExternalStore:(_subscribe:unknown,read:()=>number)=>{slot(()=>null);return read();},
    useLayoutEffect:(effect:()=>void)=>effects.push(effect),
  };
  runInNewContext(compile(hookSource+timedSource.replace('function Timed(','export function Timed(')),context);
  return {render(cell:TimedCell){cursor=0;effects=[];const output=context.exports.Timed({cell,render:(shown,time)=>({shown:plain(shown),time})});return {output,effects:[...effects]};},
    layout(frame:{effects:(()=>void)[]}){frame.effects.forEach(effect=>effect());return dues.at(-1)!;},dues};
}

function reference(period:any,base:Line,history:{range:string;since:number},column:WorkColumn,now:number,resetAt:number|null) {
  const fresh=make(period,base,history,column,resetAt);
  // No render precedes this planner: the production fallback reads now normally.
  const due=fresh.changesAt(now),shown=plain(make(period,base,history,column,resetAt).at(now));
  return {due,shown};
}

function reads(period:any) {
  const original=period.quotaAt.bind(period),times:number[]=[];
  period.quotaAt=(base:Line,at:number,key?:string)=>{times.push(at);return original(base,at,key);};
  return {times,clear:()=>{times.length=0;}};
}

for(const locale of ['en','ru'] as const)test(`${locale}: rendered work cells seed only their committed time and retain every future probe`,async t=>{
  t.mock.method(Date,'now',()=>NOW);setLocale(locale,false);const h=await fixture();let now=NOW;const base=line(h.source),history={range:'1h',since:NOW-H},resetAt=NOW+H;
  try {
    const read=reads(h.period);
    for(const column of WORK_COLUMNS){
      const clock=consumer(()=>now),cell=make(h.period,base,history,column,resetAt),frame=clock.render(cell);
      assert.equal(clock.dues.length,0,'render must not evaluate a deadline');assert.equal(frame.output.time,column);
      read.clear();const actual=clock.layout(frame),seeded=[...read.times];
      read.clear();const expected=reference(h.period,base,history,column,now,resetAt),unseeded=read.times.slice(0,-1);
      assert.deepEqual(frame.output.shown,expected.shown);assert.equal(actual.now,now);assert.equal(actual.at,expected.due);
      assert.deepEqual(seeded,unseeded.slice(1),'only the duplicate current-time summary is removed');
      read.clear();assert.equal(clock.layout(frame).at,expected.due);assert.deepEqual(read.times,unseeded,'effect replay follows the original planner');

      // A discarded update shares useClock.latest.current with its committed fiber.
      const kept=clock.render(cell);now+=17;clock.render(cell);read.clear();
      const afterDiscard=clock.layout(kept),discardReads=[...read.times];
      read.clear();const expectedDiscard=reference(h.period,base,history,column,now-17,resetAt),discardBaseline=read.times.slice(0,-1);
      assert.equal(afterDiscard.now,now-17);assert.equal(afterDiscard.at,expectedDiscard.due);assert.deepEqual(discardReads,discardBaseline,'another timestamp cannot seed a previous effect');

      // The hook reads latest.current: equal-time double render has the same pure Cell.
      const older=clock.render(cell),latest=clock.render(cell);assert.deepEqual(latest.output,older.output);read.clear();
      const superseded=clock.layout(older),supersededReads=[...read.times];
      read.clear();const expectedSuperseded=reference(h.period,base,history,column,now,resetAt);
      assert.equal(superseded.at,expectedSuperseded.due);
      assert.deepEqual(supersededReads,read.times.slice(1,-1),'the newest equal-time shown Cell preserves the same future probes');
      if(column==='work'){
        const translated=clock.render(cell);setLocale(locale==='en'?'ru':'en',false);read.clear();
        const afterLocale=clock.layout(translated),localeReads=[...read.times];
        read.clear();const localeExpected=reference(h.period,base,history,column,now,resetAt);
        assert.equal(afterLocale.at,localeExpected.due);assert.deepEqual(localeReads,read.times.slice(0,-1),'a language change between render and layout rejects the old text');
        assert.notDeepEqual(translated.output.shown,localeExpected.shown);setLocale(locale,false);
      }
    }
  } finally {setLocale('en',false);await h.close();}
});

/** Actual receive/preparation/reservation paths, with no direct authority mutation. */
async function reservedOwner() {
  const periodMs=24*H,now=periodMs+1,selection={mode:'live' as const,periodMs};let refuse=false,preparing=false;
  class Accounting extends PeriodAccounting {
    static *prepare(...args:Parameters<typeof PeriodAccounting.prepare>):ReturnType<typeof PeriodAccounting.prepare>{preparing=true;try{return yield*super.prepare(...args);}finally{preparing=false;}}
  }
  const context={exports:{} as {BoardPeriod:new()=>any},hubNow:()=>now,retention,historyPool:{register:()=>{},reserve:()=>!refuse||!preparing,release:()=>{}},clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},
    PeriodTransport:class{},fetchPeriod:()=>{},page:{get:()=>({})},pan:{get:()=>null},preparations:()=>null,prepareAsync:async(_owner:unknown,work:Parameters<typeof drain>[0])=>drain(work),
    evaluatedRange,periodKey,PeriodAccounting:Accounting,PeriodIndex,PeriodActivity,packWorkPrepared,workPreparationBytes,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,periodTextChangesAt,
    empty:()=>({value:null,basis:null,loading:false,error:null}),sameJson:(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),prefs:()=>({range:'24h'}),PERIOD_SCOPES:['quota','budget','funds'],noSessions:[],noValue:{}};
  runInNewContext(compile(region(code('../lib/period.ts'),'class BoardPeriod','export const boardPeriod').replace('class BoardPeriod','export class BoardPeriod')),context);
  const period=new context.exports.BoardPeriod();period.selection=selection;
  const basis={run:'r',revision:'1',evaluatedAt:now,evidenceCut:now,range:{from:1,to:now}},intent={board:'b',generation:0,revision:0,request:{version:1,selection,evaluatedAt:now}};
  const work={anchor:0,cut:now,knownFrom:0,refs:[{ref:'a',source:'s',device:{id:'d',name:'Device'},origin:'terminal',project:'Project',folder:null,startedAt:0}],spans:[[0,10_000,1_000_000]],cursor:'work'};
  await period.receive({basis,sessions:{state:'complete',basis,value:work},quota:{state:'complete',basis,value:{run:'r',now,historyStart:0,known:{work:0,sources:{}},chunks:[],tape:{from:0,cut:now,replaceFrom:0,cursor:'c',quota:[{source:'s',window:'w',samples:packSamples([{at:0,used:17,resetAt:null,staleAfterMs:0}])}],money:[]}}}},intent);
  return {period,now,periodMs,replace:async(rejected:boolean)=>{refuse=rejected;try{await period.receive({basis,sessions:{state:'complete',basis,value:{...work,refs:[],spans:[],cursor:'new'}}},intent);}finally{refuse=false;}}};
}

for(const locale of ['en','ru'] as const)for(const rejected of [false,true])test(`${locale}: a ${rejected?'refused':'successful'} quota accounting replacement between render and layout keeps the right captured owner`,async()=>{
  setLocale(locale,false);const h=await reservedOwner(),base=line('s'),history={range:'24h',since:0},resetAt=h.now+H;
  try {
    const readers=WORK_COLUMNS.map(column=>{const clock=consumer(()=>h.now),cell=make(h.period,base,history,column,resetAt);return {column,clock,frame:clock.render(cell)};});
    const entry=h.period.cellBasis('quota');await h.replace(rejected);
    assert.equal(h.period.index.trace.refs.length,0,'the real new empty work index was adopted');
    assert.equal(h.period.cellBasis('quota')===entry,rejected,'only refused quota accounting retains the prior entry');
    const read=reads(h.period);
    for(const {column,clock,frame} of readers){
      read.clear();const actual=clock.layout(frame),actualReads=[...read.times];
      read.clear();const expected=reference(h.period,base,history,column,h.now,resetAt),baseline=read.times.slice(0,-1);
      assert.equal(actual.at,expected.due);assert.deepEqual(actualReads,rejected?baseline.slice(1):baseline);
      if(rejected)assert.deepEqual(frame.output.shown,expected.shown);
      if(column==='work'){
        assert.equal(frame.output.shown.content,workHours(17*60_000));
        if(rejected){assert.equal(actual.at,h.periodMs+10_001);assert.equal(make(h.period,base,history,column,resetAt).at(actual.at!).content,workHours(16*60_000));}
        else assert.notDeepEqual(frame.output.shown,expected.shown,'successful current accounting cannot reuse stale displayed work');
      }
    }
  } finally {setLocale('en',false);}
});

for(const locale of ['en','ru'] as const)test(`${locale}: real selection reuse and clock retirement replace the work-cell basis`,async t=>{
  t.mock.method(Date,'now',()=>NOW);setLocale(locale,false);const h=await fixture();const base=line(h.source),history={range:'1h',since:NOW-H},resetAt=NOW+H;let now=NOW;
  try {
    const original=h.period.cellBasis('quota'),oldSelection=JSON.stringify(h.period.tapes.get('quota').selection),oldKey=h.period.tapes.get('quota').rangeKey;
    const clock=consumer(()=>now),cell=make(h.period,base,history,'work',resetAt),frame=clock.render(cell);
    h.selectRange({from:NOW-H+123,to:NOW-123});await flush();
    assert.notEqual(h.period.cellBasis('quota'),original);
    assert.equal(JSON.stringify((original as {selection:unknown}).selection),oldSelection);assert.equal((original as {rangeKey:string}).rangeKey,oldKey,'the published previous entry keeps its selection');
    const read=reads(h.period);read.clear();const selected=clock.layout(frame),selectedReads=[...read.times];
    read.clear();const fixedExpected=reference(h.period,base,history,'work',now,resetAt);assert.equal(selected.at,fixedExpected.due);assert.deepEqual(selectedReads,read.times.slice(0,-1));
    const fixed=h.period.cellBasis('quota');h.selectRange({from:NOW-H+300,to:NOW-300});await flush();assert.notEqual(h.period.cellBasis('quota'),fixed,'a shifted exact target replaces its entry');
    h.selectRange(null);await flush();assert.notEqual(h.period.cellBasis('quota'),original,'cached live restoration exposes a clone');
    assert.equal(JSON.stringify((original as {selection:unknown}).selection),oldSelection);assert.equal((original as {rangeKey:string}).rangeKey,oldKey);

    const before=h.period.cellBasis('quota'),beforeProjection=h.period.projectionRevision.quota;
    now=NOW+H;const retiring=clock.render(make(h.period,base,history,'work',resetAt));h.jump(now);await flush();
    assert.notEqual(h.period.cellBasis('quota'),before,'real expired work compaction replaces captured accounting');
    assert.equal(h.period.projectionRevision.quota,beforeProjection,'retirement is invisible to the drawing revision');
    read.clear();const retired=clock.layout(retiring),retiredReads=[...read.times];
    read.clear();const retiredExpected=reference(h.period,base,history,'work',now,resetAt);assert.equal(retired.at,retiredExpected.due);assert.deepEqual(retiredReads,read.times.slice(0,-1));
    assert.deepEqual(retiring.output.shown,retiredExpected.shown,'compaction changes storage rather than the displayed accounting result');
  } finally {setLocale('en',false);await h.close();}
});
