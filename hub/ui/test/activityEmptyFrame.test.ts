import {AnalyticsPanel} from '../components/AnalyticsPanel';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {activityEmpty, activityScale} from '../lib/activity';
import {StackPaths} from '../lib/stackPaths';
import {stacksHeight} from '../components/Activity';
import {plotLayerFixture} from './plotLayerFixture';
import {drain} from '../lib/prepare';
import {Pan} from '../lib/pan';
import {navigationKey} from '../lib/axisNavigation';
import {niceTicks,timeTickWords} from '../lib/periods';
import {cellStart} from '../../server/domain/history';
import type {History} from '../lib/types';
import {defaultFilters} from '../../server/domain/dataFilters';
import {fixture,drawings,consumer,flush,NOW,H} from './periodRuntimeFixture';
import {activityClockConsumer} from './activityClockFixture';
import {PageClock} from '../lib/clock';
import {setLocale,t,known,type Key} from '../i18n';
import {atOnce} from '../lib/activity';
import {num,workHours} from '../lib/format';

const {clipPlot, PlotLayer, PlotOverlay} = plotLayerFixture();

const emptyProps=(node:React.ReactNode):unknown=>{
  if(Array.isArray(node))return node.map(emptyProps).find(Boolean);
  if(!React.isValidElement<{children?:React.ReactNode}>(node))return null;
  return typeof node.type==='function'&&node.type.name==='EmptyState'?node.props:emptyProps(node.props.children);
};
const emptyMessages=(node:React.ReactNode,clock?:PageClock,period?:unknown):string[]=>{
  const props=emptyProps(node);
  if(props&&clock&&period){const view=activityClockConsumer('EmptyState',clock,period,props);try{view.render();return emptyMessages(view.element());}finally{view.close();}}
  if(Array.isArray(node))return node.flatMap(child=>emptyMessages(child,clock,period));
  if(!React.isValidElement<{className?:string;children?:React.ReactNode}>(node))return [];
  const text=String(node.props.children);
  return node.props.className==='chart-empty'?[known(text)?t(text):text]:emptyMessages(node.props.children,clock,period);
};

for(const startsEmpty of [false,true])test(`actual Activity ${startsEmpty?'empty to working':'working to empty'} replacement commits its empty message, legend, bars and summary together`,async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed:true,personal:true,initialFilters:defaultFilters()}),d=await drawings(h);
  const positive={from:NOW-H,to:NOW},empty={from:NOW-3*H,to:NOW-2*H};
  const select=async(range:typeof positive)=>{h.selectRange(range);d.loader.choose('1h',range);await flush();};
  if(startsEmpty)await select(empty);
  const paint=consumer({...h,...d}),clock=new PageClock({now:()=>NOW,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
  try{
    const initial=paint.settle(),before=initial.totals.history;
    assert.ok(before);
    assert.equal(before.activity.agentMs,startsEmpty?0:60_000);
    await select(startsEmpty?positive:empty);
    const answer=d.renderActivity().history;
    assert.ok(answer);assert.notEqual(answer.activity,before.activity);
    assert.equal(answer.activity.agentMs,startsEmpty?60_000:0);
    const pending=paint.render();paint.finishParent();const parentReady=paint.render();paint.finishChild();const complete=paint.render();
    for(const [stage,frame,retained] of [['before-parent',pending,true],['parent-ready-child-pending',parentReady,true],['child-ready',complete,false]] as const){
      const active=retained?!startsEmpty:startsEmpty,expectedMs=active?60_000:0;
      const committed=frame.totals.history;
      test.diagnostic(JSON.stringify({stage,requested:h.selectedRange(),committedRange:committed?.range,incomingRange:frame.incomingFrame?.history?.range,sameCommitted:committed===before,agentMs:committed?.activity.agentMs,pathsEqual:JSON.stringify(frame.paths)===JSON.stringify(initial.paths),legend:frame.names,empty:emptyMessages(frame.tree,clock,h.period)}));
      assert.equal(committed===before,retained,stage+': the actual committed detail identity follows the child publication');
      assert.equal(committed.activity.agentMs,expectedMs,stage);
      if(retained)assert.deepEqual(frame.paths,initial.paths,stage+': pending retains the actual drawn paths');
      else if(active)assert.notDeepEqual(frame.paths,[],stage+': the ready positive answer has real bars');
      else assert.deepEqual(frame.paths,[],stage+': the ready zero answer has no bars');
      assert.deepEqual(frame.names,active?['Work project']:[],stage+': the legend belongs to that same frame');
      assert.deepEqual(emptyMessages(frame.tree,clock,h.period),active?[]:[t('activity.none')],stage+': a newer parent cannot publish or retire its empty message early');
      for(const locale of ['en','ru'] as const){
        setLocale(locale);const summary=activityClockConsumer('Totals',clock,h.period,frame.totals);
        try{const html=summary.render();assert.deepEqual([...html.matchAll(/<b[^>]*>(.*?)<\/b>/g)].map(match=>match[1]),[workHours(expectedMs),workHours(expectedMs),num(active?1:0),active?atOnce(expectedMs,expectedMs):'—'],stage+' '+locale);}finally{summary.close();}
      }
    }
  }finally{paint.close();d.close();await h.close();setLocale('en');}
});

test('a retained zero Activity keeps its empty meaning after failure and retires it on authority loss',async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed:true,personal:true,initialFilters:defaultFilters()}),d=await drawings(h);
  const range={from:NOW-3*H,to:NOW-2*H};h.selectRange(range);d.loader.choose('1h',range);await flush();
  const paint=consumer({...h,...d}),held=h.hold(),clock=new PageClock({now:()=>NOW,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
  try{
    const initial=paint.settle();assert.deepEqual(emptyMessages(initial.tree,clock,h.period),[t('activity.none')]);
    h.event({type:'history',data:{sources:[],since:range.from+60_000,workSince:range.from+60_000}});await flush();
    held.reject(new Error('selected work unavailable'));await flush();assert.equal(d.renderActivity().error,'history_failed');
    const requests=h.requests.length;
    for(let i=0;i<3;i++){
      const retained=paint.settle();assert.equal(retained.totals.history.activity.agentMs,0);assert.deepEqual(retained.paths,[]);assert.deepEqual(retained.names,[]);assert.deepEqual(emptyMessages(retained.tree,clock,h.period),[t('activity.none')]);
    }
    assert.equal(h.requests.length,requests,'rendering a known zero does not retry a failed replacement');
    h.event({type:'history',data:{sources:[],since:0,workSince:0}});
    const retired=paint.render();assert.equal(retired.totals.history,null);assert.deepEqual(retired.paths,[]);assert.deepEqual(retired.names,[]);assert.deepEqual(emptyMessages(retired.tree,clock,h.period),[],'retired evidence cannot claim a confirmed zero');
  }finally{held.release();await flush();paint.close();d.close();await h.close();}
});

test('the committed empty consumer follows retained live zero, knowledge expiry and locale without preparing another frame',async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,initialFilters:defaultFilters(),creditFrom:NOW-H-30_000,creditTo:NOW-H+1000}),d=await drawings(h),paint=consumer({...h,...d});
  let now=NOW;const timers=new Map<object,{at:number;run:()=>void}>();
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const token={};timers.set(token,{at:now+ms,run});return token;},clearTimeout:token=>{timers.delete(token as object);}});
  let empty:ReturnType<typeof activityClockConsumer>|undefined,summary:ReturnType<typeof activityClockConsumer>|undefined;
  const advance=(to:number)=>{
    for(let count=0;;count++){
      assert.ok(count<10000);const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>to)break;
      now=next[1].at;h.advance(now);timers.delete(next[0]);next[1].run();empty!.render();summary!.render();
    }
    now=to;h.advance(now);
  };
  try{
    setLocale('en');const initial=paint.settle(),initialProps=emptyProps(initial.tree);assert.ok(initialProps);
    empty=activityClockConsumer('EmptyState',clock,h.period,initialProps);summary=activityClockConsumer('Totals',clock,h.period,initial.totals);
    empty.render();assert.deepEqual(emptyMessages(empty.element()),[]);assert.ok(summary.render().includes('data-agent-ms="1000"'));
    advance(NOW+2000);
    assert.deepEqual(emptyMessages(empty.element()),[t('activity.none')]);assert.ok(summary.render().includes('data-agent-ms="0"'));
    h.store.creditWork(h.device,NOW-20*60_000,NOW-18*60_000,[{source:h.source,client:'codex',origin:'terminal',project:'New project',folder:'New project',startedAt:NOW-H,identity:{kind:'stable',sessionId:'New project'}}]);h.events.flush();await flush();
    const pending=paint.render(),props=emptyProps(pending.tree);assert.ok(props);assert.equal(pending.totals.history,initial.totals.history);assert.equal(pending.totals.retained,true);
    empty.update(props);summary.update(pending.totals);const requests=h.requests.length,jobs=[paint.queuedParent(),paint.queuedChild()];
    setLocale('ru');empty.update(props);assert.deepEqual(emptyMessages(empty.element()),[t('activity.none')]);setLocale('en');empty.update(props);
    assert.deepEqual([paint.queuedParent(),paint.queuedChild()],jobs,'translation and the empty readout never schedule preparation');
    advance(NOW+H+2000);
    const expired=emptyMessages(empty.element());assert.equal(expired.length,1);assert.notEqual(expired[0],t('activity.none'),'expired knowledge is unknown, not a retained confirmed zero');
    assert.ok(!summary.render().includes('data-agent-ms='),'the same captured projector retires numerical certainty');
    assert.equal(h.requests.length,requests,'zero and unknown clock boundaries never poll');assert.deepEqual([paint.queuedParent(),paint.queuedChild()],jobs);
    h.event({type:'history',data:{sources:[],since:0,workSince:0}});empty.update(props);assert.deepEqual(emptyMessages(empty.element()),[],'authority loss retires the old empty explanation without a scalar fallback');
  }finally{empty?.close();summary?.close();paint.close();d.close();await h.close();setLocale('en');}
});

test('the actual empty activity result keeps its time axis and legend container at the plotted height', () => {
  let locale='en',panning=false;setLocale('en');
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const answered = history?.range ===', source.indexOf('export const Activity ='));
  const end = source.indexOf('\n  );', start) + 5;
  const stacksStart = source.indexOf('const EmptyState = memo(function EmptyState(');
  assert.ok(stacksStart >= 0 && source.indexOf('const StackArtwork = memo(function StackArtwork(',stacksStart)>stacksStart, 'the fixture includes the empty consumer and actual prepared stack artwork');
  const drawing = source.slice(stacksStart) + '\nfunction draw(){' + source.slice(start, end) + '}\nglobalThis.draw=draw;';
  const M = 60_000, H = 60 * M, DAY = 24 * H, NOW = 100 * DAY;
  const range = {from: NOW - 72 * H, to: NOW - 48 * H};
  const history: History = {since: range.from, to: range.to, range: `${range.from}-${range.to}`, live: false, cellMs: 5 * M, historyStart: 0, series: [], events: [], activity: {known: {from: range.from, to: range.to}, since: 0, barMs: H, activeMs: 0, agentMs: 0, agents: 0, cells: [], by: {source: [], project: [], device: []}}};
  const x = (at: number) => 48 + (at - range.from) / DAY * 340;
  const authorities:number[]=[];
  const context = {paint:new Map(),AnalyticsPanel,quotaHistory:{retry:()=>{}},error:undefined as 'history_failed'|undefined,authority:3,
    board:'b',geometry:{numeric:{history:{range:history.range,since:history.since,activity:history.activity},since:null},identities:[]},resolved:new Map(),focus:{},navigationKey, navigation: {context: 'test', range: 'range'}, React, ...React, CSS: {escape: (id: string) => id}, StackPaths, stacksHeight, activityScale, niceTicks, timeTickWords, cellStart, activityEmpty, MINUTE: M, clipPlot, PlotLayer, PlotOverlay, usePreparationBasis: (basis: unknown,_inputs:unknown,_active:unknown,_ready:unknown,authority:number) => {authorities.push(authority);return basis;}, usePrepared: (work: () => Generator<void, unknown, void>) => ({value: drain(work()), ready: true}), EMPTY_ACTIVITY: history.activity,
    pan: new Pan({now: () => NOW, commit: () => {}, requestFrame: () => null, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}}),
    useLocale: () => locale, useActivityNumbers:(history:Pick<History,'activity'>|null)=>history?.activity??null, useTimeAxis: () => ({box: {current: null}, svg: {current: null}, width: 400, scale: 1, active:panning,panning, hover: null, drag: null, clip: 'c', handlers: {}, basis: {...range, end: range.to}, visualGeometry:()=>({...range,end:range.to}),presentation:()=>range,x, drawX: x, screenX: x, commitDrawing: () => {}}),
    hubNow:()=>NOW,clock: () => '', shortDay: () => '', workHours: () => '', stamp: () => '', t: (key:Key,params?:Record<string,string|number>) => t(key,params),
    Tooltip: () => null, useTip: () => ({tip: {current: null}, style: {}}), panel: {current: null}, loading: false,
    history: history as History | null, drawing: history, activity: history.activity, drawnActivity: history.activity, currentGroups: [], plot: undefined as number | undefined, onBase: () => {}, arrange: {},
    Totals: () => null, ActivitySettings: () => null, LegendItem: () => null,
    shownMs: 0, since: null, from: range.from, to: range.to, setTimeRange: () => {}, by: 'project', selected: range,
    timeRangeKey: (value: typeof range) => `${value.from}-${value.to}`, prefs: {range: '24h'}, groups: [], titles: {}, shownSources: ['s'],
    personal: false, groupName: (identity: {name: string}) => identity.name, activitySeriesKey: (_by: string, key: string) => key,
    prepared: {ready: true}, presentation: {identities: [], shown: [], strip: null}, strip: null as object | null, panning: null as number | null,
    draw: null as unknown as () => React.ReactNode,
  };
  runInNewContext(ts.transpileModule(drawing, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React}}).outputText, context);
  const markup = () => renderToStaticMarkup(React.createElement(() => context.draw()));
  const complete = markup();
  assert.ok(complete.includes('viewBox="0 0 400 160" style="height:160px"'));
  assert.ok(complete.includes('class="legend"'));
  const english=t('activity.none');assert.ok(complete.includes('class="chart-empty">'+english));
  assert.ok(!complete.includes('class="chart chart-loading"'));
  assert.equal(authorities.at(-1),3,'the actual Stacks receives the history presentation lifetime');
  context.prepared.ready=false;locale='ru';setLocale('ru');
  const translated=markup();assert.ok(translated.includes(t('activity.none')),'a held semantic reason uses the current language');assert.ok(!translated.includes(english),'the prepared model never retains translated empty text');
  context.prepared.ready=true;locale='en';setLocale('en');
  context.panning = 1;panning=true;
  const moving = markup();
  assert.ok(moving.includes('viewBox="0 0 400 160" style="height:160px"'));
  assert.ok(!moving.includes('class="chart-empty">'+english), 'the previous empty answer cannot describe a new draft');
  context.panning = null;panning=false;
  context.history = {...history, range: '24h'};
  assert.ok(markup().includes('class="chart-empty">'+english), 'a pending frame retains the zero meaning of its committed evidence');
  context.history = null;
  context.authority++;
  assert.ok(markup().includes('viewBox="0 0 400 160"'), 'initial loading keeps an input-capable empty axis');
  assert.equal(authorities.at(-1),4,'the empty axis also receives the retired presentation lifetime');
  context.error='history_failed';
  const failed=markup();
  assert.ok(failed.includes('reader-error'));assert.ok(!failed.includes('history.loading'));
  assert.ok(failed.includes('viewBox="0 0 400 160"'),'a failed reader retains a usable empty axis');
});
