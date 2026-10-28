import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {fixture,flush,NOW,M} from './periodRuntimeFixture';
import {preparationFixture} from './preparationFixture';
import * as heatmap from '../lib/heatmap';
import {focusEventsFixture} from './focusEventsFixture';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props.children)]:[];

test('actual calendar failure and retry retain the complete heatmap until authority changes',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({heatmap:true}),calendar=h.period.calendar,hooks=preparationFixture(),projectionHooks=preparationFixture(),jsx=(type:unknown,props:Node['props'])=>({type,props}),plot={clientWidth:350,querySelector:()=>null};
  let projectionMounted=false,projectionRenders=0;
  t.after(async()=>{projectionHooks.dispose();hooks.dispose();await h.close();});
  const context={exports:{} as Record<string,(props:unknown)=>Node>,require:()=>({jsx,jsxs:jsx}),memo:(f:unknown)=>f,...hooks,document:focusEventsFixture().document,isFocusReturn:()=>false,
    useSyncExternalStore:(_s:unknown,read:()=>unknown)=>read(),usePref:()=> 'matrix',useLocale:()=> 'en',formatLocale:()=> 'en',useTimeRange:()=>null,useSizing:()=>null,
    ...heatmap,useClock:()=>NOW,hubNow:()=>NOW,boardPeriod:h.period,t:(key:string)=>key,num:String,CATEGORY_COLORS:['blue'],CALENDAR_OPACITY:[0,.2,.4,.6,.8,1],
    ResizeObserver:class{observe(){}disconnect(){}},Popover:'popover',Segmented:'segmented',SlidersIcon:'icon',ReadState:'state'};
  const source=readFileSync(new URL('../components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  runInNewContext(ts.transpileModule(source+'\nexports.ClockProjection=ClockProjection;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{
    hooks.begin();let tree=nodes(context.exports.AgentHoursHeatmap({arrange:{owner:false}}));
    tree.find(n=>n.type==='section')!.props.ref.current={};
    const projection=tree.find(node=>node.type===context.exports.ClockProjection);
    if(projection){
      projectionMounted=true;projectionRenders++;projectionHooks.begin();Object.assign(context,projectionHooks);
      try{const children=nodes(context.exports.ClockProjection(projection.props));tree=tree.flatMap(node=>node===projection?children:[node]);}
      finally{Object.assign(context,hooks);}
    }else if(projectionMounted){projectionHooks.unmount();projectionMounted=false;}
    tree.find(n=>n.props.role==='grid')!.props.ref.current=plot;
    if(projectionMounted)projectionHooks.commit();hooks.commit();
    return tree.filter(n=>n.props.item).map(n=>n.props.item.cell);
  };
  const finish=()=>{hooks.finish();projectionHooks.finish();};
  render();finish();render();finish();const before=render(),value=calendar.get().value,basis=calendar.get().basis;
  assert.ok(calendar.get().integral&&projectionRenders>0,'the retained live grid executes the actual integral ClockProjection');
  assert.ok(before.some(cell=>cell.agentMs>0));
  const gate=h.hold();h.credit(NOW-M,NOW);h.events.flush();await flush();assert.deepEqual(render(),before);
  gate.reject(new Error('temporary failure'));await flush();
  assert.equal(calendar.get().value,value);assert.equal(calendar.get().basis,basis);assert.ok(calendar.get().error);
  assert.deepEqual(render(),before,'the first error commit retains all cells');finish();assert.deepEqual(render(),before);
  assert.ok(calendar.bytes>value!.cells.length*160,'retained evidence remains accounted');
  h.period.retry();await flush();render();finish();const ready=render();
  assert.equal(calendar.get().error,null);assert.ok(ready.reduce((sum,cell)=>sum+(cell.agentMs??0),0)>before.reduce((sum,cell)=>sum+(cell.agentMs??0),0));
  h.remove();assert.equal(calendar.get().value,null);render();finish();assert.ok(render().every(cell=>cell.agentMs===null),'authority loss still retires retained work');
});
