import {Cdp, type Browser} from './cdp.js';

type Frame={functionName:string;url:string;location:{scriptId:string;lineNumber:number;columnNumber:number}};
type Profile={nodes:{id:number;callFrame:{functionName:string;url:string;lineNumber:number;columnNumber:number}}[];samples?:number[];timeDeltas?:number[]};
type Process={type:string;id:number;cpuTime:number};

/** Diagnostic commands must not wait for the page whose input acknowledgement is missing. */
export async function bounded<T>(label:string,work:Promise<T>,ms=5000,signal?:AbortSignal):Promise<T>{
  let timer:ReturnType<typeof setTimeout>;
  let abort:()=>void=()=>{};
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+': diagnostic deadline')),ms);
    abort=()=>reject(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  })]);}
  finally{clearTimeout(timer!);signal?.removeEventListener('abort',abort);}
}

/** Samples the page and browser independently; diagnostic intervention cannot supply a passing gate. */
export async function observeReversal(page:Cdp,browser:Browser,profileBeforeInput=true,signal?:AbortSignal){
  signal?.throwIfAborted();
  const response=await fetch(browser.endpoint+'/json/version',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('diagnostic browser endpoint refused');
  const {webSocketDebuggerUrl}=await response.json() as {webSocketDebuggerUrl:string};
  signal?.throwIfAborted();
  const control=await Cdp.connect(webSocketDebuggerUrl,signal);
  let paused:Frame[]=[],capture:Promise<void>|null=null,profileActive=false,profilerEnabled=false,debuggerEnabled=false,pauseNotify:(()=>void)|null=null;
  let closed=false,independent:Cdp|undefined;
  const closeConnections=()=>{closed=true;independent?.close();control.close();};
  signal?.addEventListener('abort',closeConnections,{once:true});
  const step=<T>(label:string,run:()=>Promise<T>,ms=5000)=>{
    signal?.throwIfAborted();if(closed)throw new Error('diagnostic observer closed');
    return bounded(label,run(),ms,signal);
  };
  page.on<{callFrames:Frame[]}>('Debugger.paused',event=>{if(!closed){paused=event.callFrames;pauseNotify?.();}});
  const processes=()=>step('browser process information',()=>control.send<{processInfo:Process[]}>('SystemInfo.getProcessInfo')).then(r=>r.processInfo);
  let before:Process[],observedAt=0;
  const enable=async()=>{
    await step('enable debugger',()=>{debuggerEnabled=true;return page.send('Debugger.enable');});
    await step('enable profiler',()=>{profilerEnabled=true;return page.send('Profiler.enable');});
    await step('start profiler',()=>{profileActive=true;return page.send('Profiler.start');});
  };
  const cleanup=async()=>{
    // Requested V8 commands need cleanup even when their acknowledgement never arrives.
    const ms=signal?1000:5000;
    if(debuggerEnabled)await bounded('resume cleanup',page.send('Debugger.resume'),ms).catch(()=>{});
    if(profileActive)await bounded('stop profiler cleanup',page.send('Profiler.stop'),ms).catch(()=>{});
    if(profilerEnabled)await bounded('disable profiler cleanup',page.send('Profiler.disable'),ms).catch(()=>{});
    if(debuggerEnabled)await bounded('disable debugger cleanup',page.send('Debugger.disable'),ms).catch(()=>{});
  };
  try{
    before=await processes();
    observedAt=Date.now();
    if(profileBeforeInput)await enable();
  }catch(error){closeConnections();signal?.removeEventListener('abort',closeConnections);await cleanup();throw error;}
  const sample=async(label:string)=>{
    let browserCpu:unknown,native:unknown,pageState:unknown,independentState:unknown,activation:unknown,pause:unknown,event:unknown,top:unknown;
    let cpuElapsedMs:number|undefined;
    const frames=[];
    try{
    pageState=await step('page state before debugger',()=>page.send<{result?:{value?:unknown}}>('Runtime.evaluate',{expression:'({visibility:document.visibilityState,focus:document.hasFocus(),ready:document.readyState})',returnByValue:true})).then(r=>r.result?.value,error=>String(error));
    if(page.endpoint){
      try{
        signal?.throwIfAborted();independent=await Cdp.connect(page.endpoint,signal);
        independentState=await step('independent page state',()=>independent!.evaluate('({visibility:document.visibilityState,focus:document.hasFocus(),ready:document.readyState})'));
      }catch(error){independentState=String(error);}
      finally{independent?.close();independent=undefined;}
    }
    const after=await processes().catch(error=>String(error));
    cpuElapsedMs=Date.now()-observedAt;
    browserCpu=Array.isArray(after)?after.map(p=>({type:p.type,id:p.id,cpuSeconds:p.cpuTime,cpuDeltaSeconds:p.cpuTime-(before.find(prior=>prior.id===p.id)?.cpuTime??p.cpuTime)})):after;
    const renderers=Array.isArray(after)?after.filter(p=>p.type==='renderer').sort((a,b)=>(b.cpuTime-(before.find(p=>p.id===b.id)?.cpuTime??b.cpuTime))-(a.cpuTime-(before.find(p=>p.id===a.id)?.cpuTime??a.cpuTime))):[];
    native=renderers.length&&browser.diagnostics?await step('native process state',()=>browser.diagnostics!(renderers.map(p=>p.id),renderers[0].id),25000).catch(error=>String(error)):undefined;
    activation=profileBeforeInput?'before input':await enable().then(()=> 'after stall',error=>String(error));
    const pausedEvent=new Promise<void>(resolve=>{pauseNotify=resolve;});
    pause=await step('pause page',()=>page.send('Debugger.pause')).then(()=> 'answered',error=>String(error));
    event=pause==='answered'?await step('paused event',()=>pausedEvent).then(()=> 'received',error=>String(error)):'no reply';
    for(const frame of paused.slice(0,10)){
      const source=await step('paused script',()=>page.send<{scriptSource:string}>('Debugger.getScriptSource',{scriptId:frame.location.scriptId})).then(r=>r.scriptSource.split('\n')[frame.location.lineNumber]?.slice(frame.location.columnNumber,frame.location.columnNumber+240),error=>String(error));
      frames.push({name:frame.functionName,url:frame.url,line:frame.location.lineNumber,column:frame.location.columnNumber,code:source});
    }
    const profile=await step('stop profiler',()=>page.send<{profile:Profile}>('Profiler.stop')).then(r=>r.profile,error=>String(error));profileActive=false;
    top=profile;
    if(typeof profile!=='string'){
      const durations=new Map<number,number>();
      profile.samples?.forEach((id,i)=>durations.set(id,(durations.get(id)??0)+(profile.timeDeltas?.[i]??0)/1000));
      top=[...durations].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([id,ms])=>({ms,frame:profile.nodes.find(n=>n.id===id)?.callFrame}));
    }
    }finally{
      console.error('reversal diagnostic '+JSON.stringify({label,elapsedMs:Date.now()-observedAt,activation,browserCpu,cpuElapsedMs,native,pageState,independentState,pagePause:pause,pausedEvent:event,pausedFrames:frames,profile:top,aborted:signal?.aborted||undefined}));
    }
    await step('resume page',()=>page.send('Debugger.resume')).catch(()=>{});
  };
  return {
    diagnose(label:string){return capture=sample(label);},
    async watch<T>(label:string,run:()=>Promise<T>){
      const timer=setTimeout(()=>{capture=sample(label).catch(error=>{console.error('reversal diagnostic failed: '+String(error));});},5000);
      try{
        const result=await run();
        if(capture)throw new Error(label+': response arrived after diagnostic intervention');
        return result;
      }finally{clearTimeout(timer);if(capture)await capture;}
    },
    async close(){
      try{
        if(capture)await capture.catch(()=>{});
        await cleanup();
      }finally{closeConnections();signal?.removeEventListener('abort',closeConnections);}
    },
  };
}
