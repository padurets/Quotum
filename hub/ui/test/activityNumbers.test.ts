import {projectColorBindings} from './projectColorBindings';
import {ACTIVITY} from '../../server/domain/widgets';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {PageClock} from '../lib/clock';
import {num,workHours,stamp} from '../lib/format';
import {atOnce,activitySeriesKey} from '../lib/activity';
import {t,setLocale} from '../i18n';
import {cellLabel} from '../lib/periods';
import {PeriodActivity} from '../lib/periodActivity';
import {PeriodCurves,WorkTimeline} from '../../server/domain/periodCurves';
import type {History} from '../../server/domain/history';
import type {WorkTrace} from '../../server/domain/periodWork';
import {fixture,drawings,NOW,H,M} from './periodRuntimeFixture';
import {preparationFixture} from './preparationFixture';
import {activityEmpty,groupColors,activityGroupName as groupName} from '../lib/activity';
import {flush} from './periodRuntimeFixture';
import {CHART_SERIES_SCENES} from '../../demo/catalogue';
import {groupRegistry} from '../lib/plotRegistry';

const require=createRequire(import.meta.url),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
const clockSource=readFileSync(new URL('../lib/clock.ts',import.meta.url),'utf8');
const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;

/** Persistent hook slots, real PageClock subscriptions and the production numerical renderer. */
function consumer(name:string,clock:PageClock,period:any,initial:any,panning:()=>number|null=()=>null) {
  let cursor=0,dirty=true,renders=0,props=initial,output='',node:any;
  const focus={get:()=>null,subscribe:()=>()=>{}};
  props={focus,titles:{},...props};
  const slots:any[]=[],effects:(()=>void)[]=[],stops:(()=>void)[]=[];
  const slot=(create:()=>any)=>{const at=cursor++;return slots[at]??(slots[at]=create());};
  const useRef=(current:any)=>slot(()=>({current}));
  const context:any={...projectColorBindings(),ACTIVITY,exports:{},require,memo:(value:any)=>value,useLocale:()=>{},usePanning:panning,boardPeriod:period,
    useId:()=> 'legend-description',seriesFocusStyle:()=>({}),useRef,useState:(initial:any)=>{const box=slot(()=>({value:typeof initial==='function'?initial():initial}));return [box.value,(value:any)=>{box.value=value;dirty=true;}];},
    useSyncExternalStore:(subscribe:any,read:any)=>{const box=slot(()=>{const value={current:read()};stops.push(subscribe(()=>{const next=read();if(!Object.is(next,value.current)){value.current=next;dirty=true;}}));return value;});return box.current=read();},
    LABELS:{source:'activity.bySource',project:'activity.byProject',device:'activity.byDevice'},groupName,useLayoutEffect:(effect:any)=>effects.push(effect),clock,hubNow:clock.hubNow,num,workHours,stamp,atOnce,activitySeriesKey,t,cellLabel,
    Tooltip:({children}:any)=>React.createElement('div',{className:'tooltip'},children),
  };
  runInNewContext(compile(clockSource.slice(clockSource.indexOf('export function useClock'))),context);context.useClock=context.exports.useClock;
  const numbers=source.slice(source.indexOf('function Metrics('),source.indexOf('/** Keyboard descriptions'));
  const totals=source.slice(source.indexOf('const Totals=memo'),source.indexOf('/**\n * Agent-hours'));
  const readout=source.slice(source.indexOf('function ActivityReadout('),source.indexOf('const Stacks ='));
  const legend=source.slice(source.indexOf('const LegendItem = memo'),source.indexOf('/** Only this small region'));
  runInNewContext(compile(numbers+legend+totals+readout+`\nexports.component=${name};`),context);
  const render=()=>{if(dirty){dirty=false;cursor=0;node=context.exports.component(props);output=renderToStaticMarkup(node);renders++;while(effects.length)effects.shift()!();}return output;};
  return {render,focus:(visible:boolean)=>node.props.children[0].props.onFocus({currentTarget:{matches:()=>visible}}),update:(next:any)=>{props={focus,titles:{},...next};dirty=true;return render();},get renders(){return renders;},close:()=>stops.forEach(stop=>stop())};
}

test('a mouse-focused legend keeps its own metric description when keyboard modality changes',async test=>{
  test.mock.method(Date,'now',()=>NOW);setLocale('en');const h=await fixture(),d=await drawings(h);
  const history=d.render().history!,group=history.activity.by.project[0],clock=new PageClock({now:()=>NOW,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
  const props={history,by:'project',groupKey:group.key,group,name:'Work project',color:'red'},view=consumer('LegendItem',clock,h.period,props);
  try{
    assert.ok(view.render().includes('aria-pressed="false"'));view.focus(false);
    const focused=view.render();
    for(const key of ['activity.agentHours','activity.active','activity.agents','activity.atOnce'] as const)assert.ok(focused.includes(t(key)),key);
    assert.ok(focused.includes('aria-describedby="legend-description"'));
    view.focus(true);assert.equal(view.render(),focused);
  }finally{view.close();d.close();await h.close();}
});

for(const periodName of ['1h','30d'])test(`${periodName}: PageClock updates final Activity numbers while drawing inputs stay unchanged`,async test=>{
  test.mock.method(Date,'now',()=>NOW);setLocale('en');
  const periodMs=periodName==='1h'?H:30*24*H;
  const from=periodName==='1h'?NOW-3*M:NOW-periodMs+M,to=from+90_000;
  const h=await fixture({periodName,creditFrom:from,creditTo:to}),d=await drawings(h);
  let now=NOW;const timers=new Map<object,{at:number;run:()=>void}>();
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const token={};timers.set(token,{at:now+ms,run});return token;},clearTimeout:token=>{timers.delete(token as object);}});
  const drawn=d.render(),history=drawn.history!;assert.equal(history.activity.agents,1);
  const group=history.activity.by.project[0],base={history,by:'project',groupKey:group.key,group,since:null};
  const totals=consumer('Totals',clock,h.period,base),amount=consumer('LegendAmount',clock,h.period,base),metrics=consumer('LegendMetrics',clock,h.period,{...base,active:true});
  const hover=Math.floor(to/history.activity.barMs)*history.activity.barMs;
  const readout=consumer('ActivityReadout',clock,h.period,{...base,hover,barMs:history.activity.barMs,bar:[hover,90_000,90_000,1],parts:[{key:group.key,name:'Work project',color:'red',ms:90_000}],tipProps:{}});
  const readers=[totals,amount,metrics,readout];
  const render=()=>readers.map(reader=>reader.render());
  const advance=(at:number)=>{for(let count=0;;count++){assert.ok(count<10000);const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>at)break;now=next[1].at;h.advance(now);timers.delete(next[0]);next[1].run();render();}now=at;h.advance(now);render();};
  try {
    const before=render();assert.match(before[0],/Recorded sessions<\/span><b>1/);assert.match(before[2],/>1<\/strong>/);assert.ok(before[3]);
    h.requests.length=0;
    advance(to+periodMs+250);
    assert.equal(h.period.get().rows.length,0);
    assert.match(totals.render(),/Recorded sessions<\/span><b>0/,'expired work leaves a confirmed zero in the stable information area');
    assert.match(amount.render(),new RegExp('>'+workHours(0)+'</b>'));
    assert.ok(!metrics.render().includes('>1</strong>'),'the already open legend metrics retire membership');
    assert.equal(readout.render(),'','a stationary readout retires its clipped work');
    assert.equal(d.render().drawing,drawn.drawing,'numerical wakes retain the prepared drawing input');
    assert.equal(h.requests.length,0);
    const counts=readers.map(reader=>reader.renders);advance(now+H);assert.deepEqual(readers.map(reader=>reader.renders),counts,'empty numerical consumers have no polling wake');
  } finally {readers.forEach(reader=>reader.close());d.close();await h.close();}
});

test('numerical labels freeze during a gesture and retire on an authority replacement',async test=>{
  test.mock.method(Date,'now',()=>NOW);const h=await fixture(),d=await drawings(h);let now=NOW,panning:number|null=1;
  const timers=new Set<object>();const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:()=>{const token={};timers.add(token);return token;},clearTimeout:token=>{timers.delete(token as object);}});
  const history=d.render().history,props={history,by:'project',since:null},totals=consumer('Totals',clock,h.period,props,()=>panning);
  try {
    const before=totals.render();assert.ok(before);assert.equal(timers.size,0);
    now=NOW+H;h.advance(now);assert.equal(totals.render(),before);
    panning=null;assert.ok(!totals.update(props).includes('Recorded sessions</span><b>1'));
    assert.ok(!totals.update({...props,history:null}).includes('Recorded sessions</span><b>1'),'retired input cannot retain old numerical work');
  }finally{totals.close();d.close();await h.close();}
});

test('a closed legend defers metrics and reads current work when focused, distinguishing unavailable from zero',async test=>{
  test.mock.method(Date,'now',()=>NOW);setLocale('en');
  const h=await fixture(),d=await drawings(h);let now=NOW,timers=0,amountTimers=0;
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:()=>{timers++;return {};},clearTimeout:()=>{}});
  const amountClock=new PageClock({now:()=>now,visible:()=>true,setTimeout:()=>{amountTimers++;return {};},clearTimeout:()=>{}});
  const history=d.render().drawing!,group=history.activity.by.project[0];
  const props={history,by:'project',groupKey:group.key,group,name:'Work project',color:'red',muted:false};
  const legend=consumer('LegendItem',clock,h.period,props);
  const amount=consumer('LegendAmount',amountClock,h.period,props);
  try {
    amount.render();
    assert.ok(!legend.render().includes('data-time="activity-metrics"'));
    now=NOW+H;h.advance(now);
    assert.equal(h.period.get().rows.length,0);
    assert.ok(!legend.update(props).includes('data-time="activity-metrics"'));
    amount.update(props);
    assert.equal(timers,amountTimers,'a closed legend adds no clock work beyond its visible amount');
    legend.focus(true);
    assert.ok(legend.render().includes(`>${t('activity.agents')}</span><strong>0</strong>`),'opening metrics cannot restore expired work from the retained drawing');
    assert.ok(legend.update({...props,history:null,group:null}).includes(t('activity.pendingRange')),'unavailable work is distinct from confirmed zero');
  }finally{legend.close();amount.close();d.close();await h.close();}
});

test('fixed-period numerical consumers never subscribe to a time deadline',async test=>{
  test.mock.method(Date,'now',()=>NOW);const h=await fixture({fixed:true});let timers=0;
  const clock=new PageClock({now:()=>NOW,visible:()=>true,setTimeout:()=>{timers++;return {};},clearTimeout:()=>{}});
  const history={range:`${NOW-H}/${NOW}`,activity:{known:{from:NOW-H,to:NOW},activeMs:M,agentMs:M,agents:1,by:{project:[],source:[],device:[]}}} as unknown as History;
  history.range=h.period.workRangeKey;
  const totals=consumer('Totals',clock,h.period,{history,by:'project',since:null});
  try{assert.ok(totals.render());assert.equal(timers,0);}finally{totals.close();await h.close();}
});

test('many legend groups read only their own contexts rather than every session per group',()=>{
  const count=96,trace:WorkTrace={anchor:0,knownFrom:0,refs:Array.from({length:count},(_,i)=>({ref:String(i),source:'source',device:{id:'d',name:'Device'},origin:'terminal',project:String(i),folder:null,startedAt:0})),spans:Array.from({length:count},(_,i)=>[i,0,90_000])};
  const curves=new PeriodCurves(trace),activity=new PeriodActivity(trace,curves),base={known:{from:0,to:90_000},by:{source:[],project:[],device:[]},cells:[],barMs:M,since:0,activeMs:0,agentMs:0,agents:0};
  let reads=0,nexts=0;const read=WorkTimeline.prototype.read,next=WorkTimeline.prototype.next;
  WorkTimeline.prototype.read=function(...args){reads++;return read.apply(this,args);};WorkTimeline.prototype.next=function(...args){nexts++;return next.apply(this,args);};
  try{
    for(let i=0;i<count;i++){const key=JSON.stringify(String(i));assert.equal(activity.numbers(base,{from:0,to:90_000},'project',key).by.project[0].agents,1);activity.changesAt(90_000,H,'project',key);}
    assert.ok(reads<=count*5,`${reads} timeline reads for ${count} groups`);assert.equal(nexts,count*2);
  }finally{WorkTimeline.prototype.read=read;WorkTimeline.prototype.next=next;}
});

test('the actual summary always describes the board cohort; transient preview describes one exact group in EN/RU',async test=>{
  test.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true}),d=await drawings(h),seen=new Set<string>();
  let selected:string|null=null;
  try{
    for(const [project,from,to] of [['A',NOW-50*M,NOW-30*M],['B',NOW-40*M,NOW-20*M],['C',NOW-20*M,NOW-10*M]] as const){
      h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
    }
    h.events.flush();await flush();
    const history=d.render().history!,clock=new PageClock({now:()=>NOW,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
    const focus={get:()=>selected,subscribe:()=>()=>{}},props={history,by:'project',since:null,focus};
    const expected=history.activity;
    for(const locale of ['en','ru'] as const){
      setLocale(locale);const view=consumer('Totals',clock,h.period,props);
      try{
        const html=view.render();assert.ok(html.includes('data-agent-ms="'+expected.agentMs+'"'));assert.ok(html.includes(workHours(expected.activeMs)));assert.ok(html.includes(t('activity.agents')+'</span><b>'+expected.agents));
        seen.add('board-summary');seen.add('exact-union');seen.add('distinct-sessions');
        selected=activitySeriesKey('project','"A"');const preview=view.update(props);assert.ok(preview.includes('data-series-context='));assert.ok(preview.includes('data-agent-ms="1200000"'));assert.ok(preview.includes(t('activity.agents')+'</span><b>1'));seen.add('one-group-preview');
        selected=null;assert.equal(view.update(props),html,'leaving preview restores the complete board cohort');
        seen.add('restored-summary');
      }finally{view.close();}
    }
    for(const scene of CHART_SERIES_SCENES)for(const code of scene.expect)assert.ok(seen.has(code),scene.id+': '+code);
  }finally{setLocale('en');d.close();await h.close();}
});

test('a retained legend identity previews confirmed zero when its work leaves the selected interval',async test=>{
  test.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true}),d=await drawings(h);
  try{
    for(const [project,from,to] of [['A',NOW-50*M,NOW-30*M],['B',NOW-20*M,NOW-10*M]] as const)
      h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
    h.events.flush();await flush();
    const initial:History=d.renderActivity().drawing!,seed=initial.activity.by.project.map(group=>({...group,color:'#aaa'}));
    const range={from:NOW-25*M,to:NOW-5*M};h.selectRange(range);d.loader.choose('1h',range);await flush();
    const history:History=d.renderActivity().drawing!,groups=history.activity.by.project;
    assert.ok(history.activity.agentMs>0);assert.ok(!groups.some(group=>group.key==='"A"'));
    assert.ok(groupRegistry(seed,seed,groups).some(group=>group.key==='"A"'),'the current strip can retain A as a valid legend target');
    let selected:string|null=activitySeriesKey('project','"A"');
    const focus={get:()=>selected,subscribe:()=>()=>{}};
    const clock=new PageClock({now:()=>NOW,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
    const view=consumer('Totals',clock,h.period,{history,by:'project',since:null,focus});
    try{
      const html=view.render();assert.ok(html.includes('data-series-context='));assert.ok(html.includes('data-agent-ms="0"'),'an absent preview must not borrow the positive board cohort');
      assert.ok(html.includes(t('activity.agents')+'</span><b>0'));
      for(const label of ['activity.agentHours','activity.active'] as const)assert.ok(html.includes(t(label)+'</span><b>'+workHours(0)));
      assert.ok(html.includes(t('activity.atOnce')+'</span><b>—'));
      const unknown=view.update({history:{...history,activity:{...history.activity,known:null}},by:'project',since:null,focus});
      assert.ok(!unknown.includes('data-agent-ms='));assert.ok(unknown.includes(t('activity.knownFrom',{time:stamp(history.activity.since)})));
      const unavailable=view.update({history:{...history,activity:{...history.activity,available:false}},by:'project',since:null,focus});
      assert.ok(!unavailable.includes('data-agent-ms='));assert.ok(unavailable.includes(t('activity.noSessions')));
      selected=null;assert.ok(view.update({history,by:'project',since:null,focus}).includes('data-agent-ms="'+history.activity.agentMs+'"'));
    }finally{view.close();}
  }finally{d.close();await h.close();}
});

test('the Activity clock advances the plot without invalidating unchanged numerical consumers',async test=>{
  test.mock.method(Date,'now',()=>NOW);const h=await fixture(),d=await drawings(h),hooks=preparationFixture();
  let now=NOW,shown={...d.render(),presentation:0};
  const prefs={range:'1h',activityBy:'project'},titles={},view=h.page.get().board!.view;
  const context:any={...projectColorBindings(h.page),ACTIVITY,exports:{},require,memo:(value:any)=>value,...hooks,
    useMemo:(read:any,deps:any[])=>{const box=hooks.useRef(null) as any;if(!box.current||deps.some((v,i)=>!Object.is(v,box.current.deps[i])))box.current={deps,value:read()};return box.current.value;},
    useActivityHistory:()=>shown,useHistoryPlot:()=>null,usePlot:()=>({}),useLineup:()=>[],usePersonalBoard:()=>false,useTitles:()=>titles,
    usePref:(key:keyof typeof prefs)=>prefs[key],useSeriesFocus:()=>{},useLocale:()=> 'en',useTimeRange:()=>null,useBoardId:()=>h.board,useClock:()=>now,usePanning:()=>null,useHistoryBegins:()=>0,
    axisNavigation:()=>({context:h.board,range:'1h'}),frameOf:()=>({from:now-H,to:now}),measuredTo:()=>now,
    activityEmpty,groupColors,groupName:(group:any)=>group.name,activitySeriesKey,stamp,t,useLayoutEffect:hooks.useLayoutEffect,
    isHidden:()=>false,cardId:(id:string)=>id,quotaHistory:{},setTimeRange:()=>{},pan:{get:()=>null},
    AnalyticsPanel:()=>null,ActivitySettings:()=>null,Totals:()=>null,Stacks:()=>null,LegendItem:()=>null,EMPTY_ACTIVITY:shown.history!.activity,
  };
  runInNewContext(compile(source.slice(source.indexOf('export const Activity ='),source.indexOf('/** How tall'))),context);
  const find=(node:any,type:any):any=>Array.isArray(node)?node.flatMap(part=>find(part,type)):React.isValidElement(node)?[...(node.type===type?[node]:[]),...find((node.props as any).children,type)]:[];
  const render=()=>{hooks.begin();const node=context.exports.Activity({arrange:{view}});hooks.commit();return {totals:find(node,context.Totals)[0].props,legend:find(node,context.LegendItem).map((entry:any)=>entry.props),plot:find(node,context.Stacks)[0].props};};
  try{
    render();hooks.finish();const before=render();assert.equal(before.legend.length,1);
    now+=5*M;h.advance(now);shown={...shown,history:h.period.project(shown.history,'quota',now)};
    const moved=render();assert.ok(moved.plot.to>before.plot.to,'the actual plot still advances at its grid edge');
    for(const name of ['history','group'] as const)assert.equal(moved.legend[0][name],before.legend[0][name],`${name} cannot restart a legend formatted deadline on a drawing-only wake`);
    assert.equal(moved.totals.history,before.totals.history,'exact totals keep their independent numerical deadline');
    shown={...shown,history:null,drawing:null,presentation:1};const retired=render();
    assert.equal(retired.legend.length,0);assert.equal(retired.totals.history,null,'a new authority cannot retain withdrawn numerical evidence');
  }finally{d.close();await h.close();}
});
