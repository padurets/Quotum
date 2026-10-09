import {openTab, type Browser, type Cdp} from './cdp.js';
import {threadCpuWindow} from './traceCpu.js';
import {deadline} from './deadline.js';
import {percentile} from './budget.js';
import {panning} from './panning.js';
import type {Evidence} from './evidence.js';

const ORDER = [false, true, true, false, false, true];
const metrics = async (cdp: Cdp, signal?: AbortSignal) => {
  const reply = await cdp.send<{metrics:{name:string;value:number}[]}>('Performance.getMetrics',{},signal);
  return Object.fromEntries(reply.metrics.map(value=>[value.name,value.value]));
};

/** A fixed AB/BA/AB experiment retains every outcome; it cannot stand in for a canonical pass. */
export async function panningPairs(cdp: Cdp, browser: Browser, evidence: Evidence) {
  if (!browser.owned) throw new Error('paired diagnostics require an owned synthetic browser');
  const attempts=[];
  for(const [index,timeline] of ORDER.entries()) {
    browser.owner?.signal.throwIfAborted();
    evidence.begin('panning-pair-'+index);
    const partial={timeline,save:(name:string,value:unknown)=>evidence.save('pair-'+index+'-'+name,value)};
    try {
      const result=await panning(cdp,undefined,partial);
      const valid=result.reports.length===6&&result.reports.every(report=>report.cost?.valid);
      attempts.push({id:index,timeline,status:result.problems.length?'over-budget':'passed',problems:result.problems.map(reason=>({reason})),
        metricsStatus:valid?'complete':'insufficient-evidence',
        scriptMs:valid?result.reports.reduce((sum,report)=>sum+report.cost!.scriptMs,0):null,
        taskMs:valid?result.reports.reduce((sum,report)=>sum+report.cost!.taskMs,0):null,
        elapsedSeconds:valid?result.reports.reduce((sum,report)=>sum+report.cost!.seconds,0):null,
        reports:result.reports.map(report=>({initiator:report.initiator,period:report.period,
          cost:report.cost,
          frameP95:percentile(report.frames,.95),frameP99:percentile(report.frames,.99),inputP95:percentile(report.latency,.95),
          frames:report.frames.length,inputs:report.inputs,credited:report.latency.length,omitted:report.timeline?.omitted??0}))});
    } catch {
      attempts.push({id:index,timeline,status:'failed',command:cdp.snapshot()});
    }
    evidence.save('panning-pairs',{mode:'diagnostic',order:ORDER,attempts});
  }
  return {mode:'diagnostic',order:ORDER,attempts};
}

const TRACE_NAMES = new Set(['RunTask','ThreadControllerImpl::RunTask','FunctionCall','EventDispatch','UpdateLayoutTree','Layout','PrePaint','Paint','CompositeLayers','MinorGC','MajorGC','V8.GCScavenger','V8.GCCompactor','FireAnimationFrame','RequestAnimationFrame','UpdateLayerTree','Commit','ActivateLayerTree','DrawFrame','RasterTask','BeginFrame','BeginMainThreadFrame','EvaluateScript','TimerFire','TimeStamp']);
type TraceEvent={name:string;ph:string;ts?:unknown;dur?:unknown;tts?:unknown;tdur?:unknown;pid?:unknown;tid?:unknown;args?:{data?:{message?:unknown}}};
export type SafeTrace={name:string;phase:string;ts?:number;duration?:number;threadTs?:number;threadDuration?:number;pid?:number;tid?:number;stage?:string};
const CLOCK_MARKERS = new Set(['quotum-trace-clock-start','quotum-trace-clock-end','quotum-trace-control-start','quotum-trace-control-end']);
const numeric = (value:unknown) => typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;

/** Tracing belongs only to a new diagnostic interval in this run's own browser. */
type TraceEvidence={save(name:string,value:unknown):void;saveTrace?(name:string,value:unknown):void};
export async function tracePanning(cdp: Cdp, browser: Browser, evidence?: TraceEvidence, run=panning) {
  let active:Promise<unknown>|undefined,release=()=>{},interval=0;
  const stop=async()=>{if(active){release();const pending=active;active=undefined;await pending;}};
  const measured={on:cdp.on.bind(cdp),off:cdp.off.bind(cdp),evaluate:cdp.evaluate.bind(cdp),
    send:async<T=unknown>(method:string,params:object={},signal?:AbortSignal):Promise<T>=>{
      const rate=(params as {rate?:number}).rate;
      if(method==='Emulation.setCPUThrottlingRate'&&rate===4){
        await stop();
        const id=++interval;
        let ready=()=>{};
        const started=new Promise<void>(resolve=>{ready=resolve;});
        active=traceInterval(cdp,browser,()=>{ready();return new Promise(resolve=>{release=()=>resolve(undefined);});},{
          save:(name,value)=>evidence?.save('trace-'+id+'-'+name,value),
          saveTrace:(name,value)=>evidence?.saveTrace?evidence.saveTrace('trace-'+id+'-'+name,value):evidence?.save('trace-'+id+'-'+name,value),
        });
        await Promise.race([started,active]);
      } else if(method==='Emulation.setCPUThrottlingRate'&&rate===1)await stop();
      return cdp.send<T>(method,params,signal);
    }};
  try {return await run(measured,undefined,{timeline:true,save:(name,value)=>evidence?.save('trace-'+name,value)});}
  finally {await stop();}
}

export async function traceInterval<T>(cdp: Cdp, browser: Browser, run:()=>Promise<T>, evidence?: TraceEvidence) {
  if(!browser.owned)throw new Error('browser-wide tracing requires an owned synthetic browser');
  const events:SafeTrace[]=[];
  let omitted=0,bytes=0,ended=false;
  const collected=(message:{value:TraceEvent[]})=>{
    for(const event of message.value) {
      if(!TRACE_NAMES.has(event.name)||!['B','E','X','I'].includes(event.ph))continue;
      const stage=event.name==='TimeStamp'&&typeof event.args?.data?.message==='string'&&CLOCK_MARKERS.has(event.args.data.message)?event.args.data.message:undefined;
      if(event.name==='TimeStamp'&&!stage)continue;
      const safe:SafeTrace={name:event.name,phase:event.ph,ts:numeric(event.ts),duration:numeric(event.dur),threadTs:numeric(event.tts),threadDuration:numeric(event.tdur),pid:numeric(event.pid),tid:numeric(event.tid),stage};
      const size=Buffer.byteLength(JSON.stringify(safe));
      if(events.length>=100_000 || bytes+size>32*1024*1024){omitted++;continue;}
      bytes+=size;events.push(safe);
    }
  };
  const complete=()=>{ended=true;};
  cdp.on('Tracing.dataCollected',collected);cdp.on('Tracing.tracingComplete',complete);
  let active=false;
  const clocks:unknown[]=[];
  const clock=async(stage:'start'|'end',signal:AbortSignal)=>{
    const before=await metrics(cdp,signal);
    const page=await cdp.evaluate(`(()=>{const now=performance.now();console.timeStamp('quotum-trace-clock-${stage}');return {now,after:performance.now(),timeOrigin:performance.timeOrigin};})()`,signal);
    const after=await metrics(cdp,signal);
    clocks.push({stage,before:before.Timestamp,page,after:after.Timestamp});
    evidence?.save('trace-clock',{clocks});
  };
  try {
    active=true;
    await deadline(5000,async signal=>{
      await cdp.send('Tracing.start',{categories:'toplevel,devtools.timeline,v8,blink,cc',transferMode:'ReportEvents'},signal);
      await clock('start',signal);
    },browser.owner?.signal);
    return await run();
  } finally {
    let cleanup='complete';
    if(active)try {
      await deadline(5000,async signal=>{
        // A failed clock probe must not prevent ending the trace.
        try {await deadline(1000,endSignal=>clock('end',endSignal),signal);} catch {/* Missing end calibration remains visible in clocks. */}
        await cdp.send('Tracing.end',{},signal);
        while(!ended){signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,20));}
      });
    } catch {cleanup='incomplete';browser.owner?.failures.push('trace cleanup unconfirmed');}
    cdp.off('Tracing.dataCollected',collected);cdp.off('Tracing.tracingComplete',complete);
    const report={mode:'diagnostic',status:omitted||!ended?'insufficient-evidence':'complete',scheduler:'unavailable',threadClock:{status:events.some(event=>event.threadTs!==undefined)?'available':'unavailable'},omitted,bytes,cleanup,events};
    if(evidence?.saveTrace)evidence.saveTrace('trace',report);else evidence?.save('trace',report);
    if(cleanup==='incomplete')try {await deadline(8000,()=>browser.close());}catch {browser.owner?.failures.push('diagnostic browser cleanup unconfirmed');}
  }
}

/** Fixed controls run after panning on an empty owned tab, at each measured throttle. */
export async function traceControls(browser: Browser, evidence: TraceEvidence) {
  if(!browser.owned)throw new Error('trace controls require an owned synthetic browser');
  const tab=await openTab(browser),intervals:{kind:string;rate:number;from:number;to:number}[]=[];
  let trace:SafeTrace[]=[],complete=false;
  try {
    await tab.cdp.send('Performance.enable');
    await traceInterval(tab.cdp,browser,async()=>{
      for(const rate of [1,4]) {
        await tab.cdp.send('Emulation.setCPUThrottlingRate',{rate});
        for(const kind of ['busy','timer','busy']) {
          const interval=await tab.cdp.evaluate<{from:number;to:number}>(`(async()=>{
            await new Promise(requestAnimationFrame);
            const from=performance.now();
            console.timeStamp('quotum-trace-control-start');
            ${kind==='busy'?'while(performance.now()-from<100){}':'await new Promise(resolve=>setTimeout(resolve,100));'}
            console.timeStamp('quotum-trace-control-end');
            const to=performance.now();
            await new Promise(requestAnimationFrame);
            return {from,to};
          })()`);
          intervals.push({kind,rate,...interval});
          evidence.save('trace-control-intervals',{mode:'diagnostic',intervals});
        }
      }
      await tab.cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
    },{
      save:(name,value)=>evidence.save('control-'+name,value),
      saveTrace:(name,value)=>{const report=value as {events:SafeTrace[];status:string};trace=report.events;complete=report.status==='complete';if(evidence.saveTrace)evidence.saveTrace('control-'+name,value);else evidence.save('control-'+name,value);},
    });
    // Controls use their exact trace markers; page timestamps are retained independently.
    const markers=trace.filter(event=>event.stage?.startsWith('quotum-trace-control-')).sort((a,b)=>(a.ts??0)-(b.ts??0));
    const reports=intervals.map((interval,index)=>{
      const start=markers[index*2],end=markers[index*2+1];
      const aligned=start?.stage==='quotum-trace-control-start'&&end?.stage==='quotum-trace-control-end'
        &&start.ts!==undefined&&end.ts!==undefined&&start.pid!==undefined&&start.tid!==undefined&&start.pid===end.pid&&start.tid===end.tid;
      return {...interval,...(aligned?threadCpuWindow(trace,start.pid!,start.tid!,start.ts!,end.ts!):{status:'missing-thread-clock'})};
    });
    const valid=complete&&markers.length===12&&reports.length===6&&reports.every(report=>report.status==='observed')
      &&reports.filter(report=>report.rate===1).every(report=>('cpuInsideMs' in report)&&(report.kind==='busy'?report.cpuInsideMs!>40:report.cpuOutsideMs!<20));
    evidence.save('trace-controls',{mode:'diagnostic',status:valid?'passed':'insufficient-evidence',intervals:reports});
    if(!valid)throw new Error('thread-clock controls did not distinguish execution from timer waiting');
  } finally {await tab.close();}
}
