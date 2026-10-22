import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import type {Cdp} from './cdp.js';
import {deadline} from './deadline.js';
import {percentile} from './budget.js';
import {panning} from './panning.js';

const client={name:'index-B3XdTJFg.js',bytes:1_172_211,hash:'16ead23988b0712c6b064794792a708637c10d2d1008c7ebcf6bf6a2a46c6dd4'};
const style={name:'index-CK3ANXlu.css',bytes:84_396,hash:'f0e79efbf9db07e2aae62685a6cc9ef98ef688d45382219650dc730bea57f6c7'};
const oldClient={name:'index-Dh2ec57X.js',bytes:1_172_081,hash:'0c166f884d27deac577f54b7a4ec32e2eb8c13ddb87968f6f486c0cdef715e63'};
const oldStyle={name:'index-DUY6ug3k.css',bytes:84_236,hash:'b82047b3d8e9db91286a6cdf7b9556d3ac02b83c8761fa4ab1483255c17e0f7e'};
const hash=(body:string|Buffer)=>createHash('sha256').update(body).digest('hex');
const numeric=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
type Target=Pick<Cdp,'send'|'evaluate'|'on'|'off'>;
type Paused={requestId:string;request:{url:string};responseStatusCode?:number;responseHeaders?:{name:string;value:string}[]};
type Parsed={url:string;scriptId:string;executionContextId:number};

type Baseline={client:string;style:string};

/** A rollback serves only the separately built, byte-pinned production assets. */
export function loadCaptionBaseline(directory:string|undefined):Baseline {
  if(!directory||!path.isAbsolute(directory))throw new Error('Caption baseline assets directory required');
  const read=(asset:typeof oldClient)=>{
    try {
      const file=path.join(directory,asset.name),stat=statSync(file);
      if(!stat.isFile()||stat.size!==asset.bytes)throw new Error('size');
      const body=readFileSync(file);
      if(body.length!==asset.bytes||hash(body)!==asset.hash)throw new Error('hash');
      return body.toString('utf8');
    }catch{throw new Error('Caption baseline '+(asset===oldClient?'client':'style')+' identity mismatch');}
  };
  return {client:read(oldClient),style:read(oldStyle)};
}

/** Response interception belongs to this target and is removed even after a rejected body. */
export class CaptionAssets {
  readonly received:{name:string;receivedHash:string;fulfilledHash:string;bytes:number}[]=[];
  ready=false;
  private parsed?:Parsed;
  private failure?:unknown;
  private pending=new Set<Promise<void>>();
  private installed=false;
  private readonly clientURL:string;
  private readonly styleURL:string;
  constructor(private readonly cdp:Target,base:string,private readonly candidate:boolean,private readonly signal:AbortSignal,private readonly baseline:Baseline) {
    this.clientURL=new URL('/assets/'+client.name,base).href;
    this.styleURL=new URL('/assets/'+style.name,base).href;
  }
  private readonly onParsed=(event:Parsed)=>{if(event.url===this.clientURL)this.parsed=event;};
  private readonly onPaused=(event:Paused)=>{
    const work=this.respond(event).catch(error=>{this.failure??=error;}).finally(()=>this.pending.delete(work));
    this.pending.add(work);
  };
  private async respond(event:Paused) {
    try {
      const expected=event.request.url===this.clientURL?client:event.request.url===this.styleURL?style:null;
      if(!expected||event.responseStatusCode!==200)throw new Error('Caption asset response mismatch');
      const payload=await this.cdp.send<{body:string;base64Encoded:boolean}>('Fetch.getResponseBody',{requestId:event.requestId},this.signal);
      if(typeof payload.body!=='string'||typeof payload.base64Encoded!=='boolean'||payload.body.length>4*1024*1024)throw new Error('Caption asset body bound');
      let body=payload.base64Encoded?Buffer.from(payload.body,'base64').toString('utf8'):payload.body;
      const receivedHash=hash(body);
      if(Buffer.byteLength(body)!==expected.bytes||receivedHash!==expected.hash)throw new Error('Caption upstream identity mismatch');
      if(!this.candidate)body=expected===client?this.baseline.client:this.baseline.style;
      const fulfilled=this.candidate?expected:expected===client?oldClient:oldStyle,fulfilledHash=hash(body);
      if(Buffer.byteLength(body)!==fulfilled.bytes||fulfilledHash!==fulfilled.hash)throw new Error('Caption fulfilled identity mismatch');
      const headers=(event.responseHeaders??[]).filter(header=>!['content-length','content-encoding','transfer-encoding','connection','etag'].includes(header.name.toLowerCase()));
      await this.cdp.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:headers,body:Buffer.from(body).toString('base64')},this.signal);
      if(this.received.length>=16)throw new Error('Caption asset receipt bound');
      this.received.push({name:expected===client?'client':'style',receivedHash,fulfilledHash,bytes:Buffer.byteLength(body)});
    } catch(error) {
      // Do not leave the reload waiting for a response whose source was rejected.
      try{await deadline(2000,signal=>this.cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Aborted'},signal));}catch{/* The arm retains the source failure. */}
      throw error;
    }
  }
  async install() {
    this.cdp.on('Fetch.requestPaused',this.onPaused);this.cdp.on('Debugger.scriptParsed',this.onParsed);this.installed=true;
    await this.cdp.send('Fetch.enable',{patterns:[this.clientURL,this.styleURL].map(urlPattern=>({urlPattern,requestStage:'Response'}))},this.signal);
    await this.cdp.send('Debugger.enable',{},this.signal);
  }
  async bind() {
    await Promise.all([...this.pending]);
    if(this.failure)throw this.failure;
    const parsed=this.parsed;
    if(!parsed||!/^[1-9]\d*$/.test(parsed.scriptId)||!Number.isSafeInteger(parsed.executionContextId)||parsed.executionContextId<=0)throw new Error('Caption parsed owner missing');
    const actual=await this.cdp.evaluate<{client:string;styles:{href:string;disabled:boolean}[]}>(`({client:[...document.scripts].find(s=>s.src===${JSON.stringify(this.clientURL)})?.src,styles:[...document.styleSheets].filter(s=>s.href===${JSON.stringify(this.styleURL)}).map(s=>({href:s.href,disabled:s.disabled}))})`,this.signal);
    if(actual.client!==this.clientURL||actual.styles.length!==1||actual.styles[0].disabled||!this.received.some(row=>row.name==='client')||!this.received.some(row=>row.name==='style'))throw new Error('Caption loaded assets missing');
    const source=await this.cdp.send<{scriptSource:string}>('Debugger.getScriptSource',{scriptId:parsed.scriptId},this.signal),expected=this.candidate?client:oldClient;
    if(typeof source.scriptSource!=='string'||Buffer.byteLength(source.scriptSource)!==expected.bytes||hash(source.scriptSource)!==expected.hash)throw new Error('Caption parsed identity mismatch');
    await this.cdp.send('Debugger.disable',{},this.signal);this.ready=true;
    return {scriptId:Number(parsed.scriptId),name:client.name,receivedHash:client.hash,fulfilledHash:expected.hash,receivedStyleHash:style.hash,styleHash:this.candidate?style.hash:oldStyle.hash,bytes:expected.bytes};
  }
  check() {if(this.failure)throw this.failure;}
  async close(signal:AbortSignal) {
    try{if(this.installed)await this.cdp.send('Fetch.disable',{},signal);}
    finally{this.cdp.off('Fetch.requestPaused',this.onPaused);this.cdp.off('Debugger.scriptParsed',this.onParsed);this.installed=false;}
    await Promise.all([...this.pending]);
  }
}

const metricNames=['Timestamp','LayoutCount','LayoutDuration','RecalcStyleCount','RecalcStyleDuration','ScriptDuration','TaskDuration'] as const;
type Counters=Record<typeof metricNames[number],number>;
type WheelResponse={ms:number;queued:number;processed:number;segment:string;requests:number;at:number;delivered:number;reached:number;id:number};
type Wheel={samples:{at:number;stamp:number;ms:number;inputSegment:string;segment:string}[];responses:WheelResponse[];inputs:number;latency:number[]};
type Reading=Awaited<ReturnType<typeof panning>>;
type Arm={documentBefore?:{id:string;loaderId:string};documentAfter?:{id:string;loaderId:string};name:string;status:'complete'|'insufficient-evidence';assets:CaptionAssets['received'];binding?:Awaited<ReturnType<CaptionAssets['bind']>>;reading?:Reading;budgetFailures:{reason:string}[];exceptionCount:number;omittedExceptions:number;exceptions:{time:number|null;line:number|null;column:number|null;executionContextId:number|null}[];wheel?:Wheel;counterBefore?:Counters;counterAfter?:Counters;counterDelta?:Counters;metrics?:{frames:number;inputs:number;p95:number;p99:number;input95:number;wheelInput95:number};cleanup:string[];reason?:string};

/** A diagnostic A/B/rollback, never an accepted implementation or a canonical pass. */
export async function captionControl(cdp:Cdp,base:string,evidence:{save(name:string,value:unknown):void},expectedClientSHA:string) {
  if(expectedClientSHA!==client.hash)throw new Error('Caption control requires the exact candidate client');
  const production=loadCaptionBaseline(process.env.QUOTUM_BENCH_CAPTION_BASELINE_DIR);
  const arms:Arm[]=[],failures:{name:string;reason:string}[]=[];
  const browser=await cdp.send<{product:string;revision:string;jsVersion:string}>('Browser.getVersion');
  const saved=await cdp.evaluate<{prefs:string|null;locale:string|null;url:string}>('({prefs:localStorage.getItem("quotum.prefs"),locale:localStorage.getItem("quotum.locale"),url:location.href})');
  const url=new URL(saved.url);if(url.origin!==new URL(base).origin)throw new Error('Caption target origin mismatch');
  url.searchParams.delete('from');url.searchParams.delete('to');
  const baseline=(href:string)=>`(()=>{if(location.origin!==${JSON.stringify(url.origin)})throw Error('Caption target origin changed');const saved=${JSON.stringify(saved)};for(const [key,value]of [['quotum.prefs',saved.prefs],['quotum.locale',saved.locale]]){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}history.replaceState(null,'',${JSON.stringify(href)});})()`;
  const metrics=async(signal:AbortSignal)=>{
    const reply=await cdp.send<{metrics:{name:string;value:number}[]}>('Performance.getMetrics',{},signal);
    const values=Object.fromEntries(reply.metrics.filter(row=>(metricNames as readonly string[]).includes(row.name)&&numeric(row.value)).map(row=>[row.name,row.value])) as Counters;
    if(!metricNames.every(key=>numeric(values[key])))throw new Error('Caption counters unavailable');
    return values;
  };
  for(const name of ['A1','B','A2']) {
    const abort=new AbortController(),expires=performance.now()+90_000,assets=new CaptionAssets(cdp,base,name==='B',abort.signal,production);
    const arm:Arm={name,status:'insufficient-evidence',assets:assets.received,budgetFailures:[],exceptionCount:0,omittedExceptions:0,exceptions:[],cleanup:[]};arms.push(arm);
    const onException=(event:{timestamp?:number;exceptionDetails?:{lineNumber?:number;columnNumber?:number;executionContextId?:number}})=>{
      arm.exceptionCount++;
      if(arm.exceptions.length>=8){arm.omittedExceptions++;return;}
      const details=event.exceptionDetails;
      arm.exceptions.push({time:numeric(event.timestamp)?event.timestamp:null,line:numeric(details?.lineNumber)?details.lineNumber:null,column:numeric(details?.columnNumber)?details.columnNumber:null,executionContextId:numeric(details?.executionContextId)?details.executionContextId:null});
    };
    cdp.on('Runtime.exceptionThrown',onException);
    let stage='',began=false,ended=false,frame:{id:string;loaderId:string}|undefined;
    const restore=async(label:string,work:(signal:AbortSignal)=>Promise<unknown>)=>{
      const remaining=Math.min(2000,expires-performance.now());
      try{if(remaining<=0)throw new Error('Caption arm cleanup deadline');await deadline(remaining,work);}catch{arm.cleanup.push(label);}
    };
    try {
      await deadline(70_000,async signal=>{
        signal.addEventListener('abort',()=>abort.abort(signal.reason),{once:true});
        const combined=(parent?:AbortSignal)=>parent?AbortSignal.any([abort.signal,parent]):abort.signal;
        const send: Cdp['send']=(method,params={},parent)=>{
          assets.check();if(method==='Emulation.setCPUThrottlingRate'&&(params as {rate?:number}).rate===4&&!assets.ready)throw new Error('Caption CPU4 before binding');
          return cdp.send(method,params,combined(parent));
        };
        const evaluate: Cdp['evaluate']=async<T>(expression:string,parent?:AbortSignal)=>{
          assets.check();const current=combined(parent);
          if(expression.includes('const originalRAF=window.requestAnimationFrame')){if(arm.binding)throw new Error('Caption repeated probe');arm.binding=await assets.bind();}
          if(stage==='native/quota/24h/wheel'&&expression==='window.__quotumPan.feeding=true'){
            if(began)throw new Error('Caption wheel boundary repeated');began=true;
            frame=(await cdp.send<{frameTree:{frame:{id:string;loaderId:string}}}>('Page.getFrameTree',{},current)).frameTree.frame;
            if(typeof frame?.id!=='string'||!frame.id||typeof frame.loaderId!=='string'||!frame.loaderId)throw new Error('Caption wheel document unavailable');
            arm.documentBefore={id:frame.id,loaderId:frame.loaderId};
            arm.counterBefore=await metrics(current);
          }
          const value=await cdp.evaluate<T>(expression,current);
          if(stage==='native/quota/24h/wheel-settle'&&expression.includes('const loading=document.getElementsByClassName')&&!ended){
            ended=true;arm.counterAfter=await metrics(current);
            arm.wheel=await cdp.evaluate<Wheel>('(()=>{const p=window.__quotumPan;if(!p||p.samples.length>5000||p.responses.length>5000||p.latency.length>5000)throw Error("Caption receipt bound");return{samples:p.samples.filter(r=>r.inputSegment==="wheel"),responses:p.responses.filter(r=>r.segment==="wheel"),inputs:p.inputs,latency:p.latency};})()',current);
            const endFrame=(await cdp.send<{frameTree:{frame:{id:string;loaderId:string}}}>('Page.getFrameTree',{},current)).frameTree.frame;
            arm.documentAfter={id:endFrame.id,loaderId:endFrame.loaderId};
            if(frame?.id!==endFrame.id||frame?.loaderId!==endFrame.loaderId)throw new Error('Caption wheel document changed');
          }
          return value;
        };
        await cdp.send('Runtime.enable',{},signal);
        await cdp.evaluate(baseline(url.href),signal);
        await cdp.send('Performance.enable',{},signal);await assets.install();
        const version=await cdp.send<typeof browser>('Browser.getVersion',{},signal);
        if(JSON.stringify(version)!==JSON.stringify(browser))throw new Error('Caption browser changed');
        arm.reading=await panning({send,evaluate,on:cdp.on.bind(cdp),off:cdp.off.bind(cdp),snapshot:cdp.snapshot.bind(cdp),at:next=>{stage=next;cdp.at(name+'/'+next);}},undefined,{selection:'quota24',save:(event,value)=>evidence.save('caption-'+name.toLowerCase()+'-'+event,value)});
        arm.budgetFailures=arm.reading.problems.map(reason=>({reason}));
        assets.check();
        const allowed=new Set(['quota/24h moving-frame p95 exceeds 34 ms','quota/24h moving-frame p99 exceeds 80 ms','quota/24h input-to-updated-frame p95 exceeds 50 ms']);
        if(arm.reading.reports.length!==1||arm.reading.reports[0].initiator!=='quota'||arm.reading.reports[0].period!=='24h'||arm.reading.problems.some(problem=>!allowed.has(problem)))throw new Error('Caption original structural checks failed');
        const report=arm.reading.reports[0],currentCohort=[report.series,report.sessionSeries,report.budgetSeries,report.fundsSeries,report.charts];
        if(currentCohort.some((value,index)=>value!==[48,15,12,12,5][index]))throw new Error('Caption initial measured cohort changed');
        const wheel=arm.wheel;
        if(!began||!ended||!wheel||!wheel.samples.length||wheel.inputs!==wheel.responses.length||wheel.inputs!==wheel.latency.length||new Set(wheel.responses.map(row=>row.id)).size!==wheel.inputs||wheel.samples.some(row=>![row.at,row.stamp,row.ms].every(numeric)||row.ms<=0||row.inputSegment!=='wheel')||wheel.responses.some((row,index)=>!Number.isSafeInteger(row.id)||row.id<=0||row.segment!=='wheel'||![row.at,row.delivered,row.reached,row.ms,row.queued,row.processed].every(numeric)||row.reached<row.delivered||row.delivered<row.at||row.ms!==row.reached-row.at||row.queued!==row.delivered-row.at||row.processed!==row.reached-row.delivered||row.ms!==wheel.latency[index]))throw new Error('Caption complete wheel receipts missing');
        const first=arm.counterBefore,last=arm.counterAfter;
        if(!first||!last||metricNames.some(key=>last[key]<first[key])||last.Timestamp<=first.Timestamp)throw new Error('Caption counter window invalid');
        arm.counterDelta=Object.fromEntries(metricNames.map(key=>[key,last[key]-first[key]])) as Counters;
        arm.metrics={frames:report.frames.length,inputs:report.inputs,p95:percentile(report.frames,.95),p99:percentile(report.frames,.99),input95:percentile(report.latency,.95),wheelInput95:percentile(wheel.latency,.95)};
        if(arm.exceptionCount)throw new Error('Caption page exception observed');
        arm.status='complete';
      });
    } catch(error) {arm.reason=error instanceof Error?error.message:'Caption control failed';}
    finally {
      abort.abort();
      await restore('CPU restore',signal=>cdp.send('Emulation.setCPUThrottlingRate',{rate:1},signal));
      await restore('network restore',signal=>cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1},signal));
      await restore('touch restore',signal=>cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false},signal));
      await restore('Fetch cleanup',signal=>assets.close(signal));
      await restore('Debugger cleanup',signal=>cdp.send('Debugger.disable',{},signal));
      await restore('probe cleanup',signal=>cdp.evaluate('(()=>{window.__quotumPan?.cleanup();delete window.__quotumPan;document.getElementById("quotum-pan-layout")?.remove();})()',signal));
      await restore('opening restore',signal=>cdp.evaluate(baseline(saved.url),signal));
      await restore('viewport restore',signal=>cdp.send('Emulation.clearDeviceMetricsOverride',{},signal));
      await restore('Runtime cleanup',signal=>cdp.send('Runtime.disable',{},signal));cdp.off('Runtime.exceptionThrown',onException);
      try{assets.check();}catch(error){arm.status='insufficient-evidence';arm.reason??=error instanceof Error?error.message:'Caption asset failure';}
      if(arm.cleanup.length||performance.now()>expires||arm.exceptionCount){arm.status='insufficient-evidence';arm.reason??=arm.exceptionCount?'Caption page exception observed':'Caption cleanup unconfirmed';}
    }
    evidence.save('caption-control-'+name.toLowerCase(),arm);
    if(arm.status!=='complete'){failures.push({name,reason:arm.reason??'Caption control incomplete'});break;}
  }
  return {mode:'caption-control',status:arms.length===3&&!failures.length?'complete' as const:'insufficient-evidence' as const,browser:{name:browser.product,sourceHash:browser.revision,version:browser.jsVersion},arms,problems:arms.flatMap(arm=>arm.reading?.problems??[]),failures,adopt:false};
}
