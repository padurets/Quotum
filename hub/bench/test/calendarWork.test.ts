import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {recentCalendarTotalScript} from '../controls.js';
import {fixture,flush,NOW,M,H} from '../../ui/test/periodRuntimeFixture.js';
import {heatmapBasisPrepared,heatmapProjection,heatDateLabel,heatIntervalLabel} from '../../ui/lib/heatmap.js';
import {calendarCellAt,calendarRangeAt,calendarLevel,exactAgentHours,CALENDAR_OPACITY,type CalendarReading} from '../../ui/lib/workCalendar.js';
import {drain} from '../../server/domain/prepare.js';
import {MIN_TIME_RANGE} from '../../ui/lib/timeRange.js';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];

/** Execute the real cell renderer, including the Popover's actual button attributes. */
function renderedCells(reading:CalendarReading,now:number) {
  const jsx=(type:unknown,props:Record<string,unknown>)=>({type,props});
  const context={exports:{} as any,require:()=>({jsx,jsxs:jsx}),memo:(fn:unknown)=>fn,
    useState:(value:unknown)=>[value,()=>{}],useRef:(value:unknown)=>({current:value}),useMemo:(read:()=>unknown)=>read(),useLayoutEffect:()=>{},useSyncExternalStore:()=>false,
    useLocale:()=> 'en',formatLocale:()=> 'en-GB',useBubble:()=>null,heatDateLabel,heatIntervalLabel,calendarLevel,exactAgentHours,CALENDAR_OPACITY,CATEGORY_COLORS:['blue'],
    t:(key:string)=>key,Popover:'popover',PopoverHeading:'heading',MIN_TIME_RANGE};
  const source=readFileSync(new URL('../../ui/components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  runInNewContext(ts.transpileModule(source+'\nexports.Bucket=Bucket;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const basis=drain(heatmapBasisPrepared(reading,'matrix',1000)),layout=heatmapProjection(basis,now,1000,'matrix','en-GB');
  return layout.cells.map(item=>{
    const tree=context.exports.Bucket({item,span:layout.span,zone:reading.window.zone,tab:false,selected:false,focus:()=>{},openRange:()=>{},panel:{current:null},onKey:()=>{},preview:{get:()=>false,subscribe:()=>()=>{}}});
    const props=nodes(tree).find(node=>node.type==='popover')!.props.buttonProps;
    return {getAttribute:(name:string)=>props[name]===undefined?null:String(props[name])};
  }).filter(node=>node.getAttribute('data-agent-ms')!==null);
}

test('the work benchmark reads recent elapsed bounds after a real live calendar delta',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({heatmap:true,transportLive:true,clocked:true,periodName:'24h'});t.after(()=>h.close());
  h.store.creditWork(h.device,NOW-4*H,NOW-4*H+M,[{accountBy:'login',source:h.source,client:'codex',origin:'terminal',project:'Older work',folder:'Older folder',startedAt:NOW-5*H,identity:{kind:'stable',sessionId:'e'.repeat(32)}}]);h.events.flush();await flush();
  const calendar=h.period.calendar,before=calendar.state,cut=NOW-2*H;
  const total=(reading:CalendarReading)=>runInNewContext(recentCalendarTotalScript(cut),{document:{querySelectorAll:()=>renderedCells(reading,now)}}) as number;
  const beforeMs=total(before);
  now+=1000;h.jump(now);await flush();h.requests.length=0;
  const held=h.hold();h.credit(NOW-M,now);h.events.flush();await flush();
  assert.equal(held.reply?.calendar?.state,'delta');held.release();await flush();
  const after=calendar.state,range=calendarRangeAt(after,now);
  assert.notEqual(after,before);assert.equal(after.error,null);assert.equal(calendar.needed,false);
  assert.equal(calendarCellAt(after,range.from,range.to,now).agentMs,181_000,'older work remains in the full live period');
  assert.equal(h.requests.filter((request:any)=>request.calendar).length,1);
  assert.deepEqual([beforeMs,total(after)],[60_000,121_000],'the same fixed recent cohort gains the actual credited 61 seconds');
});
