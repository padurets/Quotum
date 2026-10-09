import type {Browser, Cdp} from './cdp.js';
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

const TRACE_NAMES = new Set(['RunTask','ThreadControllerImpl::RunTask','FunctionCall','EventDispatch','UpdateLayoutTree','Layout','PrePaint','Paint','CompositeLayers','MinorGC','MajorGC','V8.GCScavenger','V8.GCCompactor','FireAnimationFrame','RequestAnimationFrame','UpdateLayerTree','Commit','ActivateLayerTree','DrawFrame','RasterTask','BeginFrame','BeginMainThreadFrame']);
type TraceEvent={name:string;ph:string;ts?:number;dur?:number;pid?:number;tid?:number};
type SafeTrace={name:string;phase:string;ts?:number;duration?:number;pid?:number;tid?:number};

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
      const safe={name:event.name,phase:event.ph,ts:event.ts,duration:event.dur,pid:event.pid,tid:event.tid};
      const size=Buffer.byteLength(JSON.stringify(safe));
      if(events.length>=100_000 || bytes+size>32*1024*1024){omitted++;continue;}
      bytes+=size;events.push(safe);
    }
  };
  const complete=()=>{ended=true;};
  cdp.on('Tracing.dataCollected',collected);cdp.on('Tracing.tracingComplete',complete);
  let active=false;
  try {
    active=true;
    await deadline(5000,async signal=>{
      await cdp.send('Tracing.start',{categories:'devtools.timeline,v8,blink,cc',transferMode:'ReportEvents'},signal);
      const clockBefore=await metrics(cdp,signal),pageClock=await cdp.evaluate('({now:performance.now(),timeOrigin:performance.timeOrigin})',signal),clockAfter=await metrics(cdp,signal);
      evidence?.save('trace-clock',{before:clockBefore.Timestamp,page:pageClock,after:clockAfter.Timestamp});
    },browser.owner?.signal);
    return await run();
  } finally {
    let cleanup='complete';
    if(active)try {
      await deadline(5000,async signal=>{
        await cdp.send('Tracing.end',{},signal);
        while(!ended){signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,20));}
      });
    } catch {cleanup='incomplete';browser.owner?.failures.push('trace cleanup unconfirmed');}
    cdp.off('Tracing.dataCollected',collected);cdp.off('Tracing.tracingComplete',complete);
    const report={mode:'diagnostic',status:omitted||!ended?'insufficient-evidence':'complete',scheduler:'unavailable',omitted,bytes,cleanup,events};
    if(evidence?.saveTrace)evidence.saveTrace('trace',report);else evidence?.save('trace',report);
    if(cleanup==='incomplete')try {await deadline(8000,()=>browser.close());}catch {browser.owner?.failures.push('diagnostic browser cleanup unconfirmed');}
  }
}
