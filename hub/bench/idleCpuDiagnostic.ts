import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import type {Cdp} from './cdp.js';
import {bounded} from './reversalDiagnostic.js';
import {numericProfile} from './cpuProfile.js';
import {ScriptBinding} from './scriptBinding.js';
import type {Reading} from './probe.js';

type Client={status:'available';name:string;bytes:number;sha256:string}|{status:'unavailable'};
type RawEvent={name:string;ph:string;id?:unknown;bp?:unknown;ts?:number;dur?:number;tts?:number;tdur?:number;pid?:number;tid?:number;args?:{name?:unknown;layerTreeId?:unknown;prepare_tiles_id?:unknown;source_prepare_tiles_id?:unknown;count?:unknown;pending_gpu_work_tiles?:unknown;cc_scheduler_state?:{state_machine?:{minor_state?:Record<string,unknown>}};data?:{frame?:string;frameId?:unknown;id?:number;timerId?:number;timeout?:number;singleShot?:boolean;scriptId?:string|number;lineNumber?:number;columnNumber?:number;stackTrace?:unknown;message?:string;frames?:{frame?:string;processId?:number;isOutermostMainFrame?:boolean;isInPrimaryMainFrame?:boolean}[]}}};
type CounterWindow={before:Record<string,number>;after:Record<string,number>;instrumentMs:number;seconds:number};
type Save=(name:string,value:unknown,large?:boolean)=>void;
type Profile=Parameters<typeof numericProfile>[0];
type ClockSource={sha256:string;lineNumber:number;columnNumber:number}|null;
type ClockTiming=ReturnType<typeof ownedClockFires>[number]&{threadTs:number|null;threadDuration:number|null};
const MAX_EVENTS=100_000,MAX_BYTES=32*1024*1024;
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const location=(value:any)=>{
  const scriptId=typeof value?.scriptId==='string'&&/^[1-9]\d*$/.test(value.scriptId)?Number(value.scriptId):value?.scriptId;
  return Number.isSafeInteger(scriptId)&&scriptId>0&&Number.isSafeInteger(value?.lineNumber)&&value.lineNumber>=0&&Number.isSafeInteger(value?.columnNumber)&&value.columnNumber>=0
    ?{scriptId,lineNumber:value.lineNumber,columnNumber:value.columnNumber}:null;
};

type NativeRow={name:string;phase:string;ts:number|null;duration:number|null;threadTs:number|null;threadDuration:number|null;pid:number;tid:number;frame:number|null;
  source:ReturnType<typeof location>;id:number|null;marker:number|null;kind?:string;processId?:number|null;outermost?:boolean;primary?:boolean;flowId?:number;flowEnd?:true;hostId?:number;sourceFrame?:number;prepareId?:number|null;rasterTasks?:number|null;pendingGpuTasks?:number|null;scheduler?:Record<typeof SCHEDULER_FIELDS[number],boolean>};
const SCHEDULER_FIELDS=['has_pending_tree','pending_tree_is_ready_for_activation','active_tree_needs_first_draw','active_tree_is_ready_to_draw',
  'processing_animation_worklets_for_pending_tree','processing_paint_worklets_for_pending_tree','current_pending_tree_is_impl_side','can_draw'] as const;
const PIPELINE_NAMES=new Set(['ProxyMain::BeginMainFrame','ProxyMain::BeginMainFrame::commit','ProxyImpl::ReadyToCommit','ProxyImpl::Commit']);
const NATIVE_NAMES=new Set(['RunTask','FunctionCall','FireAnimationFrame','RequestAnimationFrame','CancelAnimationFrame','MinorGC','MajorGC','Layout','UpdateLayoutTree','RunMicrotasks','EventDispatch','TimerFire','TimeStamp','PrePaint','Paint','Layerize','CompositeLayers',
  'PageAnimator::serviceScriptedAnimations','WebFrameWidgetImpl::UpdateLifecycle','LayerTreeHost::WaitForCommitCompletion',...PIPELINE_NAMES,'BeginMainThreadFrame','HoldCommit','ReleaseCommitbyActivation','SchedulerStateMachine',
  'TileManager::PrepareTiles','TileManager::ScheduleTasks','RasterizerTaskImpl::RunOnWorkerThread',
  'TileManager::DidFinishRunningTileTasksRequiredForActivation','TileManager::CheckPendingGpuWorkAndIssueSignals','LayerTreeHostImpl::ActivateSyncTree']);

/** Compiled positions are valid only for the bytes the page actually received. */
export function clientIdentity(directory=path.join(import.meta.dirname,'../dist/client/assets')):Client {
  try {
    const names=readdirSync(directory).filter(name=>/^index-[\w-]+\.js$/.test(name));
    if(names.length!==1)return{status:'unavailable'};
    const bytes=readFileSync(path.join(directory,names[0]));
    return{status:'available',name:names[0],bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }catch{return{status:'unavailable'};}
}

/** A manually selected checkout can differ from the workflow event's commit. */
export function sourceIdentity(env:NodeJS.ProcessEnv=process.env,readHead=()=>execFileSync('git',['rev-parse','--verify','HEAD'],{encoding:'utf8'}).trim()) {
  const sha=(value:string|undefined)=>value&&/^[a-f0-9]{40}$/.test(value)?value:null;
  let checkoutSha:string|null=null;
  try{checkoutSha=sha(readHead());}catch{/* Keep unavailable provenance explicit. */}
  return{mode:'diagnostic',status:checkoutSha?'complete':'insufficient-evidence',sourceHead:sha(env.QUOTUM_BENCH_SOURCE_SHA),checkoutSha,eventSha:sha(env.GITHUB_SHA),run:env.GITHUB_RUN_ID??null,attempt:env.GITHUB_RUN_ATTEMPT??null};
}

/** Trace callback coordinates are one-based; CPU sample coordinates are separate. */
export function clockTimerSource(client:Client,directory=path.join(import.meta.dirname,'../dist/client/assets')):ClockSource {
  if(client.status!=='available')return null;
  try{
    const bytes=readFileSync(path.join(directory,client.name));
    if(bytes.length!==client.bytes||createHash('sha256').update(bytes).digest('hex')!==client.sha256)return null;
    const text=bytes.toString('utf8'),body='()=>{this.timer=null,this.wakeDue()}',at=text.indexOf(body);
    if(at<0||text.indexOf(body,at+1)>=0)return null;
    return{sha256:client.sha256,lineNumber:text.slice(0,at).split('\n').length,columnNumber:at-text.lastIndexOf('\n',at)};
  }catch{return null;}
}

/** A TimerFire owns only its directly nested callback, not later asynchronous work. */
export function ownedClockFires(events:readonly unknown[],binding:unknown,source:ClockSource,before:number,after:number) {
  const receipt=binding as {status?:unknown;receivedHash?:unknown;clientHash?:unknown;debuggerDisabled?:unknown;owners?:{scriptId:number;parsedHash:string;receivedAssetHashMatches:boolean}[]}|undefined;
  if(!source||receipt?.status!=='complete'||receipt.debuggerDisabled!==true||receipt.receivedHash!==source.sha256||receipt.clientHash!==source.sha256||!Array.isArray(receipt.owners))return[];
  const owners=new Set(receipt.owners.filter(owner=>owner.receivedAssetHashMatches&&owner.parsedHash===source.sha256).map(owner=>owner.scriptId));
  const rows=events as {name:string;frame:number;pid:number;tid:number;ts:number;duration:number|null;source:{scriptId:number;lineNumber:number;columnNumber:number}|null;timer:{id:number|null}|null}[];
  return rows.filter(fire=>fire.name==='TimerFire'&&fire.frame===1&&finite(fire.duration)&&fire.ts>=before*1e6&&fire.ts+fire.duration!<=after*1e6&&rows.some(call=>call.name==='FunctionCall'&&call.frame===1&&call.pid===fire.pid&&call.tid===fire.tid&&call.ts>=fire.ts&&finite(call.duration)&&call.ts+call.duration!<=fire.ts+fire.duration!&&call.source&&owners.has(call.source.scriptId)&&call.source.lineNumber===source.lineNumber&&call.source.columnNumber===source.columnNumber)).map(fire=>({timerId:fire.timer?.id??null,ts:fire.ts,duration:fire.duration,pid:fire.pid,tid:fire.tid,source}));
}

/** Original timing and chart commits qualify a trace, without proving physical geometry. */
export function originalTraceProblems(from:number,to:number,cellMs:number,window:CounterWindow,reading:Pick<Reading,'renders'|'mutations'>,fires:readonly ClockTiming[]):string[] {
  const problems:string[]=[];
  if(window.seconds!==120||to-from!==120_000||cellMs!==300_000||![from,to,window.before.Timestamp,window.after.Timestamp].every(Number.isFinite)||!(window.after.Timestamp>window.before.Timestamp))problems.push('original120s counter interval is unavailable');
  const boundary=(Math.floor(from/cellMs)+1)*cellMs;
  if(!(boundary>from&&boundary<to))problems.push('original window missed the natural chart cell edge');
  for(const widget of ['quota','session','activity','budget','funds'] as const)for(const [kind,rows] of [['render',reading.renders],['mutation',reading.mutations]] as const){
    if(!rows.some(row=>row.time&&row.kind==='chart'&&row.widget===widget&&Number.isSafeInteger(row.count)&&row.count>0))problems.push(widget+' chart '+kind+' was not observed');
  }
  if(!fires.length)problems.push('no received-source-bound own Clock TimerFire in the original counter interval');
  else if(fires.some(fire=>!finite(fire.threadTs)||!finite(fire.threadDuration)))problems.push('own Clock thread timing is unavailable');
  return problems;
}

/** Bounded CPU or timeline observations in the benchmark's own synthetic browser. */
export class IdleCpuDiagnostic {
  readonly binding:ScriptBinding;
  private frame:string|null=null;
  private active=false;
  private profiler=false;
  private tracing=false;
  private ended=false;
  private complete:()=>void=()=>{};
  private readonly events:unknown[]=[];
  private bytes=0;
  private omitted=0;
  private rejectedForeign=0;
  private unscoped=0;
  private invalid=0;
  private invalidOwners=0;
  private omittedOwners=0;
  private timerFires=0;
  private sourceCallbacks=0;
  private sourceBinding:unknown;
  private profileStatus='unavailable';
  private traceCleanup='unavailable';
  private readonly clockSource:ClockSource;
  private nativeLoader:string|null=null;
  private nativeStable=false;
  private nativeLoss:boolean|null=null;
  private nativeLifecycle=0;
  private nativeRuntime=false;
  private nativeCleaning:Promise<void>|undefined;
  private nativeProfile:ReturnType<typeof numericProfile>|null=null;
  private readonly nativeRejected:Record<string,unknown>[]=[];
  private readonly nativeClocks:{stage:'start'|'end';lo:number;hi:number;timeOrigin:number}[]=[];
  private readonly nativeInvalidated=()=>{this.nativeLifecycle++;};
  private get native(){return this.collection==='native-trace'||this.collection==='native-profile';}
  private get profiling(){return this.collection==='profile'||this.collection==='native-profile';}
  private readonly clocks:{stage:string;before:number|null;page:number;after:number|null;valid:boolean}[]=[];
  private readonly collected=(message:{value:RawEvent[]})=>{
    if(!this.active)return;
    if(this.native){this.collectNative(message.value);return;}
    for(const event of message.value){
      if(!['TimerInstall','TimerRemove','TimerFire','FunctionCall','TimeStamp'].includes(event.name))continue;
      const data=event.args?.data;
      if(!data||data.frame!==this.frame){if(data?.frame)this.rejectedForeign++;else this.unscoped++;continue;}
      if(!finite(event.ts)||!Number.isSafeInteger(event.pid)||!Number.isSafeInteger(event.tid)){this.invalid++;continue;}
      const ownerFrames=Array.isArray(data.stackTrace)?data.stackTrace.slice(0,32).map(location):[];
      const invalidOwners=ownerFrames.filter(frame=>!frame).length;
      const omittedOwners=Array.isArray(data.stackTrace)?Math.max(0,data.stackTrace.length-32):0;
      this.invalidOwners+=invalidOwners;this.omittedOwners+=omittedOwners;
      if(event.name==='TimerFire')this.timerFires++;
      if(event.name==='FunctionCall'&&location(data))this.sourceCallbacks++;
      const safe={name:event.name,phase:event.ph,ts:event.ts,duration:finite(event.dur)?event.dur:null,
        threadTs:finite(event.tts)?event.tts:null,threadDuration:finite(event.tdur)?event.tdur:null,pid:event.pid,tid:event.tid,frame:1,
        source:event.name==='FunctionCall'?location(data):null,
        timer:event.name.startsWith('Timer')?{id:Number.isSafeInteger(data.timerId)?data.timerId:null,timeout:finite(data.timeout)?data.timeout:null,
          singleShot:typeof data.singleShot==='boolean'?data.singleShot:null,ownerFrames,
          ownerStatus:invalidOwners||omittedOwners?'insufficient-evidence':ownerFrames.length?'available':'unavailable',
          omittedOwnerFrames:omittedOwners}:null};
      const bytes=Buffer.byteLength(JSON.stringify(safe));
      if(this.events.length>=MAX_EVENTS||this.bytes+bytes>MAX_BYTES){this.omitted++;continue;}
      this.bytes+=bytes;this.events.push(safe);
    }
  };
  private readonly completed=(message?:{dataLossOccurred?:unknown})=>{
    this.ended=true;if(this.native)this.nativeLoss=typeof message?.dataLossOccurred==='boolean'?message.dataLossOccurred:null;this.complete();
  };
  private rejectNative(event:RawEvent,reason:'identity'|'timestamp'|'phase'|'duration'|'frame-metadata'|'commit-metadata'|'scheduler-metadata'){
    this.invalid++;
    if(this.nativeRejected.length>=8)return;
    const metadata=event.name==='thread_name'||event.name==='TracingStartedInBrowser',known=NATIVE_NAMES.has(event.name),frame=event.args?.data?.frame;
    this.nativeRejected.push({name:known||metadata?event.name:'other',kind:metadata?'metadata':known?'known':'other',
      phase:['B','E','X','I','M','i','b','e','n','s','t','f','C','R','S','T','F','P','N','O','D'].includes(event.ph)?event.ph:null,
      pid:Number.isSafeInteger(event.pid)?event.pid:null,tid:Number.isSafeInteger(event.tid)?event.tid:null,
      ts:typeof event.ts==='number'&&Number.isFinite(event.ts)?event.ts:null,frame:typeof frame==='string'&&frame?frame===this.frame?1:2:null,reason});
  }
  private collectNative(events:RawEvent[]){
    for(const event of events){
      const metadata=event.name==='thread_name'||event.name==='TracingStartedInBrowser',known=NATIVE_NAMES.has(event.name);
      const flow=PIPELINE_NAMES.has(event.name)&&(event.ph==='s'||event.ph==='f');
      if(!metadata&&!known&&event.ph!=='B'&&event.ph!=='E')continue;
      if(!Number.isSafeInteger(event.pid)||event.pid!<=0||!Number.isSafeInteger(event.tid)||event.tid!<=0){this.rejectNative(event,'identity');continue;}
      if(!metadata&&!finite(event.ts)){this.rejectNative(event,'timestamp');continue;}
      if(!flow&&!['B','E','X','I','M'].includes(event.ph)){this.rejectNative(event,'phase');continue;}
      if(event.ph==='X'&&!finite(event.dur)){this.rejectNative(event,'duration');continue;}
      const data=event.args?.data,marker=data?.message==='quotum-native-start'?1:data?.message==='quotum-native-end'?2:null;
      if(event.name==='TimeStamp'&&marker===null&&event.ph!=='B'&&event.ph!=='E')continue;
      const row:NativeRow={name:known||metadata?event.name:'other',phase:event.ph,ts:finite(event.ts)?event.ts!:null,duration:finite(event.dur)?event.dur!:null,
        threadTs:finite(event.tts)?event.tts!:null,threadDuration:finite(event.tdur)?event.tdur!:null,pid:event.pid!,tid:event.tid!,frame:data?.frame?data.frame===this.frame?1:2:null,
        source:event.name==='FunctionCall'?location(data):null,id:Number.isSafeInteger(data?.id)?data!.id!:null,marker};
      if(flow){
        // Exported edge indices stay exact; original uint64 commit IDs may not.
        if(!integer(event.id)||event.ph==='f'&&event.bp!=='e'){this.rejectNative(event,'commit-metadata');continue;}
        row.flowId=event.id;if(event.ph==='f')row.flowEnd=true;
      }
      if(event.name==='BeginMainThreadFrame'){
        const host=event.args?.layerTreeId,frame=data?.frameId;
        if(!integer(host)||host===0||!integer(frame)){this.rejectNative(event,'commit-metadata');continue;}
        row.hostId=host;row.sourceFrame=frame;
      }
      if(event.name==='SchedulerStateMachine'&&event.ph!=='B'&&event.ph!=='E'){
        const state=event.args?.cc_scheduler_state?.state_machine?.minor_state;
        if(event.ph!=='X'||!state||SCHEDULER_FIELDS.some(key=>typeof state[key]!=='boolean')){this.rejectNative(event,'scheduler-metadata');continue;}
        row.scheduler=Object.fromEntries(SCHEDULER_FIELDS.map(key=>[key,state[key]])) as NonNullable<NativeRow['scheduler']>;
      }
      if(event.name==='TileManager::PrepareTiles'||event.name==='RasterizerTaskImpl::RunOnWorkerThread'){
        const id=event.name==='TileManager::PrepareTiles'?event.args?.prepare_tiles_id:event.args?.source_prepare_tiles_id;
        row.prepareId=integer(id)?id:null;
      }
      if(event.name==='TileManager::ScheduleTasks')row.rasterTasks=integer(event.args?.count)?event.args.count:null;
      if(event.name==='TileManager::CheckPendingGpuWorkAndIssueSignals')row.pendingGpuTasks=integer(event.args?.pending_gpu_work_tiles)?event.args.pending_gpu_work_tiles:null;
      if(event.name==='thread_name')row.kind=event.args?.name==='CrRendererMain'?'renderer-main':'other';
      if(event.name==='TracingStartedInBrowser'){
        if(!Array.isArray(data?.frames)){this.rejectNative(event,'frame-metadata');continue;}
        if(data.frames.length>32)this.omitted+=data.frames.length-32;
        for(const frame of data.frames.slice(0,32))if(frame.frame===this.frame)this.appendNative({...row,frame:1,processId:Number.isSafeInteger(frame.processId)&&frame.processId!>0?frame.processId!:null,
          outermost:frame.isOutermostMainFrame===true,primary:frame.isInPrimaryMainFrame===true});
      }else this.appendNative(row);
    }
  }
  private appendNative(row:NativeRow){
    const bytes=Buffer.byteLength(JSON.stringify(row));
    if(this.events.length>=MAX_EVENTS||this.bytes+bytes>MAX_BYTES){this.omitted++;return;}
    this.bytes+=bytes;this.events.push(row);
  }
  private async nativeClock(stage:'start'|'end'){
    const reading=await this.cdp.evaluate<{lo:number;hi:number;timeOrigin:number}>(`(()=>{const lo=performance.now();console.timeStamp('quotum-native-${stage}');return {lo,hi:performance.now(),timeOrigin:performance.timeOrigin};})()`,this.nativeSignal);
    this.nativeClocks.push({stage,lo:reading.lo,hi:reading.hi,timeOrigin:reading.timeOrigin});
  }
  private saveNative(cleanup:string){
    const rows=this.events as NativeRow[],maps=rows.filter(row=>row.name==='TracingStartedInBrowser');
    const pids=[...new Set(maps.map(row=>row.processId))],pid=pids.length===1?pids[0]:null;
    const mains=rows.filter(row=>row.name==='thread_name'&&row.pid===pid&&row.kind==='renderer-main'),tid=mains.length===1?mains[0].tid:null;
    const scope=!!pid&&tid===pid&&maps.length>0&&maps.every(row=>row.outermost&&row.primary)&&!rows.some(row=>row.name==='thread_name'&&row.pid===pid&&row.tid===tid&&row.kind!=='renderer-main')&&this.nativeStable&&!this.nativeLifecycle;
    const markers=rows.filter(row=>row.name==='TimeStamp'&&row.frame===1&&row.pid===pid&&row.tid===tid);
    const clock=this.nativeClocks.length===2&&this.nativeClocks.every((row,i)=>row.stage===(i?'end':'start')&&[row.lo,row.hi,row.timeOrigin].every(finite)&&row.hi>=row.lo)&&this.nativeClocks[0].timeOrigin===this.nativeClocks[1].timeOrigin&&this.nativeClocks[1].lo>=this.nativeClocks[0].hi;
    const start=markers.filter(row=>row.marker===1),end=markers.filter(row=>row.marker===2);
    const stamps=start.length===1&&end.length===1&&start[0].phase==='I'&&end[0].phase==='I'&&Number.isSafeInteger(start[0].ts)&&Number.isSafeInteger(end[0].ts)&&end[0].ts!>start[0].ts!;
    this.save('native-frame-trace',{mode:'diagnostic',status:'unqualified',kind:'Recorded scopes only; wall minus thread time does not identify descheduling, blocking or throttling.',
      capture:{status:cleanup==='complete'&&this.ended&&this.nativeLoss===false&&!this.omitted&&!this.invalid?'complete':'insufficient-evidence',cleanup,ended:this.ended,dataLossOccurred:this.nativeLoss,omitted:this.omitted,invalid:this.invalid,bytes:this.bytes},
      scope:{status:scope?'complete':'unknown',frame:1,pid:pid??null,tid,lifecycleEvents:this.nativeLifecycle,stableFrame:this.nativeStable},
      clocks:{status:scope&&clock&&stamps?'recorded-unqualified':'unknown',readings:this.nativeClocks,markers},
      source:this.sourceBinding??{status:'unknown'},events:rows,rejected:this.nativeRejected,omittedRejections:Math.max(0,this.invalid-this.nativeRejected.length),
      unqualifiedCandidates:scope?0:rows.length},true);
    if(this.profiling)this.save('native-frame-profile',{mode:'diagnostic',status:'unqualified',kind:'Signed sampled elapsed widths; not exclusive cost or thread CPU time. Observer overhead is unqualified.',
      capture:{status:cleanup==='complete'&&this.nativeProfile?.status==='complete'?'complete':'insufficient-evidence',cleanup},samplingInterval:2000,profile:this.nativeProfile},true);
  }
  private cleanupNative(){
    // Owner cancellation stops observations; release both domains with one separate deadline.
    return this.nativeCleaning??=bounded('native trace cleanup',async signal=>{
      const results=await Promise.allSettled([
        (async()=>{if(this.tracing){await this.cdp.send('Tracing.end',{},signal);this.tracing=false;}})(),
        (async()=>{if(this.nativeRuntime){await this.cdp.send('Runtime.disable',{},signal);this.nativeRuntime=false;}})(),
        (async()=>{if(this.profiler&&!this.nativeProfile){const reply=await this.cdp.send<{profile:Profile}>('Profiler.stop',{},signal);this.nativeProfile=numericProfile(reply.profile);}})(),
        (async()=>{if(this.profiler){await this.cdp.send('Profiler.disable',{},signal);this.profiler=false;}})(),
      ]);
      const failure=results.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
    },5000);
  }
  private nativeListeners(attach:boolean){
    for(const method of ['Page.frameNavigated','Page.frameDetached','Runtime.executionContextsCleared']){
      if(attach)this.cdp.on(method,this.nativeInvalidated);else this.cdp.off(method,this.nativeInvalidated);
    }
  }

  constructor(private readonly cdp:Cdp,private readonly save:Save,client:Client,ownedSynthetic:boolean,private readonly collection:'profile'|'trace'|'native-trace'|'native-profile'='profile',private readonly nativeSignal?:AbortSignal){
    if(!ownedSynthetic)throw Error('Idle CPU diagnostics require an owned synthetic browser');
    this.clockSource=this.native?null:clockTimerSource(client);
    this.binding=new ScriptBinding(cdp,client,(name,value)=>{if(name.startsWith('source-family-'))this.sourceBinding=value;save((this.native?'native-frame-':'idle-cpu-')+name,value);});
    save(this.native?'native-frame-client':'idle-cpu-client',{mode:'diagnostic',client,clockSource:this.clockSource});
  }

  private async clock(stage:string){
    const stamp=async()=>(await this.cdp.send<{metrics:{name:string;value:number}[]}>('Performance.getMetrics')).metrics.find(metric=>metric.name==='Timestamp')?.value;
    const before=await stamp(),page=await this.cdp.evaluate<number>('performance.now()'),after=await stamp();
    this.clocks.push({stage,before:Number.isFinite(before)?before!*1000:null,page,after:Number.isFinite(after)?after!*1000:null,
      valid:Number.isFinite(before)&&Number.isFinite(after)&&Number.isFinite(page)&&before!<=after!});
  }

  /** Called before the unchanged from/to/reset/metrics sequence. */
  async start(){
    if(this.native){
      if(this.tracing||this.ended||this.nativeClocks.length)throw Error('Native trace is single-use');
      this.nativeSignal?.throwIfAborted();this.nativeListeners(true);this.nativeRuntime=true;
      await this.cdp.send('Runtime.enable',{},this.nativeSignal);
    }
    const frame=(await this.cdp.send<{frameTree:{frame:{id:string;loaderId?:string}}}>('Page.getFrameTree',{},this.nativeSignal)).frameTree.frame;
    this.frame=frame.id;if(this.native)this.nativeLoader=typeof frame.loaderId==='string'&&frame.loaderId?frame.loaderId:null;
    if(typeof this.frame!=='string'||!this.frame)throw Error('Owned target frame unavailable');
    this.cdp.on('Tracing.dataCollected',this.collected);this.cdp.on('Tracing.tracingComplete',this.completed);
    if(this.profiling){
      this.profiler=true;await this.cdp.send('Profiler.enable',{},this.nativeSignal);
      await this.cdp.send('Profiler.setSamplingInterval',{interval:2000},this.nativeSignal);
    }
    if(!this.native)await this.clock('start');
    this.active=true;this.tracing=true;
    await this.cdp.send('Tracing.start',{categories:this.native?'toplevel,cc,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-cc.debug.scheduler':'devtools.timeline,disabled-by-default-devtools.timeline.stack',transferMode:'ReportEvents'},this.nativeSignal);
    if(this.native)await this.nativeClock('start');
    if(this.profiling)await this.cdp.send('Profiler.start',{},this.nativeSignal);
  }

  /** Stop only after the original counter readout or native report is frozen. */
  async stop(window?:CounterWindow){
    if(!this.native&&!window)throw Error('Original idle counter window unavailable');
    let profile:ReturnType<typeof numericProfile>|null=null,cleanup='complete',error:unknown;
    try{
      if(this.native){
        await this.nativeClock('end');
        const frame=(await this.cdp.send<{frameTree:{frame:{id:string;loaderId?:string}}}>('Page.getFrameTree',{},this.nativeSignal)).frameTree.frame;
        this.nativeStable=!!this.nativeLoader&&frame.id===this.frame&&frame.loaderId===this.nativeLoader;
      }else await this.clock('end');
      if(this.profiling){
        const reply=await this.cdp.send<{profile:Profile}>('Profiler.stop',{},this.nativeSignal);
        if(this.native)this.nativeProfile=numericProfile(reply.profile);
        await this.cdp.send('Profiler.disable',{},this.nativeSignal);this.profiler=false;
        profile=this.native?this.nativeProfile:numericProfile(reply.profile);
      }
      const completed=new Promise<void>(resolve=>{this.complete=resolve;});
      await this.cdp.send('Tracing.end',{},this.nativeSignal);
      await bounded('idle CPU trace drain',()=>completed,5000,this.nativeSignal);
      this.tracing=false;
    }catch(value){error=value;cleanup='incomplete';}
    finally{
      this.active=false;
      this.cdp.off('Tracing.dataCollected',this.collected);this.cdp.off('Tracing.tracingComplete',this.completed);
      if(this.profiler&&!this.native)try{await this.cdp.send('Profiler.stop');await this.cdp.send('Profiler.disable');this.profiler=false;}catch{cleanup='incomplete';}
      if(this.native){
        this.nativeListeners(false);
        try{await this.cleanupNative();}catch(value){cleanup='incomplete';error??=value;}
      }else if(this.tracing)try{await this.cdp.send('Tracing.end');this.tracing=false;}catch{cleanup='incomplete';}
      this.traceCleanup=cleanup;
      if(this.native){try{this.saveNative(cleanup);}catch(value){error??=value;}}
      else {
      this.profileStatus=this.collection==='trace'?'not-collected-by-design':cleanup==='complete'&&profile?.status==='complete'?'complete':'insufficient-evidence';
      this.save('idle-cpu-profile',{mode:'diagnostic',kind:this.collection==='trace'?'CPU sampling was not requested; tracing overhead is unqualified.':'Sampled elapsed widths, not thread CPU time; observer overhead unqualified.',
        status:this.profileStatus,samplingInterval:this.collection==='trace'?null:2000,clocks:this.clocks,cleanup,profile},true);
      this.save('idle-cpu-window',{mode:'diagnostic',kind:'Original elapsed counters and existing probe cost; collection order and budget are unchanged.',...window});
      this.save('idle-cpu-timers',{mode:'diagnostic',status:cleanup==='complete'&&this.ended&&!this.omitted&&!this.invalid&&this.timerFires>0&&this.sourceCallbacks>0?'complete':'insufficient-evidence',
        scope:'explicit owned target frame only',frame:1,coordinates:'as emitted; source binding required',cleanup,ended:this.ended,omitted:this.omitted,
        invalid:this.invalid,invalidOwners:this.invalidOwners,omittedOwners:this.omittedOwners,timerFires:this.timerFires,sourceCallbacks:this.sourceCallbacks,
        rejectedForeign:this.rejectedForeign,unscoped:this.unscoped,bytes:this.bytes,events:this.events},true);
      }
    }
    if(error)throw error;
  }

  async bindAndClose(){try{if(this.native)await this.binding.afterFamily([1],'after-family',this.nativeSignal);else await this.binding.afterFamily([1]);}finally{this.binding.close();if(this.native)this.saveNative(this.traceCleanup);}}
  traceReceipt(from:number,to:number,cellMs:number,window:CounterWindow,reading:Reading){
    const fires=ownedClockFires(this.events,this.sourceBinding,this.clockSource,window.before.Timestamp,window.after.Timestamp).map(fire=>{
      const event=this.events.find(value=>{const row=value as {name:string;ts:number;pid:number;tid:number};return row.name==='TimerFire'&&row.ts===fire.ts&&row.pid===fire.pid&&row.tid===fire.tid;}) as {threadTs:number|null;threadDuration:number|null};
      return{...fire,threadTs:event.threadTs,threadDuration:event.threadDuration};
    });
    const problems=originalTraceProblems(from,to,cellMs,window,reading,fires);
    const profileComplete=this.collection==='trace'?this.profileStatus==='not-collected-by-design':this.profileStatus==='complete';
    if(!profileComplete||this.traceCleanup!=='complete'||this.tracing||!this.ended||this.omitted||this.invalid||this.invalidOwners||this.omittedOwners||this.clocks.length!==2||this.clocks.some(clock=>!clock.valid))problems.push('owned-frame trace, profile or clock evidence is incomplete');
    const receipt={mode:'diagnostic',kind:'Original unaligned CI idle timing; elapsed, thread durations and sampled widths are distinct. Observer overhead is unqualified; chart commits do not prove geometry, and asynchronous attribution remains unknown.',status:problems.length?'insufficient-evidence':'complete',actual:{from,to,cellMs,seconds:window.seconds,beforeTimestamp:window.before.Timestamp,afterTimestamp:window.after.Timestamp},charts:{renders:reading.renders.filter(row=>row.kind==='chart'),mutations:reading.mutations.filter(row=>row.kind==='chart')},clockFires:fires,profileStatus:this.profileStatus,problems};
    this.save('idle-cpu-original-trace',receipt);return receipt;
  }
  async close(){
    const interrupted=this.native&&(this.active||this.tracing||this.nativeRuntime||this.profiler);
    this.active=false;this.binding.close();
    if(this.native)this.nativeListeners(false);
    this.cdp.off('Tracing.dataCollected',this.collected);this.cdp.off('Tracing.tracingComplete',this.completed);
    if(this.profiler&&!this.native){try{await this.cdp.send('Profiler.stop');}finally{await this.cdp.send('Profiler.disable');this.profiler=false;}}
    if(this.native){
      let error:unknown;
      try{await this.cleanupNative();}catch(value){error=value;}
      if(interrupted)try{this.saveNative('incomplete');}catch(value){error??=value;}
      if(error)throw error;
    }else if(this.tracing){await this.cdp.send('Tracing.end');this.tracing=false;}
  }
}
