import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {fixture,flush,NOW,H} from './periodRuntimeFixture';
import {preparationFixture} from './preparationFixture';
import {heatmapLayoutPrepared} from '../lib/heatmap';
import {focusEventsFixture} from './focusEventsFixture';

const DAY=24*H;
type Node={type:unknown;props:Record<string,any>};
const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];

for(const locale of ['en','ru'])for(const order of ['already-ready','immediate','data-first','placeholder-first','superseded','outside-pointer','outside-tab','assistive-focus','blank-pointer','escape','wheel','controlled-return','failure-retry','outside-failure-retry','background-retry','coalesced-range-return','coalesced-context-return','completed-then-retry','unmount'])test(`${locale} heatmap drill keeps focus through ${order} evidence`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({heatmap:true,personal:true,periodName:'30d'}),hooks=preparationFixture(),input=focusEventsFixture(),day=Math.floor(NOW/DAY)*DAY-5*DAY;
  h.store.creditWork(h.device,day+H,day+2*H,[{source:h.source,client:'codex',origin:'terminal',project:'Historical focus',folder:'historical-focus',startedAt:day,identity:{kind:'stable',sessionId:'historical-focus'}}]);
  h.events.flush();await flush();
  type Button={key:string;focus():void};
  const mounted=new Map<string,Button>(),calls:{value:boolean;ready:boolean}[]=[];
  let active:Button|null=null,latest:Node[]=[];
  const plot={clientWidth:350,querySelector:(selector:string)=>[...mounted.values()].find(button=>button.key===selector.match(/data-heatmap-cell="([^"]+)"/)?.[1])??null};
  const jsx=(type:unknown,props:Record<string,unknown>)=>({type,props});
  const focus={exports:{} as {isFocusReturn:()=>boolean;returnFocus:(target:unknown)=>void},require:()=>({}),document:input.document,getComputedStyle:()=>({visibility:'visible'})};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/focusReturn.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,focus);
  const context={exports:{} as any,require:()=>({jsx,jsxs:jsx}),...hooks,memo:(fn:unknown)=>fn,
    document:input.document,isFocusReturn:focus.exports.isFocusReturn,
    useSyncExternalStore:(_subscribe:unknown,get:()=>unknown)=>get(),usePref:()=> 'calendar',useLocale:()=>locale,formatLocale:()=>locale==='ru'?'ru-RU':'en-US',useTimeRange:h.selectedRange,useSizing:()=>null,
    heatmapLayoutPrepared,HEATMAP_MIN:160,HEATMAP_NATURAL:300,boardPeriod:h.period,t:(key:string)=>key,num:String,CATEGORY_COLORS:['blue'],CALENDAR_OPACITY:[0,.2,.4,.6,.8,1],
    setTimeRange:h.selectRange,ResizeObserver:class{observe(){}disconnect(){}},Popover:'popover',Segmented:'segmented',SlidersIcon:'icon',ReadState:'readstate'};
  const source=readFileSync(new URL('../components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{
    hooks.begin();latest=nodes(context.exports.AgentHoursHeatmap({arrange:{owner:false}}));
    const section=latest.find(node=>node.type==='section')!,grid=latest.find(node=>node.props.role==='grid')!;
    section.props.ref.current={};grid.props.ref.current=plot;
    const cells=latest.filter(node=>node.props.item),keys=new Set(cells.map(node=>node.props.item.row+':'+node.props.item.key));
    // Commit the keyed buttons before the component's actual layout effects.
    for(const [key,button] of mounted)if(!keys.has(key)){mounted.delete(key);if(active===button)active=null;}
    for(const {props:{item}} of cells){
      const key=item.row+':'+item.key;
      if(!mounted.has(key)){const button:Button={key:item.key,focus:()=>{active=button;input.document.activeElement=button;input.emit('focusin',button);calls.push({value:!!h.period.calendar.get().value,ready:section.props['data-calendar-ready']});}};mounted.set(key,button);}
    }
    hooks.commit();return latest;
  };
  const settle=()=>{for(let i=0;i<4;i++){render();hooks.finish();}return render();};
  let gate:ReturnType<typeof h.hold>|null=null;
  try{
    const bucket=settle().find(node=>node.props.item?.date===new Date(day).toISOString().slice(0,10))!;
    assert.ok(bucket);assert.equal(bucket.props.span,DAY);assert.notEqual(bucket.props.item.cell.agentMs,null);
    const range=bucket.props.item.dayRange;assert.ok(range.to<NOW);
    if(!['already-ready','immediate'].includes(order)){for(const candidate of h.period.calendar.evictionCandidates())candidate.drop();gate=h.hold();}
    if(order==='already-ready'){h.selectRange(range);await flush();assert.ok(h.period.calendar.get().value);}
    bucket.props.openRange(range);render();await flush();
    if(gate){
      assert.equal(h.period.calendar.get().value,null);
      if(order==='placeholder-first'){settle();assert.equal(latest.filter(node=>node.props.item).length,24);assert.equal(calls.length,0,'a temporary unknown grid cannot consume the drill handoff');}
      if(order==='superseded'){h.selectRange({from:range.from-DAY,to:range.to-DAY});render();}
      if(order==='coalesced-range-return'){h.selectRange({from:range.from-DAY,to:range.to-DAY});h.selectRange(range);}
      if(order==='coalesced-context-return'){h.period.calendar.configure(true,'another-context',NOW,false,{mode:'range',...range});h.period.changed();}
      const outside=input.target('chosen outside control');
      if(['outside-pointer','outside-failure-retry','completed-then-retry'].includes(order)){input.emit('pointerdown');outside.focus();}
      if(order==='outside-tab'){input.emit('keydown');outside.focus();}
      if(order==='assistive-focus')outside.focus();
      if(['blank-pointer','escape','wheel'].includes(order))input.emit(order==='blank-pointer'?'pointerdown':order==='escape'?'keydown':'wheel');
      if(order==='controlled-return')focus.exports.returnFocus(outside);
      if(order==='background-retry')outside.focus();
      if(order==='unmount')hooks.dispose();
      if(['failure-retry','outside-failure-retry','background-retry'].includes(order)){
        gate.reject(new Error('temporary calendar failure'));gate=null;await flush();render();
        assert.ok(h.period.calendar.get().error);
        if(order==='background-retry')h.period.retry();
        else {input.emit('keydown');latest.find(node=>node.type==='readstate')!.props.retry();focus.exports.returnFocus(outside);}
        await flush();
      }else{gate.release();gate=null;await flush();}
      if(order==='unmount'){assert.equal(input.listeners(),0);assert.equal(calls.length,0);return;}
    }
    settle();assert.equal(latest.find(node=>node.type==='section')!.props['data-calendar-ready'],true);
    assert.equal(latest.filter(node=>node.props.item).length,24);
    if(['superseded','outside-pointer','outside-tab','assistive-focus','blank-pointer','escape','wheel','background-retry','coalesced-range-return','coalesced-context-return','completed-then-retry'].includes(order)){
      assert.equal(calls.length,0,'a ready response cannot reclaim retired focus permission');
      if(order==='completed-then-retry'){
        gate=h.hold();
        h.store.creditWork(h.device,day+H,day+3*H,[{source:h.source,client:'codex',origin:'terminal',project:'Historical focus',folder:'historical-focus',startedAt:day,identity:{kind:'stable',sessionId:'historical-focus'}}]);
        h.events.flush();await flush();render();gate.reject(new Error('later same-range failure'));gate=null;await flush();render();
        assert.ok(h.period.calendar.get().error,'the completed request has a real later failed refresh');
        input.emit('keydown');latest.find(node=>node.type==='readstate')!.props.retry();await flush();settle();
        assert.equal(h.period.calendar.get().error,null);assert.equal(calls.length,0,'a completed revoked request cannot be revived by a later retry');
      }
    }
    else{
      assert.ok(active&&[...mounted.values()].includes(active),'focus ends on the ready mounted button, surviving evidence arrival');
      assert.equal(calls.length,1);assert.ok(calls.every(call=>call.value&&call.ready));
      render();assert.equal(calls.length,1,'ordinary renders do not repeat navigation focus');
    }
  }finally{gate?.release();hooks.dispose();assert.equal(input.listeners(),0);await h.close();}
});
