import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as agents from '../lib/agents';
import {selector,sameJson} from '../lib/store';
import {columnShown,colorOf,AGENTS} from '../lib/view';
import {timeRangeLabel} from '../lib/timeRange';
import {t,setLocale} from '../i18n';
import {EMPTY_VIEW} from '../../server/domain/view';
import type {WorkedSession} from '../../server/domain/periodWork';
import type {SessionPeriod} from '../lib/period';
import {tableCell} from '../components/TableCell';

type Node={type:unknown;props:Record<string,unknown>};
const jsx=(type:unknown,props:Record<string,unknown>):Node=>({type,props});
const runtime={jsx,jsxs:jsx,Fragment:'fragment'};
const code=(file:string)=>readFileSync(new URL(file,import.meta.url),'utf8');
function nodes(value:unknown):Node[] {
  if(Array.isArray(value))return value.flatMap(nodes);
  if(!value||typeof value!=='object')return [];
  const node=value as Node;
  return [node,...nodes(node.props.children)];
}
const basis={run:'r',revision:'1',evaluatedAt:120_000,evidenceCut:120_000,range:{from:0,to:120_000}};
const retained:WorkedSession={ref:'old',source:'s',device:{id:'d',name:'Laptop'},origin:'terminal',project:'Retained project',folder:null,startedAt:0,workedMs:60_000,lastWorkedAt:60_000,working:false};

test('a group action opens exactly once from either its row or full preview',()=>{
  const source=code('../components/Agents.tsx'),start=source.indexOf('function AgentsRows('),end=source.indexOf('\n/**',start),opens:string[]=[];
  const context={exports:{} as {draw:(props:unknown)=>Node},require:()=>runtime,COLUMNS:{},TablePreview:'preview',projectName:(name:string)=>name,t};
  runInNewContext(ts.transpileModule(source.slice(start,end)+'\nexports.draw=AgentsRows;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const group={key:'group',name:'Long project',working:0,rows:[{session:{}}]},tree=context.exports.draw({groups:[group],name:'project',columns:[],single:false,layout:'list',color:()=>({}),onOpen:(key:string)=>opens.push(key)});
  const row=(tree.props.children as Node[])[0],button=nodes(row).find(n=>n.props.className==='agents-open')!;
  const target=(popover:boolean)=>({closest:(selector:string)=>selector==='button'?{classList:{contains:(name:string)=>name==='agents-open'}}:selector==='.popover'&&popover?{}:null});
  for(const disclosed of [false,true]){
    let stopped=false;(button.props.onClick as (event:unknown)=>void)?.({stopPropagation(){stopped=true;}});
    if(!stopped)(row.props.onClick as (event:unknown)=>void)({target:target(disclosed)});
    assert.deepEqual(opens.splice(0),['group'],`the ${disclosed?'disclosed':'original'} button activates once`);
  }
  (row.props.onClick as (event:unknown)=>void)({target:{closest:(selector:string)=>selector==='button'?{classList:{contains:()=>false}}:null}});
  assert.equal(opens.length,0,'the ellipsis opens only its preview');
});

test('the open sessions dialog keeps the actual period basis, status and retry through replacement reads in both languages',()=>{
  let reading:SessionPeriod&{rows:WorkedSession[];value:object|null}={rows:[retained],basis,value:{},loading:false,error:null};
  let cursor=0,retries=0;
  const slots:unknown[]=[];
  const context={exports:{} as Record<string,(props:unknown)=>Node>,require:()=>runtime,...agents,selector,sameJson,AGENTS,columnShown,colorOf,t,timeRangeLabel,tableCell,
    COLUMNS:Object.fromEntries(agents.AGENT_COLUMNS.map(id=>[id,{title:'agents.'+id}])),
    useRef:(initial:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:initial});},
    useState:(initial:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=index===0?{group:null}:typeof initial==='function'?initial():initial;return [slots[index],(value:unknown)=>{slots[index]=value;}];},
    useMemo:(read:()=>unknown)=>read(),useCallback:(read:unknown)=>read,useLayoutEffect:()=>{},useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read(),
    memo:(component:unknown)=>component,useLocale:()=>{},useLineup:()=>['s'],useTitles:()=>({s:{title:'Source',provider:'codex'}}),
    usePref:(key:'agentsSort'|'agentsBy'|'range')=>({agentsSort:null,agentsBy:'project',range:'24h'})[key],setPrefs:()=>{},usePeriodSessions:undefined as unknown,useRemovalFocus:()=>()=>{},ReadState:'read-state',TableSurface:'surface',PeriodStatus:undefined as unknown,
    SessionCoverage:'coverage',activityText:()=>'—',boardPeriod:{activitySummaryAt:()=>null,get:()=>reading,subscribe:()=>()=>{},retry:()=>{retries++;reading={...reading,loading:true,error:null};}},
    useSizing:()=>null,useTimeRange:()=>null,useTableWidget:(_panel:unknown,_columns:unknown,_name:unknown,keys:string[])=>({layout:'table',from:0,to:Math.min(10,keys.length),measureFrom:0,measureTo:0}),TableGrouping:'grouping',TableMeasure:'measurement',WidgetPages:'pages',TablePages:'pager',useAgentsLayout:()=> 'table',Popover:'popover',SlidersIcon:'icon',HideRow:'hide',SwitchRow:'switch',Modal:'modal',AgentsRows:'rows',SortMenu:'sort',projectName:(value:string|null)=>value??t('agents.noProject'),
  };
  const run=(body:string)=>runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const period=code('../lib/period.ts');run(period.slice(period.indexOf('const roster=')));context.usePeriodSessions=context.exports.usePeriodSessions;
  const status=code('../components/PeriodStatus.tsx');run(status.slice(status.indexOf('export function PeriodStatus')));context.PeriodStatus=context.exports.PeriodStatus;
  const source=code('../components/Agents.tsx');run(source.slice(source.indexOf('function AgentsDialog(')));
  function render(disclosure:Record<string,unknown>={}) {
    cursor=0;
    const panel=nodes(context.exports.AgentsPanel({arrange:{owner:false,view:EMPTY_VIEW}}));
    const input=panel.find(node=>typeof node.type==='function'&&node.type.name==='AgentsDialog')!;
    const modal=nodes((input.type as (props:unknown)=>Node)({...input.props,...disclosure}));
    const status=modal.find(node=>node.type===context.PeriodStatus);
    return {
      modal,
      status:status?nodes(context.exports.PeriodStatus(status.props)):[],
      rows:modal.find(node=>node.type==='rows')?.props.groups as agents.AgentGroup[]|undefined,
      empty:modal.find(node=>node.props.className==='panel-empty')?.props.children,
      pages:modal.find(node=>typeof node.type==='function'&&node.type.name==='AgentPages')?.props,
    };
  }
  try {
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);
      reading={rows:[retained],basis,value:{},loading:false,error:null};
      assert.equal(render().rows?.[0].workedMs,60_000);
      assert.equal(render().status.length,0);
      reading={...reading,loading:true};
      let view=render();
      assert.ok(view.status.some(node=>node.props.role==='status'));
      assert.ok(view.status.some(node=>node.props.children===timeRangeLabel(basis.range)));
      assert.ok(view.status.some(node=>node.props.children===t('period.loading')));
      assert.equal(view.rows?.[0].workedMs,60_000);
      reading={...reading,loading:false,error:'unavailable'};
      view=render();
      assert.ok(view.status.some(node=>node.props.children===timeRangeLabel(basis.range)));
      assert.ok(view.status.some(node=>node.props.children===t('period.failed')));
      assert.equal(view.rows?.[0].workedMs,60_000);
      const retry=view.status.find(node=>node.type==='button'&&node.props.children===t('period.retry'))!;
      assert.ok(retry,'retry is inside the modal, not its inert parent');
      const before=retries;(retry.props.onClick as ()=>void)();assert.equal(retries,before+1);
      assert.ok(render().status.some(node=>node.props.children===t('period.loading')));
      reading={rows:[],basis:{...basis,range:{from:120_000,to:240_000}},value:{},loading:false,error:null};
      view=render();assert.equal(view.rows,undefined);assert.equal(view.status.length,0);assert.equal(view.empty,t('agents.none'));
      reading={rows:[],basis:null,value:null,loading:true,error:null};
      view=render();assert.equal(view.empty,undefined);assert.ok(view.status.some(node=>node.props.children===t('period.loading')));
      reading={...reading,loading:false,error:'history_limit'};
      view=render();assert.equal(view.empty,undefined);assert.ok(view.status.some(node=>node.props.children===t('period.limit')));
      assert.ok(view.status.some(node=>node.type==='button'&&node.props.children===t('period.retry')));
      slots.length=0;
      reading={rows:Array.from({length:51},(_,i)=>({...retained,ref:'context-'+i})),basis,value:{},loading:false,error:null};
      const disclosure={initial:JSON.stringify(retained.project),keepChosen:true,chosenTitle:retained.project};
      view=render(disclosure);assert.equal(view.rows?.length,50);assert.equal(view.pages?.count,51);
      (view.pages!.onPage as (page:number)=>void)(1);assert.equal(render(disclosure).rows?.length,1);
      reading={...reading,rows:[{...retained,project:'Other group',ref:'unrelated'}]};
      view=render(disclosure);assert.equal(view.rows,undefined);assert.equal(view.empty,t('agents.none'),'a removed chosen group must not broaden to unrelated work');
      slots.length=0;
    }
  } finally {setLocale('en');}
});
