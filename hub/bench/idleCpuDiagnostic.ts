import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import type {Browser,Cdp} from './cdp.js';
import {bounded} from './reversalDiagnostic.js';
import {numericProfile,profileInterval} from './cpuProfile.js';
import {ScriptBinding} from './scriptBinding.js';
import type {Reading} from './probe.js';
import {idleRetentionProblems,type IdleRetention} from './idleRetention.js';
import {safeEvidence} from './evidence.js';
import type {IdlePhase} from './still.js';

type Client={status:'available';name:string;bytes:number;sha256:string}|{status:'unavailable'};
type RawEvent={name:string;ph:string;ts?:number;dur?:number;tts?:number;tdur?:number;pid?:number;tid?:number;args?:{data?:{frame?:string;timerId?:number;timeout?:number;singleShot?:boolean;scriptId?:string|number;lineNumber?:number;columnNumber?:number;stackTrace?:unknown;message?:string}}};
type CounterWindow={before:Record<string,number>;after:Record<string,number>;instrumentMs:number;seconds:number};
type Save=(name:string,value:unknown,large?:boolean)=>void;
type Profile=Parameters<typeof numericProfile>[0];
export type IdleEdgePlan={boundary:number;from:number;to:number;cellMs:number;seconds:number;marginMs:30_000};
export type IdleChartGeometry={widget:'quota'|'session'|'activity'|'budget'|'funds';count:number;axisEnd:number|null;from:number|null;to:number|null;ready:boolean;panning:boolean;visibleFrom:number|null;visibleTo:number|null};
export type IdleGeometry={now:number;selected:boolean;charts:IdleChartGeometry[]};
type ClockSource={sha256:string;lineNumber:number;columnNumber:number}|null;
type ClockTiming=ReturnType<typeof ownedClockFires>[number]&{threadTs:number|null;threadDuration:number|null};
const MAX_EVENTS=100_000,MAX_BYTES=32*1024*1024;
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const location=(value:any)=>{
  const scriptId=typeof value?.scriptId==='string'&&/^[1-9]\d*$/.test(value.scriptId)?Number(value.scriptId):value?.scriptId;
  return Number.isSafeInteger(scriptId)&&scriptId>0&&Number.isSafeInteger(value?.lineNumber)&&value.lineNumber>=0&&Number.isSafeInteger(value?.columnNumber)&&value.columnNumber>=0
    ?{scriptId,lineNumber:value.lineNumber,columnNumber:value.columnNumber}:null;
};

export const retirementReadScript=`(()=>{const monotonicFrom=performance.now(),retention=window.__quotumIdleRetention();return {monotonicFrom,retention,monotonicTo:performance.now()};})()`;
export const gridSnapshotScript=`window.__quotumGridSnapshot=()=>{const monotonicFrom=performance.now(),retention=window.__quotumIdleRetention(),phase=window.__quotumIdlePhase.read();return {monotonicFrom,retention,phase,monotonicTo:performance.now()};};void 0;`;
export const gridReadScript='window.__quotumGridSnapshot()';
type BoundaryRead={monotonicFrom:number;monotonicTo:number;retention:IdleRetention|null;phase?:IdlePhase};

/** Observe one natural boundary inside the original idle counters, without a trace-clock join. */
export async function idleBoundaryProfile(cdp:Cdp,browser:Browser,planned:{from:number;to:number;quotaBoundary:number;boundary?:number;cellMs?:number},opening:IdleRetention|null,save:Save,target:'retirement'|'grid'='retirement'){
  const owner=browser.owner;
  if(!browser.owned||!owner)throw Error('Idle boundary profiling requires an owned synthetic run');
  return owner.operation(async()=>{
    const grid=target==='grid',boundary=grid?planned.boundary!:planned.quotaBoundary;
    // The canonical grid can be only five seconds before the original window closes.
    const from=boundary-(grid?6000:5000),to=boundary+(grid?4000:5000),script=grid?gridReadScript:retirementReadScript;
    if(![planned.from,planned.to,boundary].every(Number.isFinite)||!(planned.from<boundary&&to<planned.to)
      ||grid&&(!Number.isFinite(planned.cellMs)||planned.cellMs!<=0||boundary%planned.cellMs! !==0||from<=planned.quotaBoundary||from<=planned.from))throw Error('Idle boundary profiling requires the original boundary window');
    let before:BoundaryRead|null=null,after:BoundaryRead|null=null,finishedAt:number|null=null,failed=false,failure:unknown,writesFailed=false,runtimeAvailable=false;
    let capture:{status?:string;samplingInterval?:number;profile?:{samples?:number[];startTime?:number;endTime?:number}}|undefined;
    const write=(name:string,value:unknown,large=false)=>{try{
      const safe=safeEvidence(value,'',0,large?100_000:10_000);
      if(Buffer.byteLength(JSON.stringify(safe))>(large?32:1)*1024*1024)writesFailed=true;
      save('idle-cpu-'+target+'-'+name,safe,large);
    }catch{writesFailed=true;}};
    write('plan',{mode:'diagnostic',kind:target,...planned,from,to,samplingInterval:250});
    try{
      const runtime=await bounded('idle boundary runtime',signal=>cdp.send<{product?:string;revision?:string;jsVersion?:string;protocolVersion?:string}>('Browser.getVersion',{},signal),5000,owner.signal);
      const dotted=(value:unknown)=>typeof value==='string'&&/^\d+(?:\.\d+)+$/.test(value)&&value.length<=120?value:null;
      const version=dotted(runtime.product?.replace(/^Chrome\//,'')),v8=dotted(runtime.jsVersion);
      runtimeAvailable=!!version&&!!v8;
      write('runtime',{chromium:{version,sha:/^@?[a-f\d]{40}$/.test(runtime.revision??'')?runtime.revision!.replace(/^@/,''):null},v8:{version:v8},protocol:{version:dotted(runtime.protocolVersion)}});
      await wait(Math.max(0,from-Date.now()),undefined,{signal:owner.signal});
      if(Date.now()>=boundary)throw Error('Idle boundary profiling missed the opening boundary');
      await profileInterval(cdp,browser,async()=>{
        before=await cdp.evaluate<BoundaryRead>(script,owner.signal);write('before',before);
        await wait(Math.max(0,to-Date.now()),undefined,{signal:owner.signal});
        after=await cdp.evaluate<BoundaryRead>(script,owner.signal);write('after',after);
      },{save:(name,value)=>write(name,value),saveTrace:(name,value)=>{
        if(name==='profile')capture=value as typeof capture;
        write(name,value,true);
      }},250);
      finishedAt=Date.now();
    }catch(error){failed=true;failure=error;}
    const firstRead=before as BoundaryRead|null,lastRead=after as BoundaryRead|null;
    const first=firstRead?.retention??null,last=lastRead?.retention??null;
    const problems=grid?idleRetentionProblems(opening,first,opening?.at??NaN,first?.at??NaN,planned.quotaBoundary):idleRetentionProblems(first,last,first?.at??NaN,last?.at??NaN,boundary);
    const basis=(value:IdleRetention|null)=>value?.quota?JSON.stringify([value.identity,value.generation,value.revision,value.proofEpoch,value.scopeKey,value.selection,
      value.quota.cut,value.quota.cursor,value.quota.rows.map(row=>JSON.stringify([row.sourceId,row.windowId,row.count,row.first,row.second,row.third,row.last])).sort()]):null;
    const due=(value:IdleRetention|null)=>value?.quota?.rows.filter(row=>row.second!==null&&row.second+1+(value.selection.periodMs??NaN)===boundary)
      .map(row=>({sourceId:row.sourceId,windowId:row.windowId})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))??[];
    const expected=grid?[]:due(opening),observed=grid?[]:due(first);
    if(grid){
      if(finishedAt===null||finishedAt>=planned.to)problems.push('grid profiling did not finish inside the original idle counters');
      if(!first?.settled||!last?.settled||!basis(first)||basis(first)!==basis(last)||first.quota?.from!==last.quota?.from)problems.push('grid capture changed admitted storage or its basis');
      if(!first||!last||!(first.at<boundary&&boundary<last.at)||first.retirementAt!==last.retirementAt||[first,last].some(value=>value.retirementAt===null||!finite(value.retirementAt)||value.retirementAt<=Math.max(last.at,finishedAt??last.at)))problems.push('grid capture overlaps quota retirement or misses its boundary');
      const phase=(value:IdlePhase|undefined,advanced:boolean)=>!!value&&value.cellMs===planned.cellMs&&value.from===firstRead?.phase?.from
        &&value.from<first!.at&&value.to<planned.to&&(advanced?value.to>boundary:value.to<boundary)
        &&[value.starts,value.ends,value.transitions].every(values=>values.length===5)
        &&value.starts.every(cell=>cell===Math.floor((boundary-1)/planned.cellMs!))
        &&value.ends.every(cell=>cell===Math.floor((boundary-(advanced?0:1))/planned.cellMs!))
        &&value.transitions.every(count=>count===(advanced?1:0));
      if(!first||!phase(firstRead?.phase,false)||!phase(lastRead?.phase,true))problems.push('grid capture did not observe all five original axis transitions');
    }else if(!opening?.settled||!basis(opening)||basis(opening)!==basis(first)||!expected.length||JSON.stringify(expected)!==JSON.stringify(observed))problems.push('retirement capture differs from the opening quota evidence');
    if(!firstRead||!lastRead||![firstRead.monotonicFrom,firstRead.monotonicTo,lastRead.monotonicFrom,lastRead.monotonicTo].every(finite)
      ||firstRead.monotonicFrom>firstRead.monotonicTo||firstRead.monotonicTo>=lastRead.monotonicFrom||lastRead.monotonicFrom>lastRead.monotonicTo)problems.push('retirement snapshot page clocks unavailable');
    if(!first||!last||!(planned.from<first.at&&last.at<planned.to))problems.push('retirement capture escaped the original idle counters');
    const samples=capture?.profile?.samples?.length??0;
    if(capture?.status!=='complete'||capture.samplingInterval!==250||!samples||samples>100_000)problems.push('retirement CPU profile incomplete');
    if(!runtimeAvailable)problems.push('retirement runtime identity unavailable');
    if(failed)problems.push('retirement capture did not finish');
    if(writesFailed)problems.push('retirement evidence write failed');
    const receipt={mode:'diagnostic',kind:grid?'Natural grid boundary and coincident clock work; recording brackets both snapshots. Sampled widths are not thread CPU time or exclusive grid cost; observer overhead is unqualified.':'Natural quota retirement only; recording order brackets both snapshots. Sampled widths are not thread CPU time; observer overhead is unqualified.',
      status:problems.length?'insufficient-evidence':'complete',planned,expectedRDue:expected,observedRDue:observed,samplingInterval:250,samples,
      actual:{snapshotFrom:first?.at??null,snapshotTo:last?.at??null,finishedAt,profileStart:capture?.profile?.startTime??null,profileEnd:capture?.profile?.endTime??null},problems};
    write('result',{...receipt,problems:problems.map(reason=>({reason}))});
    if(writesFailed&&!problems.includes('retirement evidence write failed')){problems.push('retirement evidence write failed');receipt.status='insufficient-evidence';}
    if(failed)throw failure;
    return receipt;
  });
}

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

/** Waiting happens before the profiler and the original counter interval. */
export function planIdleEdge(now:number,seconds:number,cellMs:number):IdleEdgePlan {
  if(!Number.isSafeInteger(now)||seconds!==120||cellMs!==300_000)throw Error('Aligned diagnostics require the existing120s/5min idle phase');
  const half=seconds*500,boundary=(Math.floor((now+half)/cellMs)+1)*cellMs;
  return{boundary,from:boundary-half,to:boundary+half,cellMs,seconds,marginMs:30_000};
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

/** Two passive snapshots reuse the native panning readout, outside elapsed counters. */
export function idleGeometry(cdp:Pick<Cdp,'evaluate'>):Promise<IdleGeometry> {
  return cdp.evaluate(`(() => {
    const numeric=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
    return {now:Date.now(),selected:new URLSearchParams(location.search).has('from'),charts:[['quota','[data-widget="quota-history"]',40],['session','[data-widget="quota-session-history"]',40],['activity','.activity',48],['budget','[data-widget="budget-history"]',76],['funds','.subscription-funds',76]].map(([widget,selector,left])=>{
      const all=document.querySelectorAll(selector+' .chart'),chart=all[0],svg=chart?.querySelector(':scope > svg');
      const empty={widget,count:all.length,axisEnd:numeric(chart?.dataset.axisEnd),from:numeric(svg?.dataset.drawFrom),to:numeric(svg?.dataset.drawTo),ready:svg?.dataset.drawReady==='true',panning:!!svg?.classList.contains('is-panning'),visibleFrom:null,visibleTo:null};
      const slides=chart?.querySelector(widget==='activity'?'.plot-clip.is-band .plot-move .slides':'.plot-move[data-plot-main] .slides');
      if(!svg||!slides||empty.from===null||empty.to===null)return empty;
      const box=svg.viewBox.baseVal.width,r=svg.getBoundingClientRect(),scale=r.width/box,matrix=slides.getScreenCTM(),inner=box-left-12;
      if(!matrix||!(matrix.a>0)||!(scale>0)||!(inner>0))return empty;
      const timeAt=x=>empty.from+((x-matrix.e)/matrix.a-left)/inner*Math.max(60000,empty.to-empty.from);
      return {...empty,visibleFrom:timeAt(r.left+left*scale),visibleTo:timeAt(r.right-12*scale)};
    })};
  })()`);
}

/** Planned wall time alone cannot credit an edge or a different chart. */
export function idleEdgeProblems(plan:IdleEdgePlan,from:number,to:number,counterFrom:number,counterTo:number,before:IdleGeometry,after:IdleGeometry):string[] {
  const problems:string[]=[];
  if(to-from!==plan.seconds*1000||![from,to,counterFrom,counterTo].every(Number.isFinite)||counterFrom<from||counterTo<counterFrom||plan.boundary-counterFrom<plan.marginMs||counterTo-plan.boundary<plan.marginMs)problems.push('actual counter window missed the30s edge margins');
  if(before.selected||after.selected||before.now>=plan.boundary||after.now<plan.boundary)problems.push('snapshots do not bracket a natural live edge');
  for(const widget of ['quota','session','activity','budget','funds'] as const){
    const previous=before.charts.filter(chart=>chart.widget===widget),next=after.charts.filter(chart=>chart.widget===widget),a=previous[0],b=next[0];
    if(previous.length!==1||next.length!==1||!a||!b||a.count!==1||b.count!==1||!a.ready||!b.ready||a.panning||b.panning||![a.axisEnd,a.from,a.to,a.visibleFrom,a.visibleTo,b.axisEnd,b.from,b.to,b.visibleFrom,b.visibleTo].every(value=>typeof value==='number'&&Number.isFinite(value))||a.axisEnd!>=plan.boundary||b.axisEnd!<plan.boundary||!(a.to!>a.from!)||!(b.to!>b.from!)||!(b.visibleFrom!>a.visibleFrom!)||!(b.visibleTo!>a.visibleTo!))problems.push(widget+' actual chart geometry did not cross the selected edge');
  }
  return problems;
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

/** One original idle interval, observed only in the benchmark's own synthetic browser. */
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
  private readonly clocks:{stage:string;before:number|null;page:number;after:number|null;valid:boolean}[]=[];
  private readonly collected=(message:{value:RawEvent[]})=>{
    if(!this.active)return;
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
  private readonly completed=()=>{this.ended=true;this.complete();};

  constructor(private readonly cdp:Cdp,private readonly save:Save,client:Client,ownedSynthetic:boolean,private readonly collection:'profile'|'trace'='profile'){
    if(!ownedSynthetic)throw Error('Idle CPU diagnostics require an owned synthetic browser');
    this.clockSource=clockTimerSource(client);
    this.binding=new ScriptBinding(cdp,client,(name,value)=>{if(name.startsWith('source-family-'))this.sourceBinding=value;save('idle-cpu-'+name,value);});
    save('idle-cpu-client',{mode:'diagnostic',client,clockSource:this.clockSource});
  }

  private async clock(stage:string){
    const stamp=async()=>(await this.cdp.send<{metrics:{name:string;value:number}[]}>('Performance.getMetrics')).metrics.find(metric=>metric.name==='Timestamp')?.value;
    const before=await stamp(),page=await this.cdp.evaluate<number>('performance.now()'),after=await stamp();
    this.clocks.push({stage,before:Number.isFinite(before)?before!*1000:null,page,after:Number.isFinite(after)?after!*1000:null,
      valid:Number.isFinite(before)&&Number.isFinite(after)&&Number.isFinite(page)&&before!<=after!});
  }

  /** Called before the unchanged from/to/reset/metrics sequence. */
  async start(){
    this.frame=(await this.cdp.send<{frameTree:{frame:{id:string}}}>('Page.getFrameTree')).frameTree.frame.id;
    if(typeof this.frame!=='string'||!this.frame)throw Error('Owned target frame unavailable');
    this.cdp.on('Tracing.dataCollected',this.collected);this.cdp.on('Tracing.tracingComplete',this.completed);
    if(this.collection==='profile'){
      this.profiler=true;await this.cdp.send('Profiler.enable');
      await this.cdp.send('Profiler.setSamplingInterval',{interval:2000});
    }
    await this.clock('start');
    this.active=true;this.tracing=true;
    await this.cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline.stack',transferMode:'ReportEvents'});
    if(this.collection==='profile')await this.cdp.send('Profiler.start');
  }

  /** Called only after the original after-metrics and readout have been frozen. */
  async stop(window:CounterWindow){
    let profile:ReturnType<typeof numericProfile>|null=null,cleanup='complete',error:unknown;
    try{
      await this.clock('end');
      if(this.collection==='profile'){
        const reply=await this.cdp.send<{profile:Profile}>('Profiler.stop');
        await this.cdp.send('Profiler.disable');this.profiler=false;
        profile=numericProfile(reply.profile);
      }
      const completed=new Promise<void>(resolve=>{this.complete=resolve;});
      await this.cdp.send('Tracing.end');
      await bounded('idle CPU trace drain',()=>completed);
      this.tracing=false;
    }catch(value){error=value;cleanup='incomplete';}
    finally{
      this.active=false;
      this.cdp.off('Tracing.dataCollected',this.collected);this.cdp.off('Tracing.tracingComplete',this.completed);
      if(this.profiler)try{await this.cdp.send('Profiler.stop');await this.cdp.send('Profiler.disable');this.profiler=false;}catch{cleanup='incomplete';}
      if(this.tracing)try{await this.cdp.send('Tracing.end');this.tracing=false;}catch{cleanup='incomplete';}
      this.traceCleanup=cleanup;
      this.profileStatus=this.collection==='trace'?'not-collected-by-design':cleanup==='complete'&&profile?.status==='complete'?'complete':'insufficient-evidence';
      this.save('idle-cpu-profile',{mode:'diagnostic',kind:this.collection==='trace'?'CPU sampling was not requested; tracing overhead is unqualified.':'Sampled elapsed widths, not thread CPU time; observer overhead unqualified.',
        status:this.profileStatus,samplingInterval:this.collection==='trace'?null:2000,clocks:this.clocks,cleanup,profile},true);
      this.save('idle-cpu-window',{mode:'diagnostic',kind:'Original elapsed counters and existing probe cost; collection order and budget are unchanged.',...window});
      this.save('idle-cpu-timers',{mode:'diagnostic',status:cleanup==='complete'&&this.ended&&!this.omitted&&!this.invalid&&this.timerFires>0&&this.sourceCallbacks>0?'complete':'insufficient-evidence',
        scope:'explicit owned target frame only',frame:1,coordinates:'as emitted; source binding required',cleanup,ended:this.ended,omitted:this.omitted,
        invalid:this.invalid,invalidOwners:this.invalidOwners,omittedOwners:this.omittedOwners,timerFires:this.timerFires,sourceCallbacks:this.sourceCallbacks,
        rejectedForeign:this.rejectedForeign,unscoped:this.unscoped,bytes:this.bytes,events:this.events},true);
    }
    if(error)throw error;
  }

  async bindAndClose(){try{await this.binding.afterFamily([1]);}finally{this.binding.close();}}
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
  edgeReceipt(plan:IdleEdgePlan,from:number,to:number,counterFrom:number,counterTo:number,before:IdleGeometry,after:IdleGeometry,window:CounterWindow){
    const problems=idleEdgeProblems(plan,from,to,counterFrom,counterTo,before,after);
    const fires=ownedClockFires(this.events,this.sourceBinding,this.clockSource,window.before.Timestamp,window.after.Timestamp);
    if(!fires.length)problems.push('no received-source-bound own Clock TimerFire in the original counter interval');
    if(this.profileStatus!=='complete'||!this.ended||this.omitted||this.invalid)problems.push('CPU or owned-frame trace is incomplete');
    const receipt={mode:'diagnostic',kind:'Temporally aligned natural edge; required benchmark timing is unchanged. Observer overhead and asynchronous attribution remain unqualified.',status:problems.length?'insufficient-evidence':'complete',plan,actual:{from,to,counterFrom,counterTo,marginBeforeMs:plan.boundary-counterFrom,marginAfterMs:counterTo-plan.boundary},before,after,clockFires:fires,problems};
    this.save('idle-cpu-edge',receipt);return receipt;
  }
  async close(){
    this.active=false;this.binding.close();
    this.cdp.off('Tracing.dataCollected',this.collected);this.cdp.off('Tracing.tracingComplete',this.completed);
    if(this.profiler){try{await this.cdp.send('Profiler.stop');}finally{await this.cdp.send('Profiler.disable');this.profiler=false;}}
    if(this.tracing){await this.cdp.send('Tracing.end');this.tracing=false;}
  }
}
