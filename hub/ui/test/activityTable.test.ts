import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import * as table from '../lib/activityTable';
import * as activity from '../lib/activity';
import * as format from '../lib/format';
import * as agents from '../lib/agents';
import * as view from '../lib/view';
import * as i18n from '../i18n';
import {EMPTY_VIEW,encodeView,decodeView} from '../../server/domain/view';
import {reconcileAnalytics} from '../../server/domain/analyticsView';
import {ACTIVITY_TABLE,widgetVisible,showWidgets} from '../../server/domain/widgets';
import type {ActivityDimension} from '../lib/types';
import type {WorkTrace} from '../../server/domain/periodWork';
import {fixture,NOW,M,flush} from './periodRuntimeFixture';

const ref=(id:string,device:string,project:string|null='Project')=>({ref:id,source:'s',device:{id:device,name:'Same machine'},origin:'terminal' as const,project,folder:id,startedAt:0});
const trace:WorkTrace={anchor:0,knownFrom:0,cut:200_000,refs:[ref('a','a'),ref('b','b')],spans:[[0,0,100_000],[1,50_000,150_000]]};

test('comparison groups, total and retained contributions share exact clipped work in every dimension',()=>{
  const range={from:25_000,to:125_000},index=new PeriodIndex(trace),rows=index.advance(range,200_000).rows;
  const metrics=new PeriodActivity(trace,index.curves);metrics.update(rows);
  for(const by of ['project','device','source'] as const){
    const summary=metrics.summary(range,by);
    assert.deepEqual([summary.agentMs,summary.activeMs,summary.agents],[150_000,100_000,2]);
    for(const group of summary.by[by]){
      const contributing=rows.filter(row=>table.activityKey(row,by)===group.key);
      assert.equal(contributing.reduce((sum,row)=>sum+row.workedMs,0),group.agentMs);
      assert.equal(contributing.length,group.agents);
      assert.ok(contributing.every(row=>!row.currentPresence));
    }
  }
  const devices=metrics.summary(range,'device').by.device;
  assert.equal(devices.length,2,'equal machine names never merge identities');
  assert.equal(devices.reduce((sum,g)=>sum+g.activeMs,0),150_000,'the whole active total must not sum rows');
  assert.equal(metrics.summary({from:150_000,to:200_000},'project').agents,0,'the exclusive endpoint supplies no work');
  const unknown=new PeriodActivity({...trace,knownFrom:175_000},index.curves).summary({from:150_000,to:170_000},'project');
  assert.equal(unknown.known,null);
});

test('the table is opt-in, sticky when empty, and retains the released v3 aliases',()=>{
  const automatic=reconcileAnalytics(EMPTY_VIEW,[{id:'s',provider:'codex'}]);
  assert.ok(!automatic.shown.includes(ACTIVITY_TABLE));assert.ok(!automatic.layout.places[ACTIVITY_TABLE]);
  assert.equal(widgetVisible(automatic,ACTIVITY_TABLE,1),false);
  const explicit=showWidgets({...automatic,layout:{columns:6,places:{[ACTIVITY_TABLE]:{x:0,y:0,w:6}}}},[ACTIVITY_TABLE]);
  assert.equal(widgetVisible(explicit,ACTIVITY_TABLE,0),true);
  assert.equal(widgetVisible({...explicit,hidden:[ACTIVITY_TABLE]},ACTIVITY_TABLE,1),false);
  const encoded=encodeView(explicit);
  assert.ok(encoded[1].some(tuple=>tuple[0]===ACTIVITY_TABLE));
  assert.ok(encoded[1].every(tuple=>typeof tuple[0]!=='number'||tuple[0]<=6));
  assert.deepEqual(decodeView(encoded),explicit);
  const legacy=decodeView([3,[[0,3],[1,3],[2,3],[3,3],[4,3],[5,3],[6,3]],4,[127,ACTIVITY_TABLE]])!;
  assert.equal(legacy.shown.length,8);assert.ok(legacy.shown.includes(ACTIVITY_TABLE));
});

test('table-only private work uses the existing sessions transport with no quota cells or second read',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const h=await fixture({personal:true,privateWork:true,unknown:true,tableOnly:true});
  try{
    assert.equal(h.initialRequests.length,1);assert.ok(h.initialRequests[0].sessions);
    assert.ok(!h.initialRequests[0].quota&&!h.initialRequests[0].budget&&!h.initialRequests[0].funds);
    for(const by of ['project','device','source'] as const){
      const summary=h.period.activitySummaryAt(by,NOW);
      assert.equal(summary.agentMs,M);assert.equal(summary.activeMs,M);assert.equal(summary.agents,1);
      assert.equal(summary.by[by].length,1);
    }
    assert.equal(h.period.activitySummaryAt('source',NOW).by.source[0].key,'unknown');
    h.period.refreshWorkClock();await flush();assert.equal(h.requests.length,0);
    assert.ok(h.pool.estimatedBytes<=h.pool.budget);
  }finally{await h.close();}
});

test('the shared table summary keeps its old complete basis through delayed ranges and retires with authority',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const h=await fixture({personal:true,privateWork:true,unknown:true,tableOnly:true});
  try{
    const before=h.period.activitySummaryAt('project',NOW),basis=h.period.get().basis;
    const pending=h.hold();h.settings.range='6h';h.period.changed();await flush();
    assert.equal(h.period.get().loading,true);
    const retained=h.period.activitySummaryAt('project',NOW)!;
    assert.deepEqual({...retained,by:before.by},before);
    assert.deepEqual(retained.by.project,before.by.project);
    assert.deepEqual(h.period.get().basis,basis);
    assert.equal(h.period.activitySummaryChangesAt('project',NOW,()=>''),null,'retained scalars are frozen while replacement is pending');
    h.period.refreshWorkClock();assert.deepEqual(h.period.get().basis,basis);
    pending.release();await flush();assert.equal(h.period.get().loading,false);
    assert.equal(h.period.activitySummaryAt('project',NOW).agentMs,M);
    assert.equal(h.period.get().basis.range.from,NOW-6*60*M);
    h.event({type:'history',data:{sources:[],since:NOW,ownSince:NOW,workAuthority:'replacement'}});await flush();
    h.period.activate(false);assert.equal(h.period.activitySummaryAt('project',NOW),null);
  }finally{await h.close();}
});

test('numeric and name sorting preserve independent preferences, hidden-column fallback and exact values',()=>{
  const metrics=new PeriodActivity(trace),groups=metrics.summary({from:0,to:125_000},'device').by.device;
  const name=(g:typeof groups[number])=>g.name??g.key;
  assert.equal(table.sortedActivity(groups,{column:'agenthours',descending:true},name,'en','device')[0].key,'a');
  assert.equal(table.sortedActivity(groups,{column:'agenthours',descending:false},name,'en','device')[0].key,'b');
  const saved={column:'concurrency',descending:false} as const;
  assert.equal(table.effectiveActivitySort(saved,['active']).column,'agenthours');
  assert.equal(table.effectiveActivitySort(saved,table.ACTIVITY_COLUMNS),saved);
  assert.equal(table.readActivitySort({column:'unsupported',descending:true}),null);
  assert.deepEqual(table.nextActivitySort(null,'active'),{column:'active',descending:false});
  assert.equal(table.nextActivitySort({column:'active',descending:true},'active'),null);
  const project=[{...groups[0],key:'null',name:null},{...groups[1],key:'"Named"',name:'Named'}];
  for(const descending of [false,true])assert.equal(table.sortedActivity(project,{column:'name',descending},name,'en','project').at(-1)!.name,null);
});

function renderer(){
  let by:ActivityDimension='device',owner=false,hidden:string[]=[],range={from:25_000,to:125_000},knownFrom=0;
  const index=new PeriodIndex(trace),metrics=new PeriodActivity(trace,index.curves);
  const period={activitySummaryAt:(dimension:ActivityDimension,_now:number,key?:string)=>metrics.summary(range,dimension,key),activitySummaryChangesAt:()=>null};
  let summary=metrics.summary(range,by);
  const modules:Record<string,unknown>={react:React,'react/jsx-runtime':jsxRuntime,'../lib/activityTable':table,'../lib/activity':activity,'../lib/format':format,'../lib/agents':agents,'../lib/view':view,
    '../i18n':{...i18n,useLocale:i18n.useLocale},'../lib/prefs':{ACTIVITY_BY:['project','device','source'],usePref:(key:string)=>key==='activityTableBy'?by:key==='activityTableSort'?null:'1h'},
    '../lib/board':{useTitles:()=>({s:{provider:'codex',title:'Subscription'}})},'../lib/timeRange':{useTimeRange:()=>null},'../lib/clock':{useClock:()=>125_000},
    '../lib/period':{boardPeriod:period,usePeriodActivity:()=>({summary,basis:{range},loading:false,error:null})},'./sizing':{useSizing:()=>null},'./PeriodStatus':{PeriodStatus:()=>null},'./Popover':{Popover:()=>null},'./Agents':{AgentPages:()=>null,SortIcon:()=>null},'./Kit':{Segmented:()=>null}};
  const compile=(file:string)=>{
    const context={exports:{} as Record<string,React.ComponentType<any>>,require:(name:string)=>modules[name]??{}};
    runInNewContext(ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);return context.exports;
  };
  modules['./AnalyticsTable']=compile('../components/AnalyticsTable.tsx');
  const {ActivityTable}=compile('../components/ActivityTable.tsx');
  return {set:(options:Partial<{by:ActivityDimension;owner:boolean;hidden:string[];range:typeof range;knownFrom:number}>)=>{by=options.by??by;owner=options.owner??owner;hidden=options.hidden??hidden;range=options.range??range;knownFrom=options.knownFrom??knownFrom;summary=new PeriodActivity({...trace,knownFrom},index.curves).summary(range,by);period.activitySummaryAt=(dimension,_now,key)=>new PeriodActivity({...trace,knownFrom},index.curves).summary(range,dimension,key);},
    render:()=>renderToStaticMarkup(React.createElement(ActivityTable,{arrange:{owner,view:{...EMPTY_VIEW,columns:{[ACTIVITY_TABLE]:hidden}},update:()=>{}}}))};
}

test('actual shared table renders union totals, session hints, honest unknowns and owner columns in EN/RU',()=>{
  const r=renderer();try{
    for(const locale of ['en','ru'] as const){
      i18n.setLocale(locale);r.set({range:{from:25_000,to:125_000},knownFrom:0,hidden:[]});let html=r.render();
      assert.ok(html.includes(i18n.t('activityTable.title'))&&html.includes(i18n.t('activity.agents')));
      assert.equal((html.match(/data-activity-group/g)??[]).length,2);
      const total=html.match(/<tr class="analytics-total">(.*?)<\/tr>/)![1];
      assert.ok(total.includes(format.workHours(150_000))&&total.includes(format.workHours(100_000))&&total.includes(activity.atOnce(150_000,100_000)));
      assert.ok(html.includes('aria-sort="descending"')&&html.includes(i18n.t('activity.agentsHint')));
      r.set({hidden:['sessions','concurrency']});html=r.render();assert.ok(!html.includes('data-time="activity-table" title="'+i18n.t('activity.agentsHint')));
      r.set({hidden:[],range:{from:160_000,to:170_000},knownFrom:175_000});html=r.render();
      assert.ok(html.includes(i18n.t('activity.knownFrom',{time:format.stamp(175_000)})));
      assert.equal((html.match(/>—</g)??[]).length,4);
      r.set({knownFrom:0});html=r.render();assert.ok(html.includes(i18n.t('activity.none')));
    }
  }finally{i18n.setLocale('en');}
});
