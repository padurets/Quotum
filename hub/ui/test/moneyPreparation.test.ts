import * as widgets from '../../server/domain/widgets';
import {moneyBalanceSeries} from '../lib/moneyTable';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {axisNavigation} from '../lib/axisNavigation';
import {pan} from '../lib/pan';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {plotPathPrepared} from '../lib/plotPath';
import {clipPrepared} from '../lib/forecast';
import {preparationFixture} from './preparationFixture';
import {composeMeters,composeMetersPrepared,type MeterSeriesCells} from '../../server/domain/meterHistory';
import {drain} from '../lib/prepare';
import {moneyIdentity} from '../lib/moneyView';
import * as jsx from 'react/jsx-runtime';
import * as providers from '../../server/domain/providers';
import * as currency from '../../server/domain/currency';
import * as moneyView from '../lib/moneyView';
import * as money from '../lib/money';
import * as moneyTable from '../lib/moneyTable';
import {moneySelection} from '../lib/moneySelection';
import {EMPTY_VIEW} from '../../server/domain/view';
import type {Card, History} from '../lib/types';
import type {Chart as ChartComponent} from '../components/Chart';
import {memo as reactMemo, type ComponentProps, type ReactElement} from 'react';

test('balance and funds drawing facts do not depend on the visible quantity frame',()=>{
  const minute=60_000,huge=9007199254740993n;
  const semantics={limit:null,resetAt:null,minutes:null,scope:null,label:null};
  const balance:MeterSeriesCells={source:'wallet',meter:'balance',kind:'balance',unit:'USD',semantics,cells:[
    [0,String(huge),'1','0',minute],
    [1,String(huge-2n),'2','0',minute,{steps:[{from:minute/2,to:minute+1,amount:'7',evidence:'continuous'}]}],
    [3,String(huge-9n),'4','5',minute,{segment:2,topupInternal:'5'}],
  ]};
  const cap:MeterSeriesCells={source:'wallet',meter:'cap',kind:'cap',unit:'USD',semantics:{...semantics,limit:String(huge*2n)},cells:[
    [0,String(huge),'0','0',minute-1001,{knownFrom:1000,knownUntil:minute-1}],
    [2,String(huge-1n),'0','0',minute-1000,{knownFrom:2*minute+1000,knownUntil:3*minute,semantics:{...semantics,limit:String(huge*3n)}}],
  ]};
  const funds:MeterSeriesCells={source:'subscription',meter:'balance:credits',kind:'balance',unit:'USD',pointMode:'observation',accounting:{spending:'unavailable',topups:'unavailable'},semantics,cells:[
    [0,String(huge),null,null,10_000,{observations:[{at:1234,value:String(huge),validUntil:11_234,semantics}]}],
    [2,String(huge+5n),null,null,30_000,{observations:[{at:2*minute+4321,value:String(huge+5n),validUntil:2*minute+34_321,semantics}]}],
  ]};
  const source=readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8'),start=source.indexOf('  const modelContext='),region=source.slice(start,source.indexOf('  const model=prepared.value',start));
  for(const [family,meterSeries] of [['budget',[balance,cap]],['funds',[funds]]] as const) {
    const chunks=[{from:0,meterSeries:[...meterSeries]}],drawing={meterSeries:composeMeters(chunks,minute,0,4*minute)};
    const draw=(quantities:{from:number;to:number}|undefined)=>{
      const context={authority:0,family,axisNavigation,selected:null,panning:null,useRef:(value:unknown)=>({current:value}),moneyBalanceSeries,accounting:()=>true,settings:{},context:defaultCurrencyContext,strip:{meterChunks:chunks,cell:minute,from:0,to:4*minute,meterFrame:quantities},drawing,history:drawing,unit:'USD',prefs:{range:'1h',horizon:'auto',muted:{}},sources:[{id:'wallet',provider:'openrouter'},{id:'subscription',provider:'codex'}],arrange:{view:{}},locale:'en',board:'b',selection:{ids:meterSeries.map(s=>[s.source,s.meter])},moneyIdentity,composeMetersPrepared,colorOf:()=> '#fff',nameOf:()=> 'Fixture',usePrepared:(work:()=>Generator<void,unknown,void>)=>({value:drain(work()),ready:true}),model:null as unknown as {entries:typeof drawing.meterSeries;lines:Record<string,unknown>[];origin:bigint;span:bigint;pad:bigint}};
      runInNewContext(ts.transpileModule(region+'\nglobalThis.model=prepared.value;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
      return context.model;
    };
    const facts=(model:ReturnType<typeof draw>)=>({
      entries:model.entries.map(({spent:_spent,topup:_topup,coveredMs:_covered,unlocated:_unlocated,topupUnlocated:_topupUnlocated,points,...entry})=>({...entry,points:points.map(({spent:_spent,...point})=>point)})),
      lines:model.lines.map(({coveredMs:_covered,...line})=>line),origin:model.origin,span:model.span,pad:model.pad,
    });
    const expected=draw(undefined);
    for(const frame of [{from:0,to:2*minute},{from:minute,to:4*minute},{from:2*minute,to:3*minute}])assert.deepEqual(structuredClone(facts(draw(frame))),structuredClone(facts(expected)),family);
    if(family==='budget') {
      assert.notEqual(draw({from:0,to:2*minute}).entries[0].spent,draw({from:2*minute,to:4*minute}).entries[0].spent,'quantity frames still change accounting');
      assert.equal(expected.entries[0].points[0].value,String(huge));
      assert.notEqual(expected.entries[0].points[1].segment,expected.entries[0].points[2].segment);
      assert.deepEqual(expected.entries[1].points.map(p=>[p.knownFrom,p.knownUntil]),[[1000,minute-1],[2*minute+1000,3*minute]]);
    } else assert.deepEqual(expected.entries[0].points.map(p=>[p.at,p.validUntil]),[[1234,11_234],[2*minute+4321,2*minute+34_321]]);
  }
});

test('the actual prepared money chart keeps its value axis, step geometry and exact last amount',()=>{
  const hook=preparationFixture();let exactReads=0;
  const valueAxis={min:-5,max:15,rawValue:()=>{exactReads++;return '10000000';}};
  const context={context:defaultCurrencyContext,...hook,axis:{active:false,basis:{from:0,to:120000,end:60000}},incomingLines:[{key:'money',points:[[0,0,1],[60000,10,1]]}],
    incomingPlans:[],incomingForecasts:[],incomingMarkers:[],incomingStrip:null,desiredFrom:0,desiredTo:120000,desiredNow:60000,
    desiredLive:true,incomingReady:true,modelContext:'money',navigation:undefined,valueAxis,stepped:true,
    incomingCellMs:60000,width:900,height:220,left:40,right:12,top:12,bottom:28,clipPrepared,plotPathPrepared,
    draw:null as unknown as ()=>{value:{valueAxis:typeof valueAxis;paths:{line:string;latest:string}[]}|null;ready:boolean}};
  const source=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8'),start=source.indexOf('  const inputs = ');
  const region=source.slice(start,source.indexOf('  const model = ',start));
  runInNewContext(ts.transpileModule(`function draw(){${region}\nreturn prepared;}\nglobalThis.draw=draw;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  hook.begin();context.draw();hook.commit();hook.finish();hook.begin();const model=context.draw().value!;
  assert.equal(model.valueAxis,valueAxis);assert.equal(model.paths[0].line,'M252.0,147.0H464.0V57.0');
  assert.equal(model.paths[0].latest,'60000:10000000');assert.equal(exactReads,1);
  context.valueAxis={min:0,max:20,rawValue:()=> '3000000'};
  context.incomingLines=[{key:'money',points:[[0,0,1],[60000,3,1]]}];
  hook.begin();const pending=context.draw();
  assert.equal(pending.value,model,'the same account and unit retain their drawing during a display-mode change');
  assert.equal(pending.ready,false);hook.commit();hook.finish();hook.begin();
  const next=context.draw().value!;assert.equal(next.valueAxis,context.valueAxis);assert.equal(next.paths[0].latest,'60000:3000000');
});

for (const change of ['hidden', 'removed', 'boundary', 'batched boundary', 'resource revision', 'empty selection']) test(`MoneyHistory retires ${change} through the prepared Chart`, t => {
    const outer = preparationFixture(), inner = preparationFixture();
    t.after(()=>{outer.dispose();inner.dispose();});
    const cards: Card[] = ['A', 'B'].map(id => ({id, title: id, provider: 'openrouter', plan: '', successAt: 60000, error: null, stale: false, windows: [], resets: null, owners: [], staleAfterMs: 1000, measureIntervalMs: null,
      meters: [{id: 'balance', amount: '10000000', kind: 'balance', unit: 'USD', limit: null, at: 60000, stale: false, staleAfterMs: 1000, resetAt: null, minutes: null, scope: null, label: null}]}));
    const chunks = [{from: 0, meterSeries: cards.map(c => ({source: c.id, meter: 'balance', kind: 'balance', unit: 'USD', semantics: null, cells: [[0, '10000000', '1000000', '0', 60000], [1, '10000000', '3000000', '0', 60000]]} as MeterSeriesCells))}];
    const series = composeMeters(chunks, 60000, 0, 120000);
    let history = {board: 'board', range: '1h', cellMs: 60000, since: 0, to: 120000, meterSeries: series} as History | null;
    let sources = cards, view = EMPTY_VIEW, presentation = 0,loading:boolean|undefined;
    const prefs = {money: {unit: 'USD', view: 'balance', selected: {}}, muted: {}, range: '1h', horizon: 'auto'};
    const Chart = () => null;
    const memo = (read: () => unknown, deps: unknown[]) => {const box = outer.useRef(null) as {current: {deps: unknown[]; value: unknown} | null}; if (!box.current || deps.some((v, i) => !Object.is(v, box.current!.deps[i]))) box.current = {deps, value: read()}; return box.current.value;};
    const modules: Record<string, unknown> = {
      'react/jsx-runtime': jsx, react: {memo: reactMemo, useRef: outer.useRef, useMemo: memo,useLayoutEffect:outer.useLayoutEffect},
      '../../server/domain/providers': providers, '../../server/domain/currency': currency, '../../server/domain/meterHistory': {composeMetersPrepared},
      '../lib/board': {useServerView:()=>undefined,useBoardId: () => 'board', useCurrencyContext: () => defaultCurrencyContext, useNamed: () => sources},
      '../lib/history': {useBudgetFinancialHistory: () => ({history,drawing:history,loading:loading??!history,presentation}),useBudgetHistory: () => ({history, drawing: history, loading: !history, presentation}), useBudgetHistoryPlot: () => null, useHistoryBegins: () => 0, budgetHistory: {retry: () => {}}},
      '../lib/prefs': {usePref: (key:keyof typeof prefs) => prefs[key]}, '../lib/moneySelection': {moneySelection}, '../lib/moneyView': moneyView, '../lib/money': money,
      '../lib/view': {...widgets,colorOf: () => '#fff'}, '../lib/periods': {frameOf: () => ({from: 0, to: 120000, live: true}), measuredTo: () => 60000},
      '../lib/timeRange': {useTimeRange: () => null}, '../lib/clock': {useClock: () => 60000}, '../lib/pan': {pan,usePanning: () => null},
      '../lib/axisNavigation': {axisNavigation: () => ({context: 'board'})}, '../i18n': {t: (key: string) => key, useLocale: () => 'en'},
      './prepared': {usePrepared: outer.usePrepared}, './sizing': {usePlot: () => ({plot: {}, onBase: () => {}})}, './Chart': {Chart},
      './seriesFocus': {useSeriesFocus:()=>{}}, '../lib/moneyTable': moneyTable,
    };
    const component = {exports: {} as {MoneyHistory: (props: unknown) => ReactElement<{children: ReactElement[]}>}, require: (name: string) => modules[name] ?? {}};
    runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneyAnalytics.tsx', import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, component);
    const child = {...inner, axis: {active: false, basis: {from: 0, to: 120000, end: 60000}}, incomingPlans: [], incomingForecasts: [], incomingMarkers: [], incomingStrip: null,
      desiredFrom: 0, desiredTo: 120000, desiredNow: 60000, desiredLive: true, navigation: undefined, stepped: true, incomingCellMs: 60000,
      width: 900, height: 220, left: 40, right: 12, top: 12, bottom: 28, clipPrepared, plotPathPrepared,
      draw: null as unknown as () => {value: {lines: {sourceId: string}[]; paths: {line: string; latest: string}[]; valueAxis: unknown} | null; ready: boolean}};
    const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8'), start = source.indexOf('  const inputs = ');
    runInNewContext(ts.transpileModule(`function draw(){${source.slice(start, source.indexOf('  const model = ', start))}\nreturn prepared;}\nglobalThis.draw=draw;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, child);
    const draw = () => {
      outer.begin();
      const tree = component.exports.MoneyHistory({arrange: {view, owner: false}});
      const chart = tree.props.children.find(node => node?.type === Chart)! as ReactElement<ComponentProps<typeof ChartComponent>>;
      outer.commit();
      Object.assign(child, {incomingCellMs: chart.props.cellMs, incomingLines: chart.props.lines, incomingReady: chart.props.prepared, valueAxis: chart.props.axis, modelContext: chart.props.modelContext});
      inner.begin(); const result = child.draw(); inner.commit(); return result;
    };
    const settle = () => {for (let i = 0; i < 4; i++) {draw(); outer.finish(); inner.finish();} return draw();};
    const original = settle().value!;
    assert.deepEqual(Array.from(original.lines, l => l.sourceId), ['A', 'B']);
    assert.equal(original.paths[0].latest, '60000:10000000');
    prefs.range = '3h';
    assert.equal(draw().value, original, 'the same resources keep their answered frame during a range read');
    const previous = history!; history = null; presentation++;
    if (change === 'removed') sources = cards.slice(1);
    else if (change === 'hidden') view = {...view, hidden: ['source:A']};
    else if(change==='empty selection'){sources=[];loading=false;}
    if (change !== 'batched boundary') assert.equal(draw().value, null, 'the nested geometry retires immediately');
    if(change==='empty selection'){
      const empty=settle();assert.equal(empty.ready,true,'a known empty selection needs no future history answer');assert.equal(empty.value!.lines.length,0);
      history={...previous,range:'1h'};
      const retained=settle();assert.equal(retained.ready,true,'a retained answer for another range cannot strand an empty chart');assert.equal(retained.value!.lines.length,0);
    }else if (change === 'hidden' || change === 'removed') {
      assert.equal(settle().value, null, 'no old path, amount or value axis survives while the answer is pending');
    } else {
      history = {...previous, range: '3h', since: 60000, meterSeries: series.map(series => ({...series, end: '5000000', points: series.points.map(point => ({...point, value: '5000000'}))}))};
      assert.equal(draw().value, null, 'same IDs cannot revive the previous model while the authorized replacement prepares');
      const fresh = settle().value!;
      assert.equal(fresh.paths[0].latest, '60000:5000000', 'the replacement owns its amount and readout axis');
      assert.notEqual(fresh.valueAxis, original.valueAxis);
    }
});
