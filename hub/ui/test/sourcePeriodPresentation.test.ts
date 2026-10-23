import {windowName} from '../lib/quota';
import {selectedAllowanceIds} from '../lib/moneySelection';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {selector,sameJson} from '../lib/store';
import {machinesOf,drawn} from '../lib/agents';
import {timeRangeLabel} from '../lib/timeRange';
import {t} from '../i18n';
import {EMPTY_VIEW} from '../../server/domain/view';
import {providerOf} from '../../server/domain/providers';
import {quotaPeriods,primaryQuotaPeriods} from '../lib/subscription';
import {hasSubscriptionCaps} from '../lib/providers';
import type {WorkedSession} from '../../server/domain/periodWork';
import type {SessionPeriod} from '../lib/period';
import {budgetView,budgetVisible,subscriptionFundsVisible,historicalCurrencyContext} from '../lib/money';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';

type Node={type:unknown;props:Record<string,unknown>};
const jsx=(type:unknown,props:Record<string,unknown>):Node=>({type,props});
const runtime={jsx,jsxs:jsx,Fragment:'fragment'};
const code=(file:string)=>readFileSync(new URL(file,import.meta.url),'utf8');
function component(file:string,name:string,start:string,end?:string,bindings:Record<string,unknown>={}) {
  const source=code(file),at=source.indexOf(start);
  assert.ok(at>=0);
  const body=source.slice(at,end?source.indexOf(end,at):undefined);
  const context={selectedAllowanceIds,usePref:()=>({unit:'USD'}),useDataFilters:()=>({current:null}),exports:{},draw:null as unknown as (props:Record<string,unknown>)=>Node|null,
    require:()=>runtime,t,...bindings};
  runInNewContext(ts.transpileModule(body+`\nglobalThis.draw=${name};`,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  return context.draw;
}
function nodes(value:unknown):Node[] {
  if(Array.isArray(value))return value.flatMap(nodes);
  if(!value||typeof value!=='object')return [];
  const node=value as Node;
  if(typeof node.type==='function')return nodes(node.type(node.props));
  return [node,...nodes(node.props.children),...nodes(node.props.trigger)];
}
const row=(ref:string,at=100,machine='d'):WorkedSession=>({ref,source:'s',device:{id:machine,name:machine},origin:'terminal',project:ref,folder:null,startedAt:0,workedMs:60_000,lastWorkedAt:at,working:false});
const basis={run:'r',revision:'1',evaluatedAt:120_000,evidenceCut:120_000,range:{from:0,to:120_000}};

/** Run the actual source hook with observable subscriptions and stable React hook slots. */
function sourceHook(board:ReturnType<typeof workStore>,id:string) {
  const source=code('../lib/period.ts'),body=source.slice(source.indexOf('const roster='));
  let cursor=0,changes=0;
  const slots:unknown[]=[],subscriptions:{read:()=>unknown;value:unknown;stop:()=>void}[]=[];
  const context={selectedAllowanceIds,usePref:()=>({unit:'USD'}),useDataFilters:()=>({current:null}),exports:{} as {useTimeRange:()=>null,useSourcePeriodSessions:(id:string)=>SessionPeriod&{rows:WorkedSession[]}},boardPeriod:board,selector,sameJson,
    useRef:(value:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:value});},
    useState:(initial:()=>unknown)=>{const index=cursor++;return [slots[index]??(slots[index]=initial())];},
    useSyncExternalStore:(subscribe:(listener:()=>void)=>()=>void,read:()=>unknown)=>{
      const index=cursor++;let own=subscriptions[index];
      if(!own){own=subscriptions[index]={read,value:read(),stop:()=>{}};own.stop=subscribe(()=>{const next=own.read();if(next!==own.value){own.value=next;changes++;}});}
      own.read=read;own.value=read();return own.value;
    },require:()=>({})};
  runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
  const render=()=>{cursor=0;return context.exports.useSourcePeriodSessions(id);};
  render();
  return {render,changes:()=>changes,close:()=>subscriptions.forEach(entry=>entry.stop())};
}
function workStore() {
  let state:{basis:SessionPeriod['basis'];loading:boolean;error:string|null;value:object|null}={basis,loading:false,error:null,value:{}};
  const sources=new Map<string,WorkedSession[]>([['s',[row('one')]],['other',[row('other')]]]);
  const global=new Set<()=>void>(),listeners=new Map<string,Set<()=>void>>();
  return {
    get:()=>state,getSource:(id:string)=>sources.get(id)??[],getWorkEvidence:()=>state.value,
    subscribe:(listener:()=>void)=>{global.add(listener);return()=>{global.delete(listener);};},
    subscribeSource:(id:string,listener:()=>void)=>{let set=listeners.get(id);if(!set)listeners.set(id,set=new Set());set.add(listener);return()=>{set!.delete(listener);};},
    status:(update:Partial<typeof state>)=>{state={...state,...update};for(const listener of global)listener();},
    source:(id:string,rows:WorkedSession[])=>{sources.set(id,rows);state={...state,value:{}};for(const listener of listeners.get(id)??[])listener();for(const listener of global)listener();},
  };
}

test('source sessions retain their basis through pending and failure, including sources without rows',()=>{
  const board=workStore(),hook=sourceHook(board,'empty');
  board.status({loading:true});
  assert.equal(hook.changes(),1);
  assert.deepEqual(JSON.parse(JSON.stringify(hook.render())),{rows:[],basis,loading:true,error:null});
  board.status({loading:false,error:'history_limit'});
  assert.equal(hook.changes(),2);assert.equal(hook.render().error,'history_limit');
  board.status({loading:true,error:null});assert.equal(hook.render().loading,true);
  board.status({loading:false,basis:{...basis,range:{from:120_000,to:240_000}}});
  assert.equal(hook.render().basis,null);assert.equal(hook.render().error,null);hook.close();
});

test('global work publication never wakes unrelated source cards but a source evidence change does',()=>{
  const board=workStore(),own=sourceHook(board,'s'),other=sourceHook(board,'other');
  const first=own.render().rows;
  board.status({basis:{...basis,range:{from:1000,to:121_000}},value:{}});
  assert.equal(own.changes(),0);assert.equal(other.changes(),0);
  board.source('s',[{...row('one'),workedMs:90_000}]);
  assert.equal(own.changes(),1,'new source evidence replans its worked-time clocks');
  assert.notEqual(own.render().rows,first);assert.equal(own.render().rows[0].workedMs,90_000);
  assert.equal(other.changes(),0,'a global evidence object is not a data subscription for other sources');
  own.close();other.close();
});

function agents(page=0,retry=()=>{}) {
  const status=component('../components/PeriodStatus.tsx','PeriodStatus','export function PeriodStatus',undefined,{timeRangeLabel,boardPeriod:{retry},useRemovalFocus:()=>()=>{}});
  const sharedPages=component('../components/TableWidget.tsx','TablePages','export function TablePages(','\ntype Measurement=');
  const pages=component('../components/Agents.tsx','AgentPages','function AgentPages(',undefined,{TablePages:sharedPages});
  return component('../components/Agents.tsx','Agents','export function Agents(','/** A project as',{
    useState:()=>[page,()=>{}],machinesOf,drawn,timeRangeLabel,Popover:'popover',PeriodStatus:status,AgentPages:pages,
    TerminalIcon:'terminal',WarningIcon:'warning',Mark:'mark',Origin:'origin',WorkTime:'worked',stateOf:()=>'',placeOf:()=>'',folderOf:()=>null,
  });
}

test('the actual card tray keeps an accessible loading/error disclosure and retry without session rows',()=>{
  let retried=0;
  const drawAgents=agents(0,()=>{retried++;});
  const drawTray=component('../components/Tray.tsx','Tray','export function Tray(',undefined,{
    useRef:()=>({current:null}),useState:()=>[true,()=>{}],useClock:()=>0,useLayoutEffect:()=>{},resetLabel:()=>null,DRAWN:10,Agents:drawAgents,ResetNews:'reset',
  });
  let reading:SessionPeriod&{rows:WorkedSession[]}={rows:[],basis:null,loading:true,error:null};
  const drawCard=component('../components/SourceCard.tsx','CardTray','function CardTray(','\n/**',{
    useTimeRange:()=>null,useSourcePeriodSessions:()=>reading,useResetsFor:()=>undefined,useSourceAccess:()=>null,providerOf,Tray:drawTray,
    AccessMark:'access',QuotaMark:'quota',BalanceMark:'balance',FreeResets:'free-resets',
  });
  const draw=()=>nodes(drawCard({source:{id:'s',provider:'claude'}}));
  let tree=draw(),popover=tree.find(node=>node.type==='popover')!;
  assert.match(String(popover.props.label),/Loading the selected period/);
  assert.ok(tree.some(node=>node.props.className==='spinner'));
  assert.equal(tree.filter(node=>node.type==='footer').length,1);
  assert.equal(tree.some(node=>node.props.className==='agents-count'),false,'unknown membership never reads as zero');
  reading={rows:[],basis:null,loading:false,error:'history_limit'};
  tree=draw();popover=tree.find(node=>node.type==='popover')!;
  assert.match(String(popover.props.triggerClass),/is-warn/);
  assert.match(String(popover.props.label),/history limit/);
  const retry=tree.find(node=>node.type==='button'&&node.props.children===t('period.retry'))!;
  assert.ok(retry);(retry.props.onClick as ()=>void)();assert.equal(retried,1);
  reading={rows:[row('retained')],basis,loading:false,error:'unavailable'};
  tree=draw();popover=tree.find(node=>node.type==='popover')!;
  assert.ok(String(popover.props.label).includes(timeRangeLabel(basis.range)));
  assert.ok(tree.some(node=>node.type==='span'&&node.props.children===timeRangeLabel(basis.range)));
  assert.ok(tree.some(node=>node.type==='worked'),'retained rows stay available inside the labelled disclosure');
  reading={rows:[],basis:null,loading:false,error:null};
  assert.equal(draw().some(node=>node.type==='popover'),false,'confirmed empty sessions need no tray mark');
});

test('card measurements distinguish a failed first read from a successful absence',()=>{
  let reading:{value:null|{windows:[];meters:[];keys:[]};basis:typeof basis|null;loading:boolean;error:string|null}={value:null,basis:null,loading:false,error:'unavailable'};
  const draw=component('../components/SourceCard.tsx','CardMeasurements','function CardMeasurements(','/** Historical funds',{
    usePeriodValues:()=>reading,useTimeRange:()=>basis.range,useCurrencyContext:()=>({sources:{}}),historicalCurrencyContext,quotaPeriods,primaryQuotaPeriods,windowName,PercentLimit:'unavailable',hasSubscriptionCaps,
    isWindowHidden:()=>false,planOf:()=>null,MeasurementClock:{Provider:'clock'},providerOf,
    MoneyValues:'money',MoneyCard:'money',QuotaCard:'quota',Limit:'limit',AllHidden:'hidden',PeriodStatus:'period-status',
  });
  const render=()=>nodes(draw({source:{id:'s',provider:'claude',windows:[]},arrange:{view:EMPTY_VIEW},boardId:'b'}));
  assert.equal(render().some(node=>node.props.children===t('period.noEvidence')),false);
  assert.equal(render().some(node=>node.type==='period-status'),false,'errors use the existing disclosure instead of inserting a body row');
  reading={value:{windows:[],meters:[],keys:[]},basis,loading:false,error:null};
  assert.ok(render().some(node=>node.props.children===t('period.noEvidence')));
  reading={...reading,error:'history_limit'};
  assert.equal(render().some(node=>node.props.children===t('period.noEvidence')),false);
});

test('historical card consumers accept the recorded Codex conversion through the shared renderer',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true});t.after(h.close);
  h.store.record(h.source,{observedAt:NOW-10*M,staleAfterMs:H,plan:'pro',resets:null,windows:[{id:'w',kind:'weekly',minutes:10080,label:null,used:10,remaining:90,resetAt:NOW+H}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'50000',hasCredits:true}]});
  h.selectRange({from:NOW-H,to:NOW-5*M});await flush();
  const value=h.period.getValue(h.source).value;
  assert.ok(value);assert.equal(value.meters.find((m:any)=>m.unit==='USD')?.amount,'2000000000');
  const bindings={usePeriodValues:()=>h.period.getValue(h.source),useTimeRange:h.selectedRange,useCurrencyContext:()=>h.page.get().board!.currencies,
    budgetVisible,subscriptionFundsVisible,historicalCurrencyContext,MeasurementClock:{Provider:'clock'},CardTray:'tray',MoneyValues:'money',
    quotaPeriods,primaryQuotaPeriods,windowName,PercentLimit:'unavailable',hasSubscriptionCaps,isWindowHidden:()=>false,planOf:()=>null,providerOf,Limit:'limit',PeriodStatus:'status'};
  const footer=component('../components/SourceCard.tsx','CardFooter','function CardFooter(',undefined,bindings);
  const MoneyCard=component('../components/MoneyCard.tsx','MoneyCard','export function MoneyCard(','type MoneySource=',{...bindings,useShownKeys:()=>({keys:[],meters:[],allowances:[]})});
  const measurements=component('../components/SourceCard.tsx','CardMeasurements','function CardMeasurements(','/** Historical funds',{...bindings,MoneyCard});
  const props={source:h.page.get().board!.cards[h.source],arrange:{view:EMPTY_VIEW},boardId:h.board};
  const funds=(footer(props)!.props.funds as Node).props.children as Node;
  const measured=nodes(measurements({...props,source:{...props.source,provider:'deepseek'}})).find(node=>node.type==='money')!;
  for(const consumer of [funds,measured]){
    const source=consumer.props.source as any,context=consumer.props.context as any;
    const shown=budgetView(source,[],source.meters,context).remaining.values;
    assert.equal(shown[0]?.total.amount,'2000000000');assert.equal(shown[0]?.total.unit,'USD');
    assert.equal(shown[0]?.total.conversion?.original.amount,'50000');
    assert.equal(shown[0]?.total.conversion?.original.at,NOW-10*M);
  }
});

test('tray pages follow the globally ordered machine groups and retain complete machine totals',()=>{
  const sessions=Array.from({length:51},(_,i)=>({...row('s'+i,i===50?1000:i),working:i===50}));
  const rows=(page:number)=>nodes(agents(page)({sessions})).filter(node=>node.type==='worked').map(node=>(node.props.refs as string[])[0]);
  assert.equal(rows(0)[0],'s50');assert.equal(rows(0).length,50);assert.deepEqual(rows(1),['s0']);
  const second=nodes(agents(1)({sessions}));
  assert.ok(second.some(node=>node.type==='small'&&node.props.children===t('agents.machineSummary',{working:1,count:51})));
  const mixed=[...Array.from({length:49},(_,i)=>row('old'+i,i,'B')),row('A1',100,'A'),row('A2',10,'A'),row('B-latest',90,'B')];
  const first=nodes(agents()({sessions:mixed})).filter(node=>node.type==='worked').map(node=>(node.props.refs as string[])[0]);
  assert.deepEqual(first.slice(0,3),['A1','A2','B-latest'],'paging preserves machine grouping after activity decides machine order');
});
