const PIPELINE = new Set(['PipelineReporter','BeginImplFrameToSendBeginMainFrame','SendBeginMainFrameToCommit','Commit','EndCommitToActivation','Activation','EndActivateToSubmitCompositorFrame','SubmitCompositorFrameToPresentationCompositorFrame']);
const INPUT = new Set(['EventLatency','GenerationToBrowserMain','GenerationToRendererCompositor','BrowserMainToRendererCompositor','RendererCompositorQueueingDelay','RendererCompositorToMain','RendererCompositorProcessing','RendererMainProcessing','ArrivedInRendererCompositorToTermination','RendererCompositorStartedToTermination','RendererCompositorFinishedToTermination','RendererMainStartedToTermination','RendererMainFinishedToTermination']);
const INPUT_TYPES = new Set(['MOUSE_PRESSED','MOUSE_RELEASED','MOUSE_WHEEL','MOUSE_DRAGGED','MOUSE_MOVED_EVENT','KEY_PRESSED','KEY_RELEASED']);
const NAMES = new Set([...INPUT,...PIPELINE,'RunTask','ThreadControllerImpl::RunTask','FunctionCall','EventDispatch','UpdateLayoutTree','Layout','PrePaint','Paint','CompositeLayers','MinorGC','MajorGC','V8.GCScavenger','V8.GCCompactor','FireAnimationFrame','RequestAnimationFrame','UpdateLayerTree','ActivateLayerTree','DrawFrame','RasterTask','BeginFrame','BeginMainThreadFrame','EvaluateScript','TimerFire','TimeStamp','KeyframeModel','AnimationHost::ActivateAnimations','TileManager::DidFinishRunningTileTasksRequiredForActivation','LayerTreeHost::WaitForCommitCompletion']);
const TIMERS = new Set(['TimerInstall','TimerRemove','TimerFire']);
const CLOCK_MARKERS = new Set(['quotum-trace-clock-start','quotum-trace-clock-end','quotum-trace-control-start','quotum-trace-control-end']);
const STATES = new Set(['STATE_PRESENTED_ALL','STATE_PRESENTED_PARTIAL','STATE_DROPPED','STATE_NO_UPDATE_DESIRED']);
const BREAKDOWN = ['handle_input_events_us','animate_us','style_update_us','layout_update_us','accessibility_update_us','prepaint_us','compositing_inputs_us','paint_us','composite_commit_us','update_layers_us','begin_main_sent_to_started_us'] as const;
type Fields = Record<string,unknown>;
type TraceEvent = {name:string;ph:string;ts?:unknown;dur?:unknown;tts?:unknown;tdur?:unknown;pid?:unknown;tid?:unknown;id2?:unknown;args?:unknown};
type SourceFrames = {status:string;frames:{scriptId:number;lineNumber:number;columnNumber:number}[];invalid:number;omitted:number};
export type SafeTrace = {name:string;phase:string;ts?:number;duration?:number;threadTs?:number;threadDuration?:number;pid?:number;tid?:number;stage?:string;trackId?:number;
  source?:{scriptId:number;lineNumber:number;columnNumber:number};
  timer?:{id?:number;timeout?:number;singleShot?:boolean;invalid:number;ownerFrames:SourceFrames};
  flush?:SourceFrames;
  callbackId?:number;contextFrame?:number;
  frame?:{source?:number;sequence?:number;hostId?:number;state?:string;mainAnimation?:boolean;compositorAnimation?:boolean};
  input?:{type?:string};tile?:{layerId?:number;sourceFrame?:number};breakdown?:Partial<Record<typeof BREAKDOWN[number],number>>};
const fields = (value:unknown):Fields => value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Fields:{};
const numeric = (value:unknown) => typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;
const integer = (value:unknown) => typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
const boolean = (value:unknown) => typeof value==='boolean'?value:undefined;
const sourceFrames = (original:unknown,minCoordinate=0):SourceFrames => {
  const frames:SourceFrames['frames']=[];
  let invalid=0,omitted=0;
  if(Array.isArray(original))for(const value of original.slice(0,32)) {
    const frame=fields(value),scriptId=typeof frame.scriptId==='string'&&/^[1-9][0-9]*$/.test(frame.scriptId)?integer(Number(frame.scriptId)):integer(frame.scriptId);
    const lineNumber=integer(frame.lineNumber),columnNumber=integer(frame.columnNumber);
    if(scriptId!==undefined&&scriptId>0&&lineNumber!==undefined&&lineNumber>=minCoordinate&&columnNumber!==undefined&&columnNumber>=minCoordinate)frames.push({scriptId,lineNumber,columnNumber});
    else invalid++;
  }
  if(Array.isArray(original))omitted=Math.max(0,original.length-32);
  else if(original!==undefined)invalid++;
  // Preserve emitted coordinates; received-source binding is established separately.
  return {status:invalid||omitted?'insufficient-evidence':frames.length?'available':'unavailable',frames,invalid,omitted};
};

/** Async tracks are scoped to this interval and process. Their original opaque IDs never leave it. */
export function traceSanitizer(timers = false, flushStacks = false) {
  const tracks = new Map<string,number>();
  const contexts = new Map<string,number>();
  return (event:TraceEvent):SafeTrace|undefined => {
    if((!NAMES.has(event.name)&&!(timers&&TIMERS.has(event.name)))||!['B','E','X','I','b','e'].includes(event.ph))return;
    const args=fields(event.args),data=fields(args.data);
    const stage=event.name==='TimeStamp'&&typeof data.message==='string'&&CLOCK_MARKERS.has(data.message)?data.message:undefined;
    if(event.name==='TimeStamp'&&!stage)return;
    const safe:SafeTrace={name:event.name,phase:event.ph,ts:numeric(event.ts),duration:numeric(event.dur),threadTs:numeric(event.tts),threadDuration:numeric(event.tdur),pid:integer(event.pid),tid:integer(event.tid),stage};
    if(flushStacks&&(event.name==='FireAnimationFrame'||event.name==='FunctionCall'||stage)) {
      // RAF IDs can collide between Blink's internal and web callback collections.
      if(event.name==='FireAnimationFrame')safe.callbackId=integer(data.id);
      if(safe.pid!==undefined&&typeof data.frame==='string'&&data.frame.length>0&&data.frame.length<=128) {
        const key=safe.pid+':'+data.frame;
        if(!contexts.has(key)&&contexts.size<100_000)contexts.set(key,contexts.size+1);
        safe.contextFrame=contexts.get(key);
      }
    }
    if(['b','e'].includes(event.ph)) {
      const id=fields(event.id2).local;
      if(typeof id==='string'&&/^0x[0-9a-f]{1,16}$/i.test(id)&&safe.pid!==undefined) {
        const key=safe.pid+':'+id.toLowerCase();
        if(!tracks.has(key)&&tracks.size<100_000)tracks.set(key,tracks.size+1);
        safe.trackId=tracks.get(key);
      }
    }
    if(event.name==='FunctionCall') {
      // Callback locations survive without names, URLs or source text.
      const scriptId=typeof data.scriptId==='string'&&/^(0|[1-9][0-9]*)$/.test(data.scriptId)?integer(Number(data.scriptId)):integer(data.scriptId);
      const lineNumber=integer(data.lineNumber),columnNumber=integer(data.columnNumber);
      if(scriptId!==undefined&&lineNumber!==undefined&&columnNumber!==undefined)safe.source={scriptId,lineNumber,columnNumber};
    }
    if(timers&&TIMERS.has(event.name)) {
      const id=integer(data.timerId),timeout=numeric(data.timeout),singleShot=boolean(data.singleShot);
      const invalid=Number(id===undefined)+(event.name==='TimerInstall'?Number(timeout===undefined)+Number(singleShot===undefined):0);
      safe.timer={id,...(event.name==='TimerInstall'?{timeout,singleShot}:{}),invalid,ownerFrames:sourceFrames(data.stackTrace)};
    }
    if(flushStacks&&['Layout','UpdateLayoutTree'].includes(event.name)&&['B','X'].includes(event.ph)) {
      // beginData describes the current flush caller, not an earlier invalidation writer.
      safe.flush=sourceFrames(fields(args.beginData).stackTrace,1);
    }
    if(event.name==='EventLatency') {
      const type=fields(args.event_latency).event_type;
      safe.input={type:typeof type==='string'&&INPUT_TYPES.has(type)?type:undefined};
    } else if(event.name==='PipelineReporter') {
      const frame=fields(args.frame_reporter);
      safe.frame={source:integer(frame.frame_source),sequence:integer(frame.frame_sequence),hostId:integer(frame.layer_tree_host_id),
        state:typeof frame.state==='string'&&STATES.has(frame.state)?frame.state:undefined,
        mainAnimation:boolean(frame.has_main_animation),compositorAnimation:boolean(frame.has_compositor_animation)};
    } else if(event.name==='RasterTask') {
      const tile=fields(args.tileData);
      safe.tile={layerId:integer(tile.layerId),sourceFrame:integer(tile.sourceFrameNumber)};
    } else if(event.name==='SendBeginMainFrameToCommit') {
      const values=fields(args.send_begin_mainframe_to_commit_breakdown);
      // Chromium can emit unsigned underflow sentinels; they are not measured durations.
      safe.breakdown=Object.fromEntries(BREAKDOWN.flatMap(key=>{const value=integer(values[key]);return value!==undefined&&value<=60_000_000?[[key,value]]:[];}));
    }
    return safe;
  };
}
