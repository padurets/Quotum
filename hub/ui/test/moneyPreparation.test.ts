import {defaultCurrencyContext} from '../../server/domain/currency';
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
import {moneySelection} from '../lib/moneySelection';
import {EMPTY_VIEW} from '../../server/domain/view';
import type {Card, History} from '../lib/types';
import type {Chart as ChartComponent} from '../components/Chart';
import type {ComponentProps, ReactElement} from 'react';

test('the actual spending generator keeps visible quantities invariant under overscan and boundary steps',()=>{
  const source=readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8'),start=source.indexOf('  const modelContext='),region=source.slice(start,source.indexOf('  const model=prepared.value',start));
  const cells:MeterSeriesCells={source:'s',meter:'balance',kind:'balance',unit:'USD',semantics:null,cells:[0,1,2,3].map(i=>[i,'10000000','1000000','0',60000])};
  for(const crossing of [false,true]) {
    const raw=crossing?{...cells,cells:[[1,'10000000','0','1000000',60000,{steps:[{from:10000,to:60001,amount:'1000000',evidence:'continuous'}]}]] as MeterSeriesCells['cells']}:cells;
    const chunks=[{from:0,meterSeries:[raw]}],original=composeMeters(chunks,60000,60000,180000);
    const draw=(strip:unknown)=>{
      const context={family:'budget',settings:{view:'spending'},context:defaultCurrencyContext,strip,original,history:{meterSeries:original},unit:'USD',prefs:{money:{view:'spending'},muted:{}},sources:[{id:'s',title:'Fixture',provider:'openrouter'}],arrange:{view:{}},locale:'en',board:'b',selection:{ids:[['s','balance']]},moneyIdentity,composeMetersPrepared,colorOf:()=> '#fff',nameOf:()=> 'Fixture',usePrepared:(work:()=>Generator<void,unknown,void>)=>({value:drain(work()),ready:true}),model:null as unknown as {entries:typeof original}};
      runInNewContext(ts.transpileModule(region+'\nglobalThis.model=prepared.value;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
      return JSON.stringify(context.model.entries[0].points.filter(p=>p.at>=60000&&p.at<180000).map(p=>[p.at,p.value]));
    };
    assert.equal(draw({meterChunks:chunks,cell:60000,from:0,to:240000,meterFrame:{from:60000,to:180000}}),draw(null));
    if(crossing)assert.equal(original[0].spent,'0');else assert.equal(original[0].spent,'2000000');
  }
});

test('the actual prepared money chart keeps its value axis, step geometry and exact last amount',()=>{
  const hook=preparationFixture();let exactReads=0;
  const valueAxis={min:-5,max:15,rawValue:()=>{exactReads++;return '10000000';}};
  const context={context:defaultCurrencyContext,...hook,axis:{active:false,basis:{from:0,to:120000,end:60000}},incomingLines:[{key:'money',points:[[0,0,1],[60000,10,1]]}],
    incomingPlans:[],incomingForecasts:[],incomingMarkers:[],incomingStrip:null,desiredFrom:0,desiredTo:120000,desiredNow:60000,
    desiredLive:true,incomingReady:true,modelContext:'money',navigation:undefined,valueAxis,stepped:true,
    cellMs:60000,width:900,height:220,left:40,right:12,top:12,bottom:28,clipPrepared,plotPathPrepared,
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

test('MoneyHistory passes resource retirement through to the prepared Chart while a replacement read is pending', () => {
  for (const removed of [false, true]) {
    const outer = preparationFixture(), inner = preparationFixture();
    const cards: Card[] = ['A', 'B'].map(id => ({id, title: id, provider: 'openrouter', plan: '', successAt: 60000, error: null, stale: false, windows: [], resets: null, owners: [], staleAfterMs: 1000, measureIntervalMs: null,
      meters: [{id: 'balance', amount: '10000000', kind: 'balance', unit: 'USD', limit: null, at: 60000, stale: false, staleAfterMs: 1000, resetAt: null, minutes: null, scope: null, label: null}]}));
    const series = composeMeters([{from: 0, meterSeries: cards.map(c => ({source: c.id, meter: 'balance', kind: 'balance', unit: 'USD', semantics: null, cells: [[0, '10000000', '0', '0', 60000], [1, '10000000', '0', '0', 60000]]}))}], 60000, 0, 120000);
    let history = {board: 'board', range: '1h', cellMs: 60000, since: 0, to: 120000, meterSeries: series} as History | null;
    let sources = cards, view = EMPTY_VIEW;
    const prefs = {money: {unit: 'USD', view: 'balance', selected: {}}, muted: {}, range: '1h', horizon: 'auto'};
    const Chart = () => null;
    const memo = (read: () => unknown, deps: unknown[]) => {const box = outer.useRef(null) as {current: {deps: unknown[]; value: unknown} | null}; if (!box.current || deps.some((v, i) => !Object.is(v, box.current!.deps[i]))) box.current = {deps, value: read()}; return box.current.value;};
    const modules: Record<string, unknown> = {
      'react/jsx-runtime': jsx, react: {useRef: outer.useRef, useMemo: memo},
      '../../server/domain/providers': providers, '../../server/domain/currency': currency, '../../server/domain/meterHistory': {composeMetersPrepared},
      '../lib/board': {useBoardId: () => 'board', useCurrencyContext: () => defaultCurrencyContext, useNamed: () => sources},
      '../lib/history': {useBudgetHistory: () => ({history, loading: !history}), useBudgetHistoryPlot: () => null, useHistoryBegins: () => 0, budgetHistory: {retry: () => {}}},
      '../lib/prefs': {usePrefs: () => prefs}, '../lib/moneySelection': {moneySelection}, '../lib/moneyView': moneyView, '../lib/money': money,
      '../lib/view': {colorOf: () => '#fff'}, '../lib/periods': {frameOf: () => ({from: 0, to: 120000, live: true}), measuredTo: () => 60000},
      '../lib/timeRange': {useTimeRange: () => null}, '../lib/clock': {useClock: () => 60000}, '../lib/pan': {usePanning: () => null},
      '../lib/axisNavigation': {axisNavigation: () => ({context: 'board'})}, '../i18n': {t: (key: string) => key, useLocale: () => 'en'},
      './prepared': {usePrepared: outer.usePrepared}, './sizing': {usePlot: () => ({plot: {}, onBase: () => {}})}, './Chart': {Chart},
    };
    const component = {exports: {} as {MoneyHistory: (props: unknown) => ReactElement<{children: ReactElement[]}>}, require: (name: string) => modules[name] ?? {}};
    runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneyAnalytics.tsx', import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, component);
    const child = {...inner, axis: {active: false, basis: {from: 0, to: 120000, end: 60000}}, incomingPlans: [], incomingForecasts: [], incomingMarkers: [], incomingStrip: null,
      desiredFrom: 0, desiredTo: 120000, desiredNow: 60000, desiredLive: true, navigation: undefined, stepped: true, cellMs: 60000,
      width: 900, height: 220, left: 40, right: 12, top: 12, bottom: 28, clipPrepared, plotPathPrepared,
      draw: null as unknown as () => {value: {lines: {sourceId: string}[]; paths: {latest: string}[]; valueAxis: unknown} | null; ready: boolean}};
    const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8'), start = source.indexOf('  const inputs = ');
    runInNewContext(ts.transpileModule(`function draw(){${source.slice(start, source.indexOf('  const model = ', start))}\nreturn prepared;}\nglobalThis.draw=draw;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, child);
    const draw = () => {
      outer.begin();
      const tree = component.exports.MoneyHistory({arrange: {view, owner: false}});
      const chart = tree.props.children.find(node => node?.type === Chart)! as ReactElement<ComponentProps<typeof ChartComponent>>;
      outer.commit();
      Object.assign(child, {incomingLines: chart.props.lines, incomingReady: chart.props.prepared, valueAxis: chart.props.axis, modelContext: chart.props.modelContext});
      inner.begin(); const result = child.draw(); inner.commit(); return result;
    };
    const settle = () => {for (let i = 0; i < 4; i++) {draw(); outer.finish(); inner.finish();} return draw();};
    const original = settle().value!;
    assert.deepEqual(Array.from(original.lines, l => l.sourceId), ['A', 'B']);
    assert.equal(original.paths[0].latest, '60000:10000000');
    prefs.range = '3h';
    assert.equal(draw().value, original, 'the same resources keep their answered frame during a range read');
    history = null;
    if (removed) sources = cards.slice(1); else view = {...view, hidden: ['source:A']};
    assert.equal(draw().value, null, 'the nested geometry retires immediately with its source context');
    assert.equal(settle().value, null, 'no old path, amount or value axis survives while the answer is pending');
  }
});
