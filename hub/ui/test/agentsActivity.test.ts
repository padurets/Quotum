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
import * as sharedTable from '../lib/table';
import * as activity from '../lib/activity';
import * as format from '../lib/format';
import * as agents from '../lib/agents';
import * as view from '../lib/view';
import * as i18n from '../i18n';
import {EMPTY_VIEW,encodeView,decodeView,decodeUnifiedView} from '../../server/domain/view';
import {AGENTS,widgetVisible,showWidgets,WIDGETS} from '../../server/domain/widgets';
import type {ActivityDimension} from '../lib/types';
import type {WorkTrace} from '../../server/domain/periodWork';
import {fixture,NOW,M,flush} from './periodRuntimeFixture';

const ref=(id:string,device:string,project:string|null='Project')=>({ref:id,source:'s',device:{id:device,name:'Same machine'},origin:'terminal' as const,project,folder:id,startedAt:0});
const trace:WorkTrace={anchor:0,knownFrom:0,cut:200_000,refs:[ref('a','a'),ref('b','b')],spans:[[0,0,100_000],[1,50_000,150_000]]};

test('grouped columns sort union time and concurrency with unknowns last',()=>{
  const index=new PeriodIndex(trace),range={from:25_000,to:125_000},rows=index.advance(range,200_000).rows;
  const metrics=new PeriodActivity(trace,index.curves);metrics.update(rows);
  const entries=rows.map(session=>({session,source:{id:'s',provider:'codex',sessions:[]}}));
  const groups=agents.groupsOf(entries,'machine',metrics.summary(range,'device'));
  assert.deepEqual(groups.map(g=>g.activeMs),[75_000,75_000]);
  const split=[{...groups[0],workedMs:150_000,activeMs:100_000},{...groups[1],workedMs:90_000,activeMs:30_000},{...groups[0],key:'unknown',activeMs:null}];
  const order=(column:agents.AgentColumn,descending=false)=>agents.sortedGroups(split,{column,descending},agents.AGENT_COLUMNS).map(g=>g.key);
  assert.deepEqual(order('active'),['b','a','unknown']);
  assert.deepEqual(order('active',true),['a','b','unknown']);
  assert.deepEqual(order('concurrency'),['a','b','unknown']);
  assert.deepEqual(order('concurrency',true),['b','a','unknown']);
  assert.equal(agents.readAgentsSort({column:'concurrency',descending:true})?.column,'concurrency');
  assert.equal(agents.visibleAgentsSort({column:'active',descending:true},agents.columnsOf('none').rest),null);
});

function renderer(input:WorkTrace=trace){
  let savedSort:agents.AgentsSort=null,by:agents.AgentsBy='machine',owner=false,narrow=false,hidden:string[]=[],range={from:input.anchor+25_000,to:input.anchor+125_000},knownFrom=input.knownFrom,now=range.to;
  const clicks=new Map<string,()=>void>();
  const model=()=>{const work={...input,knownFrom},index=new PeriodIndex(work),rows=index.advance(range,input.cut??input.anchor+200_000).rows,metrics=new PeriodActivity(work,index.curves);metrics.update(rows);return {rows,metrics};};
  const period={activitySummaryAt:(dimension:ActivityDimension,_now?:number,key?:string)=>model().metrics.summary(range,dimension,key),activitySummaryChangesAt:()=>null,activityRangeAt:()=>range,activityCoverageChangesAt:()=>null,workedAt:(_refs:string[],ms:number)=>ms,workedChangesAt:()=>null};
  const modules:Record<string,unknown>={react:React,'react/jsx-runtime':jsxRuntime,'../lib/table':sharedTable,'../lib/activity':activity,'../lib/format':format,'../lib/agents':agents,'../lib/view':view,
    '../i18n':i18n,'../lib/prefs':{setPrefs:(change:{agentsSort?:agents.AgentsSort})=>{if('agentsSort' in change)savedSort=change.agentsSort!;},usePref:(key:string)=>key==='agentsBy'?by:key==='agentsSort'?savedSort:'1h'},
    '../lib/board':{useLineup:()=>['s'],useTitles:()=>({s:{provider:'codex',title:'Subscription'}})},'../lib/timeRange':{useTimeRange:()=>null},'../lib/clock':{useClock:()=>now,hubNow:()=>now},
    '../lib/period':{boardPeriod:period,usePeriodSessions:()=>({rows:model().rows,basis:{range},loading:false,error:null})},'./sizing':{useSizing:()=>null},'./PeriodStatus':{PeriodStatus:()=>null},
    './Popover':{Popover:()=>null},'./Kit':{Modal:({children}:{children:React.ReactNode})=>React.createElement('div',null,children)}};
  const compile=(file:string)=>{const context={exports:{} as Record<string,React.ComponentType<any>>,require:(name:string)=>modules[name]??{}};runInNewContext(ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);return context.exports;};
  modules['./TableCell']=compile('../components/TableCell.tsx');
  modules['./Time']=compile('../components/Time.tsx');
  const common=compile('../components/TableWidget.tsx'),NativeHeading=common.TableHeading,NativeWidget=common.useTableWidget as (...args:any[])=>any,NativeLayout=common.useTableLayout as (...args:any[])=>any;
  modules['./TableWidget']={...common,useTableWidget:(...args:any[])=>{const widget=NativeWidget(...args);return {...widget,layout:narrow?'list':widget.layout};},useTableLayout:(...args:any[])=>({...NativeLayout(...args),layout:narrow?'list':'table'}),TableHeading:(props:any)=>{if(props.sorting)clicks.set(props.id,()=>props.sorting.onSort(props.id));return React.createElement(NativeHeading,props);}};
  const {AgentsPanel,AgentsDialog}=compile('../components/Agents.tsx');
  const currentView=()=>({...EMPTY_VIEW,columns:{[AGENTS]:hidden},shownColumns:{[AGENTS]:['active','concurrency'].filter(id=>!hidden.includes(id))}});
  return {set:(options:Partial<{by:agents.AgentsBy;owner:boolean;narrow:boolean;hidden:string[];range:typeof range;knownFrom:number;now:number}>)=>{by=options.by??by;owner=options.owner??owner;narrow=options.narrow??narrow;hidden=options.hidden??hidden;range=options.range??range;knownFrom=options.knownFrom??knownFrom;now=options.now??now;},click:(column:string)=>clicks.get(column)!(),
    render:()=>renderToStaticMarkup(React.createElement(AgentsPanel,{arrange:{owner,view:currentView(),update:()=>{}}})),
    dialog:(chosen=false)=>{
      const groups=agents.groupsOf(model().rows.map(session=>({session,source:{id:'s',provider:'codex',title:'Subscription',sessions:[]}})),by);
      return renderToStaticMarkup(React.createElement(AgentsDialog,{groups,by,initial:chosen?groups[0].key:null,agentsSort:null,sortBy:()=>{},color:()=>({}),empty:null,period:{rows:model().rows,basis:{range},loading:false,error:null},onClose:()=>{},restore:()=>null,
        arrangement:(inGroup:boolean)=>{const {name,rest}=agents.columnsOf(by,inGroup);return {name,columns:rest.filter(column=>view.columnShown(currentView(),AGENTS,column))};}}));
    }};
}

test('actual period rows keep relative last activity and exact hover times across grouping, layouts and dialogs in EN/RU',()=>{
  const anchor=new Date(2026,9,19,12).getTime(),r=renderer({...trace,anchor,knownFrom:anchor,cut:anchor+200_000});
  try {
    for(const locale of ['en','ru'] as const)for(const by of ['project','machine','subscription','none'] as const)for(const narrow of [false,true]) {
      i18n.setLocale(locale);r.set({by,narrow,now:anchor+425_000});
      for(const html of [r.render(),r.dialog(),...(by==='none'?[]:[r.dialog(true)])]) {
        const cells=[...html.matchAll(/<span data-time="activity" title="([^"]+)">([^<]+)<\/span>/g)];
        assert.ok(cells.length,`${locale}/${by}/${narrow}: retained period rows render the actual relative time component`);
        for(const [,title,text] of cells) {
          assert.equal(text,i18n.t('time.minutesAgo',{n:5}));
          assert.ok([100_000,125_000].some(offset=>title===format.stamp(anchor+offset)),title);
        }
        for(const footer of html.matchAll(/<footer\b[^>]*>(.*?)<\/footer>/gs))assert.ok(!footer[1].includes('data-time="activity"'),'totals contain period metrics, not a last-activity timestamp');
      }
    }
  } finally {i18n.setLocale('en');}
});

test('the actual sessions table renders union metrics and separate whole-period totals in EN/RU',()=>{
  const r=renderer();try{
    for(const locale of ['en','ru'] as const){
      i18n.setLocale(locale);r.set({by:'machine',hidden:[],range:{from:25_000,to:125_000},knownFrom:0});let html=r.render();
      assert.ok(html.includes(i18n.t('agents.title'))&&html.includes(i18n.t('agents.concurrency')));
      assert.ok(!html.includes('class="panel-empty"'), 'a populated table must not reserve an empty-state block');
      assert.match(html,/<p class="analytics-note" data-time="working-count">/);
      assert.equal((html.match(/data-agents-group=/g)??[]).length,2);
      const footer=html.match(/<footer[^>]*class="table-footer"[^>]*>(.*?)<\/footer>/)![1];
      assert.equal((footer.match(/<dt class="sr-only"/g)??[]).length,4, 'wide totals reuse their column headings');
      assert.ok(footer.includes(i18n.t('table.summary'))&&footer.includes(format.workHours(150_000))&&footer.includes(format.workHours(100_000))&&footer.includes(activity.atOnce(150_000,100_000)));
      assert.ok(!html.includes('aria-sort='));
      r.set({hidden:['active','concurrency']});html=r.render();assert.ok(!html.includes('data-table-metric="active"')&&!html.includes('data-time="session-activity"'));
      r.set({hidden:[],by:'none'});html=r.render();assert.ok(!html.includes('data-time="session-activity"'));
      r.set({by:'machine',range:{from:160_000,to:170_000},knownFrom:175_000});html=r.render();assert.ok(html.includes(i18n.t('activity.knownFrom',{time:format.stamp(175_000)})));
      for(const id of ['sessions','worked','active','concurrency'])assert.match(html,new RegExp('<dd[^>]*data-table-metric="'+id+'"[^>]*>—</dd>'));
      assert.ok(html.includes(i18n.t('agents.machineSummary',{working:'—',count:'—'})));
      r.set({narrow:true,range:{from:25_000,to:125_000},knownFrom:0});html=r.render();
      const compact=html.match(/<ul class="agents-compact[^>]*>(.*?)<\/ul>/s)![1];
      assert.ok(compact.includes(i18n.t('agents.worked'))&&compact.includes(i18n.t('agents.lastActivity')),compact);
      assert.ok(!compact.includes(i18n.t('activity.active'))&&!compact.includes(i18n.t('agents.concurrency')));
      assert.ok(!compact.includes('data-time="session-activity"'));
      assert.ok(html.includes('data-table-metric="active"')&&html.includes('data-table-metric="concurrency"'));
      const compactFooter=html.match(/<footer[^>]*class="table-footer is-list"[^>]*>(.*?)<\/footer>/)![1];
      assert.ok(!compactFooter.includes('<dt class="sr-only"'), 'compact totals retain their labels');
      r.set({narrow:false});
    }
  }finally{i18n.setLocale('en');}
});

test('one sessions table fits a bounded page while its footer counts the complete period',()=>{
  const refs=Array.from({length:57},(_,i)=>ref('context-'+i,'device-'+i,'Project '+i)),r=renderer({...trace,refs,spans:refs.map((_,i)=>[i,0,100_000])});
  const html=r.render(),footer=html.match(/<footer[^>]*class="table-footer"[^>]*>(.*?)<\/footer>/)![1];
  assert.equal((html.match(/data-agents-group=/g)??[]).length,sharedTable.TABLE_PAGE_ROWS);
  assert.ok(footer.includes('data-table-metric="sessions"')&&/<dd[^>]*data-table-metric="sessions"[^>]*>57<\/dd>/.test(footer));
  assert.ok(html.includes(i18n.t('agents.machineSummary',{working:0,count:57})));
  assert.ok(!footer.includes('working-count'));
  assert.ok(html.includes('1 / 6'));
  const pages=footer.match(/<div class="table-footer-pages">(.*?)<\/nav><\/div>/)![1];
  assert.ok(pages.includes(i18n.t('table.rows',{count:57}))&&pages.includes('1 / 6'));
});

test('every grouped header uses the existing ascending, descending, reset cycle',()=>{
  const r=renderer(),order=(html:string)=>[...html.matchAll(/data-agents-group="([^"]+)"/g)].map(match=>match[1]),expected=order(r.render());
  for(const column of ['machine','agents','worked','active','concurrency','activity']){
    r.click(column);assert.ok(r.render().includes('aria-sort="ascending"'));
    r.click(column);assert.ok(r.render().includes('aria-sort="descending"'));
    r.click(column);const html=r.render();assert.ok(!html.includes('aria-sort='));assert.deepEqual(order(html),expected);
  }
});

test('comparison groups, total and retained contributions share exact clipped work in every dimension',()=>{
  const range={from:25_000,to:125_000},index=new PeriodIndex(trace),rows=index.advance(range,200_000).rows;
  const metrics=new PeriodActivity(trace,index.curves);metrics.update(rows);
  for(const by of ['project','device','source'] as const){
    const summary=metrics.summary(range,by);
    assert.deepEqual([summary.agentMs,summary.activeMs,summary.agents],[150_000,100_000,2]);
    for(const group of summary.by[by]){
      const contributing=rows.filter(row=>(by==='project'?JSON.stringify(row.project):by==='device'?row.device.id:row.source??'unknown')===group.key);
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

test('one established sessions widget keeps placements, v3 aliases and independent owner columns',()=>{
  assert.equal(WIDGETS.filter(id=>id===AGENTS).length,1);
  assert.ok(!WIDGETS.includes('activity-table' as any));
  const original=showWidgets({...EMPTY_VIEW,layout:{columns:6,places:{agents:{x:0,y:0,w:6,h:12}}}},[AGENTS]);
  const enabled=view.withColumn(view.withColumn(original,AGENTS,'active',true),AGENTS,'concurrency',true);
  assert.deepEqual(enabled.layout,original.layout);
  assert.equal(widgetVisible(enabled,AGENTS,0),true);
  assert.equal(view.columnShown(EMPTY_VIEW,AGENTS,'active'),false);
  assert.equal(view.columnShown(enabled,AGENTS,'active'),true);
  assert.equal(view.columnShown(enabled,AGENTS,'concurrency'),true);
  assert.deepEqual(decodeView(encodeView(enabled)),enabled);
  assert.equal(decodeUnifiedView([3,[[0,3],[1,3],[2,3],[3,3],[4,3],[5,3],[6,3]],4,[127]])!.shown.length,7);
  assert.deepEqual(agents.columnsOf('none').rest,['client','worked','activity','machine','subscription','running']);
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
    assert.equal(activity.activityCoverage(h.period.activitySummaryAt('project',NOW+1),h.period.activityRangeAt(NOW+1).from),null,'a stale publication basis must not invent an unknown prefix');
    const pending=h.hold();h.settings.range='6h';h.period.changed();await flush();
    assert.equal(h.period.get().loading,true);
    const retained=h.period.activitySummaryAt('project',NOW)!;
    assert.deepEqual({...retained,by:before.by},before);
    assert.deepEqual(retained.by.project,before.by.project);
    assert.deepEqual(h.period.get().basis,basis);
    assert.equal(h.period.activitySummaryChangesAt('project',NOW,()=>''),null,'retained scalars are frozen while replacement is pending');
    assert.equal(h.period.activityCoverageChangesAt(NOW),null);
    h.period.refreshWorkClock();assert.deepEqual(h.period.get().basis,basis);
    pending.release();await flush();assert.equal(h.period.get().loading,false);
    assert.equal(h.period.activitySummaryAt('project',NOW).agentMs,M);
    assert.equal(h.period.get().basis.range.from,NOW-6*60*M);
    const since=h.period.activitySummaryAt('project',NOW).since,deadline=since+6*60*M;
    assert.ok(activity.activityCoverage(h.period.activitySummaryAt('project',deadline-1),h.period.activityRangeAt(deadline-1).from));
    assert.equal(h.period.activityCoverageChangesAt(NOW),deadline);
    assert.equal(activity.activityCoverage(h.period.activitySummaryAt('project',deadline),h.period.activityRangeAt(deadline).from),null);
    h.event({type:'history',data:{sources:[],since:NOW,workSince:NOW,workAuthority:'replacement'}});await flush();
    h.period.activate(false);assert.equal(h.period.activitySummaryAt('project',NOW),null);
  }finally{await h.close();}
});

test('hiding Recorded sessions removes grouped footer metrics in both layouts while keeping row count, paging and None totals',()=>{
 const r=renderer();try{
  for(const locale of ['en','ru'] as const)for(const narrow of [false,true])for(const by of ['project','machine','subscription'] as const){
   i18n.setLocale(locale);r.set({by,owner:true,narrow,hidden:[]});let html=r.render();assert.ok(html.includes('data-table-metric="sessions"'));
   r.set({hidden:['agents']});html=r.render();assert.ok(!html.includes('data-table-metric="sessions"'),`${locale}/${by}/${narrow}: hidden metric stays hidden in the footer`);
   assert.ok(html.includes('data-table-metric="worked"'));assert.ok(html.includes(i18n.t('table.rows',{count:by==='machine'?2:1})));assert.ok(html.includes('class="table-pages"'));
   r.set({hidden:[]});assert.ok(r.render().includes('data-table-metric="sessions"'));
  }
  r.set({by:'none',narrow:true,hidden:['agents']});assert.ok(r.render().includes('data-table-metric="sessions"'),'None keeps its deliberate complete-context summary without a grouped count column');
 }finally{i18n.setLocale('en');}
});
