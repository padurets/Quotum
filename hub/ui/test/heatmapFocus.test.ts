import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {calendarWindow,type CalendarReading} from '../lib/workCalendar';
import {heatmapLayout} from '../lib/heatmap';

type Node={type:unknown;props:Record<string,any>};
function nodes(value:unknown):Node[]{
  if(Array.isArray(value))return value.flatMap(nodes);
  if(!value||typeof value!=='object')return [];
  const node=value as Node;return [node,...nodes(node.props.children)];
}
test('heatmap rows follow physical order and an explicit drill focuses the new grid only after its target renders',()=>{
  const hooks=preparationFixture(),jsx=(type:unknown,props:Record<string,unknown>)=>({type,props});
  let selection:{from:number;to:number}|null=null,reading:CalendarReading={window:calendarWindow(Date.UTC(2026,9,20,15,41),'UTC',{mode:'live',periodMs:30*86_400_000}),value:null,basis:null,loading:false,error:null};
  const focused:string[]=[],plot={clientWidth:1200,querySelector:(selector:string)=>({focus:()=>focused.push(selector)})},root={};
  const context={exports:{} as any,require:()=>({jsx,jsxs:jsx}),...hooks,memo:(f:unknown)=>f,useMemo:(read:()=>unknown)=>read(),
    useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read(),usePref:()=> 'matrix',useLocale:()=> 'en',formatLocale:()=> 'en',useTimeRange:()=>selection,useSizing:()=>null,
    heatmapLayout,boardPeriod:{calendar:{subscribe:()=>()=>{},get:()=>reading}},t:(key:string)=>key,num:String,CATEGORY_COLORS:['blue'],CALENDAR_OPACITY:[0,.2,.4,.6,.8,1],
    setTimeRange:(range:{from:number;to:number})=>{selection=range;},ResizeObserver:class{observe(){}disconnect(){}},Popover:'popover',Segmented:'segmented',SlidersIcon:'icon',HistoryFailure:'failure',
  };
  const source=readFileSync(new URL('../components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{
    hooks.begin();const view=nodes(context.exports.AgentHoursHeatmap({arrange:{owner:false}}));
    view.find(n=>n.type==='section')!.props.ref.current=root;
    view.find(n=>n.props.role==='grid')!.props.ref.current=plot;hooks.commit();return view;
  };
  render();let view=render();
  const rows=view.filter(n=>n.props.role==='row'),order=rows.map(n=>(n.props.children as Node[])[0].props.item.row);
  assert.deepEqual(order,[...order].sort((a,b)=>a-b),'DOM row traversal matches the visual grid and arrow navigation');
  const bucket=view.find(n=>n.props.item?.date==='2026-10-05'&&n.props.item.from===Date.UTC(2026,9,5,12))!;
  assert.ok(bucket);const range={from:bucket.props.item.from,to:bucket.props.item.to};
  bucket.props.openRange(range);render();assert.equal(focused.length,0,'an old frame cannot receive the requested focus');
  reading={...reading,window:calendarWindow(range.to,'UTC',{mode:'range',...range}),loading:true};view=render();
  const tab=view.find(n=>n.props.tab)!;assert.ok(tab);assert.equal(focused.length,1);assert.ok(focused[0].includes(tab.props.item.key));
  render();assert.equal(focused.length,1,'ordinary data renders do not steal focus');
  bucket.props.openRange(range);selection={from:range.from-86_400_000,to:range.to-86_400_000};render();assert.equal(focused.length,1,'later navigation cancels a pending drill focus');
});
