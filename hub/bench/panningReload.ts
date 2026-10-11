import type {Cdp} from './cdp.js';
import {bounded,type DiagnosticOrigin} from './reversalDiagnostic.js';

type Pending={endpoint:string;type:string;method:string;startedMs:number;status?:number;bytes:number};
export type ReloadDiagnostic=(label:string,signal:AbortSignal,origin:DiagnosticOrigin)=>Promise<void>;
const endpoint=(url:string)=>{
  let path:string;try{path=new URL(url).pathname;}catch{return 'other';}
  if(/^\/api\/boards\/[^/]+\/period(?:\/sessions)?$/.test(path))return path.endsWith('/sessions')?'period/sessions':'period';
  if(path==='/')return 'document';
  if(path.startsWith('/assets/'))return 'asset';
  return path.startsWith('/api/')?'other-api':'other';
};

/** Record only reload metadata; URLs, request bodies and page text never enter diagnostics. */
export async function panningReload(cdp:Pick<Cdp,'send'|'evaluate'|'on'>,initiator:string,diagnose?:ReloadDiagnostic){
  const started=Date.now(),events:object[]=[],pending=new Map<string,Pending>();
  const counts={requests:0,responses:0,requestExtraInfo:0,responseExtraInfo:0,finished:0,failed:0,untracked:0};
  let active=true,loadAtMs:number|null=null,load:()=>void=()=>{},timer:ReturnType<typeof setTimeout>;
  let requested: {atMs:number;frame?:string;loader?:string}|undefined,committed:typeof requested;
  const elapsed=()=>Date.now()-started;
  const origin:DiagnosticOrigin={startedAt:started,navigation:()=>({requested,committed,loadAtMs})};
  const record=(event:object)=>{events.push({atMs:elapsed(),...event});if(events.length>32)events.shift();};
  const on=<T>(method:string,read:(event:T)=>void)=>cdp.on<T>(method,event=>{if(active)read(event);});
  for(const method of ['Page.domContentEventFired','Page.loadEventFired'])on(method,()=>{record({event:method});if(method==='Page.loadEventFired'){loadAtMs=elapsed();load();}});
  for(const method of ['Page.frameStartedLoading','Page.frameStoppedLoading'])on<{frameId:string}>(method,event=>record({event:method,frame:event.frameId}));
  on<{frame:{id:string;loaderId:string;parentId?:string}}>('Page.frameNavigated',({frame})=>{if(!frame.parentId)committed={atMs:elapsed(),frame:frame.id,loader:frame.loaderId};record({event:'Page.frameNavigated',frame:frame.id,loader:frame.loaderId,main:!frame.parentId});});
  on<{name:string}>('Page.lifecycleEvent',event=>record({event:'Page.lifecycleEvent',name:['init','DOMContentLoaded','load','networkAlmostIdle','networkIdle','firstPaint','firstContentfulPaint'].includes(event.name)?event.name:'other'}));
  on<{type:string;hasBrowserHandler:boolean}>('Page.javascriptDialogOpening',event=>record({event:'Page.javascriptDialogOpening',type:['alert','confirm','prompt','beforeunload'].includes(event.type)?event.type:'other',hasBrowserHandler:!!event.hasBrowserHandler}));
  on<{result:boolean}>('Page.javascriptDialogClosed',event=>record({event:'Page.javascriptDialogClosed',accepted:!!event.result}));
  on<{requestId:string;type:string;frameId?:string;loaderId?:string;request:{url:string;method:string}}>('Network.requestWillBeSent',event=>{
    counts.requests++;
    if(event.type==='Document'&&endpoint(event.request.url)==='document')requested={atMs:elapsed(),frame:event.frameId,loader:event.loaderId};
    if(pending.size===128&&!pending.has(event.requestId)){pending.delete(pending.keys().next().value!);counts.untracked++;}
    pending.set(event.requestId,{endpoint:endpoint(event.request.url),type:event.type,method:event.request.method,startedMs:elapsed(),bytes:0});
  });
  on<{requestId:string}>('Network.requestWillBeSentExtraInfo',event=>{counts.requestExtraInfo++;record({event:'Network.requestWillBeSentExtraInfo',endpoint:pending.get(event.requestId)?.endpoint});});
  on<{requestId:string;statusCode:number}>('Network.responseReceivedExtraInfo',event=>{counts.responseExtraInfo++;record({event:'Network.responseReceivedExtraInfo',endpoint:pending.get(event.requestId)?.endpoint,status:event.statusCode});});
  on<{requestId:string;response:{status:number}}>('Network.responseReceived',event=>{counts.responses++;const request=pending.get(event.requestId);if(request)request.status=event.response.status;});
  on<{requestId:string;encodedDataLength:number}>('Network.dataReceived',event=>{const request=pending.get(event.requestId);if(request)request.bytes+=event.encodedDataLength;});
  on<{requestId:string;encodedDataLength:number}>('Network.loadingFinished',event=>{counts.finished++;const request=pending.get(event.requestId);if(request)record({event:'Network.loadingFinished',...request,bytes:event.encodedDataLength});pending.delete(event.requestId);});
  on<{requestId:string;canceled?:boolean;blockedReason?:string;errorText:string}>('Network.loadingFailed',event=>{
    counts.failed++;record({event:'Network.loadingFailed',...pending.get(event.requestId),canceled:!!event.canceled,blocked:!!event.blockedReason,error:/^net::ERR_[A-Z_]+$/.test(event.errorText)?event.errorText:'other'});pending.delete(event.requestId);
  });
  const timeout=new Error(`native/${initiator}/reload: panning board reload did not finish in 5 s`);
  const loaded=new Promise<void>((resolve,reject)=>{load=resolve;timer=setTimeout(()=>reject(timeout),5000);});
  try {await Promise.all([cdp.send('Page.reload'),loaded]);}
  catch(error){
    if(error===timeout){
      // Emit received events before asking a possibly stalled renderer anything.
      console.error('panning reload diagnostic '+JSON.stringify({initiator,stage:'reload',startedAt:started,elapsedMs:elapsed(),navigation:origin.navigation(),counts,pending:[...pending.values()],events}));
      // Start the independent observer at the failure boundary, before renderer probes can time out.
      const observer=(async()=>{
        if(!diagnose)return;
        const controller=new AbortController();
        // Reserve five seconds inside the hard bound for the observer's cleanup.
        const deadline=setTimeout(()=>controller.abort(new Error('reload diagnostic deadline')),40000);
        let state='completed';
        try{await bounded('reload failure observer',Promise.resolve().then(()=>diagnose(`native/${initiator}/reload`,controller.signal,origin)),45000);}
        catch{state=controller.signal.aborted?'deadline':'failed';}
        finally{clearTimeout(deadline);controller.abort();}
        return state;
      })();
      try{
      const [page,performance]=await Promise.all([
        bounded('reload page state',cdp.evaluate(`(() => ({timeOrigin:performance.timeOrigin,ready:document.readyState,visibility:document.visibilityState,focused:document.hasFocus(),selectedRange:new URLSearchParams(location.search).has('from'),navigation:[...performance.getEntriesByType('navigation')].map(n=>({start:n.startTime,responseEnd:n.responseEnd,domInteractive:n.domInteractive,domContentLoaded:n.domContentLoadedEventEnd,loadStart:n.loadEventStart,loadEnd:n.loadEventEnd})),panels:['history','activity','budget-history','subscription-funds','forecast','budget-table'].map(name=>{const p=document.querySelector('.'+name),svg=p?.querySelector('.chart>svg');return {name,present:!!p,loading:p?.classList.contains('is-loading'),error:!!p?.querySelector('.history-error'),drawReady:svg?.dataset.drawReady,panning:svg?.classList.contains('is-panning')};})}))()`),2000).then(value=>({state:'answered',value}),()=>({state:'unavailable'})),
        bounded('reload performance',cdp.send<{metrics:{name:string;value:number}[]}>('Performance.getMetrics'),2000).then(reply=>({state:'answered',metrics:reply.metrics.filter(metric=>['TaskDuration','ScriptDuration','JSHeapUsedSize','JSHeapTotalSize','Documents','Nodes','LayoutCount','RecalcStyleCount','Frames'].includes(metric.name))})).catch(()=>({state:'unavailable'})),
      ]);
      console.error('panning reload state '+JSON.stringify({initiator,stage:'reload',startedAt:started,elapsedMs:elapsed(),navigation:origin.navigation(),loadAtMs,page,performance}));
      }catch{console.error('panning reload state '+JSON.stringify({initiator,stage:'reload',state:'unavailable'}));}
      const state=await observer;
      if(diagnose)console.error('panning reload observer '+JSON.stringify({initiator,stage:'reload',state,startedAt:started,elapsedMs:elapsed(),navigation:origin.navigation(),loadAtMs,counts,pending:[...pending.values()],events}));
    }
    throw error;
  }finally{active=false;clearTimeout(timer!);pending.clear();events.length=0;}
}

/** A separate failure-only request tests hub reachability, not the original document's arrival. */
export async function reloadHubProbe(base:string,signal:AbortSignal,origin:DiagnosticOrigin){
  const startedMs=Date.now()-origin.startedAt;
  let state='unavailable',status:number|undefined;
  const controller=new AbortController(),cancel=()=>controller.abort();
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  try{
    signal.throwIfAborted();
    const response=await bounded('reload hub health',fetch(base+'/health',{signal:controller.signal,redirect:'error'}),2000,signal);
    status=response.status;state='answered';
    void response.body?.cancel().catch(()=>{});
  }catch{state=signal.aborted?'aborted':'unavailable';}
  finally{controller.abort();signal.removeEventListener('abort',cancel);}
  const finishedMs=Date.now()-origin.startedAt;
  console.error('panning reload hub '+JSON.stringify({startedAt:origin.startedAt,startedMs,finishedMs,durationMs:finishedMs-startedMs,state,status,originalDocumentArrival:'unknown'}));
}
