import {Cdp, type Browser} from './cdp.js';

type Frame={functionName:string;url:string;location:{scriptId:string;lineNumber:number;columnNumber:number}};
type Profile={nodes:{id:number;callFrame:{functionName:string;url:string;lineNumber:number;columnNumber:number}}[];samples?:number[];timeDeltas?:number[]};
type Process={type:string;id:number;cpuTime:number};

/** Diagnostic commands must not wait for the page whose input acknowledgement is missing. */
export async function bounded<T>(label:string,work:Promise<T>,ms=5000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+': diagnostic deadline')),ms);})]);}
  finally{clearTimeout(timer!);}
}

/** A separate replay samples the page and browser independently; it cannot supply a passing gate. */
export async function observeReversal(page:Cdp,browser:Browser){
  const response=await fetch(browser.endpoint+'/json/version',{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('diagnostic browser endpoint refused');
  const {webSocketDebuggerUrl}=await response.json() as {webSocketDebuggerUrl:string};
  const control=await Cdp.connect(webSocketDebuggerUrl);
  let paused:Frame[]=[],capture:Promise<void>|null=null,profileActive=false,pauseNotify:(()=>void)|null=null;
  page.on<{callFrames:Frame[]}>('Debugger.paused',event=>{paused=event.callFrames;pauseNotify?.();});
  const processes=()=>bounded('browser process information',control.send<{processInfo:Process[]}>('SystemInfo.getProcessInfo')).then(r=>r.processInfo);
  let before:Process[];
  try{
    before=await processes();
    await bounded('enable debugger',page.send('Debugger.enable'));
    await bounded('enable profiler',page.send('Profiler.enable'));
    await bounded('start profiler',page.send('Profiler.start'));profileActive=true;
  }catch(error){control.close();await bounded('disable failed setup',page.send('Debugger.disable')).catch(()=>{});throw error;}
  const sample=async(label:string)=>{
    const after=await processes().catch(error=>String(error));
    const browserCpu=Array.isArray(after)?after.map(p=>({type:p.type,id:p.id,cpuSeconds:p.cpuTime,cpuDeltaSeconds:p.cpuTime-(before.find(prior=>prior.id===p.id)?.cpuTime??p.cpuTime)})):after;
    const pausedEvent=new Promise<void>(resolve=>{pauseNotify=resolve;});
    const pause=await bounded('pause page',page.send('Debugger.pause')).then(()=> 'answered',error=>String(error));
    const event=pause==='answered'?await bounded('paused event',pausedEvent).then(()=> 'received',error=>String(error)):'no reply';
    const frames=[];
    for(const frame of paused.slice(0,10)){
      const source=await bounded('paused script',page.send<{scriptSource:string}>('Debugger.getScriptSource',{scriptId:frame.location.scriptId})).then(r=>r.scriptSource.split('\n')[frame.location.lineNumber]?.slice(frame.location.columnNumber,frame.location.columnNumber+240),error=>String(error));
      frames.push({name:frame.functionName,url:frame.url,line:frame.location.lineNumber,column:frame.location.columnNumber,code:source});
    }
    const profile=await bounded('stop profiler',page.send<{profile:Profile}>('Profiler.stop')).then(r=>r.profile,error=>String(error));profileActive=false;
    let top:unknown=profile;
    if(typeof profile!=='string'){
      const durations=new Map<number,number>();
      profile.samples?.forEach((id,i)=>durations.set(id,(durations.get(id)??0)+(profile.timeDeltas?.[i]??0)/1000));
      top=[...durations].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([id,ms])=>({ms,frame:profile.nodes.find(n=>n.id===id)?.callFrame}));
    }
    console.error('reversal diagnostic '+JSON.stringify({label,browserCpu,pagePause:pause,pausedEvent:event,pausedFrames:frames,profile:top}));
    await bounded('resume page',page.send('Debugger.resume')).catch(()=>{});
  };
  return {
    async watch<T>(label:string,run:()=>Promise<T>){
      const timer=setTimeout(()=>{capture=sample(label).catch(error=>{console.error('reversal diagnostic failed: '+String(error));});},5000);
      try{return await run();}finally{clearTimeout(timer);if(capture)await capture;}
    },
    async close(){
      try{
        if(capture)await capture;
        await bounded('resume cleanup',page.send('Debugger.resume')).catch(()=>{});
        if(profileActive)await bounded('stop profiler cleanup',page.send('Profiler.stop')).catch(()=>{});
        await bounded('disable debugger cleanup',page.send('Debugger.disable')).catch(()=>{});
      }finally{control.close();}
    },
  };
}
