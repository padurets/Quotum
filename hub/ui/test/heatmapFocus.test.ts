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
test('hidden heatmaps defer geometry and restore current rows before completing an explicit drill',()=>{
  const hooks=preparationFixture(),jsx=(type:unknown,props:Record<string,unknown>)=>({type,props});
  let selection:{from:number;to:number}|null=null,reading:CalendarReading={window:calendarWindow(Date.UTC(2026,9,20,15,41),'UTC',{mode:'live',periodMs:30*86_400_000}),value:null,basis:null,loading:false,error:null};
  let layouts=0,view:Node[]=[];
  const focused:string[]=[],resizes:(()=>void)[]=[],reports:{min:number;natural:number;shown:number}[]=[];
  const plot={clientWidth:0,height:0,getBoundingClientRect:()=>({height:plot.clientWidth?plot.height:0}),querySelector:(selector:string)=>({focus:()=>focused.push(selector)})};
  const root={getBoundingClientRect:()=>({height:plot.clientWidth?plot.height+100:0})};
  const sizing={manual:false,allocated:0,width:'wide',report:(value:any)=>{if(value)reports.push(value);}};
  const context={exports:{} as any,require:()=>({jsx,jsxs:jsx}),...hooks,memo:(f:unknown)=>f,flushSync:(run:()=>void)=>{run();render();},
    useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read(),usePref:()=> 'matrix',useLocale:()=> 'en',formatLocale:()=> 'en',useTimeRange:()=>selection,useSizing:()=>sizing,
    heatmapLayout:(...args:Parameters<typeof heatmapLayout>)=>{layouts++;return heatmapLayout(...args);},boardPeriod:{calendar:{subscribe:()=>()=>{},get:()=>reading}},t:(key:string)=>key,num:String,CATEGORY_COLORS:['blue'],CALENDAR_OPACITY:[0,.2,.4,.6,.8,1],
    fillOf:()=>0,pixels:Math.round,same:(a:number,b:number)=>a===b,
    setTimeRange:(range:{from:number;to:number})=>{selection=range;},ResizeObserver:class{constructor(read:()=>void){resizes.push(read);}observe(){}disconnect(){}},Popover:'popover',Segmented:'segmented',SlidersIcon:'icon',HistoryFailure:'failure',
  };
  const source=readFileSync(new URL('../components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{
    hooks.begin();view=nodes(context.exports.AgentHoursHeatmap({arrange:{owner:false}}));
    view.find(n=>n.type==='section')!.props.ref.current=root;
    const grid=view.find(n=>n.props.role==='grid')!;grid.props.ref.current=plot;plot.height=grid.props.style.height;hooks.commit();return view;
  };
  render();render();assert.equal(layouts,0,'a zero-width mount does not format or prepare invisible calendar cells');assert.equal(reports.length,0,'hidden geometry cannot replace a useful sizing report');
  plot.clientWidth=1200;resizes[0]();assert.ok(view.some(n=>n.props.item),'the ResizeObserver restores cells before returning');
  const before=layouts;plot.clientWidth=0;resizes[0]();const reported=reports.length;
  reading={...reading,window:calendarWindow(Date.UTC(2026,9,21,15,41),'UTC',{mode:'live',periodMs:30*86_400_000})};render();render();
  assert.equal(layouts,before,'hidden navigation does not prepare a replacement layout');assert.equal(reports.length,reported,'hidden navigation does not publish zero geometry');assert.ok(!view.some(n=>n.props.item));
  plot.clientWidth=1200;resizes[0]();
  const expectedLayout=heatmapLayout(reading,1200,'matrix','en'),actual=view.filter(n=>n.props.item).map(n=>n.props.item);
  assert.deepEqual(actual.sort((a,b)=>a.from-b.from),expectedLayout.cells.sort((a,b)=>a.from-b.from),'same-width restoration uses the newest calendar reading');
  assert.ok(reports.length>reported,'show publishes current useful geometry');assert.equal(reports.at(-1)!.natural,100+expectedLayout.naturalHeight);assert.ok(reports.every(r=>r.min>100));
  const rows=view.filter(n=>n.props.role==='row'),order=rows.map(n=>(n.props.children as Node[])[0].props.item.row);
  assert.deepEqual(order,[...order].sort((a,b)=>a-b),'DOM row traversal matches the visual grid and arrow navigation');
  const bucket=view.find(n=>n.props.item?.date==='2026-10-05'&&n.props.item.from===Date.UTC(2026,9,5,12))!;
  assert.ok(bucket);const range={from:bucket.props.item.from,to:bucket.props.item.to};
  bucket.props.openRange(range);render();assert.equal(focused.length,0,'an old frame cannot receive the requested focus');
  plot.clientWidth=0;resizes[0]();reading={...reading,window:calendarWindow(range.to,'UTC',{mode:'range',...range}),loading:true};render();assert.equal(focused.length,0,'hidden cells cannot complete a pending drill');
  plot.clientWidth=1200;resizes[0]();
  const tab=view.find(n=>n.props.tab)!;assert.ok(tab);assert.equal(focused.length,1);assert.ok(focused[0].includes(tab.props.item.key));
  render();assert.equal(focused.length,1,'ordinary data renders do not steal focus');
  bucket.props.openRange(range);selection={from:range.from-86_400_000,to:range.to-86_400_000};render();assert.equal(focused.length,1,'later navigation cancels a pending drill focus');
});
