import * as widgets from '../../server/domain/widgets';
import {chartSeriesMuted} from '../lib/prefs';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {memo as reactMemo,type ComponentProps,type ReactElement} from 'react';
import {cards} from '../../demo/model';
import {SETS} from '../../demo/catalogue';
import {creditSnapshot} from '../../bench/credits';
import {stillSnapshot} from '../../bench/still';
import {probeScript,type Fiber} from '../../bench/probe';
import {centralFixture,at as fixtureAt} from '../../server/test/centralFixture';
import {Currencies} from '../../server/currencies/service';
import {parseBatch,toMeasurement} from '../../server/domain/ingest';
import {cellOf,cellStart,expandHistory} from '../../server/domain/history';
import {expandPeriod} from '../../server/domain/periodWire';
import {composeMeters,composeMetersPrepared,type MeterHistory} from '../../server/domain/meterHistory';
import * as providers from '../../server/domain/providers';
import * as currency from '../../server/domain/currency';
import {EMPTY_VIEW} from '../../server/domain/view';
import * as moneyView from '../lib/moneyView';
import * as money from '../lib/money';
import * as moneyTable from '../lib/moneyTable';
import {seriesFocusStyle} from '../components/seriesFocus';
import {moneySelection,fundsLegacyMuted,DEFAULT_MONEY} from '../lib/moneySelection';
import * as periods from '../lib/periods';
import {plotPathPrepared,observationRunsPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {preparationFixture} from './preparationFixture';
import type {Card,History} from '../lib/types';
import type {Line} from '../lib/lines';
import type {Chart as ChartComponent} from '../components/Chart';

const DAY=86_400_000;
type Update={amount:string;observedAt:number;now:number;series:MeterHistory;historyStart:number;ledger:number;coverage:number;bytes:number};

/** Real capture, authenticated period reads and compressed valuation anchors. */
async function creditHistory(t:TestContext) {
  const boundary=fixtureAt+DAY-300_000,quotaAt=boundary-100,cell=cellOf(DAY),from=boundary-cell;
  let now=boundary+1000,referenceReads=0;t.mock.method(Date,'now',()=>now);
  const h=await centralFixture(),board=h.directory.boards(h.owner.id)[0].id;
  const service=new Currencies(h.store,async()=>{referenceReads++;throw new Error('Unexpected reference rate request');},()=>now);
  t.after(async()=>{await service.stop();await h.app.close();h.store.close();});
  service.start();
  const source=h.store.source('codex','a'.repeat(24),from);h.store.hold(source,h.owner.id,from);
  const card=cards(SETS[0]).find(card=>card.provider==='codex'&&card.windows.length)!;
  const record=(wire:object)=>h.store.record(source,toMeasurement(parseBatch({version:1,agent:'quotum-demo/1',machine:{id:'bench-machine-0123456789',name:'Bench',os:'linux',arch:'x86_64'},sentAt:new Date(now).toISOString(),snapshots:[wire],failures:[]}).snapshots[0]));
  record(stillSnapshot(card,boundary-3_600_000,quotaAt));const windows=structuredClone(h.store.state(source).windows);
  const updates:Update[]=[];let evidence:string|undefined,meta:string|undefined;
  for(const [index,amount] of ['2500','2499','2498','2498','2498','2498'].entries()) {
    const observedAt=quotaAt-(index===0?25_000:22_000-index*2000);now=boundary+1000+index*250;
    const result=record(creditSnapshot(card,boundary-3_600_000,observedAt,amount));await service.update(source);
    assert.equal(result.accepted,true);assert.equal(result.budget,true);assert.equal(result.windows,false);
    assert.deepEqual(h.store.state(source).windows,windows,'independent late balances preserve the newer quotas');
    const response=await h.call('POST',`/api/boards/${board}/period`,{version:1,selection:{mode:'live',periodMs:DAY},evaluatedAt:now,
      funds:{cell:String(cell),from:String(from),to:String(boundary+cell),unit:'USD',currency:'USD',meters:JSON.stringify([[source,'balance:credits']]),...(evidence?{evidence}:{}),...(meta?{meta}:{})}});
    assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json());
    assert.equal(reply.funds?.state,'complete',response.body);if(reply.funds?.state!=='complete')throw new Error('Missing funds history');
    const body=reply.funds.value,answer=expandHistory(body);evidence=body.tape?.cursor;meta=body.meta;
    const series=composeMeters(answer.chunks,cell,from,now)[0];assert.ok(series);
    const last=series.points.at(-1)!;
    assert.equal(last.value,String(BigInt(amount)*40_000n));assert.equal(last.semantics?.conversion?.original.at,observedAt);
    const ledger=Number(h.store.db.prepare('SELECT count(*) n FROM readings WHERE source_id=? AND meter_id=?').get(source,'balance:credits')!.n);
    const coverage=Number(h.store.db.prepare('SELECT max(to_at) at FROM meter_spans WHERE source_id=? AND meter_id=?').get(source,'balance:credits')!.at);
    updates.push({amount,observedAt,now,series,historyStart:answer.historyStart,ledger,coverage,bytes:response.body.length});
  }
  assert.equal(referenceReads,0,'Codex capture uses its fixed rate without a network dependency');
  for(let i=3;i<updates.length;i++){assert.equal(updates[i].ledger,updates[i-1].ledger);assert.equal(updates[i].coverage-updates[i-1].coverage,2000);}
  assert.equal(updates[3].series.points.length,updates[4].series.points.length,'the second heartbeat replaces a sparse valuation tail');
  assert.ok(updates[4].bytes<updates[3].bytes);
  assert.equal(cellStart(updates[3].now,cell),updates[3].series.points.at(-1)!.at);
  const sourceCard:Card={...h.store.state(source),owners:[],stale:false,measureIntervalMs:null};
  return {source,sourceCard,cell,updates};
}

/** Only changed committed attributes produce MutationObserver records. */
class Element {
  readonly nodeType=1;
  readonly children:Element[]=[];
  constructor(readonly tagName:string,readonly className:string,readonly attributes:Record<string,string>,readonly parentElement:Element|null){parentElement?.children.push(this);}
  hasAttribute(name:string){return Object.hasOwn(this.attributes,name);}
  getAttribute(name:string){return this.attributes[name]??null;}
  private matches(selector:string){const attribute=selector.match(/^\[([\w-]+)\]$/);if(attribute)return this.hasAttribute(attribute[1]);const [tag,klass]=selector.split('.');return (!tag||this.tagName===tag)&&this.className.split(' ').includes(klass);}
  closest(selector:string):Element|null {for(let element:Element|null=this;element;element=element.parentElement)if(selector.split(',').some(part=>element!.matches(part.trim())))return element;return null;}
  querySelectorAll(selector:string):Element[]{return this.children.flatMap(child=>[...(selector.split(',').some(part=>child.matches(part.trim()))?[child]:[]),...child.querySelectorAll(selector)]);}
}
type Mutation={type:'attributes';attributeName:string;target:Element};
type Probe={reset():void;seriesChanged(source:string,last:string):number|null};
type ProbePage={performance:Performance;document:object;MutationObserver:unknown;__quotumBench:Probe;__REACT_DEVTOOLS_GLOBAL_HOOK__:{onCommitFiberRoot(id:number,root:{current:Fiber}):void}};

function observedPage() {
  let observe!:(records:Mutation[])=>void;
  const context={performance,document:{body:{},readyState:'complete',addEventListener(){}},MutationObserver:class{constructor(callback:typeof observe){observe=callback;}observe(){}disconnect(){}}} as unknown as ProbePage;
  runInNewContext(probeScript(),context);
  const section=new Element('section','analytics',{},null),svg=new Element('svg','chart',{},section),series=new Element('g','',{},svg),path=new Element('path','series',{},series);
  return {bench:context.__quotumBench,series,path,record:(record:Mutation)=>observe([record]),commitReact:()=>context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1,{current:{tag:3,flags:0,child:null,sibling:null,return:null,alternate:null,stateNode:null}})};
}
type ChartProps=ComponentProps<typeof ChartComponent>;
type Model={lines:Line[];paths:{line:string;latest?:string;observation?:string}[]};
type Drawn={value:Model|null;ready:boolean};
type SeriesProps={'data-series'?:string;'data-last'?:string;'data-observation'?:string;children:ReactElement<{d:string}>};

/** Actual parent/child preparation hooks and the JSX that publishes their series. */
function drawing(h:Awaited<ReturnType<typeof creditHistory>>,initial:Update,page:ReturnType<typeof observedPage>) {
  const outer=preparationFixture(),inner=preparationFixture();let current=initial,presentation=0;
  const history=():History=>({board:'board',range:'24h',live:true,since:current.now-DAY,to:current.now,cellMs:h.cell,historyStart:current.historyStart,series:[],meterSeries:[current.series],events:[],activity:{since:0,known:null,barMs:h.cell,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}});
  let shown=history();const sources=[h.sourceCard],prefs={money:DEFAULT_MONEY,funds:DEFAULT_MONEY,muted:{},range:'24h',horizon:'auto'};
  const Chart=()=>null;
  const memo=(read:()=>unknown,deps:unknown[])=>{const box=outer.useRef(null) as {current:{deps:unknown[];value:unknown}|null};if(!box.current||deps.some((value,i)=>!Object.is(value,box.current!.deps[i])))box.current={deps,value:read()};return box.current.value;};
  const modules:Record<string,unknown>={
    'react/jsx-runtime':jsx,react:{memo:reactMemo,useRef:outer.useRef,useMemo:memo},
    '../../server/domain/providers':providers,'../../server/domain/currency':currency,'../../server/domain/meterHistory':{composeMetersPrepared},
    '../lib/board':{useBoardId:()=> 'board',useCurrencyContext:()=>currency.defaultCurrencyContext,useNamed:()=>sources},
    '../lib/history':{useBudgetHistory:()=>({history:shown,drawing:shown,loading:false,presentation}),useBudgetHistoryPlot:()=>null,useHistoryBegins:()=>current.historyStart,fundsHistory:{retry(){}}},
    '../lib/prefs':{useChartMuted:()=>prefs.muted,chartSeriesMuted,usePref:(key:keyof typeof prefs)=>prefs[key]},'../lib/moneySelection':{moneySelection,fundsLegacyMuted},'../lib/moneyView':moneyView,'../lib/money':money,'../lib/moneyTable':moneyTable,'./seriesFocus':{useSeriesFocus:()=>{}},
    '../lib/view':{...widgets,colorOf:()=> '#fff'},'../lib/periods':periods,'../lib/timeRange':{useTimeRange:()=>null},'../lib/clock':{useClock:()=>current.now},'../lib/pan':{usePanning:()=>null},
    '../lib/axisNavigation':{axisNavigation:()=>({context:'board'})},'../i18n':{t:(key:string)=>key,useLocale:()=> 'en'},
    './prepared':{usePrepared:outer.usePrepared},'./sizing':{usePlot:()=>({plot:160,onBase(){}})},'./Chart':{Chart},
  };
  const moneySource=readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8');
  const component={exports:{} as {MoneyHistory:(props:object)=>ReactElement<{children:ReactElement[]}>},require:(name:string)=>modules[name]??{}};
  runInNewContext(ts.transpileModule(moneySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,component);
  const chartSource=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8'),start=chartSource.indexOf('  const inputs = '),region=chartSource.slice(start,chartSource.indexOf('  const model = ',start));
  const child={...inner,axis:{active:false,basis:{from:initial.now-DAY,to:initial.now,end:initial.now}},incomingLines:[] as Line[],incomingReady:false,valueAxis:undefined as ChartProps['axis'],modelContext:'',
    incomingPlans:[],incomingForecasts:[],incomingMarkers:[],incomingStrip:null,desiredFrom:initial.now-DAY,desiredTo:initial.now,desiredNow:initial.now,desiredLive:true,navigation:undefined,stepped:true,cellMs:h.cell,
    width:1240,height:160,left:76,right:12,top:12,bottom:28,clipPrepared,plotPathPrepared,observationRunsPrepared,draw:null as unknown as ()=>Drawn};
  runInNewContext(ts.transpileModule(`function draw(){${region}\nreturn prepared;}\nglobalThis.draw=draw;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,child);
  const groupStart=chartSource.indexOf('  const seriesArtwork='),groupEnd=chartSource.indexOf('  const seriesEnds=',groupStart);
  assert.ok(groupStart>=0&&groupEnd>groupStart,'the observation probe binds the actual retained series artwork');
  let keptGroup:{deps:unknown[];value:unknown}|null=null;
  const groups={seriesFocusStyle,useMemo:(read:()=>unknown,deps:unknown[])=>{if(!keptGroup||deps.some((value,i)=>!Object.is(value,keptGroup!.deps[i])))keptGroup={deps,value:read()};return keptGroup.value;},exports:{},require:(name:string)=>name==='react/jsx-runtime'?jsx:{},groups:null as unknown as (lines:Line[],paths:Model['paths'])=>ReactElement<SeriesProps>[]};
  runInNewContext(ts.transpileModule(`function groups(lines,paths){${chartSource.slice(groupStart,groupEnd)}\nreturn seriesArtwork;}\nglobalThis.groups=groups;`,{fileName:'series.tsx',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,groups);
  let pathChanges=0,observationChanges=0;
  const commit=(model:Model|null)=>{
    const props=model?groups.groups(model.lines,model.paths)[0]?.props:undefined;
    for(const name of ['data-series','data-last','data-observation'] as const){const value=props?.[name];if((value??null)===page.series.getAttribute(name))continue;if(value==null)delete page.series.attributes[name];else page.series.attributes[name]=value;if(name==='data-observation')observationChanges++;page.record({type:'attributes',attributeName:name,target:page.series});}
    const path=props?.children?.props.d;if((path??null)!==page.path.getAttribute('d')){if(path==null)delete page.path.attributes.d;else page.path.attributes.d=path;pathChanges++;page.record({type:'attributes',attributeName:'d',target:page.path});}
  };
  const render=()=>{
    outer.begin();const tree=component.exports.MoneyHistory({family:'funds',arrange:{view:EMPTY_VIEW,owner:false}});
    const chart=tree.props.children.find(node=>node?.type===Chart) as ReactElement<ChartProps>;assert.ok(chart);
    outer.commit();Object.assign(child,{incomingLines:chart.props.lines,incomingReady:chart.props.prepared,valueAxis:chart.props.axis,modelContext:chart.props.modelContext,
      desiredFrom:chart.props.from,desiredTo:chart.props.to,desiredNow:chart.props.now});child.axis.basis={from:chart.props.from,to:chart.props.to,end:chart.props.now};
    inner.begin();const result=child.draw();commit(result.value);inner.commit();return result;
  };
  const settle=()=>{for(let i=0;i<5;i++){render();outer.finish();inner.finish();}return render();};
  return {render,settle,finishParent:()=>outer.finish(),finishChart:()=>inner.finish(),replace:(update:Update)=>{current=update;shown=history();},retire:()=>{presentation++;},
    mutations:()=>({path:pathChanges,observation:observationChanges}),close:()=>{outer.scheduler.dispose();inner.scheduler.dispose();}};
}

test('equal credit heartbeats count only after their new prepared observation reaches the chart',async t=>{
  const h=await creditHistory(t),[previous,next,dropped]=h.updates.slice(3),page=observedPage(),chart=drawing(h,previous,page);
  t.after(()=>chart.close());
  const expected=(update:Update)=>`observation:${update.observedAt}:${BigInt(update.amount)*40_000n}`;
  const seen=(update:Update)=>page.bench.seriesChanged(h.source+' balance:credits',expected(update));
  const baseline=chart.settle().value!;assert.equal(baseline.paths[0].observation,expected(previous).slice('observation:'.length));
  page.bench.reset();const dBefore=page.path.getAttribute('d'),lastBefore=page.series.getAttribute('data-last'),before=chart.mutations();
  chart.replace(next);assert.equal(chart.render().value,baseline);assert.equal(seen(next),null,'a new response cannot credit an old prepared drawing');
  page.commitReact();chart.render();assert.equal(seen(next),null,'React commits retaining old geometry are not new observation evidence');
  chart.finishParent();assert.equal(chart.render().value,baseline);assert.equal(seen(next),null,'the child drawing still waits after money preparation');
  chart.finishChart();assert.equal(seen(next),null,'detached numeric preparation has not reached the DOM');
  const final=chart.render();assert.ok(final.ready);assert.notEqual(final.value,baseline);
  assert.equal(final.value!.paths[0].line,baseline.paths[0].line);assert.equal(final.value!.paths[0].latest,baseline.paths[0].latest);
  assert.equal(page.path.getAttribute('d'),dBefore);assert.equal(page.series.getAttribute('data-last'),lastBefore);
  assert.ok(Number.isFinite(seen(next)),'the committed new observation proves the equal heartbeat');
  assert.deepEqual(chart.mutations(),{path:before.path,observation:before.observation+1});
  assert.equal(page.bench.seriesChanged(h.source+' balance:credits',`observation:${next.observedAt}:99919999`),null,'the exact amount must agree');
  assert.equal(page.bench.seriesChanged('codex:other balance:credits',expected(next)),null,'the source must agree');
  assert.equal(page.bench.seriesChanged(h.source+' balance:credits',`observation:${next.observedAt+1}:99920000`),null,'the observation anchor must agree');
  page.bench.reset();page.record({type:'attributes',attributeName:'d',target:page.path});
  assert.equal(page.bench.seriesChanged(h.source+' balance:credits','observation:'+lastBefore),null,'a geometry cell boundary cannot impersonate an observation');
  page.bench.reset();chart.replace(dropped);chart.render();chart.finishParent();assert.equal(chart.render().value,final.value);
  assert.equal(seen(dropped),null,'dropping the new child model leaves the previous DOM uncredited');
  chart.retire();chart.render();chart.finishParent();chart.finishChart();
  assert.equal(seen(dropped),null,'a retired pending lifetime cannot publish its observation');
});
