import {chartSeriesMuted} from '../lib/prefs';
import * as retention from '../../server/domain/periodRetention';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PeriodTransport} from '../lib/periodTransport';
import {HistoryPool} from '../lib/historyPool';
import {drain,prepareAsync,type Preparations} from '../lib/prepare';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import {evaluatedRange,periodKey} from '../../server/domain/period';
import {planEventsAt,planEventsDeadline,cellOf} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodRequest,type PeriodReply} from '../../server/domain/periodRead';
import {packWorkPrepared,workPreparationBytes,mergeWorkPrepared} from '../../server/domain/periodWork';
import {retainSamplesPrepared,sampleBytes,mergeTapePrepared} from '../../server/domain/periodTape';
import {hasPeriodValue,periodValueAt} from '../../server/domain/periodValues';
import {canShift,shifted} from '../../server/domain/periodShift';
import {periodOf} from '../lib/periods';
import {moneySelection,DEFAULT_MONEY} from '../lib/moneySelection';
import {subscriptionSelection} from '../lib/subscription';
import {sameJson,shallowEqual} from '../lib/store';
import {EMPTY_VIEW} from '../../server/domain/view';
import {AGENTS,ACTIVITY,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,widgetVisible} from '../../server/domain/widgets';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {Events,type Frame} from '../../server/events';
import {Ingest} from '../../server/ingest';
import {Duty} from '../../server/duty';
import {Cadence} from '../../server/cadence';
import {ResetFeed} from '../../server/resets';
import {HistoryTiles} from '../../server/history';
import {PeriodReader} from '../../server/periodRead';
import {expandPeriod} from '../../server/domain/periodWire';
import {createStore} from '../lib/store';
import {periodTextChangesAt} from '../lib/periodClock';
import {reduce,INITIAL,type HubEvent} from '../lib/board';
import {PageClock} from '../lib/clock';
import {Pan} from '../lib/pan';
import {Live} from '../lib/live';

import {Pairing} from '../../server/pairing';
import {Setup} from '../../server/setup';
import type {Hub} from '../../server/api';
export const NOW=1_800_000_000_000,H=3_600_000,M=60_000;
export const flush=async()=>{for(let i=0;i<300;i++)await Promise.resolve();};

/** Actual producer, wire JSON boundary, page reducer, transport and bounded server reader. */
export async function fixture({personal=false,ownerDevice=false,transportLive=false,privateWork=false,unknown=false,current=false,stable=true,fixed=false,tableOnly=false,periodName="1h",creditFrom=NOW-3*M,creditTo=NOW-2*M,clocked=false,sessionMs=24*H}={}) {
  const start=NOW-Math.max(3*H,periodOf(periodName).ms+H);
  const store=new Store(':memory:',start),directory=new Directory(store.db);
  const alice=directory.createUser('a@example.com','Alice','unused',start),bob=directory.createUser('b@example.com','Bob','unused',start);
  const board=personal?directory.boards(alice.id)[0].id:directory.createBoard('Shared',alice.id,start).id;
  if(!personal)directory.addMember(board,bob.id,start);
  directory.saveView(board,{...EMPTY_VIEW,shown:[AGENTS,'quota-history'],hidden:[ACTIVITY]},alice.id,start);
  const source=store.source('codex','a'.repeat(24),start);store.hold(source,alice.id,start);store.hold(source,bob.id,start);
  if(tableOnly)directory.saveView(board,{...EMPTY_VIEW,shown:[AGENTS],enabledWhenEmpty:[AGENTS],hidden:[ACTIVITY,'quota-history','quota-session-history','quota-table','quota-session-table','subscription-funds','budget-history','budget-table','source:'+source]},alice.id,start);
  if(!personal)store.share(board,source,alice.id,start);
  store.record(source,{observedAt:NOW-2*M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:NOW+H}]});
  const owner=personal||ownerDevice?alice.id:bob.id;
  const device=directory.saveDevice({userId:owner,machine:{id:'machine-0123456789',name:'Work laptop',os:'linux',arch:'x86_64'},agent:'quotum/0.6.0',tokenId:null},start).id;
  const funding=privateWork?(unknown?null:store.source('codex','b'.repeat(24),start)):source;
  const credit=(from=creditFrom,to=creditTo)=>store.creditWork(device,from,to,[{source:funding,origin:'terminal',startedAt:start,project:'Work project',folder:'Private folder',client:'codex',identity:stable?{kind:'stable',sessionId:'c'.repeat(32)}:{kind:'legacy',ordinal:0}}]);credit();
  const hub:Hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  let now=NOW;
  const live=(working=false)=>({source:funding,clientId:'codex',sessionId:stable?'c'.repeat(32):null,device:{id:device,name:'Work laptop'},origin:'terminal' as const,project:'Work project',folder:'Private folder',startedAt:start,sentStartedAt:start,lastWorkedAt:NOW-2*M,working});
  if(current)hub.ingest.live.report(device,owner,[live()],NOW);
  const timers=new Map<object,{at:number;run:()=>void}>();
  const events=new Events(hub,undefined,{now:()=>now,after:(ms,run)=>{const token={};timers.set(token,{at:now+ms,run});return ()=>{timers.delete(token);};}},null),tiles=new HistoryTiles(store),reader=new PeriodReader(hub,tiles,events);
  events.onHistory=(source,since,scopes,work)=>{tiles.touch(source,since,scopes);reader.touch(source,since,scopes,work);};
  events.onClientHistory=(user,since)=>{tiles.touchClient(user,since);reader.touchClient(user,since);};events.attach();
  const page=createStore(reduce,INITIAL),frames:Frame[]=[],requests:PeriodRequest[]=[],pool=new HistoryPool();
  let stream:ReadableStreamDefaultController<Uint8Array>|null=null;
  const connection=transportLive?new Live({fetch:async()=>new Response(new ReadableStream<Uint8Array>({start:controller=>{stream=controller;}}),{headers:{'content-type':'text/event-stream'}}),now:()=>now,setTimeout:(run,ms)=>{const token={};timers.set(token,{at:now+ms,run});return token;},clearTimeout:token=>{timers.delete(token as object);},random:()=>0.5,visible:()=>true,hubNow:()=>now,heard:()=>{},dispatch:event=>page.dispatch(event),unauthorized:()=>{},gone:()=>{},epochChanged:()=>{},script:null,reload:()=>{},storage:()=>({getItem:()=>null,setItem:()=>{}})}):null;
  connection?.open(board);
  const feed=(batch:Frame[])=>{
    frames.push(...batch);
    if(connection){stream!.enqueue(new TextEncoder().encode(batch.map(frame=>`event: ${frame.type}\ndata: ${frame.data}\n\n`).join('')));return;}
    for(const frame of batch){if(frame.type==='ping'||frame.type==='bye')continue;if(frame.type==='snapshot')page.dispatch({type:'connection',status:'live',lostAt:null});page.dispatch({type:'hub',event:{type:frame.type,data:JSON.parse(frame.data)} as HubEvent});}
  };
  const secret='fixture-session';directory.createSession(secret,alice.id,NOW-3*H,sessionMs);
  const initial=events.open({user:alice.id,secret,board,kind:'stream',send:feed,end:()=>{}});
  if(!initial||initial==='limit')throw new Error('stream did not open');let opened=initial;feed(opened.frames);
  if(connection)await flush();
  const settings={range:periodName,kind:'session',money:DEFAULT_MONEY,funds:DEFAULT_MONEY};
  const code=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
  let wait:Promise<void>|null=null,preparer:Preparations|null=null;
  const pageClock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const token={};timers.set(token,{at:now+ms,run});return token;},clearTimeout:token=>{timers.delete(token as object);}});
  const pan=new Pan({now:()=>now,commit:()=>{},requestFrame:run=>{run();return null;},cancelFrame:()=>{},setTimeout:()=>null,clearTimeout:()=>{}});
  const context={exports:{} as any,hubNow:clocked?pageClock.hubNow:()=>now,retention,historyPool:pool,clock:clocked?pageClock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},PeriodTransport,
    fetchPeriod:async(_board:string,body:PeriodRequest)=>{requests.push(body);const reply=expandPeriod(JSON.parse(reader.read(board,alice.id,JSON.parse(JSON.stringify(body)))));const pending=wait;wait=null;await pending;return reply;},
    periodTextChangesAt,page,pan,preparations:()=>preparer,prepareAsync:(owner:object,work:Parameters<typeof drain>[0],valid:()=>boolean)=>prepareAsync(owner,work,valid,preparer),evaluatedRange,periodKey,PeriodAccounting,PeriodIndex,PeriodActivity,
    packWorkPrepared,workPreparationBytes,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,canShift,shifted,hasPeriodValue,periodValueAt,empty:()=>({value:null,basis:null,loading:false,error:null}),sameJson,
    timeRange:()=>fixed?{from:NOW-H,to:NOW}:null,prefs:()=>settings,periodOf,cellOf,moneySelection,subscriptionSelection,PERIOD_SCOPES,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,ACTIVITY,AGENTS,widgetVisible,noSessions:[],noValue:{}};
  runInNewContext(ts.transpileModule(code.slice(code.indexOf('class BoardPeriod'),code.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const period=new context.exports.BoardPeriod();pan.onPhase(()=>period.refreshWorkClock());page.listen((event,state)=>period.changed(event,state));period.activate(true);await flush();
  assert.equal(period.get().error,null);assert.equal(period.get().rows.length,1);const initialRequests=requests.slice();requests.length=0;frames.length=0;
  const advance=(at:number)=>{for(let count=0;;count++){assert.ok(count<10000);const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>at)break;now=next[1].at;timers.delete(next[0]);next[1].run();events.flush();}now=at;if(!clocked)period.tick();};
  const jump=(at:number)=>{now=at;for(const [token,timer] of [...timers])if(timer.at<=at){timers.delete(token);timer.run();}events.flush();if(clocked)pageClock.wakeDue();else period.tick();};
  return {hub,device,owner,advance,jump,pan,clock:pageClock,initialRequests,prepareWith:(value:Preparations|null)=>{preparer=value;},settings,pool,reader,store,directory,board,alice,bob,source,credit,events,period,page,frames,requests,
    report:(working=false,at=NOW)=>{now=at;hub.ingest.sessions({kind:'device',device:directory.deviceById(device)!},{version:1,agent:'quotum/0.6.0',machine:{id:'machine-0123456789',name:'Work laptop',os:'linux',arch:'x86_64'},sentAt:new Date(at).toISOString(),sessions:[{provider:'codex',...(funding?{account:(privateWork?'b':'a').repeat(24)}:{}),sessionId:stable?'c'.repeat(32):null,origin:'terminal',project:'Work project',folder:'Private folder',startedAt:new Date(start).toISOString(),lastWorkedAt:new Date(NOW-2*M).toISOString(),working}]},at);events.flush();},
    endIdle:()=>{hub.ingest.sessions({kind:'device',device:directory.deviceById(device)!},{version:1,agent:'quotum/0.6.0',machine:{id:'machine-0123456789',name:'Work laptop',os:'linux',arch:'x86_64'},sentAt:new Date(NOW).toISOString(),sessions:[]},NOW);events.flush();},
    event:(event:HubEvent)=>page.dispatch({type:'hub',event}),
    hold:()=>{let release!:()=>void,reject!:(error:Error)=>void;wait=new Promise<void>((yes,no)=>{release=yes;reject=no;});return {release,reject};},
    disconnect:()=>{opened.close();page.dispatch({type:'connection',status:'retrying',lostAt:now});}, reconnect:()=>{page.dispatch({type:'connection',status:'connecting',lostAt:now});opened=events.open({user:alice.id,secret,board,kind:'stream',send:feed,end:()=>{}}) as any;feed(opened.frames);}, remove:()=>{directory.removeMember(board,bob.id);store.unshareOrphans(board);events.flush();},
    fresh:()=>expandPeriod(JSON.parse(reader.read(board,alice.id,{version:1,selection:{mode:'live',periodMs:H},evaluatedAt:NOW,sessions:{}}))) as PeriodReply,
    close:async()=>{period.activate(false);connection?.close();stream?.close();opened.close();events.close();await new Promise(resolve=>setImmediate(resolve));store.close();assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);}};
}



import * as React from 'react';
import {preparationFixture} from './preparationFixture';
import {activityScale,
  activityEmpty,groupColors,mutedKey} from '../lib/activity';
import {plotGroupsPrepared} from '../lib/historyPlot';
import {StackPaths} from '../lib/stackPaths';
import {groupRegistry} from '../lib/plotRegistry';
import {cellStart} from '../../server/domain/history';
import {niceTicks} from '../lib/periods';
import {navigationKey} from '../lib/axisNavigation';
import {cardId,isHidden} from '../lib/view';

export function consumer(h: any) {
  const parent=preparationFixture(),child=preparationFixture();
  const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
  const axis={box:{current:null},svg:{current:null},width:400,scale:1,hover:null,drag:null,clip:'c',handlers:{},basis:{from:NOW-H,to:NOW,end:NOW},active:false,screenX:(at:number)=>48+(at-(NOW-H))/H*340,commitDrawing:()=>{}};
  const EMPTY_ACTIVITY={since:0,known:null,barMs:60_000,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}};
  const titles=Object.fromEntries(Object.values(h.page.get().board!.cards).map((c:any)=>[c.id,{provider:c.provider,title:'Shared source'}]));
  let panning:number|null=null;
  const prefs={range:'1h',activityBy:'project',muted:{}};
  const context={chartSeriesMuted,ACTIVITY,
    exports:{} as any,React,...parent,memo:(f:any)=>f,useMemo:(f:any,deps:any[])=>{const slot=parent.useRef(null) as any;if(!slot.current||deps.some((v,i)=>!Object.is(v,slot.current.deps[i])))slot.current={deps,value:f()};return slot.current.value;},
    useEffect:()=>{},useSeriesFocus:()=>{},seriesFocusStyle:()=>({}),useId:()=> 'c',useHistory:()=>h.render(),useHistoryPlot:()=>h.loader.getPlot(),usePlot:()=>({plot:undefined,onBase:()=>{}}),
    useLineup:()=>h.page.get().board!.lineup,usePersonalBoard:()=>false,useTitles:()=>titles,
    useChartMuted:()=>prefs.muted,usePref:(key:keyof typeof prefs)=>prefs[key],useLocale:()=> 'en',useTimeRange:()=>null,useBoardId:()=>h.board,
    axisNavigation:()=>({context:'b',range:'1h'}),useClock:()=>NOW,usePanning:()=>panning,
    pan:{get:()=>null,active:()=>null,subscribe:()=>()=>{}},useHistoryBegins:()=>0,frameOf:()=>({from:NOW-H,to:NOW,live:true}),measuredTo:()=>NOW,
    activityEmpty,groupColors,groupRegistry,mutedKey,plotGroupsPrepared,StackPaths,stacksHeight:()=>160,activityScale,niceTicks,cellStart,MINUTE:60_000,EMPTY_ACTIVITY,groupName:(g:any)=>g.name??g.key,cardId,isHidden,t:(s:any)=>s,
    quotaHistory:{retry:()=>{}},AnalyticsPanel:()=>null,ActivitySettings:()=>null,Totals:()=>null,LegendItem:()=>null,
    setTimeRange:()=>{},navigationKey,useTimeAxis:()=>axis,useTip:()=>({tip:{current:null},style:{}}),
    PlotLayer:()=>null,PlotOverlay:()=>null,Tooltip:()=>null,clock:()=>'',shortDay:()=>'',workHours:()=>'',stamp:()=>'',
    CSS:{escape:(id:any)=>id},Stacks:null as any};
  runInNewContext(ts.transpileModule(source.slice(source.indexOf('export const Activity ='))+'\nglobalThis.Stacks=Stacks;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,context);
  function find(node:any,type:any):any{if(Array.isArray(node))return node.map(n=>find(n,type)).find(Boolean);if(!React.isValidElement(node))return null;if(node.type===type)return node;return find((node.props as any).children,type);}
  const pathsOf=(node:any):string[]=>{if(Array.isArray(node))return node.flatMap(pathsOf);if(!React.isValidElement(node))return [];const p=node.props as any;return p.className==='activity-stack'&&p.d!==undefined?[p.d]:pathsOf(p.children);};
  let latestParent:any;const renderParent=()=>{Object.assign(context,parent);parent.begin();latestParent=context.exports.Activity({arrange:{view:h.page.get().board!.view}});return find(latestParent,context.Stacks).props;};
  const renderChild=(props:any)=>{Object.assign(context,child);child.begin();return pathsOf(context.Stacks(props));};

    const names=(node:any):string[]=>{if(Array.isArray(node))return node.flatMap(names);if(!React.isValidElement(node))return [];const props=node.props as any;return node.type===context.LegendItem?[props.name]:names(props.children);};
    const render=()=>{const props=renderParent();parent.commit();const paths=renderChild(props);child.commit();return {paths,names:names(latestParent),ready:props.prepared};};
    const settle=()=>{for(let i=0;i<4;i++){render();parent.finish();child.finish();}return render();};
    return {render,settle,pan:()=>{panning=1;axis.active=true;}};
}


import {HistoryStore,follow} from '../lib/history';
import {expandHistory} from '../../server/domain/history';

export async function drawings(h:any){
 const loader=new HistoryStore({now:()=>NOW,preparations:null,read:(_board,cell,from,to,signal,_meters,meta)=>h.period.transport.read('quota',{cell:String(cell),from:String(from),to:String(to),meta:meta?.meta??''},signal).then((reply:import('../../server/domain/history').HistoryReply)=>expandHistory(reply,meta)),setTimeout:()=>({}),clearTimeout:()=>{},dropTimeRange:()=>{}},undefined,'quota',h.pool);
 const stop=follow(loader,h.page);loader.choose(h.settings.range,null);loader.open(h.board);loader.hello(h.events.epoch);
 const board=h.page.get().board;loader.snapshot(board.lineup,Object.values(board.cards).flatMap((c:any)=>c.windows.map((w:any)=>`${c.id} ${w.id}`)),board.historyStart,board.workAuthority);await flush();
 const slots:any[]=[];let cursor=0;
 const useRef=(current:any)=>slots[cursor++]??(slots[cursor-1]={current});
 const useMemo=(read:any,deps:any[])=>{const box=useRef(null);if(!box.current||deps.some((v,i)=>!Object.is(v,box.current.deps[i])))box.current={deps,value:read()};return box.current.value;};
 const context={useRef,useMemo,useSyncExternalStore:(_s:any,read:any)=>read(),pan:{active:()=>null,onPhase:()=>()=>{}},hubNow:()=>NOW,planEventsAt,planEventsDeadline,shallowEqual,useClock:()=>NOW,fundsHistory:{},page:h.page,timeRange:()=>null,prefs:()=>h.settings,boardPeriod:h.period,read:null as any};
 const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');
 runInNewContext(ts.transpileModule(source.slice(source.indexOf('function usePeriodHistory('),source.indexOf('export function useHistory('))+'\nglobalThis.read=usePeriodHistory;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 const render=()=>{cursor=0;return context.read(loader,true);};
 return {loader,render,close:()=>{stop();loader.close();}};
}
import {subscriptionLinesOf} from '../lib/subscription';
import {lineWork,workText} from '../lib/work';
export function quotaCells(h:any,d:any){
 const history=d.render().history,board=h.page.get().board;
 if(!history)return {work:{content:'—'},agenthours:{content:'—'}};
 const [line]=subscriptionLinesOf(history,Object.values(board.cards),board.view,'weekly');
 if(!line)return {work:{content:'—'},agenthours:{content:'—'}};
 const value=h.period.quotaAt(line,NOW,history.range),cells=lineWork(value,false,NOW+H,NOW);
 const since=h.period.rangeAt('quota',NOW,history.range)?.from??history.since;
 return Object.fromEntries((['work','agenthours'] as const).map(column=>[column,cells&&value.work?workText(column,cells[column],value.work,since,NOW+H,null):{content:'—'}]));
}
