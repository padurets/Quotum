import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Sessions,KEEP_MS,CREDIT_MS} from '../../server/sessions';
import {sessionPresent,runningFrom,runningChangesAt,since} from '../lib/agents';
import * as agents from '../lib/agents';
import {selector,sameJson} from '../lib/store';
import {columnShown,colorOf,AGENTS} from '../lib/view';
import {timeRangeLabel} from '../lib/timeRange';
import {t as translate} from '../i18n';
import {fixture,flush,NOW,M} from './periodRuntimeFixture';
import {tableCell} from '../components/TableCell';

const require=createRequire(import.meta.url),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const agentCode=readFileSync(new URL('../components/Agents.tsx',import.meta.url),'utf8');
const context={exports:{} as any,require,t:translate,hubNow:()=>NOW,useClock:()=>NOW,sessionPresent,runningFrom,runningChangesAt,since};
runInNewContext(ts.transpileModule(agentCode.slice(agentCode.indexOf('const stateOf ='),agentCode.indexOf('function SessionState'))+agentCode.slice(agentCode.indexOf('function RunningTime('),agentCode.indexOf('/** How many of a group'))+'\nexports.stateOf=stateOf;exports.RunningTime=RunningTime;',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
const visible=(session:any)=>({state:context.exports.stateOf(session),running:renderToStaticMarkup(React.createElement(context.exports.RunningTime,{group:{rows:[{session,source:null}]},still:false}))});

/** The actual panel selector and open dialog consume the coordinator's current rows. */
function dialog(h:Awaited<ReturnType<typeof fixture>>) {
  type Node={type:unknown;props:Record<string,any>};
  const jsx=(type:unknown,props:Record<string,any>):Node=>({type,props});
  const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
  let cursor=0;const slots:any[]=[];
  const ctx={exports:{} as any,require:()=>({jsx,jsxs:jsx,Fragment:'fragment'}),...agents,selector,sameJson,AGENTS,columnShown,colorOf,t:translate,timeRangeLabel,tableCell,
    COLUMNS:Object.fromEntries(agents.AGENT_COLUMNS.map(id=>[id,{title:'agents.'+id}])),
    useRef:(initial:any)=>slots[cursor++]??(slots[cursor-1]={current:initial}),
    useState:(initial:any)=>{const i=cursor++;if(!(i in slots))slots[i]=i===0?{group:null}:typeof initial==='function'?initial():initial;return [slots[i],(value:any)=>{slots[i]=value;}];},
    useMemo:(read:any)=>read(),useCallback:(read:any)=>read,useLayoutEffect:()=>{},useSyncExternalStore:(_subscribe:any,read:any)=>read(),
    memo:(component:any)=>component,useLocale:()=>{},useLineup:()=>h.page.get().board!.lineup,useTitles:()=>({[h.source]:{title:'Source',provider:'codex'}}),
    usePref:(key:'agentsSort'|'agentsBy'|'range')=>({agentsSort:null,agentsBy:'project',range:'1h'})[key],useTimeRange:()=>null,setPrefs:()=>{},usePeriodSessions:undefined as any,PeriodStatus:'status',SessionCoverage:'coverage',activityCell:()=>null,boardPeriod:h.period,
    useSizing:()=>null,useTableWidget:(_panel:unknown,_columns:unknown,_name:unknown,keys:string[])=>({layout:'table',from:0,to:Math.min(10,keys.length),measureFrom:0,measureTo:0}),TableGrouping:'grouping',TableMeasure:'measurement',WidgetPages:'pages',TablePages:'pager',useAgentsLayout:()=> 'table',Popover:'popover',SlidersIcon:'icon',HideRow:'hide',SwitchRow:'switch',Modal:'modal',AgentsRows:'rows',SortMenu:'sort',projectName:(value:string|null)=>value??translate('agents.noProject'),
  };
  const run=(body:string)=>runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,ctx);
  const period=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');run(period.slice(period.indexOf('const roster=')));ctx.usePeriodSessions=ctx.exports.usePeriodSessions;
  run(agentCode.slice(agentCode.indexOf('function AgentsDialog(')));
  return ()=>{cursor=0;const panel=nodes(ctx.exports.AgentsPanel({arrange:{owner:false,view:h.page.get().board!.view}}));
    const input=panel.find(n=>typeof n.type==='function'&&n.type.name==='AgentsDialog')!;
    const modal=nodes((input.type as any)(input.props));return modal.find(n=>n.type==='rows')!.props.groups[0].rows[0].session;
  };
}

for(const options of [{},{personal:true},{personal:true,privateWork:true},{personal:true,privateWork:true,unknown:true}])test(`an empty live report clears presence through the period row and actual state/running consumers ${JSON.stringify(options)}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({...options,current:true});
  try {
    const readDialog=dialog(h),before=h.period.get().rows[0];assert.ok(readDialog().currentPresence);assert.ok(before.currentPresence);assert.ok(before.presenceKey);
    assert.equal(visible(before).state,'waiting in terminal');assert.match(visible(before).running,/3h/);
    const stream=h.page.get().board!,live=before.source===null?stream.unattributedSessions![0]:stream.sessions[h.source][0];
    assert.equal(live.presenceKey,before.presenceKey,'private display-source mapping preserves the original authorized binding');
    h.endIdle();await flush();
    const after=h.period.get().rows[0];assert.equal(readDialog().currentPresence,undefined,'the already open dialog receives current presence');assert.equal(after.currentPresence,undefined);assert.equal(after.workedMs,before.workedMs);assert.equal(after.ref,before.ref);
    assert.equal(visible(after).state,'Credited work in this period; no current presence known');assert.match(visible(after).running,/—/);
    if(after.source!==null)assert.equal(h.period.getSource(h.source)[0].currentPresence,undefined,'source tray and its disclosure read the same updated row');
    assert.equal(h.requests.length,0,'an idle disappearance creates no analytical read');
  } finally {await h.close();}
});

for(const failure of [false,true])test(`an older ${failure?'failed':'completed'} period read cannot restore presence removed by a newer stream event`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({current:true});
  try {
    const readDialog=dialog(h);assert.ok(readDialog().currentPresence);
    const gate=h.hold();h.event({type:'history',data:{sources:[h.source],since:NOW-3*M}});await flush();assert.equal(h.requests.length,1);
    h.endIdle();await flush();assert.equal(h.period.get().rows[0].currentPresence,undefined);assert.equal(readDialog().currentPresence,undefined);
    if(failure)gate.reject(new Error('unavailable'));else gate.release();await flush();
    assert.equal(h.period.get().rows.length,1);assert.equal(readDialog().currentPresence,undefined);assert.equal(h.period.get().rows[0].currentPresence,undefined);assert.match(visible(h.period.get().rows[0]).running,/—/);
    assert.equal(h.requests.length,1);
  } finally {await h.close();}
});

for(const options of [{},{personal:true},{personal:true,privateWork:true},{personal:true,privateWork:true,unknown:true}])test(`idle renewals stay quiet and real lease transitions reach consumers ${JSON.stringify(options)}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({...options,current:true});
  try {
    const readDialog=dialog(h),before=h.period.get(),source=h.period.getSource(h.source);assert.ok(readDialog().currentPresence);
    let panel=0,tray=0;const stop=h.period.subscribe(()=>panel++),stopSource=h.period.subscribeSource(h.source,()=>tray++);
    for(let i=1;i<=8;i++){h.report(false,NOW+i*1000);await flush();}
    assert.equal(h.frames.filter(f=>['sessions','unattributedSessions','devices'].includes(f.type)).length,0);
    assert.equal(panel,0);assert.equal(tray,0);assert.equal(h.period.get(),before);assert.equal(h.period.getSource(h.source),source);
    assert.equal(readDialog().currentPresence,before.rows[0].currentPresence);
    assert.equal('through' in before.rows[0].currentPresence,false,'renewable leases never enter retained UI props');
    stop();stopSource();
    h.report(true,NOW+9000);await flush();assert.equal(h.period.get().rows[0].working,true);
    h.advance(NOW+9000+CREDIT_MS);let row=h.period.get().rows[0];assert.equal(row.working,false);assert.ok(row.currentPresence);
    assert.equal(readDialog().working,false,'an already open dialog receives actual CREDIT expiry');
    h.advance(NOW+9000+KEEP_MS+1);row=h.period.get().rows[0];assert.equal(row.currentPresence,undefined);
    assert.equal(readDialog().currentPresence,undefined,'the hub emits actual KEEP expiry');
    assert.equal(row.workedMs,before.rows[0].workedMs);assert.equal(h.requests.length,0);
  } finally {await h.close();}
});

for(const status of ['connecting','retrying','paused'] as const)test(`lost ${status} continuity clears only current presence until an actual snapshot`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({current:true});try{
    const before=h.period.get().rows[0],readDialog=dialog(h);
    h.page.dispatch({type:'connection',status,lostAt:NOW});
    assert.equal(readDialog().currentPresence,undefined);assert.equal(h.period.get().rows[0].workedMs,before.workedMs);
    for(const healthy of ['live','polling'] as const){h.page.dispatch({type:'connection',status:healthy,lostAt:null});assert.equal(readDialog().currentPresence,undefined,'status before snapshot cannot confirm an old list');}
    assert.equal(h.requests.length,0);
    h.disconnect();const gate=h.hold();h.reconnect();await flush();
    assert.ok(readDialog().currentPresence,'snapshot restores current presence before the analytical baseline');
    gate.release();await flush();assert.ok(readDialog().currentPresence);
  }finally{await h.close();}
});

test('stable binding distinguishes raw contexts and hub lifetimes while legacy identity stays unknown',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({current:true,stable:false});
  try {
    const row=h.period.get().rows[0];assert.equal(row.presenceKey,undefined);assert.equal(row.currentPresence,undefined);
    assert.equal(h.page.get().board!.sessions[h.source][0].presenceKey,undefined);
    const live=h.hub.ingest.live,args=[h.device,'codex',h.source,'secret-producer','terminal','raw project','raw folder'] as const;
    const key=live.binding(...args)!;assert.match(key,/^[\w-]{16}$/);assert.equal(live.binding(...args),key);
    assert.notEqual(live.binding(h.device,'codex',h.source,'twin','terminal','raw project','raw folder'),key);
    assert.notEqual(live.binding(h.device,'codex',null,'secret-producer','terminal','raw project','raw folder'),key);
    assert.notEqual(live.binding(h.device,'codex',h.source,'secret-producer','terminal','raw project','other folder'),key);
    assert.notEqual(new Sessions(h.store).binding(...args),key);
    const wire=JSON.stringify(h.fresh());assert.ok(!wire.includes('secret-producer'));assert.ok(!wire.includes('producer_id'));assert.ok(!wire.includes('sessionId'));
  } finally {await h.close();}
});

test('a fresh authorized detail read uses the same binding and latest absence',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({current:true});try{
    const row=h.period.get().rows[0],cursor=h.period.get().value.cursor;
    h.endIdle();await flush();
    const reply=JSON.parse(h.reader.details(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs:3_600_000},evaluatedAt:NOW,cursor,refs:[row.ref]}));
    assert.equal(reply.sessions.value.length,1);assert.equal(reply.sessions.value[0].presenceKey,row.presenceKey);
    assert.equal(reply.sessions.value[0].currentPresence,undefined);assert.equal(reply.sessions.value[0].workedMs,row.workedMs);
  }finally{await h.close();}
});

for(const failure of [false,true])test(`same-authority snapshot removes offline presence while analytical baseline ${failure?'fails':'waits'}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({current:true});try{
    const readDialog=dialog(h),before=h.period.get().rows[0],authority=h.page.get().board!.workAuthority;assert.ok(readDialog().currentPresence);
    h.disconnect();h.endIdle();const gate=h.hold();h.reconnect();await flush();
    if(failure){gate.reject(new Error('unavailable'));await flush();}
    assert.equal(h.page.get().board!.workAuthority,authority);assert.equal(h.period.get().rows[0].ref,before.ref);
    assert.equal(h.period.get().rows[0].workedMs,before.workedMs);assert.equal(readDialog().currentPresence,undefined);
    if(!failure){gate.release();await flush();}
  }finally{await h.close();}
});

test('display project renaming keeps the stable binding after the authorized baseline changes',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({current:true,personal:true,privateWork:true});try{
    const before=h.period.get().rows[0];h.store.nameProjects(h.owner,['Work project'],'Renamed project');h.events.flush();await flush();
    const row=h.period.get().rows[0];assert.equal(row.project,'Renamed project');assert.equal(row.presenceKey,before.presenceKey);assert.ok(row.currentPresence);
    assert.equal(h.page.get().board!.unattributedSessions![0].presenceKey,row.presenceKey);
  }finally{await h.close();}
});

test('a fixed accounting interval keeps its work while current presence disappears',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({current:true,fixed:true});try{
    const before=h.period.get();assert.ok(before.rows[0].currentPresence);h.endIdle();await flush();
    const after=h.period.get();assert.equal(after.rows[0].currentPresence,undefined);assert.equal(after.rows[0].workedMs,before.rows[0].workedMs);
    assert.deepEqual(after.basis.range,before.basis.range);assert.equal(h.requests.length,0);
  }finally{await h.close();}
});
