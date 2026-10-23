import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {calendarProof} from '../../server/domain/calendarWork';
import {calendarCells,type CalendarSection} from '../../server/domain/workCalendar';
import {packCalendar,expandCalendar} from '../../server/domain/workCalendarWire';
import {drain} from '../../server/domain/prepare';
import {WorkCalendar,calendarWindow} from '../lib/workCalendar';
import {HistoryPool} from '../lib/historyPool';
import {heatmapLayoutPrepared} from '../lib/heatmap';
import {preparationFixture} from './preparationFixture';
import {focusEventsFixture} from './focusEventsFixture';

const H=3_600_000,DAY=24*H,now=Date.UTC(2026,9,22,15)+4321,periodMs=30*DAY,retentionMs=90*DAY;
const selection={mode:'live' as const,periodMs};
function section(revision='1'):Extract<CalendarSection,{state:'complete'}>{
  const window=calendarWindow(now,'UTC',selection),range=window.range,known=now-75*DAY,retained=now-retentionMs;
  const rows=[{session:0,source:null,device:'synthetic-device',user:'synthetic-user',origin:'terminal' as const,project:null,folder:null,startedAt:now-H,from:now-H,to:now-H/2}];
  const cells=drain(calendarCells(rows,window.edges,window.edges.slice(1).map((_,i)=>i),now,known,retained,retentionMs,range,periodMs)).map(([,cell])=>cell);
  const proof={...drain(calendarProof(rows,range,now,known,retained,()=>{})),retentionMs,periodMs};
  const basis={run:'synthetic-run',revision,evaluatedAt:now,evidenceCut:now,range,calendarKey:'calendar',workAuthority:'authority',filterKey:'filter'};
  const part=expandCalendar(packCalendar({state:'complete',basis,value:{zone:'UTC',edges:window.edges,cells,availableFrom:known,retainedFrom:retained,cursor:revision,proof}},basis,()=>{}),basis,()=>{},()=>{});
  assert.ok(part?.state==='complete');assert.deepEqual(part.value.cells,cells);return part;
}
function utc(t:TestContext){
  const resolved=Intl.DateTimeFormat.prototype.resolvedOptions;
  t.mock.method(Intl.DateTimeFormat.prototype,'resolvedOptions',function(this:Intl.DateTimeFormat){return {...resolved.call(this),timeZone:'UTC'};});
}

for(const envelope of ['complete','delta','error'] as const)test(`work news revokes a queued ${envelope} calendar envelope without retiring its view`,t=>{
  utc(t);const calendar=new WorkCalendar();calendar.configure(true,'same-context',now,false,selection);
  calendar.receive(section(),calendar.generation,()=>true);
  const retained=calendar.get(),generation=calendar.generation,part=section('2');
  const stale:CalendarSection=envelope==='complete'?part:envelope==='error'?{state:'error',error:'unavailable'}:
    {state:'delta',basis:part.basis,value:{availableFrom:part.value.availableFrom,retainedFrom:part.value.retainedFrom,cursor:part.value.cursor,updates:[]}};
  assert.equal(calendar.dirty(now-H/4),true);let reservations=0;
  calendar.receive(stale,generation,()=>{reservations++;return true;});
  assert.equal(calendar.get(),retained,'a pre-news envelope cannot replace or mark the retained view as failed');
  assert.equal(calendar.needed,true,'a stale success or failure cannot discharge the current work demand');
  assert.equal(reservations,0,'revoked evidence must not allocate a new proof');
});

for(const phase of ['reserve','handoff'] as const)test(`work news during calendar ${phase} preserves its new demand`,t=>{
  utc(t);const calendar=new WorkCalendar(),fixed={mode:'range' as const,from:now-periodMs,to:now};calendar.configure(true,'same-context',now,false,fixed);
  calendar.receive(section(),calendar.generation,()=>true);const generation=calendar.generation;let dirtied=false;
  const dirty=()=>{if(!dirtied){dirtied=true;calendar.dirty(now-H/4);}return true;};
  calendar.receive(section('2'),generation,{reserve:()=>phase==='reserve'?dirty():true,handoff:()=>phase==='handoff'?dirty():true});
  assert.ok(dirtied);assert.equal(calendar.needed,true,'admission cannot clear work delivered during that admission');
  assert.ok(calendar.get().value,'the permitted retained view remains available');
  calendar.configure(true,'same-context',now,false,{mode:'range',from:now-2*H,to:now-H});
  calendar.configure(true,'same-context',now,false,fixed);
  assert.equal(calendar.needed,true,'a pre-news proof cannot become a complete healthy cache hit after Back');
});

for(const since of [now,now+1,Infinity])test(`outside fixed work does not revoke independent calendar evidence at ${since}`,t=>{
  utc(t);const calendar=new WorkCalendar(),fixed={mode:'range' as const,from:now-periodMs,to:now};
  calendar.configure(true,'same-context',now,false,fixed);calendar.receive(section(),calendar.generation,()=>true);
  const generation=calendar.generation;
  assert.equal(calendar.dirty(since),false);calendar.receive(section('2'),generation,()=>true);
  assert.equal(calendar.get().basis?.revision,'2','an unrelated update cannot revoke an otherwise current reply');
  assert.equal(calendar.needed,false);
});

test('cold calendar adoption transfers shared cells before another owner reserves at publication',t=>{
  utc(t);const part=section();
  // Keep all incoming non-numeric data, with an extra allowance independent of
  // WorkCalendar's estimator. Only the proven shared cell/edge roots transfer.
  const metadata=JSON.stringify({...part,value:{...part.value,cells:[],edges:[]}}).length*3+16_384;
  function run(padding=0,victim=0){
    const calendar=new WorkCalendar(),pool=new HistoryPool(),first={role:'visible' as const},second={role:'visible' as const};
    let drops=0,peak=0,published=false;
    pool.register({get estimatedBytes(){return calendar.bytes;},evictionCandidates:()=>calendar.evictionCandidates()});
    pool.register({get estimatedBytes(){return padding+victim;},evictionCandidates:()=>victim?[{bytes:victim,shownAt:-Infinity,drop(){victim=0;drops++;}}]:[]});
    calendar.configure(true,'same-context',now,false,selection);const initial=calendar.bytes;
    const stop=calendar.subscribe(()=>{
      assert.equal(calendar.get().value!.cells,part.value.cells,'the resident cells really share the decoded response allocation');
      published=true;assert.equal(pool.reserve(second,8192),true);
    });
    try{
      calendar.receive(part,calendar.generation,bytes=>{const accepted=pool.reserve(first,bytes);if(!published)peak=Math.max(peak,pool.estimatedBytes-padding-victim);return accepted;});
      assert.ok(published);assert.equal(calendar.get().error,null);
      return {peak,initial,resident:calendar.bytes,drops};
    }finally{stop();pool.release(first);pool.release(second);calendar.clear();padding=0;victim=0;assert.equal(pool.estimatedBytes,0);}
  }
  const calibration=run(),victim=2*1024*1024,headroom=64*1024;
  const honestPeak=Math.max(calibration.peak,calibration.resident+calibration.initial+metadata+8192),padding=15*1024*1024-victim-honestPeak-headroom;
  assert.ok(padding>0);const actual=run(padding,victim);
  assert.equal(actual.drops,0,'resident cells and caller staging must not evict unrelated history for the same allocation');
  t.diagnostic(JSON.stringify({budget:15*1024*1024,padding,victim,headroom,honestPeak,metadata,calibration,actual}));
});

test('calendar handoff keeps unadopted siblings and the incoming proof charged',t=>{
  utc(t);const calendar=new WorkCalendar(),pool=new HistoryPool(),flight={role:'visible' as const},part=section();
  calendar.configure(true,'same-context',now,false,selection);
  pool.register({get estimatedBytes(){return calendar.bytes;},evictionCandidates:()=>calendar.evictionCandidates()});
  const siblings=3*1024*1024;let calendarSlot=calendar.incomingBytes(part),remaining=-1,held=siblings+calendarSlot;
  assert.equal(pool.reserve(flight,held),true);
  const reserve=(bytes:number)=>{const accepted=pool.reserve(flight,siblings+bytes);if(accepted){calendarSlot=bytes;held=siblings+bytes;}return accepted;};
  const stop=calendar.subscribe(()=>{
    assert.equal(calendarSlot,remaining);assert.equal(held,siblings+remaining);
    assert.equal(pool.estimatedBytes,calendar.bytes+siblings+remaining);
    assert.ok(remaining>=JSON.stringify(part.value.proof).length*3,'proof storage remains in the caller until its flight releases');
  });
  try{
    calendar.receive(part,calendar.generation,{reserve,handoff(bytes){remaining=bytes;return reserve(bytes);}});
    assert.ok(remaining>0&&remaining<calendar.incomingBytes(part));
    assert.equal(calendar.get().value!.cells,part.value.cells);assert.equal(calendar.get().window.edges,part.value.edges);
  }finally{stop();pool.release(flight);calendar.clear();assert.equal(pool.estimatedBytes,0);}
});

test('captured calendar readings share exact roots and survive authority retirement until the last consumer releases',t=>{
  utc(t);const calendar=new WorkCalendar();calendar.configure(true,'same-context',now,false,selection);calendar.receive(section(),calendar.generation,()=>true);
  for(const entry of calendar.evictionCandidates())entry.drop();
  const old=calendar.get(),single=calendar.bytes,releaseA=calendar.retain(old),releaseB=calendar.retain(old);
  assert.equal(calendar.bytes,single,'multiple consumers of one snapshot count its roots once');
  calendar.receive({state:'error',error:'unavailable'},calendar.generation,()=>true);
  assert.ok(calendar.bytes-single<8192,'a new status wrapper must not charge the identical value/window roots twice');
  calendar.receive(section('2'),calendar.generation,()=>true);
  assert.ok(calendar.bytes>=old.value!.cells.length*160*2,'a genuinely new numeric root coexists with the captured old one');
  calendar.clear();assert.ok(calendar.bytes>=old.value!.cells.length*160,'authority loss cannot release live consumer references');
  assert.equal(calendar.bytes,single);releaseA();assert.equal(calendar.bytes,single);
  releaseA();assert.equal(calendar.bytes,single,'release is idempotent');releaseB();assert.equal(calendar.bytes,0);
});

for(const phase of ['reserve','handoff','publish'] as const)for(const change of ['hide','replace','clear'] as const)test(`a reentrant ${change} at ${phase} keeps captured readings charged without restoring retired authority`,t=>{
  utc(t);const calendar=new WorkCalendar();calendar.configure(true,'same-context',now,false,selection);calendar.receive(section(),calendar.generation,()=>true);
  const old=calendar.get(),part=section('2');let changed=false,checked=false;
  const retire=()=>{
    if(changed)return;changed=true;
    if(change==='hide')calendar.configure(false,'same-context',now);
    if(change==='replace')calendar.configure(true,'replacement-authority',now);
    if(change==='clear')calendar.clear();
    const roots=phase==='reserve'?1:2;
    assert.ok(calendar.bytes>=old.value!.cells.length*160*roots,'producer pins outlive reentrant retirement through every callback');checked=true;
  };
  const stop=calendar.subscribe(()=>{if(phase==='publish')retire();});
  try{calendar.receive(part,calendar.generation,{reserve(){if(phase==='reserve')retire();return true;},handoff(){if(phase==='handoff')retire();return true;}});}
  finally{stop();}
  assert.ok(changed&&checked);assert.equal(calendar.get().value,null);
  if(change==='replace'){assert.ok(calendar.presentationKey().includes('replacement-authority'));assert.ok(calendar.needed);}
  else assert.equal(calendar.bytes,0,'the last producer pin releases after the retired receive returns');
  calendar.clear();assert.equal(calendar.bytes,0);
});

for(const phase of ['reserve','handoff'] as const)for(const failure of ['refuse','throw'] as const)test(`calendar ${phase} ${failure} preserves the previous evidence and releases temporary owners`,t=>{
  utc(t);const calendar=new WorkCalendar();calendar.configure(true,'same-context',now,false,selection);calendar.receive(section(),calendar.generation,()=>true);
  for(const entry of calendar.evictionCandidates())entry.drop();
  const old=calendar.get(),part=section('2');let held=0,published=false;
  const reserve=(bytes:number)=>{if(phase==='reserve'){if(failure==='throw')throw new Error('reservation failed');return false;}held=bytes;return true;};
  const stop=calendar.subscribe(()=>{published=true;assert.equal(calendar.get().value,old.value);assert.ok(held===0||held>=calendar.incomingBytes(part),'a refused shrink retains its prior admitted incoming charge');});
  try{
    const receive=()=>calendar.receive(part,calendar.generation,{reserve,handoff(){if(failure==='throw')throw new Error('handoff failed');return false;}});
    if(failure==='throw')assert.throws(receive,/failed/);else receive();
    assert.equal(calendar.get().value,old.value);assert.equal(calendar.get().basis,old.basis);
    assert.equal(published,failure==='refuse');assert.equal(calendar.get().error,failure==='refuse'?'history_limit':null);
  }finally{stop();calendar.clear();assert.equal(calendar.bytes,0,'no producer pin leaks on failure');}
});

test('delta handoff releases its new cells array scratch while retaining incoming updates',t=>{
  utc(t);const calendar=new WorkCalendar();calendar.configure(true,'same-context',now,false,selection);calendar.receive(section(),calendar.generation,()=>true);
  const old=calendar.get(),cell={...old.value!.cells[1],agentMs:1234},part:Extract<CalendarSection,{state:'delta'}>={state:'delta',basis:{...old.basis!,revision:'2'},value:{availableFrom:old.value!.availableFrom,retainedFrom:old.value!.retainedFrom,cursor:'2',updates:[[1,cell]]}};
  let staged=0,remaining=0;
  calendar.receive(part,calendar.generation,{reserve(bytes){staged=bytes;return true;},handoff(bytes){remaining=bytes;return true;}});
  assert.equal(staged-remaining,old.value!.cells.length*16);assert.equal(remaining,calendar.incomingBytes(part));
  assert.notEqual(calendar.get().value!.cells,old.value!.cells);assert.equal(calendar.get().value!.cells[1],cell);assert.equal(calendar.get().value!.cells[0],old.value!.cells[0]);
  calendar.clear();assert.equal(calendar.bytes,0);
});

test('actual heatmap owns captured input and the displayed old grid through skipped readings, retirement and unmount',t=>{
  utc(t);const calendar=new WorkCalendar();calendar.configure(true,'same-context',now,false,selection);calendar.receive(section(),calendar.generation,()=>true);
  const hooks=preparationFixture(),jsx=(type:unknown,props:Record<string,any>)=>({type,props}),plot={clientWidth:350,querySelector:()=>null};
  type Node={type:unknown;props:Record<string,any>};
  const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props.children)]:[];
  const context={exports:{} as Record<string,(props:unknown)=>Node>,require:()=>({jsx,jsxs:jsx}),memo:(f:unknown)=>f,...hooks,document:focusEventsFixture().document,isFocusReturn:()=>false,
    useSyncExternalStore:(_s:unknown,read:()=>unknown)=>read(),usePref:()=> 'matrix',useLocale:()=> 'en',formatLocale:()=> 'en',useTimeRange:()=>null,useSizing:()=>null,
    heatmapLayoutPrepared,HEATMAP_MIN:160,HEATMAP_NATURAL:300,boardPeriod:{calendar},t:(key:string)=>key,num:String,CATEGORY_COLORS:['blue'],CALENDAR_OPACITY:[0,.2,.4,.6,.8,1],
    ResizeObserver:class{observe(){}disconnect(){}},Popover:'popover',Segmented:'segmented',SlidersIcon:'icon',ReadState:'state'};
  const source=readFileSync(new URL('../components/AgentHoursHeatmap.tsx',import.meta.url),'utf8').replace(/^import .*;$/mg,'');
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{
    hooks.begin();const tree=nodes(context.exports.AgentHoursHeatmap({arrange:{owner:false}}));
    tree.find(n=>n.type==='section')!.props.ref.current={};tree.find(n=>n.props.role==='grid')!.props.ref.current=plot;hooks.commit();return tree.filter(n=>n.props.item).map(n=>n.props.item);
  };
  try{
    render();hooks.finish();render();hooks.finish();const shown=render(),old=calendar.get(),count=old.value!.cells.length;
    assert.ok(shown.length);const oldParts=new Set<unknown>(old.value!.cells);assert.ok(shown.some(item=>item.parts.some((cell:unknown)=>oldParts.has(cell))));
    calendar.receive(section('2'),calendar.generation,()=>true);assert.deepEqual(render(),shown,'the complete old grid survives while its replacement is queued');
    calendar.receive(section('3'),calendar.generation,()=>true);
    assert.ok(calendar.bytes>=count*160*3,'displayed A, queued B and current C all own different numeric roots');
    render();assert.ok(calendar.bytes>=count*160*2,'cancelled B releases while the displayed A remains owned');
    calendar.clear();assert.ok(calendar.bytes>=count*160*2,'authority retirement preserves real captured/displayed references until commit');
    assert.equal(render().length,0,'the retired grid is not offered for painting');hooks.finish();render();
    assert.ok(calendar.bytes<count*160,'the old cell roots release after the retiring commit');
  }finally{hooks.dispose();calendar.clear();assert.equal(calendar.bytes,0,'unmount releases the last captured shell');}
});
