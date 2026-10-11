import {createHash} from 'node:crypto';
import {deadline} from './deadline.js';
import type {Cdp} from './cdp.js';

type Client = {status:'available';name:string;bytes:number;sha256:string} | {status:'unavailable'};
type Response = {requestId?:unknown;type?:unknown;response?:{url?:unknown}};
type Parsed = {url?:unknown;hash?:unknown;scriptId?:unknown};
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f\d]{64}$/i.test(value);
const scriptId=(value:unknown)=>typeof value==='string'&&/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;

/** Received bytes and parsed script IDs are joined only after a completed input family. */
export class ScriptBinding {
  private received:{requestId:string;url:string}[]=[];
  private omitted=0;
  private family=0;
  private readonly response=(event:Response)=>{
    if(this.client.status!=='available'||event.type!=='Script'||typeof event.requestId!=='string'||typeof event.response?.url!=='string')return;
    let pathname:string;try{pathname=new URL(event.response.url).pathname;}catch{return;}
    if(pathname!=='/assets/'+this.client.name)return;
    if(this.received.length>=32){this.omitted++;return;}
    this.received.push({requestId:event.requestId,url:event.response.url});
  };
  constructor(private readonly cdp:Pick<Cdp,'on'|'off'|'send'>,private readonly client:Client,private readonly save:(name:string,value:unknown)=>void){cdp.on('Network.responseReceived',this.response);}
  close(){this.cdp.off('Network.responseReceived',this.response);this.received=[];}

  async afterFamily(intervals:readonly number[]){
    const family=++this.family,received=this.received;this.received=[];
    const report:{[key:string]:unknown}={mode:'diagnostic',stage:'after-family',family,intervals,omitted:this.omitted,status:'unavailable',owners:[],debuggerDisabled:true};
    if(this.client.status!=='available'||!received.length||this.omitted){report.reason=this.omitted?'received script limit':'received client unavailable';this.save('source-family-'+family,report);return;}
    const client=this.client,last=received.at(-1)!,owners=new Map<number,string>(),conflicting=new Set<number>();
    let enabled=false,disabled=false,conflicts=0,omitted=0;
    const parsed=(event:Parsed)=>{
      const id=scriptId(event.scriptId);
      if(event.url!==last.url||id===null||!digest(event.hash))return;
      const hash=event.hash.toLowerCase(),prior=owners.get(id);
      if(prior!==undefined&&prior!==hash){conflicts++;conflicting.add(id);return;}
      if(owners.size>=32&&!owners.has(id)){omitted++;return;}
      owners.set(id,hash);
    };
    const started=performance.now();
    try{
      await deadline(5000,async signal=>{
        const response=await this.cdp.send<{body:string;base64Encoded:boolean}>('Network.getResponseBody',{requestId:last.requestId},signal);
        if(typeof response.body!=='string'||typeof response.base64Encoded!=='boolean'||response.body.length>4*1024*1024)throw Error('received script unavailable');
        const bytes=Buffer.from(response.body,response.base64Encoded?'base64':'utf8'),receivedHash=createHash('sha256').update(bytes).digest('hex');
        report.bytes=bytes.length;report.receivedHash=receivedHash;report.clientHash=client.sha256;
        report.receivedAssetHashMatches=bytes.length===client.bytes&&receivedHash===client.sha256;
        this.cdp.on('Debugger.scriptParsed',parsed);enabled=true;
        await this.cdp.send('Debugger.enable',{},signal);
        await this.cdp.send('Debugger.disable',{},signal);disabled=true;
        report.owners=[...owners].map(([scriptId,parsedHash])=>({scriptId,parsedHash,receivedAssetHashMatches:report.receivedAssetHashMatches===true&&!conflicting.has(scriptId)&&parsedHash===receivedHash}));
        report.conflicts=conflicts;report.omittedOwners=omitted;
        report.status=report.receivedAssetHashMatches===true&&owners.size>0&&!conflicts&&!omitted&&[...owners.values()].every(hash=>hash===receivedHash)?'complete':'mismatch';
      });
    }catch{report.status='unavailable';report.reason='script binding command failed';}
    finally{
      this.cdp.off('Debugger.scriptParsed',parsed);
      if(enabled&&!disabled)try{await deadline(1000,signal=>this.cdp.send('Debugger.disable',{},signal));disabled=true;}catch{/* An unconfirmed debugger cannot enter another measured interval. */}
      report.elapsedMs=performance.now()-started;report.debuggerDisabled=!enabled||disabled;
      this.save('source-family-'+family,report);
    }
    if(enabled&&!disabled)throw Error('diagnostic script binding cleanup unconfirmed');
  }
}
