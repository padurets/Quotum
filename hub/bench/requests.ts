import type {Cdp} from './cdp.js';
import {accountingPath,accountingTotal} from './accountingTraffic';
import {compactJSON} from '../server/history';
import {PERIOD_SCOPES,type PeriodRequest} from '../server/domain/periodRead';

const ASKED=new Set(['Fetch','XHR','EventSource','Document']);
type TrafficRead={endpoint:'history'|'period'|'period/sessions';requestBytes:number|null;request:unknown;complete:boolean;encodedTotal?:number;encodedBodyLower:number;decodedObserved:number;contentLength?:number;coding:string;httpStatus?:number};

/** Exact decoded-wire partition, with only fixed names, states and counts exported. */
export function periodBodyDiagnostic(bytes:Buffer) {
  try{
    if(bytes.length>1024*1024)return;
    const text=bytes.toString(),raw=JSON.parse(text) as Record<string,unknown>;
    const serialize=compactJSON(raw)===text?compactJSON:JSON.stringify(raw)===text?JSON.stringify:null;
    if(!serialize||!raw||Array.isArray(raw)||typeof raw!=='object')return;
    const allowed=new Set(['basis',...PERIOD_SCOPES,'values','sessions','facets','sourceWork','calendar','moneySemantics','rateLegs']);
    const sections:Record<string,number>={},sectionStates:Record<string,{state:string|null;arrays:Record<string,number>}>={},unknown={count:0,bytes:0};let framing=2;
    for(const [key,value]of Object.entries(raw)){
      const size=Buffer.byteLength(serialize(value));framing+=Buffer.byteLength(JSON.stringify(key))+1;
      if(allowed.has(key)){sections[key]=size;const part=value as {state?:unknown;value?:Record<string,unknown>}|null;
        sectionStates[key]={state:part&&['complete','delta','error'].includes(String(part.state))?String(part.state):null,
          arrays:{...(Array.isArray(part?.value)?{values:part.value.length}:{}),...Object.fromEntries(['chunks','patch','updates','cells','refs','rows','values','sources','patterns'].flatMap(name=>Array.isArray(part?.value?.[name])?[[name,(part.value[name] as unknown[]).length]]:[]))}};
      }else{unknown.count++;unknown.bytes+=size;}
    }
    framing+=Math.max(0,Object.keys(raw).length-1);
    const partition=framing+unknown.bytes+Object.values(sections).reduce((sum,size)=>sum+size,0);
    if(partition===bytes.length)return {decodedBytes:bytes.length,sections,sectionStates,unknown,framing,partition,headerBytes:null};
  }catch{/* Unavailable or noncanonical bodies cannot provide an exact partition. */}
}

/** Counts what the page asks the hub while `counting`: the stream of events it opened before is not asked again, one opened meanwhile is. */
export class Requests {
  counting = false;
  count = 0;
  bytes = 0;
  readonly byPath: Record<string, number> = {};
  readonly bytesByPath: Record<string, number> = {};
  readonly history: {scope:string|null;meters:string|null;from:number;to:number}[] = [];
  private readonly ids = new Map<string, string>();
  private readonly traffic=new Map<string,TrafficRead>();
  private trafficOmitted=0;
  get historyPending() {return [...this.ids.values()].filter(accountingPath).length;}

  get historyRequests() {return accountingTotal(this.byPath);}
  get historyBytes() {return accountingTotal(this.bytesByPath);}
  get trafficReading(){return {omitted:this.trafficOmitted,reads:[...this.traffic.values()]};}

  constructor(cdp: Cdp, diagnose = false) {
    const partial=new Map<string,number>();
    cdp.on<{requestId:string;encodedDataLength:number;dataLength?:number}>('Network.dataReceived',event=>{if(this.ids.has(event.requestId))partial.set(event.requestId,(partial.get(event.requestId)??0)+event.encodedDataLength);const read=this.traffic.get(event.requestId);if(read){read.encodedBodyLower+=event.encodedDataLength;read.decodedObserved+=event.dataLength??0;}});
    cdp.on<{requestId:string}>('Network.loadingFailed',event=>{const path=this.ids.get(event.requestId);if(path){this.ids.delete(event.requestId);const bytes=partial.get(event.requestId)??0;this.bytes+=bytes;this.bytesByPath[path]=(this.bytesByPath[path]??0)+bytes;}partial.delete(event.requestId);});
    cdp.on<{requestId: string; type?: string; request: {url: string;postData?:string}}>('Network.requestWillBeSent', event => {
      if (!this.counting || !ASKED.has(event.type ?? '')) return;
      const url = new URL(event.request.url);
      this.count++;
      this.byPath[url.pathname] = (this.byPath[url.pathname] ?? 0) + 1;
      if(url.pathname==='/api/history')this.history.push({scope:url.searchParams.get('scope'),meters:url.searchParams.get('meters'),from:Number(url.searchParams.get('from')),to:Number(url.searchParams.get('to'))});
      if(accountingPath(url.pathname)&&url.pathname!=='/api/history'){const body=JSON.parse(event.request.postData??'{}');for(const scope of ['quota','budget','funds'])if(body[scope]){const q=body[scope];this.history.push({scope:scope==='funds'?'budget':scope,meters:q.meters??null,from:Number(q.from),to:Number(q.to)});}}
      this.ids.set(event.requestId, url.pathname);
      if(diagnose&&accountingPath(url.pathname)){
        if(this.traffic.size>=8){this.trafficOmitted++;return;}
        let request:unknown=null;
        if(event.request.postData!==undefined)try{
          const body=JSON.parse(event.request.postData) as PeriodRequest,selection=body.selection;
          request={selection:selection?.mode==='live'?{mode:'live',periodMs:Number(selection.periodMs)}:selection?.mode==='range'?{mode:'range',from:Number(selection.from),to:Number(selection.to)}:null,
            evaluatedAt:Number(body.evaluatedAt),sections:PERIOD_SCOPES.flatMap(scope=>{const q=body[scope];return q?[{scope,from:Number(q.from),to:Number(q.to),cell:Number(q.cell),cells:q.cells==='skip'?'skip':'read',evidence:q.evidence==='skip'?'skip':q.evidence?'cursor':'baseline'}]:[];}),
            values:body.values?.length??0,sessions:!!body.sessions,sessionsCursor:!!body.sessions?.cursor,sourceWork:!!body.sourceWork,sourceWorkCursor:!!body.sourceWork?.cursor,calendar:!!body.calendar,calendarCursor:!!body.calendar?.cursor,facets:!!body.facets};
        }catch{/* Missing or malformed shape remains unknown. */}
        this.traffic.set(event.requestId,{endpoint:url.pathname==='/api/history'?'history':url.pathname.endsWith('/sessions')?'period/sessions':'period',requestBytes:event.request.postData===undefined?null:Buffer.byteLength(event.request.postData),request,complete:false,encodedBodyLower:0,decodedObserved:0,coding:'unknown'});
      }
    });
    if(diagnose)cdp.on<{requestId:string;response:{status:number;headers:Record<string,string>}}>('Network.responseReceived',event=>{
      const read=this.traffic.get(event.requestId);if(!read)return;const headers=Object.fromEntries(Object.entries(event.response.headers).map(([key,value])=>[key.toLowerCase(),value]));
      read.httpStatus=event.response.status;read.coding=['gzip','br','deflate'].includes(headers['content-encoding'])?headers['content-encoding']:headers['content-encoding']?'other':'identity';
      const length=Number(headers['content-length']);if(headers['content-length']!==undefined&&Number.isSafeInteger(length)&&length>=0)read.contentLength=length;
    });
    cdp.on<{requestId: string; encodedDataLength: number}>('Network.loadingFinished', event => {
      const path = this.ids.get(event.requestId);
      if (path) {partial.delete(event.requestId);this.ids.delete(event.requestId); this.bytes += event.encodedDataLength; this.bytesByPath[path] = (this.bytesByPath[path] ?? 0) + event.encodedDataLength;}
      const read=this.traffic.get(event.requestId);if(read){read.complete=true;read.encodedTotal=event.encodedDataLength;}
    });
  }

  /** Called after the work verdicts: never add body reads to a measured interval. */
  async diagnose(cdp:Pick<Cdp,'send'>) {
    const metadata=this.trafficReading,{reads}=metadata;
    if(this.trafficOmitted||reads.length!==1||!reads[0].complete)return {...metadata,status:'insufficient-evidence'};
    try{
      const [requestId]=this.traffic.keys(),reply=await cdp.send<{body:string;base64Encoded:boolean}>('Network.getResponseBody',{requestId});
      const bytes=reply.base64Encoded?Buffer.from(reply.body,'base64'):Buffer.from(reply.body);
      const body=periodBodyDiagnostic(bytes);
      return body?{...metadata,status:'complete',body}:{...metadata,status:'insufficient-evidence'};
    }catch{return {...metadata,status:'insufficient-evidence'};}
  }
}
