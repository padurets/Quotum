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
import {namedCardsOf,titlesOf} from '../lib/board';
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

/** Actual board hooks and store selectors; the hook host only reads and subscribes. */
function boardConsumers(h:Awaited<ReturnType<typeof fixture>>) {
  const cells:{notifications:number;reads:number;value:unknown;stop:()=>void}[]=[];
  const react={useMemo:(read:()=>unknown)=>read(),useRef:(value:unknown)=>({current:value}),
    useState:(value:unknown)=>[typeof value==='function'?value():value,()=>{}],
    useSyncExternalStore:(subscribe:(listener:()=>void)=>()=>void,read:()=>unknown)=>{
      const cell={notifications:0,reads:0,value:read(),stop:()=>{}};
      cell.stop=subscribe(()=>{cell.notifications++;cell.reads++;cell.value=read();});cells.push(cell);return cell.value;
    }};
  const store={exports:{} as any,require:()=>react};
  const compile=(url:URL)=>ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  runInNewContext(compile(new URL('../lib/store.ts',import.meta.url)),store);
  const boardRequire=createRequire(new URL('../lib/board.ts',import.meta.url));
  const board={exports:{} as any,require:(id:string)=>id==='react'?react:id==='./store'?{...store.exports,createStore:()=>h.page}:boardRequire(id)};
  runInNewContext(compile(new URL('../lib/board.ts',import.meta.url)),board);
  const api=board.exports;
  api.useCard(h.source);api.useMine(h.source);api.useTitle(h.source,h.page.get().board!.view.names);api.useCadence(h.source);api.useRefresh(h.source);
  for(let i=0;i<4;i++)api.useNamed(undefined,'quota');
  const count=cells.length,card=cells[0],titles=cells[6];
  api.useDeviceContact(h.device,NOW);const contact=cells.at(-1)!;
  api.useRole();const role=cells.at(-1)!;
  api.useConnection();const connection=cells.at(-1)!;
  api.useApp();const app=cells.at(-1)!;
  api.useResetNews();const resets=cells.at(-1)!;
  return {card,titles,contact,role,connection,app,resets,
    read:()=>({notifications:cells.slice(0,count).reduce((sum,cell)=>sum+cell.notifications,0),reads:cells.slice(0,count).reduce((sum,cell)=>sum+cell.reads,0)}),
    again:()=>{api.useCard(h.source);return cells.at(-1)!;},
    close:()=>cells.forEach(cell=>{cell.stop();cell.stop=()=>{};})};
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

test('device contacts update their own state without projecting period demand again',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({personal:true,current:true,clocked:true});
  try{
    const before=h.period.get(),board=h.page.get().board,tape=h.period.tapes.get('quota'),bytes=h.pool.estimatedBytes;
    assert.ok(tape);
    const source=board!.cards[h.source],windows=source.windows,used=windows[0].used;
    const windowsProperty=Object.getOwnPropertyDescriptor(source,'windows')!,usedProperty=Object.getOwnPropertyDescriptor(windows[0],'used')!;
    let windowReads=0,valueReads=0;
    Object.defineProperty(source,'windows',{enumerable:true,configurable:true,get:()=>{windowReads++;return windows;}});
    Object.defineProperty(windows[0],'used',{enumerable:true,configurable:true,get:()=>{valueReads++;return used;}});
    // Both chart/table pairs subscribe through this same selector and equality check.
    const readers=Array.from({length:4},()=>selector(h.page,()=>({select:state=>namedCardsOf(state,'quota'),equal:sameJson})));
    const selected=readers.map(read=>read()),stops=readers.map(read=>h.page.subscribe(read));
    assert.equal(selected[0].find(card=>card.id===h.source)!.windows[0].used,used);
    assert.ok(windowReads>0&&valueReads>0,'the initial consumers read the real source and its quota value');
    windowReads=valueReads=0;
    const names=board!.view.names,namesJSON=JSON.stringify(names),namesProperty=Object.getOwnPropertyDescriptor(names,'toJSON');
    let nameSerializations=0;
    Object.defineProperty(names,'toJSON',{configurable:true,value:()=>{nameSerializations++;return {...names};}});
    assert.equal(JSON.stringify(names),namesJSON,'the witness preserves the saved names');
    // One name reader per card, and one shared name reader for each chart/table.
    const titleReaders=Array.from({length:board!.lineup.length+4},()=>selector(h.page,()=>({select:state=>titlesOf(state.board,state.board?.view.names),equal:Object.is})));
    const titleSelection=titleReaders.map(read=>read()),titleStops=titleReaders.map(read=>h.page.subscribe(read));
    assert.equal(titleSelection[0][h.source].provider,source.provider);
    let activePageSubscriptions=0;
    const subscribe=h.page.subscribe;
    t.mock.method(h.page,'subscribe',(listener:()=>void)=>{activePageSubscriptions++;const stop=subscribe(listener);return()=>{activePageSubscriptions--;stop();};});
    const hooks=boardConsumers(h);
    windowReads=valueReads=0;
    nameSerializations=0;
    const queries=t.mock.method(h.period,'queries');
    let published=0;const stop=h.period.subscribe(()=>published++);
    try{
      for(let i=1;i<=8;i++)h.event({type:'deviceContacts',data:{devices:[{deviceId:h.device,lastSeenAt:NOW+i*1000}]}});
      await flush();
      const contactProjections=queries.mock.callCount();
      const contactReads={windowReads,valueReads};
      const contactNameSerializations=nameSerializations;
      const contactHookReads=hooks.read();
      assert.equal(hooks.contact.notifications,8,'the actual contact hook still hears every accepted renewal');
      assert.equal(hooks.contact.value,NOW+8000);
      assert.equal(h.page.get().deviceContacts![h.device],NOW+8000);
      assert.equal(h.page.get().board,board);assert.equal(h.period.get(),before);
      assert.equal(h.period.tapes.get('quota'),tape);assert.equal(h.pool.estimatedBytes,bytes);
      assert.equal(published,0);assert.equal(h.requests.length,0);
      h.event({type:'history',data:{sources:[h.source],since:NOW-3*M}});await flush();
      assert.equal(h.requests.length,1,'a subsequent history event still reads its new evidence');
      assert.ok(queries.mock.callCount()>contactProjections);
      assert.equal(contactProjections,0,'contacts must not rebuild unchanged analytical selections');
      assert.deepEqual(readers.map(read=>read()),selected);
      assert.deepEqual(contactReads,{windowReads:0,valueReads:0},'contacts must not rebuild or serialize unchanged UI quota cards');
      assert.deepEqual(titleReaders.map(read=>read()),titleSelection);
      assert.equal(contactNameSerializations,0,'contacts must not serialize unchanged saved names again');
      assert.deepEqual(contactHookReads,{notifications:0,reads:0},'unchanged boards must not notify their UI hooks or read their selectors');
      assert.equal(activePageSubscriptions,6,'all thirteen board consumers share one page subscription; five global consumers remain independent');

      const retained=h.page.get().board;
      h.page.dispatch({type:'session-boards',boards:h.page.get().boards!.map(board=>({...board,role:'member'}))});
      assert.equal(hooks.role.value,'member');
      h.page.dispatch({type:'connection',status:'polling',lostAt:null});
      assert.equal(hooks.connection.value,h.page.get().connection);
      h.page.dispatch({type:'app',state:{seq:1,agent:{state:'idle'},providers:[],sessions:true,autostart:false,configPath:'',logPath:'',version:'test',commit:''}});
      assert.equal(hooks.app.value,h.page.get().app);
      h.event({type:'resets',data:{...h.page.get().resets!,resets:{codex:{scheduled:null,watch:null,latest:{at:NOW,url:'https://example.com/reset',text:'reset',scope:'all'},policy:null,credit:{name:'Resets',url:'https://example.com'}}}}});
      assert.equal(hooks.resets.value,h.page.get().resets!.resets);
      assert.equal(h.page.get().board,retained);assert.deepEqual(hooks.read(),{notifications:0,reads:0});

      h.event({type:'card',data:{...source,plan:'Changed'}});
      assert.equal(hooks.card.value,h.page.get().board!.cards[h.source]);assert.notEqual(hooks.card.value,source);
      h.event({type:'view',data:{revision:(h.page.get().board!.viewRevision??0)+1,view:{...board!.view,names:{[h.source]:'Renamed'}}}});
      assert.equal((hooks.titles.value as ReturnType<typeof titlesOf>)[h.source].title,'Renamed');
      h.page.dispatch({type:'board-close'});assert.equal(hooks.card.value,undefined);
      h.disconnect();h.reconnect();await flush();
      assert.equal(h.page.get().board!.id,board!.id);assert.equal(hooks.card.value,h.page.get().board!.cards[h.source]);
      hooks.close();assert.equal(activePageSubscriptions,0,'the last board consumer releases the shared subscription');
      h.event({type:'card',data:{...source,plan:'While unsubscribed'}});
      const resumed=hooks.again();assert.equal(resumed.value,h.page.get().board!.cards[h.source]);
      h.event({type:'card',data:{...source,plan:'After resubscribe'}});
      assert.equal(resumed.value,h.page.get().board!.cards[h.source]);assert.equal(resumed.notifications,1);
    }finally{
      stop();stops.forEach(stop=>stop());titleStops.forEach(stop=>stop());hooks.close();
      Object.defineProperty(source,'windows',windowsProperty);Object.defineProperty(windows[0],'used',usedProperty);
      if(namesProperty)Object.defineProperty(names,'toJSON',namesProperty);else delete names.toJSON;
    }
  }finally{await h.close();}
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
