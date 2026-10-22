import {createHash} from 'node:crypto';
import {deadline} from './deadline.js';
import type {Cdp} from './cdp.js';

type Client = {status:'available';name:string;bytes:number;sha256:string} | {status:'unavailable'};
type Response = {requestId?:unknown;type?:unknown;response?:{url?:unknown}};
type Parsed = {url?:unknown;hash?:unknown;scriptId?:unknown};
type Injected = {interval:number;kind:'native-sampler'|'idle-probe';bytes:number;sourceHash:string};
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f\d]{64}$/i.test(value);
const scriptId=(value:unknown)=>typeof value==='string'&&/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;

/** Received bytes and parsed script IDs are joined outside the family's trace. */
export class ScriptBinding {
  private received:{requestId:string;url:string}[]=[];
  private omitted=0;
  private family=0;
  private injected:Injected[]=[];
  private injectedOmitted=0;
  private injectedConflicts=0;
  private readonly response=(event:Response)=>{
    if(this.client.status!=='available'||event.type!=='Script'||typeof event.requestId!=='string'||typeof event.response?.url!=='string')return;
    let pathname:string;try{pathname=new URL(event.response.url).pathname;}catch{return;}
    if(pathname!=='/assets/'+this.client.name)return;
    if(this.received.length>=32){this.omitted++;return;}
    this.received.push({requestId:event.requestId,url:event.response.url});
  };
  constructor(private readonly cdp:Pick<Cdp,'on'|'off'|'send'>,private readonly client:Client,private readonly save:(name:string,value:unknown)=>void){cdp.on('Network.responseReceived',this.response);}
  /** Binds an existing page probe only after its installation succeeds. */
  rememberInjected(interval:number,expression:string,kind:Injected['kind']='native-sampler'){
    if(!Number.isSafeInteger(interval)||interval<1||typeof expression!=='string'){this.injectedOmitted++;return;}
    const bytes=Buffer.byteLength(expression);
    if(bytes>64*1024){this.injectedOmitted++;return;}
    const sourceHash=createHash('sha256').update(expression).digest('hex'),prior=this.injected.find(value=>value.interval===interval);
    if(prior){if(prior.sourceHash!==sourceHash)this.injectedConflicts++;return;}
    if(this.injected.length>=2){this.injectedOmitted++;return;}
    this.injected.push({interval,kind,bytes,sourceHash});
  }
  close(){
    this.cdp.off('Network.responseReceived',this.response);this.received=[];
    if(this.injected.length||this.injectedOmitted||this.injectedConflicts)this.save('source-injected-pending',{mode:'diagnostic',status:'unavailable',expected:this.injected,omittedExpected:this.injectedOmitted,expectedConflicts:this.injectedConflicts});
    this.injected=[];this.injectedOmitted=this.injectedConflicts=0;
  }

  async afterFamily(intervals:readonly number[],stage:'after-family'|'after-failed-family'='after-family',parent?:AbortSignal){
    const family=++this.family,received=this.received;this.received=[];
    const expected=this.injected;this.injected=[];
    const omittedExpected=this.injectedOmitted,expectedConflicts=this.injectedConflicts;this.injectedOmitted=this.injectedConflicts=0;
    const injected:{[key:string]:unknown}={expected,omittedExpected,expectedConflicts,owners:[],conflicts:0,omittedOwners:0,anonymousScripts:0,omittedAnonymous:0,unmatchedIntervals:expected.map(value=>value.interval),status:expected.length||omittedExpected||expectedConflicts?'unavailable':'not-requested'};
    const report:{[key:string]:unknown}={mode:'diagnostic',stage,family,intervals,omitted:this.omitted,status:'unavailable',owners:[],debuggerDisabled:true};
    report.injected=injected;
    if(this.client.status!=='available'||!received.length||this.omitted){report.reason=this.omitted?'received script limit':'received client unavailable';this.save('source-family-'+family,report);return;}
    const client=this.client,last=received.at(-1)!,owners=new Map<number,string>(),conflicting=new Set<number>();
    let enabled=false,disabled=false,conflicts=0,omitted=0;
    const anonymous=new Map<number,string>(),anonymousConflicts=new Set<number>(),injectedOwners=new Map<number,{scriptId:number;parsedHash:string;intervals:number[]}>();
    let omittedAnonymous=0,omittedInjectedOwners=0;
    const parsed=(event:Parsed)=>{
      const id=scriptId(event.scriptId);
      if(expected.length&&event.url===''&&id!==null&&digest(event.hash)){
        const hash=event.hash.toLowerCase(),prior=anonymous.get(id);
        if(prior!==undefined&&prior!==hash)anonymousConflicts.add(id);
        else if(prior===undefined){if(anonymous.size>=256)omittedAnonymous++;else anonymous.set(id,hash);}
        const matches=expected.filter(value=>value.sourceHash===hash);
        if(matches.length&&!injectedOwners.has(id)){
          if(injectedOwners.size>=32)omittedInjectedOwners++;
          else injectedOwners.set(id,{scriptId:id,parsedHash:hash,intervals:matches.map(value=>value.interval)});
        }
      }
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
        const consistent=(owner:{scriptId:number;parsedHash:string})=>anonymous.get(owner.scriptId)===owner.parsedHash&&!anonymousConflicts.has(owner.scriptId);
        injected.owners=[...injectedOwners.values()].map(owner=>({...owner,expectedHashMatches:consistent(owner)}));
        injected.conflicts=[...injectedOwners.keys()].filter(id=>anonymousConflicts.has(id)).length;
        injected.omittedOwners=omittedInjectedOwners;injected.anonymousScripts=anonymous.size;injected.omittedAnonymous=omittedAnonymous;
        const matched=new Set([...injectedOwners.values()].filter(consistent).flatMap(owner=>owner.intervals));
        const unmatched=expected.filter(value=>!matched.has(value.interval)).map(value=>value.interval);injected.unmatchedIntervals=unmatched;
        if(expected.length||omittedExpected||expectedConflicts)injected.status=expected.length&&!unmatched.length&&!omittedExpected&&!expectedConflicts&&!injected.conflicts&&!omittedInjectedOwners&&!omittedAnonymous?'complete':'insufficient-evidence';
      },parent);
    }catch{report.status='unavailable';report.reason='script binding command failed';}
    finally{
      this.cdp.off('Debugger.scriptParsed',parsed);
      if(enabled&&!disabled)try{await deadline(1000,signal=>this.cdp.send('Debugger.disable',{},signal));disabled=true;}catch{/* An unconfirmed debugger cannot enter another measured interval. */}
      report.elapsedMs=performance.now()-started;report.debuggerDisabled=!enabled||disabled;
      if(enabled&&!disabled&&injected.status!=='not-requested')injected.status='insufficient-evidence';
      this.save('source-family-'+family,report);
    }
    if(enabled&&!disabled)throw Error('diagnostic script binding cleanup unconfirmed');
  }
}
