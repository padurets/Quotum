const PIPELINE = new Set(['PipelineReporter','BeginImplFrameToSendBeginMainFrame','SendBeginMainFrameToCommit','Commit','EndCommitToActivation','Activation','EndActivateToSubmitCompositorFrame','SubmitCompositorFrameToPresentationCompositorFrame']);
const INPUT = new Set(['EventLatency','GenerationToBrowserMain','GenerationToRendererCompositor','BrowserMainToRendererCompositor','RendererCompositorQueueingDelay','RendererCompositorToMain','RendererCompositorProcessing','RendererMainProcessing','ArrivedInRendererCompositorToTermination','RendererCompositorStartedToTermination','RendererCompositorFinishedToTermination','RendererMainStartedToTermination','RendererMainFinishedToTermination']);
const INPUT_TYPES = new Set(['MOUSE_PRESSED','MOUSE_RELEASED','MOUSE_WHEEL','MOUSE_DRAGGED','MOUSE_MOVED_EVENT','KEY_PRESSED','KEY_RELEASED']);
const NAMES = new Set([...INPUT,...PIPELINE,'RunTask','ThreadControllerImpl::RunTask','FunctionCall','EventDispatch','UpdateLayoutTree','Layout','PrePaint','Paint','CompositeLayers','MinorGC','MajorGC','V8.GCScavenger','V8.GCCompactor','FireAnimationFrame','RequestAnimationFrame','UpdateLayerTree','ActivateLayerTree','DrawFrame','RasterTask','BeginFrame','BeginMainThreadFrame','EvaluateScript','TimerFire','TimeStamp','KeyframeModel','AnimationHost::ActivateAnimations','TileManager::DidFinishRunningTileTasksRequiredForActivation','LayerTreeHost::WaitForCommitCompletion']);
const CLOCK_MARKERS = new Set(['quotum-trace-clock-start','quotum-trace-clock-end','quotum-trace-control-start','quotum-trace-control-end']);
const STATES = new Set(['STATE_PRESENTED_ALL','STATE_PRESENTED_PARTIAL','STATE_DROPPED','STATE_NO_UPDATE_DESIRED']);
const BREAKDOWN = ['handle_input_events_us','animate_us','style_update_us','layout_update_us','accessibility_update_us','prepaint_us','compositing_inputs_us','paint_us','composite_commit_us','update_layers_us','begin_main_sent_to_started_us'] as const;
type Fields = Record<string,unknown>;
type TraceEvent = {name:string;ph:string;ts?:unknown;dur?:unknown;tts?:unknown;tdur?:unknown;pid?:unknown;tid?:unknown;id2?:unknown;args?:unknown};
export type SafeTrace = {name:string;phase:string;ts?:number;duration?:number;threadTs?:number;threadDuration?:number;pid?:number;tid?:number;stage?:string;trackId?:number;
  frame?:{source?:number;sequence?:number;hostId?:number;state?:string;mainAnimation?:boolean;compositorAnimation?:boolean};
  input?:{type?:string};tile?:{layerId?:number;sourceFrame?:number};breakdown?:Partial<Record<typeof BREAKDOWN[number],number>>};
const fields = (value:unknown):Fields => value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Fields:{};
const numeric = (value:unknown) => typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;
const integer = (value:unknown) => typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
const boolean = (value:unknown) => typeof value==='boolean'?value:undefined;

/** Async tracks are scoped to this interval and process. Their original opaque IDs never leave it. */
export function traceSanitizer() {
  const tracks = new Map<string,number>();
  return (event:TraceEvent):SafeTrace|undefined => {
    if(!NAMES.has(event.name)||!['B','E','X','I','b','e'].includes(event.ph))return;
    const args=fields(event.args),data=fields(args.data);
    const stage=event.name==='TimeStamp'&&typeof data.message==='string'&&CLOCK_MARKERS.has(data.message)?data.message:undefined;
    if(event.name==='TimeStamp'&&!stage)return;
    const safe:SafeTrace={name:event.name,phase:event.ph,ts:numeric(event.ts),duration:numeric(event.dur),threadTs:numeric(event.tts),threadDuration:numeric(event.tdur),pid:integer(event.pid),tid:integer(event.tid),stage};
    if(['b','e'].includes(event.ph)) {
      const id=fields(event.id2).local;
      if(typeof id==='string'&&/^0x[0-9a-f]{1,16}$/i.test(id)&&safe.pid!==undefined) {
        const key=safe.pid+':'+id.toLowerCase();
        if(!tracks.has(key)&&tracks.size<100_000)tracks.set(key,tracks.size+1);
        safe.trackId=tracks.get(key);
      }
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
