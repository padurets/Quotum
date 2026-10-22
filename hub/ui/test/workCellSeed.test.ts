import {WorkCalendar} from '../lib/workCalendar';
import {AGENT_HOURS_HEATMAP} from '../../server/domain/widgets';
import * as filterModelBindings from '../../server/domain/dataFilters';
import * as filterRuntimeBindings from '../lib/filterSelection';
import * as filterCurveBindings from '../../server/domain/periodCurves';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PageClock} from '../lib/clock';
import {workHours} from '../lib/format';
import {periodTextChangesAt} from '../lib/periodClock';
import {lineWork,workText,workLeftChangesAt,WORK_COLUMNS,type WorkColumn} from '../lib/work';
import {formatLocale,setLocale,t} from '../i18n';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import {evaluatedRange,periodKey} from '../../server/domain/period';
import {cellOf} from '../../server/domain/history';
import {packWorkPrepared,workPreparationBytes,mergeWorkPrepared} from '../../server/domain/periodWork';
import {packSamples,retainSamplesPrepared,sampleBytes,mergeTapePrepared} from '../../server/domain/periodTape';
import {drain} from '../lib/prepare';
import * as retention from '../../server/domain/periodRetention';
import {fixture,flush,NOW,H} from './periodRuntimeFixture';
import type {Cell,TimedCell} from '../components/AnalyticsTable';
import type {Line} from '../lib/lines';
import {defaultFilters} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../lib/filterSelection';

const code=(file:string)=>readFileSync(new URL(file,import.meta.url),'utf8');
const compile=(body:string)=>ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const region=(body:string,from:string,to:string)=>body.slice(body.indexOf(from),body.indexOf(to,body.indexOf(from)));
const cellSource=region(code('../components/Forecast.tsx'),'    const lineAt=','    const workCells:');
const hookSource=code('../lib/clock.ts').slice(code('../lib/clock.ts').indexOf('export function useClock('));
const timedSource=region(code('../components/TableCell.tsx'),'function Timed(','\nexport const tableCell=');
const cellContext={exports:{} as {make:(period:any,line:Line,history:{range:string;since:number},column:WorkColumn,resetAt:number|null)=>TimedCell},lineWork,workText,workLeftChangesAt,formatLocale,t,WeakRef};
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
    useMemo:(read:()=>unknown,deps:unknown[])=>{
      const memo=slot(()=>({deps:undefined as unknown[]|undefined,value:undefined as unknown}));
      if(!memo.deps||deps.length!==memo.deps.length||deps.some((value,i)=>!Object.is(value,memo.deps![i]))){memo.deps=[...deps];memo.value=read();}
      return memo.value;
    },
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

      // New evidence in a discarded update shares latest.current with its committed fiber.
      const kept=clock.render(cell);now+=17;clock.render(make(h.period,base,history,column,resetAt));read.clear();
      const afterDiscard=clock.layout(kept),discardReads=[...read.times];
      read.clear();const expectedDiscard=reference(h.period,base,history,column,now-17,resetAt),discardBaseline=read.times.slice(0,-1);
      assert.equal(afterDiscard.now,now-17);assert.equal(afterDiscard.at,expectedDiscard.due);assert.deepEqual(discardReads,discardBaseline,'another timestamp cannot seed a previous effect');

      // New evidence advances the intent; its equal-time layout render reuses the pure Cell.
      const refreshed=make(h.period,base,history,column,resetAt),older=clock.render(refreshed);read.clear();
      const latest=clock.render(refreshed);assert.deepEqual(latest.output,older.output);assert.deepEqual(read.times,[],'a layout render does not reread the displayed summary');read.clear();
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

test('pending selected work keeps the prior clock while a real filter request waits',async context=>{
  context.mock.method(Date,'now',()=>NOW);const h=await fixture(),filters=defaultFilters();
  filters.projects={mode:'include',values:['Work project']};const gate=h.hold();
  try{
    publishDataFilters(filters);h.period.changed();await flush();assert.equal(h.period.work.loading,true);
    const entry=h.period.tapes.get('quota');assert.ok(entry);
    context.mock.method(entry.accounting,'quotaSelectedWorkChangesAt',()=>{throw new Error('pending work used a stable selected clock');});
    const legacy=new Proxy(h.period,{get(target,key){const value=Reflect.get(target,key);return key==='cellChangesAt'?(...args:any[])=>{args[8]=false;return value.apply(target,args);}:typeof value==='function'?value.bind(target):value;}});
    for(const locale of ['en','ru'] as const){setLocale(locale,false);
      for(const column of ['work','agenthours'] as const){
        const cell=make(h.period,line(h.source),{range:'1h',since:NOW-H},column,NOW+H),before=make(legacy,line(h.source),{range:'1h',since:NOW-H},column,NOW+H);
        assert.deepEqual(plain(cell.at(NOW)),plain(before.at(NOW)));
        assert.equal(cell.changesAt(NOW),before.changesAt(NOW));
      }
    }
  }finally{gate.release();await flush();publishDataFilters(null,false);setLocale('en',false);await h.close();}
});

for(const locale of ['en','ru'] as const)test(`${locale}: actual work cells preserve future transitions through clock retirement`,async context=>{
  context.mock.method(Date,'now',()=>NOW);setLocale(locale,false);
  const h=await fixture({personal:true,clocked:true,creditFrom:NOW-H+17*60_000,creditTo:NOW-H+47*60_000});
  const legacy=new Proxy(h.period,{get(target,key){const value=Reflect.get(target,key);return key==='cellChangesAt'?(...args:any[])=>{args[8]=false;return value.apply(target,args);}:typeof value==='function'?value.bind(target):value;}});
  let removed=0,changes=0;
  try{
    for(const now of [NOW,NOW+17*60_000+1,NOW+47*60_000+1]){
      h.advance(now);await flush();
      for(const column of ['work','agenthours'] as const){
        const history={range:'1h',since:now-H},base=line(h.source);
        const cell=make(h.period,base,history,column,NOW+H),before=make(legacy,base,history,column,NOW+H);
        const shown=plain(cell.at(now));assert.deepEqual(shown,plain(before.at(now)));
        const due=cell.changesAt(now),oldDue=before.changesAt(now);
        if(due!==oldDue){
          assert.equal(due,null);assert.equal(oldDue,now+H);removed++;
          // Every minute and the captured work edges retain content and title.
          const probes=new Set([now+1,now+H-1,now+H,...Array.from({length:61},(_,i)=>now+i*60_000),NOW+17*60_000,NOW+47*60_000]);
          for(const at of probes)if(at>=now&&at<=now+H){assert.deepEqual(plain(before.at(at)),shown);assert.deepEqual(plain(cell.at(at)),shown);}
        }else if(due!==null&&due<now+H){
          changes++;assert.deepEqual(plain(cell.at(due-1)),shown);assert.notDeepEqual(plain(cell.at(due)),shown);
          assert.deepEqual(plain(cell.at(due)),plain(before.at(due)));
        }
      }
    }
    assert.ok(changes>0,'real selected hours cross a displayed rounding boundary');
    assert.ok(removed>0,'exhausted selected work drops only its unchanged hourly wake');
    assert.equal(h.pool.activeFlights,0);
  }finally{setLocale('en',false);await h.close();}
});

/** Actual receive/preparation/reservation paths, with no direct authority mutation. */
async function reservedOwner() {
  const periodMs=24*H,now=periodMs+1,selection={mode:'live' as const,periodMs};let refuse=false,preparing=false;
  class Accounting extends PeriodAccounting {
    static *prepare(...args:Parameters<typeof PeriodAccounting.prepare>):ReturnType<typeof PeriodAccounting.prepare>{preparing=true;try{return yield*super.prepare(...args);}finally{preparing=false;}}
  }
  const context={WorkCalendar,AGENT_HOURS_HEATMAP,exports:{} as {BoardPeriod:new()=>any},hubNow:()=>now,retention,historyPool:{register:()=>{},reserve:()=>!refuse||!preparing,release:()=>{}},clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},
    PeriodTransport:class{},fetchPeriod:()=>{},page:{get:()=>({})},pan:{get:()=>null},preparations:()=>null,prepareAsync:async(_owner:unknown,work:Parameters<typeof drain>[0])=>drain(work),
    evaluatedRange,periodKey,PeriodAccounting:Accounting,PeriodIndex,PeriodActivity,packWorkPrepared,workPreparationBytes,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,periodTextChangesAt,
    empty:()=>({value:null,basis:null,loading:false,error:null}),sameJson:(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),prefs:()=>({range:'24h'}),PERIOD_SCOPES:['quota','budget','funds'],noSessions:[],noValue:{}};
  runInNewContext(compile(region(code('../lib/period.ts'),'class BoardPeriod','export const boardPeriod').replace('class BoardPeriod','export class BoardPeriod')),Object.assign(context,filterModelBindings,filterRuntimeBindings,filterCurveBindings));
  const period=new context.exports.BoardPeriod();period.selection=selection;
  const cell=cellOf(periodMs),basis={run:'r',revision:'1',evaluatedAt:now,evidenceCut:now,range:{from:1,to:now}},intent={board:'b',generation:0,revision:0,request:{version:1,selection,evaluatedAt:now,quota:{cell:String(cell),from:'0',to:String(Math.ceil(now/cell)*cell),cells:'skip'},sessions:{}}};
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
