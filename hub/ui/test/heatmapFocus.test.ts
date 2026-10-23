import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {calendarWindow,type CalendarReading} from '../lib/workCalendar';
import {heatmapLayout,heatmapLayoutPrepared} from '../lib/heatmap';
import {focusEventsFixture} from './focusEventsFixture';

type Node={type:unknown;props:Record<string,any>};
function nodes(value:unknown):Node[]{
  if(Array.isArray(value))return value.flatMap(nodes);
  if(!value||typeof value!=='object')return [];
  const node=value as Node;return [node,...nodes(node.props.children)];
}
test('cold heatmap preparation leaves render cheap, retains compatible cells and retires authority immediately',t=>{
  const hooks=preparationFixture(),jsx=(type:unknown,props:Record<string,unknown>)=>({type,props}),from=Date.UTC(2034,5,10,5),window=calendarWindow(from+86_400_000,'UTC',{mode:'range',from,to:from+86_400_000});
  let reading:CalendarReading={window,value:{zone:'UTC',edges:window.edges,cursor:'test',availableFrom:from,retainedFrom:from,cells:window.edges.slice(0,-1).map((at,i)=>({agentMs:Math.max(0,Math.min(window.edges[i+1],window.range.to)-Math.max(at,from)),from:Math.max(at,from),to:Math.max(Math.max(at,from),Math.min(window.edges[i+1],window.range.to)),validUntil:null}))},basis:null,loading:false,error:null},authority='a';
  const plot={clientWidth:0,querySelector:()=>null},root={};let resize=()=>{};
  const context={exports:{} as any,require:()=>({jsx,jsxs:jsx}),memo:(f:unknown)=>f,...hooks,flushSync:(run:()=>void)=>run(),document:focusEventsFixture().document,isFocusReturn:()=>false,
    useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read(),usePref:()=> 'matrix',useLocale:()=> 'en',formatLocale:()=> 'en',useTimeRange:()=>null,useSizing:()=>null,
    heatmapLayout,heatmapLayoutPrepared,HEATMAP_MIN:160,HEATMAP_NATURAL:300,boardPeriod:{calendar:{subscribe:()=>()=>{},get:()=>reading,retain:()=>()=>{},presentationKey:()=>authority}},t:(key:string)=>key,num:String,CATEGORY_COLORS:['blue'],CALENDAR_OPACITY:[0,.2,.4,.6,.8,1],
    ResizeObserver:class{constructor(read:()=>void){resize=read;}observe(){}disconnect(){}},Popover:'popover',Segmented:'segmented',SlidersIcon:'icon',ReadState:'state',
  };
  const source=readFileSync(new URL('../components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=(commit=true)=>{hooks.begin();const view=nodes(context.exports.AgentHoursHeatmap({arrange:{owner:false}}));view.find(n=>n.type==='section')!.props.ref.current=root;view.find(n=>n.props.role==='grid')!.props.ref.current=plot;if(commit)hooks.commit();return view;};
  let formatted=0;const original=Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype,'formatToParts',function(this:Intl.DateTimeFormat,...args:Parameters<typeof original>){formatted++;return original.apply(this,args);});
  render(false);assert.equal(formatted,0,'React render never translates the entire fine partition');
  hooks.commit();render();hooks.finish();render();assert.equal(formatted,0,'a hidden mount never prepares invisible civil cells');
  plot.clientWidth=1200;resize();render();hooks.tick();assert.ok(formatted>0&&formatted<=16,'one scheduler slice performs only one small batch');
  assert.equal(render().filter(n=>n.props.item).length,0,'an incomplete grid is never published');
  hooks.finish();let view=render(),cells=view.filter(n=>n.props.item);assert.ok(cells.length>0);
  const sum=()=>render().filter(n=>n.props.item).reduce((total,n)=>total+(n.props.item.cell.agentMs??0),0),before=sum(),height=view.find(n=>n.props.role==='grid')!.props.style.height;
  reading={...reading,window:{...window,edges:[...window.edges]},value:{...reading.value!,cells:reading.value!.cells.map(cell=>({...cell,agentMs:cell.agentMs!+1}))},loading:true};
  view=render();assert.equal(sum(),before,'same-context replacement retains its complete grid');
  assert.equal(view.find(n=>n.props.role==='grid')!.props.style.height,height);
  reading={...reading,loading:false,error:'unavailable'};render();assert.equal(sum(),before);
  hooks.finish();render();assert.ok(sum()>before,'the replacement arrives as one complete model');
  const complete=reading;authority='revoked';reading={...reading,value:null,basis:null,loading:true};
  view=render();assert.equal(view.filter(n=>n.props.item).length,0,'authority loss retires the old grid synchronously');
  authority='a';reading=complete;view=render();assert.equal(view.filter(n=>n.props.item).length,0,'returning context text cannot resurrect a retired model');
  hooks.finish();assert.ok(render().filter(n=>n.props.item).length>0);
  const visible=sum();plot.clientWidth=0;resize();view=render();
  assert.equal(sum(),visible,'a hidden surface cannot replace its measured width with zero');
  assert.equal(view.find(n=>n.props.role==='grid')!.props.style.height,height);
  const hiddenFormats=formatted;reading={...reading,value:{...reading.value!,cells:[...reading.value!.cells]}};render();hooks.finish();render();
  assert.equal(formatted,hiddenFormats,'a hidden refresh defers replacement preparation');
  plot.clientWidth=600;resize();render();hooks.finish();view=render();
  assert.equal(sum(),visible,'revealing at another width prepares the same exact work');
  assert.ok(view.filter(n=>n.props.item).every(n=>n.props.item.x+n.props.item.width<=600));
});
test('heatmap rows follow physical order and an explicit drill focuses the new grid only after its target renders',()=>{
  const hooks=preparationFixture(),jsx=(type:unknown,props:Record<string,unknown>)=>({type,props});
  let selection:{from:number;to:number}|null=null,reading:CalendarReading={window:calendarWindow(Date.UTC(2026,9,20,15,41),'UTC',{mode:'live',periodMs:30*86_400_000}),value:null,basis:null,loading:false,error:null};
  const focused:string[]=[],plot={clientWidth:1200,querySelector:(selector:string)=>({focus:()=>focused.push(selector)})},root={};
  const context={exports:{} as any,require:()=>({jsx,jsxs:jsx}),...hooks,memo:(f:unknown)=>f,flushSync:(run:()=>void)=>run(),document:focusEventsFixture().document,isFocusReturn:()=>false,
    useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read(),usePref:()=> 'matrix',useLocale:()=> 'en',formatLocale:()=> 'en',useTimeRange:()=>selection,useSizing:()=>null,
    heatmapLayout,heatmapLayoutPrepared,HEATMAP_MIN:160,HEATMAP_NATURAL:300,boardPeriod:{calendar:{subscribe:()=>()=>{},get:()=>reading,retain:()=>()=>{},presentationKey:()=> 'fixture'}},t:(key:string)=>key,num:String,CATEGORY_COLORS:['blue'],CALENDAR_OPACITY:[0,.2,.4,.6,.8,1],
    setTimeRange:(range:{from:number;to:number})=>{selection=range;},ResizeObserver:class{observe(){}disconnect(){}},Popover:'popover',Segmented:'segmented',SlidersIcon:'icon',ReadState:'state',
  };
  const source=readFileSync(new URL('../components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{
    hooks.begin();const view=nodes(context.exports.AgentHoursHeatmap({arrange:{owner:false}}));
    view.find(n=>n.type==='section')!.props.ref.current=root;
    view.find(n=>n.props.role==='grid')!.props.ref.current=plot;hooks.commit();return view;
  };
  render();hooks.finish();render();hooks.finish();let view=render();
  const rows=view.filter(n=>n.props.role==='row'),order=rows.map(n=>(n.props.children as Node[])[0].props.item.row);
  assert.deepEqual(order,[...order].sort((a,b)=>a-b),'DOM row traversal matches the visual grid and arrow navigation');
  const bucket=view.find(n=>n.props.item?.date==='2026-10-05'&&n.props.item.from===Date.UTC(2026,9,5,12))!;
  assert.ok(bucket);const range={from:bucket.props.item.from,to:bucket.props.item.to};
  bucket.props.openRange(range);render();assert.equal(focused.length,0,'an old frame cannot receive the requested focus');
  reading={...reading,window:calendarWindow(range.to,'UTC',{mode:'range',...range}),loading:true};render();hooks.finish();view=render();
  assert.equal(focused.length,0,'a pending unknown grid must not consume the drill focus');
  const window=reading.window;
  reading={...reading,value:{zone:'UTC',edges:window.edges,cursor:'ready',availableFrom:range.from,retainedFrom:range.from,cells:window.edges.slice(0,-1).map((from,i)=>({agentMs:0,from,to:window.edges[i+1],validUntil:null}))},loading:false};
  render();hooks.finish();view=render();
  const tab=view.find(n=>n.props.tab)!;assert.ok(tab);assert.equal(focused.length,1);assert.ok(focused[0].includes(tab.props.item.key));
  render();assert.equal(focused.length,1,'ordinary data renders do not steal focus');
  bucket.props.openRange(range);selection={from:range.from-86_400_000,to:range.to-86_400_000};render();assert.equal(focused.length,1,'later navigation cancels a pending drill focus');
});
