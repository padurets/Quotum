import {deadline} from './deadline.js';
import type {Cdp,Browser} from './cdp.js';
import type {ProcessIdentity} from './browserProcess.js';
import type {RunOwner} from './runOwner.js';
export type RendererIdentityState={status:'known'|'unknown';invalidations:number;invalid:number;omitted:number;events:number;mappings:number;loss:boolean|null;cleanup:'complete'|'unknown';mustCloseOwner:boolean};
export type RendererIdentityEvidence=RendererIdentityState&{pid:number|null;birth:string|null;frame:1};
export type RendererIdentity={readonly pid:number|null;readonly birth:string|null;valid():boolean;dispose():Promise<void>;evidence():RendererIdentityEvidence};
export type RendererPage=Pick<Cdp,'send'|'on'|'off'>;
export type RendererBrowser=Pick<Browser,'owned'|'owner'|'observeProcesses'|'launchReport'>;
type Frame={id?:unknown;loaderId?:unknown;parentId?:unknown};
type MetadataFrame={frame?:unknown;processId?:unknown;isOutermostMainFrame?:unknown;isInPrimaryMainFrame?:unknown};
type TraceEvent={name?:unknown;args?:{data?:{frames?:unknown}}};
type TraceBatch={value?:unknown}|null|undefined;
type Mapping={pid:unknown;outer:unknown;primary:unknown};

export type RendererDocument={pin(reply:{frameId?:unknown;loaderId?:unknown;errorText?:unknown}|null|undefined):void;read(page:RendererPage):Frame|undefined;valid():boolean;dispose():void};

/** Install before the existing Page.enable/navigation; retain no URL or page text. */
export function rendererDocument(page:RendererPage):RendererDocument{
  let first:Frame|undefined,pinned=false,committed=false,invalid=false,disposed=false;
  const invalidate=()=>{invalid=true;};
  const started=(event:{frameId?:unknown;loaderId?:unknown;navigationType?:unknown}|null|undefined)=>{
    const type=event?.navigationType,same=type==='sameDocument'||type==='historySameDocument';
    if(typeof event?.frameId!=='string'||!event.frameId||typeof event.loaderId!=='string'||!event.loaderId||
      !['reload','reloadBypassingCache','restore','restoreWithPost','historyDifferentDocument','differentDocument','sameDocument','historySameDocument'].includes(type as string)){invalidate();return;}
    if(!first){if(same){invalidate();return;}first={id:event.frameId,loaderId:event.loaderId};return;}
    invalidate();
  };
  const navigated=(event:{frame?:Frame}|null|undefined)=>{
    const frame=event?.frame;
    if(!first||committed||!frame||frame.parentId!==undefined||frame.id!==first.id||frame.loaderId!==first.loaderId)invalidate();else committed=true;
  };
  const life=['Page.frameDetached','Inspector.targetCrashed','Inspector.detached'];
  page.on('Page.frameStartedNavigating',started);page.on('Page.frameNavigated',navigated);for(const event of life)page.on(event,invalidate);
  const valid=()=>pinned&&committed&&!invalid&&!disposed;
  return{valid,pin(reply){if(pinned||!first||reply?.errorText!==undefined||reply?.frameId!==first.id||reply?.loaderId!==first.loaderId)invalidate();pinned=true;},
    read(cdp){return cdp===page&&valid()?{...first}:undefined;},
    dispose(){disposed=true;page.off('Page.frameStartedNavigating',started);page.off('Page.frameNavigated',navigated);for(const event of life)page.off(event,invalidate);}};
}

/** UNKNOWN requires the existing owner cleanup; it never licenses a max-CPU fallback. */
export async function rendererIdentity(cdp:RendererPage,browser:RendererBrowser,parent?:AbortSignal,document?:RendererDocument):Promise<RendererIdentity>{
  const owner:RunOwner|undefined=browser.owner,until=performance.now()+2000;
  if(browser.owned!==true||!owner||!browser.observeProcesses)throw Error('Owned browser required');
  const signal=AbortSignal.any([owner.signal,...(parent?[parent]:[])]);
  const state:RendererIdentityState={status:'unknown',invalidations:0,invalid:0,omitted:0,events:0,mappings:0,loss:null,cleanup:'complete',mustCloseOwner:false};
  let frame:unknown,loader:unknown,bound:Pick<ProcessIdentity,'pid'|'birth'>|undefined,attempted=false,started=false,endSent=false,completed=0,active=false,disposed=false,resolve:(()=>void)|undefined;
  const complete=new Promise<void>(done=>{resolve=done;}),matches:Mapping[]=[];
  const life=['Page.frameNavigated','Page.frameDetached','Inspector.targetCrashed','Inspector.detached'];
  const invalidate=()=>{state.invalidations++;};
  const cancel=()=>{invalidate();void release();};
  const valid=()=>state.status==='known'&&!disposed&&!signal.aborted&&!state.invalidations&&(!document||document.valid());
  const within=<T>(work:(signal:AbortSignal)=>Promise<T>,cleanup=false):Promise<T>=>{
    const left=until-performance.now();if(left<=0)return Promise.reject(Error('Preflight deadline'));
    return deadline(left,async pending=>{if(!cleanup&&disposed)throw Error('Disposed');const value=await work(pending);pending.throwIfAborted();return value;},cleanup?undefined:signal);
  };
  const collected=(message:TraceBatch)=>{
    if(!active)return;
    try{
      if(!Array.isArray(message?.value)){state.invalid++;return;}
      state.events+=message.value.length;if(state.events>4096){state.omitted++;return;}
      for(const event of message.value as TraceEvent[]){
        if(event?.name!=='TracingStartedInBrowser')continue;
        const rows=event.args?.data?.frames;if(!Array.isArray(rows)){state.invalid++;continue;}
        if(rows.length>32){state.omitted+=rows.length-32;continue;}
        for(const row of rows as MetadataFrame[])if(row?.frame===frame){
          state.mappings++;if(matches.length>=2){state.omitted++;continue;}
          matches.push({pid:row.processId,outer:row.isOutermostMainFrame,primary:row.isInPrimaryMainFrame});
        }
      }
    }catch{state.invalid++;}
  };
  const finished=(message:{dataLossOccurred?:unknown}|null|undefined)=>{if(active){completed++;state.loss=typeof message?.dataLossOccurred==='boolean'?message.dataLossOccurred:null;resolve!();}};
  const removeTrace=()=>{active=false;cdp.off('Tracing.dataCollected',collected);cdp.off('Tracing.tracingComplete',finished);};
  const release=owner.resource(async()=>{
    disposed=true;
    try{
      if(started&&!endSent){endSent=true;await within(s=>cdp.send('Tracing.end',{},s),true);await within(()=>complete,true);}
    }catch{state.cleanup='unknown';}
    finally{
      if(attempted&&(!started||completed!==1)){state.cleanup='unknown';state.mustCloseOwner=true;}
      removeTrace();for(const name of life)cdp.off(name,invalidate);signal.removeEventListener('abort',cancel);document?.dispose();
      if(state.mustCloseOwner)owner.failures.push('renderer identity tracing outcome unknown');
    }
  });
  const handle:RendererIdentity={get pid(){return valid()?bound!.pid:null;},get birth(){return valid()?bound!.birth:null;},valid,dispose:release,
    evidence:()=>({...state,status:valid()?'known':'unknown',pid:valid()?bound!.pid:null,birth:valid()?bound!.birth:null,frame:1})};
  try{
    if(!document)await within(s=>cdp.send('Page.enable',{},s));await within(s=>cdp.send('Inspector.enable',{},s));
    for(const name of life)cdp.on(name,invalidate);signal.addEventListener('abort',cancel,{once:true});
    const readFrame=async(s:AbortSignal)=>document?document.read(cdp):(await cdp.send<{frameTree?:{frame?:Frame}}>('Page.getFrameTree',{},s))?.frameTree?.frame;
    const first=await within(readFrame);frame=first?.id;loader=first?.loaderId;
    if(typeof frame!=='string'||!frame||typeof loader!=='string'||!loader||first!.parentId)throw Error('Frame unavailable');
    const before=await within(s=>browser.observeProcesses!(s));
    cdp.on('Tracing.dataCollected',collected);cdp.on('Tracing.tracingComplete',finished);active=true;attempted=true;
    await within(s=>cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline',transferMode:'ReportEvents'},s));started=true;
    endSent=true;await within(s=>cdp.send('Tracing.end',{},s));await within(()=>complete);
    removeTrace();
    const last=await within(readFrame),after=await within(s=>browser.observeProcesses!(s));
    if(last?.id!==frame||last?.loaderId!==loader||state.invalidations||state.invalid||state.omitted||completed!==1||state.loss!==false||matches.length!==1)throw Error('Incomplete mapping');
    const map=matches[0],root=(browser.launchReport?.() as {pid?:unknown}|undefined)?.pid;
    if(!Number.isSafeInteger(map.pid)||(map.pid as number)<=0||map.pid===root||map.outer!==true||map.primary!==true||!Number.isSafeInteger(root))throw Error('Invalid mapping');
    const left=before.filter(p=>p.pid===map.pid),right=after.filter(p=>p.pid===map.pid);
    if(left.length!==1||right.length!==1||left[0].birth!==right[0].birth||typeof left[0].birth!=='string'||!/^\d+$/.test(left[0].birth)||[...left,...right].some(p=>p.group!==root||p.session!==root||['Z','X'].includes(p.state)))throw Error('Owned birth mismatch');
    signal.throwIfAborted();if(disposed)throw Error('Disposed');bound={pid:map.pid as number,birth:left[0].birth};state.status='known';
  }catch{await release();}
  finally{removeTrace();}
  return handle;
}
