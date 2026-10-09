import {test} from 'node:test';
import assert from 'node:assert/strict';
import {traceInterval, tracePanning} from '../panningDiagnostic.js';
import type {Cdp} from '../cdp.js';
import {safeEvidence} from '../evidence.js';
import type {SafeTrace} from '../traceEvents.js';

function fixture() {
  const listeners=new Map<string,(value:unknown)=>void>(),sent:string[]=[],files=new Map<string,unknown>(),starts:object[]=[];
  const cdp={
    on:(method:string,callback:(value:unknown)=>void)=>listeners.set(method,callback),
    off:(method:string)=>listeners.delete(method),
    send:async(method:string,params:object)=>{sent.push(method);if(method==='Tracing.start')starts.push(params);if(method==='Tracing.end')listeners.get('Tracing.tracingComplete')?.({});return {metrics:[{name:'Timestamp',value:42}]};},
    evaluate:async()=>({now:7,timeOrigin:35}),
  } as unknown as Cdp;
  return {cdp,listeners,sent,files,starts,evidence:{save:(name:string,value:unknown)=>files.set(name,value),saveTrace:(name:string,value:unknown)=>files.set(name,value)}};
}

test('a trace retains only allowed numeric events from its own original interval', async()=>{
  const f=fixture();
  const result=await traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},async()=>{
    f.listeners.get('Tracing.dataCollected')?.({value:[{name:'Paint',ph:'X',ts:1,dur:2,tts:100,tdur:1,pid:3,tid:4,args:{cookie:'private-canary',url:'private-canary'}},{name:'private-canary',ph:'X',ts:5}]});
    return 17;
  },f.evidence);
  assert.equal(result,17);assert.equal(f.listeners.size,0);
  const text=JSON.stringify(f.files.get('trace'));
  assert.ok(text.includes('Paint')&&!text.includes('private-canary')&&!text.includes('cookie'));
  assert.deepEqual(f.sent,['Tracing.start','Performance.getMetrics','Performance.getMetrics','Performance.getMetrics','Performance.getMetrics','Tracing.end']);
  assert.deepEqual(f.starts,[{categories:'cc,devtools.timeline',transferMode:'ReportEvents'}]);
  assert.deepEqual((f.files.get('trace') as {events:{threadTs:number;threadDuration:number}[]}).events.map(event=>[event.threadTs,event.threadDuration]),[[100,1]]);
});

test('a failing trace interval stops collection and preserves the original error', async()=>{
  const f=fixture(),error=new Error('original failure');
  await assert.rejects(traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},async()=>{throw error;},f.evidence),value=>value===error);
  assert.equal(f.sent.at(-1),'Tracing.end');assert.equal(f.listeners.size,0);
  assert.ok(f.files.has('trace'));
});

for(const fails of [false,true])test(`an unconfirmed trace drain closes its browser and preserves ${fails?'the scenario failure':'the drain failure'}`, async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),original=f.cdp.send.bind(f.cdp),error=new Error('original scenario failed');
  let reached=()=>{},closed=0;
  const stopping=new Promise<void>(resolve=>{reached=resolve;});
  f.cdp.send=(async(method:string,params:object,signal?:AbortSignal)=>{
    if(method!=='Tracing.end')return original(method,params,signal);
    f.sent.push(method);reached();return {};
  }) as Cdp['send'];
  const outcome=assert.rejects(traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{closed++;}},async()=>{
    f.listeners.get('Tracing.dataCollected')?.({value:[{name:'Paint',ph:'X',ts:1,dur:2},{name:'private-canary',ph:'X',args:{cookie:'private-canary'}}]});
    if(fails)throw error;
    return 17;
  },f.evidence),value=>fails?value===error:value instanceof Error&&value.message==='diagnostic trace drain failed at events');
  await stopping;await new Promise<void>(resolve=>queueMicrotask(resolve));
  t.mock.timers.tick(5000);await outcome;
  assert.equal(closed,1);assert.equal(f.listeners.size,0);assert.equal(f.sent.at(-1),'Tracing.end');
  const report=f.files.get('trace') as {status:string;cleanup:string;drain:{stage:string;endAckMs:number};collection:{chunks:number;sourceEvents:number};events:SafeTrace[]};
  assert.equal(report.status,'insufficient-evidence');assert.equal(report.cleanup,'incomplete');
  assert.equal(report.drain.stage,'events');assert.ok(report.drain.endAckMs>=0);
  assert.equal(report.collection.chunks,1);assert.equal(report.collection.sourceEvents,2);
  assert.equal(report.events.length,1);assert.doesNotMatch(JSON.stringify(safeEvidence(report)),/private-canary/);
});

test('an attached browser never receives browser-wide tracing', async()=>{
  const f=fixture();
  await assert.rejects(traceInterval(f.cdp,{endpoint:'fixture',close:async()=>{}},async()=>{}),/owned synthetic/);
  assert.equal(f.sent.length,0);assert.equal(f.listeners.size,0);
});

test('a lost trace-start reply still stops the possibly active trace with its own cleanup', async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),original=f.cdp.send.bind(f.cdp);let cancelled=false;
  f.cdp.send=((method:string,params:object,signal?:AbortSignal)=>{
    if(method!=='Tracing.start')return original(method,params,signal);
    f.sent.push(method);
    return new Promise((_,reject)=>signal!.addEventListener('abort',()=>{cancelled=true;reject(signal!.reason);},{once:true}));
  }) as Cdp['send'];
  const outcome=assert.rejects(traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},async()=>{assert.fail('timed-out setup cannot run the scenario');},f.evidence),/deadline/);
  t.mock.timers.tick(5000);
  await outcome;
  assert.equal(cancelled,true);assert.equal(f.sent.at(-1),'Tracing.end');assert.equal(f.listeners.size,0);
});

test('native trace limits and clocks belong to each original scenario, with cleanup after a later failure', async()=>{
  const f=fixture(),error=new Error('second scenario failed');
  await assert.rejects(tracePanning(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},f.evidence,async cdp=>{
    for(const id of [1,2]){
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
      f.listeners.get('Tracing.dataCollected')?.({value:[{name:'Paint',ph:'X',ts:id,dur:1}]});
      if(id===2)throw error;
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
    }
    return {reports:[],problems:[]};
  }),value=>value===error);
  assert.equal(f.sent.filter(method=>method==='Tracing.start').length,2);
  assert.equal(f.sent.filter(method=>method==='Tracing.end').length,2);
  assert.equal(f.listeners.size,0);
  const first=f.files.get('trace-1-trace') as {events:{ts:number}[]};
  const second=f.files.get('trace-2-trace') as {events:{ts:number}[]};
  assert.deepEqual(first.events.map(event=>event.ts),[1]);assert.deepEqual(second.events.map(event=>event.ts),[2]);
});

test('trace clocks reject payload strings and arbitrary console timestamps', async()=>{
  const f=fixture();
  await traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},async()=>{
    f.listeners.get('Tracing.dataCollected')?.({value:[
      {name:'Paint',ph:'X',ts:'private-canary',dur:NaN,tts:'private-canary',tdur:-1},
      {name:'TimeStamp',ph:'I',ts:123,pid:3,tid:4,args:{data:{message:'quotum-trace-clock-start',url:'private-canary'}}},
      {name:'TimeStamp',ph:'I',ts:124,args:{data:{message:'private-canary'}}},
    ]});
  },f.evidence);
  const trace=f.files.get('trace') as {events:unknown[]};
  assert.equal(trace.events.length,2);assert.doesNotMatch(JSON.stringify(trace),/private-canary|url/);
  assert.deepEqual(trace.events[1],{name:'TimeStamp',phase:'I',ts:123,duration:undefined,threadTs:undefined,threadDuration:undefined,pid:3,tid:4,stage:'quotum-trace-clock-start'});
});

test('recorded commit and activation stages stay paired after exported trace sanitization', async()=>{
  const f=fixture();
  await traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},async()=>{
    // A real owned Electron control waited 72.682 ms between commit and activation.
    f.listeners.get('Tracing.dataCollected')?.({value:[
      {name:'PipelineReporter',ph:'b',pid:91,tid:10,ts:6343538,id2:{local:'0x1'},args:{frame_reporter:{frame_source:4294967296,frame_sequence:2,layer_tree_host_id:1,state:'STATE_PRESENTED_ALL',has_main_animation:false,has_compositor_animation:false}}},
      {name:'EndCommitToActivation',ph:'b',pid:91,tid:10,ts:6361328,id2:{local:'0x1'}},
      {name:'RasterTask',ph:'X',pid:91,tid:7,ts:6396884,dur:17574,args:{tileData:{layerId:6,sourceFrameNumber:1,tileId:{id_ref:'private-canary'}}}},
      {name:'PipelineReporter',ph:'b',pid:92,tid:10,ts:6361328,id2:{local:'0x1'},args:{frame_reporter:{frame_sequence:99}}},
      {name:'EndCommitToActivation',ph:'b',pid:92,tid:10,ts:6361328,id2:{local:'0x1'}},
      {name:'EndCommitToActivation',ph:'e',pid:92,tid:10,ts:6362328,id2:{local:'0x1'}},
      {name:'EndCommitToActivation',ph:'e',pid:91,tid:10,ts:6434010,id2:{local:'0x1'}},
      {name:'Activation',ph:'b',pid:91,tid:10,ts:6434010,id2:{local:'0x1'}},
      {name:'Activation',ph:'e',pid:91,tid:10,ts:6434093,id2:{local:'0x1'}},
      {name:'PipelineReporter',ph:'e',pid:91,tid:10,ts:6436700,id2:{local:'0x1'}},
    ]});
  },f.evidence);
  const trace=safeEvidence(f.files.get('trace')) as {events:SafeTrace[]};
  const frame=trace.events.find(event=>event.name==='PipelineReporter'&&event.pid===91)!;
  assert.deepEqual(frame.frame,{source:4294967296,sequence:2,hostId:1,state:'STATE_PRESENTED_ALL',mainAnimation:false,compositorAnimation:false});
  assert.equal(typeof frame.trackId,'number');
  const stages=trace.events.filter(event=>event.trackId===frame.trackId&&event.name==='EndCommitToActivation');
  assert.deepEqual(stages.map(event=>event.phase),['b','e']);
  assert.equal((stages[1].ts!-stages[0].ts!)/1000,72.682);
  assert.notEqual(trace.events.find(event=>event.pid===92)!.trackId,frame.trackId);
  assert.deepEqual(trace.events.find(event=>event.name==='RasterTask')!.tile,{layerId:6,sourceFrame:1});
  assert.doesNotMatch(JSON.stringify(trace),/private-canary|id_ref|0x1/);
});

test('compositor fields reject arbitrary text, opaque IDs and invalid duration sentinels', async()=>{
  const f=fixture();
  await traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},async()=>{
    f.listeners.get('Tracing.dataCollected')?.({value:[
      {name:'PipelineReporter',ph:'b',pid:1,id2:{local:'private-canary'},args:{frame_reporter:{state:'private-canary',frame_sequence:'private-canary',frame_source:Number.MAX_SAFE_INTEGER+1,layer_tree_host_id:-1,has_main_animation:'private-canary',surface_frame_trace_id:'private-canary'}}},
      {name:'SendBeginMainFrameToCommit',ph:'b',pid:1,id2:{local:'0x2'},args:{send_begin_mainframe_to_commit_breakdown:{animate_us:660,paint_us:487,begin_main_sent_to_started_us:18446739443733190000,layout_update_us:-1,style_update_us:'private-canary',private:'private-canary'}}},
      {name:'KeyframeModel',ph:'b',pid:1,id2:{local:'0x3'},args:{Name:'private-canary'}},
      {name:'RasterTask',ph:'X',args:{tileData:{layerId:'private-canary',sourceFrameNumber:-1,tileId:{id_ref:'private-canary'}}}},
    ]});
  },f.evidence);
  const trace=JSON.parse(JSON.stringify(safeEvidence(f.files.get('trace')))) as {events:SafeTrace[]};
  assert.deepEqual(trace.events[0].frame,{});assert.equal(trace.events[0].trackId,undefined);
  assert.deepEqual(trace.events[1].breakdown,{animate_us:660,paint_us:487});
  assert.deepEqual(trace.events[3].tile,{});
  assert.doesNotMatch(JSON.stringify(trace),/private-canary|surface_frame_trace_id|id2|"Name"|184467/);
});
