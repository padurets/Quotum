import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {fixture,flush,NOW,M} from './periodRuntimeFixture';
import {preparationFixture} from './preparationFixture';
import {heatmapLayoutPrepared} from '../lib/heatmap';
import {focusEventsFixture} from './focusEventsFixture';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props.children)]:[];

test('actual calendar failure and retry retain the complete heatmap until authority changes',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({heatmap:true}),calendar=h.period.calendar,hooks=preparationFixture(),jsx=(type:unknown,props:Node['props'])=>({type,props}),plot={clientWidth:350,querySelector:()=>null};
  t.after(async()=>{hooks.dispose();await h.close();});
  const context={exports:{} as Record<string,(props:unknown)=>Node>,require:()=>({jsx,jsxs:jsx}),memo:(f:unknown)=>f,...hooks,document:focusEventsFixture().document,isFocusReturn:()=>false,
    useSyncExternalStore:(_s:unknown,read:()=>unknown)=>read(),usePref:()=> 'matrix',useLocale:()=> 'en',formatLocale:()=> 'en',useTimeRange:()=>null,useSizing:()=>null,
    heatmapLayoutPrepared,HEATMAP_MIN:160,HEATMAP_NATURAL:300,boardPeriod:h.period,t:(key:string)=>key,num:String,CATEGORY_COLORS:['blue'],CALENDAR_OPACITY:[0,.2,.4,.6,.8,1],
    ResizeObserver:class{observe(){}disconnect(){}},Popover:'popover',Segmented:'segmented',SlidersIcon:'icon',ReadState:'state'};
  const source=readFileSync(new URL('../components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{
    hooks.begin();const tree=nodes(context.exports.AgentHoursHeatmap({arrange:{owner:false}}));
    tree.find(n=>n.type==='section')!.props.ref.current={};tree.find(n=>n.props.role==='grid')!.props.ref.current=plot;hooks.commit();
    return tree.filter(n=>n.props.item).map(n=>n.props.item.cell);
  };
  render();hooks.finish();render();hooks.finish();const before=render(),value=calendar.get().value,basis=calendar.get().basis;
  assert.ok(before.some(cell=>cell.agentMs>0));
  const gate=h.hold();h.credit(NOW-M,NOW);h.events.flush();await flush();assert.deepEqual(render(),before);
  gate.reject(new Error('temporary failure'));await flush();
  assert.equal(calendar.get().value,value);assert.equal(calendar.get().basis,basis);assert.ok(calendar.get().error);
  assert.deepEqual(render(),before,'the first error commit retains all cells');hooks.finish();assert.deepEqual(render(),before);
  assert.ok(calendar.bytes>value!.cells.length*160,'retained evidence remains accounted');
  h.period.retry();await flush();render();hooks.finish();const ready=render();
  assert.equal(calendar.get().error,null);assert.ok(ready.reduce((sum,cell)=>sum+(cell.agentMs??0),0)>before.reduce((sum,cell)=>sum+(cell.agentMs??0),0));
  h.remove();assert.equal(calendar.get().value,null);render();hooks.finish();assert.ok(render().every(cell=>cell.agentMs===null),'authority loss still retires retained work');
});
