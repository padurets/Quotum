import {deadline} from './deadline.js';
import type {Cdp,Browser} from './cdp.js';
import type {ProcessIdentity} from './browserProcess.js';
import type {RunOwner} from './runOwner.js';
import {readlink} from 'node:fs/promises';
import {accountingPath} from './accountingTraffic.js';
import {HISTORY_ATTEMPT_HEADER} from './historyProxy.js';
export type RendererIdentityState={status:'known'|'unknown';invalidations:number;invalid:number;omitted:number;events:number;mappings:number;loss:boolean|null;cleanup:'complete'|'unknown';mustCloseOwner:boolean};
export type RendererIdentityEvidence=RendererIdentityState&{pid:number|null;birth:string|null;frame:1};
export type RendererIdentity={readonly pid:number|null;readonly birth:string|null;readonly signal?:AbortSignal;valid():boolean;dispose():Promise<void>;evidence():RendererIdentityEvidence};
export type RendererPage=Pick<Cdp,'send'|'on'|'off'>;
export type RendererBrowser=Pick<Browser,'owned'|'owner'|'observeProcesses'|'launchReport'>;
type Frame={id?:unknown;loaderId?:unknown;parentId?:unknown};
type MetadataFrame={frame?:unknown;processId?:unknown;isOutermostMainFrame?:unknown;isInPrimaryMainFrame?:unknown};
type TraceEvent={name?:unknown;args?:{data?:{frames?:unknown}}};
type TraceBatch={value?:unknown}|null|undefined;
type Mapping={pid:unknown;outer:unknown;primary:unknown};

export type RendererDocument={readonly signal:AbortSignal;pin(reply:{frameId?:unknown;loaderId?:unknown;errorText?:unknown}|null|undefined):void;read(page:RendererPage):Frame|undefined;valid():boolean;dispose():void};

/** Install before the existing Page.enable/navigation; retain no URL or page text. */
export function rendererDocument(page:RendererPage):RendererDocument{
  let first:Frame|undefined,pinned=false,committed=false,invalid=false,disposed=false;
  const lifetime=new AbortController();
  const invalidate=()=>{invalid=true;lifetime.abort();};
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
  return{signal:lifetime.signal,valid,pin(reply){if(pinned||!first||reply?.errorText!==undefined||reply?.frameId!==first.id||reply?.loaderId!==first.loaderId)invalidate();pinned=true;},
    read(cdp){return cdp===page&&valid()?{...first}:undefined;},
    dispose(){disposed=true;lifetime.abort();page.off('Page.frameStartedNavigating',started);page.off('Page.frameNavigated',navigated);for(const event of life)page.off(event,invalidate);}};
}

export type RendererProcessSample={status:'pending'|'observed'|'unavailable';fromMs:number;toMs:number|null;processes?:ProcessIdentity[];omitted?:number};
export type RendererResolution={after:RendererProcessSample;failedStart:number|null;browserPid:number|null};

/** This internal request-ID contract is qualified only against these Chromium sources. */
export function networkRendererProfile(report:unknown):boolean{
  const {version,sourceRevisionHash}=report as {version?:unknown;sourceRevisionHash?:unknown}??{};
  return version==='Chrome/155.0.8059.39'&&sourceRevisionHash==='3ff7ac5a9224be9156d7f8703a06e22890aafd34'
    ||version==='Chrome/155.0.8059.12'&&sourceRevisionHash==='384c82079f60e0b79cdca6e49efd5cfceefa5b74'
    ||version==='Chrome/156.0.8078.47'&&sourceRevisionHash==='1d17a2e2ee147bb7d6ae2ab6abdb3a2510c17775';
}

/** A cold request witnesses this document until its lifetime ends, including HTTP-free returns. */
export function historyRendererIdentity(page:RendererPage,browser:RendererBrowser,document:RendererDocument,origin:string,attemptPrefix:()=>string){
  const lifetime=new AbortController(),signal=AbortSignal.any([lifetime.signal,document.signal,...(browser.owner?[browser.owner.signal]:[])]);
  let launch:unknown;try{launch=browser.launchReport?.();}catch{/* Optional metadata cannot fail the benchmark. */}
  const root=(launch as {pid?:unknown}|undefined)?.pid,profile=networkRendererProfile(launch);
  let before:RendererProcessSample|undefined,namespaceEqual:boolean|null=null,setupSend:number|null=null,setupReply:number|null=null;
  let input:{started:number;scenario:string}|undefined,witness:{pid:number;received:number;input:{started:number;scenario:string}}|undefined;
  let failedCommand:{started:number|null}|undefined,afterBracket:Omit<RendererProcessSample,'processes'>|undefined;
  let bound:Pick<ProcessIdentity,'pid'|'birth'>|undefined,disposed=false,invalid=0,events=0;
  const invalidate=()=>{invalid++;lifetime.abort();};
  const valid=()=>!!bound&&!disposed&&!signal.aborted&&document.valid();
  const received=(event:{requestId?:unknown;frameId?:unknown;loaderId?:unknown;type?:unknown;redirectResponse?:unknown;request?:{url?:unknown;method?:unknown;headers?:Record<string,unknown>}}|null|undefined)=>{
    if(disposed||signal.aborted||setupReply===null||!input)return;
    let url:URL;try{url=new URL(event?.request?.url as string);}catch{return;}
    if(url.origin!==origin||!accountingPath(url.pathname))return;
    events++;
    const frame=document.read(page),match=typeof event?.requestId==='string'?/^([1-9]\d*)\.([1-9]\d*)$/.exec(event.requestId):null;
    const ids=match?.slice(1).map(Number),headers=Object.entries(event?.request?.headers??{}).filter(([key])=>key.toLowerCase()===HISTORY_ATTEMPT_HEADER);
    const attempt=headers.length===1?headers[0][1]:undefined,prefix=attemptPrefix();
    if(!profile||!frame||event?.type!=='Fetch'||event.request?.method!=='POST'||url.pathname==='/api/history'||event.redirectResponse!==undefined
      ||event.frameId!==frame.id||event.loaderId!==frame.loaderId||event.loaderId===event.requestId||!ids?.every(n=>Number.isSafeInteger(n)&&n>0)
      ||typeof attempt!=='string'||!/^b[1-9]\d*$/.test(prefix)||!attempt.startsWith(prefix+':')||!/^b[1-9]\d*:[1-9]\d*$/.test(attempt)) {invalidate();return;}
    const pid=ids[0];if(witness&&witness.pid!==pid){invalidate();return;}
    witness??={pid,received:performance.now(),input:{...input}};
  };
  page.on('Network.requestWillBeSent',received);
  const dispose=async()=>{if(disposed)return;disposed=true;lifetime.abort();page.off('Network.requestWillBeSent',received);};
  browser.owner?.resource(dispose);
  const handle:RendererIdentity={get pid(){return valid()?bound!.pid:null;},get birth(){return valid()?bound!.birth:null;},signal,valid,dispose,
    evidence:()=>({status:valid()?'known':'unknown',pid:valid()?bound!.pid:null,birth:valid()?bound!.birth:null,frame:1,invalidations:invalid,invalid,events,omitted:0,mappings:witness?1:0,loss:null,cleanup:'complete',mustCloseOwner:false,
      mechanism:'network-document',profile,namespaceEqual,before,after:afterBracket,setupSend,setupReply,failedCommand,witness:witness?{pid:witness.pid,received:witness.received,input:witness.input}:null})};
  return {requireBeforeInput:false,prohibitFallback:true,signal,validDocument:()=>document.valid()&&!signal.aborted,
    input(scenario:string,started:number){if(setupReply!==null&&started>=setupReply)input??={scenario,started};},
    async before(){
      const fromMs=performance.now();
      try{
        if(!profile||browser.owned!==true||!browser.owner||!browser.observeProcesses||!Number.isSafeInteger(root)||(root as number)<=0)throw Error('Unsupported binding');
        const processes=await deadline(1000,async pending=>{
          const [rows,self,owned]=await Promise.all([browser.observeProcesses!(pending),readlink('/proc/self/ns/pid'),readlink(`/proc/${root}/ns/pid`)]);
          pending.throwIfAborted();namespaceEqual=/^pid:\[\d+\]$/.test(self)&&self===owned;return rows;
        },signal);
        before={status:processes.length?'observed':'unavailable',fromMs,toMs:performance.now(),processes:processes.slice(0,32),omitted:Math.max(0,processes.length-32)};
      }catch{before={status:'unavailable',fromMs,toMs:performance.now()};}
    },
    setupSent(){setupSend=performance.now();},setupComplete(){setupReply=performance.now();},
    async resolve(pending:AbortSignal,context?:RendererResolution){
      const unknown=()=>{bound=undefined;invalidate();return handle;};
      const after=context?.after,failed=context?.failedStart;
      failedCommand={started:failed??null};afterBracket=after?{status:after.status,fromMs:after.fromMs,toMs:after.toMs,omitted:after.omitted}:undefined;
      if(pending.aborted||signal.aborted||!document.valid()||!profile||namespaceEqual!==true||!witness||!before||before.status!=='observed'||before.omitted!==0
        ||!after||after.status!=='observed'||after.omitted!==0||after.toMs===null||before.toMs===null||setupSend===null||setupReply===null
        ||failed===null||failed===undefined||!Number.isFinite(failed)||context.browserPid!==root
        ||!([before.fromMs,before.toMs,setupSend,setupReply,witness.input.started,witness.received,after.fromMs,after.toMs].every(Number.isFinite)
          &&before.fromMs<=before.toMs&&before.toMs<=setupSend&&setupSend<setupReply&&setupReply<=witness.input.started&&witness.input.started<=witness.received&&witness.received<after.fromMs&&failed<=after.fromMs&&after.fromMs<=after.toMs))return unknown();
      const left=before.processes?.filter(p=>p.pid===witness!.pid),right=after.processes?.filter(p=>p.pid===witness!.pid);
      const roots=[before,after].map(sample=>sample.processes?.filter(p=>p.pid===root));
      if(left?.length!==1||right?.length!==1||left[0].birth!==right[0].birth||!/^\d+$/.test(left[0].birth)||witness.pid===root
        ||[...left,...right].some(p=>p.group!==root||p.session!==root||['Z','X'].includes(p.state))
        ||roots.some(rows=>rows?.length!==1||rows[0].group!==root||rows[0].session!==root||['Z','X'].includes(rows[0].state))||roots[0]![0].birth!==roots[1]![0].birth)return unknown();
      bound={pid:witness.pid,birth:left[0].birth};return handle;
    },dispose};
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
