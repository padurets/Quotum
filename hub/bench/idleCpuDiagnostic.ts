import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import type {Cdp} from './cdp.js';
import {bounded} from './reversalDiagnostic.js';
import {numericProfile} from './cpuProfile.js';
import {ScriptBinding} from './scriptBinding.js';

type Client={status:'available';name:string;bytes:number;sha256:string}|{status:'unavailable'};
type RawEvent={name:string;ph:string;ts?:number;dur?:number;tts?:number;tdur?:number;pid?:number;tid?:number;args?:{data?:{frame?:string;timerId?:number;timeout?:number;singleShot?:boolean;scriptId?:string|number;lineNumber?:number;columnNumber?:number;stackTrace?:unknown;message?:string}}};
type CounterWindow={before:Record<string,number>;after:Record<string,number>;instrumentMs:number;seconds:number};
type Save=(name:string,value:unknown,large?:boolean)=>void;
type Profile=Parameters<typeof numericProfile>[0];
const MAX_EVENTS=100_000,MAX_BYTES=32*1024*1024;
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const location=(value:any)=>{
  const scriptId=typeof value?.scriptId==='string'&&/^[1-9]\d*$/.test(value.scriptId)?Number(value.scriptId):value?.scriptId;
  return Number.isSafeInteger(scriptId)&&scriptId>0&&Number.isSafeInteger(value?.lineNumber)&&value.lineNumber>=0&&Number.isSafeInteger(value?.columnNumber)&&value.columnNumber>=0
    ?{scriptId,lineNumber:value.lineNumber,columnNumber:value.columnNumber}:null;
};

/** Compiled positions are valid only for the bytes the page actually received. */
export function clientIdentity(directory=path.join(import.meta.dirname,'../dist/client/assets')):Client {
  try {
    const names=readdirSync(directory).filter(name=>/^index-[\w-]+\.js$/.test(name));
    if(names.length!==1)return{status:'unavailable'};
    const bytes=readFileSync(path.join(directory,names[0]));
    return{status:'available',name:names[0],bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }catch{return{status:'unavailable'};}
}

/** One original idle interval, observed only in the benchmark's own synthetic browser. */
export class IdleCpuDiagnostic {
  readonly binding:ScriptBinding;
  private frame:string|null=null;
  private active=false;
  private profiler=false;
  private tracing=false;
  private ended=false;
  private complete:()=>void=()=>{};
  private readonly events:unknown[]=[];
  private bytes=0;
  private omitted=0;
  private rejectedForeign=0;
  private unscoped=0;
  private invalid=0;
  private invalidOwners=0;
  private omittedOwners=0;
  private timerFires=0;
  private sourceCallbacks=0;
  private readonly clocks:{stage:string;before:number|null;page:number;after:number|null;valid:boolean}[]=[];
  private readonly collected=(message:{value:RawEvent[]})=>{
    if(!this.active)return;
    for(const event of message.value){
      if(!['TimerInstall','TimerRemove','TimerFire','FunctionCall','TimeStamp'].includes(event.name))continue;
      const data=event.args?.data;
      if(!data||data.frame!==this.frame){if(data?.frame)this.rejectedForeign++;else this.unscoped++;continue;}
      if(!finite(event.ts)||!Number.isSafeInteger(event.pid)||!Number.isSafeInteger(event.tid)){this.invalid++;continue;}
      const ownerFrames=Array.isArray(data.stackTrace)?data.stackTrace.slice(0,32).map(location):[];
      const invalidOwners=ownerFrames.filter(frame=>!frame).length;
      const omittedOwners=Array.isArray(data.stackTrace)?Math.max(0,data.stackTrace.length-32):0;
      this.invalidOwners+=invalidOwners;this.omittedOwners+=omittedOwners;
      if(event.name==='TimerFire')this.timerFires++;
      if(event.name==='FunctionCall'&&location(data))this.sourceCallbacks++;
      const safe={name:event.name,phase:event.ph,ts:event.ts,duration:finite(event.dur)?event.dur:null,
        threadTs:finite(event.tts)?event.tts:null,threadDuration:finite(event.tdur)?event.tdur:null,pid:event.pid,tid:event.tid,frame:1,
        source:event.name==='FunctionCall'?location(data):null,
        timer:event.name.startsWith('Timer')?{id:Number.isSafeInteger(data.timerId)?data.timerId:null,timeout:finite(data.timeout)?data.timeout:null,
          singleShot:typeof data.singleShot==='boolean'?data.singleShot:null,ownerFrames,
          ownerStatus:invalidOwners||omittedOwners?'insufficient-evidence':ownerFrames.length?'available':'unavailable',
          omittedOwnerFrames:omittedOwners}:null};
      const bytes=Buffer.byteLength(JSON.stringify(safe));
      if(this.events.length>=MAX_EVENTS||this.bytes+bytes>MAX_BYTES){this.omitted++;continue;}
      this.bytes+=bytes;this.events.push(safe);
    }
  };
  private readonly completed=()=>{this.ended=true;this.complete();};

  constructor(private readonly cdp:Cdp,private readonly save:Save,client:Client,ownedSynthetic:boolean){
    if(!ownedSynthetic)throw Error('Idle CPU diagnostics require an owned synthetic browser');
    this.binding=new ScriptBinding(cdp,client,(name,value)=>save('idle-cpu-'+name,value));
    save('idle-cpu-client',{mode:'diagnostic',client});
  }

  private async clock(stage:string){
    const stamp=async()=>(await this.cdp.send<{metrics:{name:string;value:number}[]}>('Performance.getMetrics')).metrics.find(metric=>metric.name==='Timestamp')?.value;
    const before=await stamp(),page=await this.cdp.evaluate<number>('performance.now()'),after=await stamp();
    this.clocks.push({stage,before:Number.isFinite(before)?before!*1000:null,page,after:Number.isFinite(after)?after!*1000:null,
      valid:Number.isFinite(before)&&Number.isFinite(after)&&Number.isFinite(page)&&before!<=after!});
  }

  /** Called before the unchanged from/to/reset/metrics sequence. */
  async start(){
    this.frame=(await this.cdp.send<{frameTree:{frame:{id:string}}}>('Page.getFrameTree')).frameTree.frame.id;
    if(typeof this.frame!=='string'||!this.frame)throw Error('Owned target frame unavailable');
    this.cdp.on('Tracing.dataCollected',this.collected);this.cdp.on('Tracing.tracingComplete',this.completed);
    this.profiler=true;await this.cdp.send('Profiler.enable');
    await this.cdp.send('Profiler.setSamplingInterval',{interval:2000});
    await this.clock('start');
    this.active=true;this.tracing=true;
    await this.cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline.stack',transferMode:'ReportEvents'});
    await this.cdp.send('Profiler.start');
  }

  /** Called only after the original after-metrics and readout have been frozen. */
  async stop(window:CounterWindow){
    let profile:ReturnType<typeof numericProfile>|null=null,cleanup='complete',error:unknown;
    try{
      await this.clock('end');
      const reply=await this.cdp.send<{profile:Profile}>('Profiler.stop');
      await this.cdp.send('Profiler.disable');this.profiler=false;
      profile=numericProfile(reply.profile);
      const completed=new Promise<void>(resolve=>{this.complete=resolve;});
      await this.cdp.send('Tracing.end');
      await bounded('idle CPU trace drain',completed);
      this.tracing=false;
    }catch(value){error=value;cleanup='incomplete';}
    finally{
      this.active=false;
      this.cdp.off('Tracing.dataCollected',this.collected);this.cdp.off('Tracing.tracingComplete',this.completed);
      if(this.profiler)try{await this.cdp.send('Profiler.stop');await this.cdp.send('Profiler.disable');this.profiler=false;}catch{cleanup='incomplete';}
      if(this.tracing)try{await this.cdp.send('Tracing.end');this.tracing=false;}catch{cleanup='incomplete';}
      this.save('idle-cpu-profile',{mode:'diagnostic',kind:'Sampled elapsed widths, not thread CPU time; observer overhead unqualified.',
        status:cleanup==='complete'&&profile?.status==='complete'?'complete':'insufficient-evidence',samplingInterval:2000,clocks:this.clocks,cleanup,profile},true);
      this.save('idle-cpu-window',{mode:'diagnostic',kind:'Original elapsed counters and existing probe cost; collection order and budget are unchanged.',...window});
      this.save('idle-cpu-timers',{mode:'diagnostic',status:cleanup==='complete'&&this.ended&&!this.omitted&&!this.invalid&&this.timerFires>0&&this.sourceCallbacks>0?'complete':'insufficient-evidence',
        scope:'explicit owned target frame only',frame:1,coordinates:'as emitted; source binding required',cleanup,ended:this.ended,omitted:this.omitted,
        invalid:this.invalid,invalidOwners:this.invalidOwners,omittedOwners:this.omittedOwners,timerFires:this.timerFires,sourceCallbacks:this.sourceCallbacks,
        rejectedForeign:this.rejectedForeign,unscoped:this.unscoped,bytes:this.bytes,events:this.events},true);
    }
    if(error)throw error;
  }

  async bindAndClose(){try{await this.binding.afterFamily([1]);}finally{this.binding.close();}}
  async close(){
    this.active=false;this.binding.close();
    this.cdp.off('Tracing.dataCollected',this.collected);this.cdp.off('Tracing.tracingComplete',this.completed);
    if(this.profiler){try{await this.cdp.send('Profiler.stop');}finally{await this.cdp.send('Profiler.disable');this.profiler=false;}}
    if(this.tracing){await this.cdp.send('Tracing.end');this.tracing=false;}
  }
}
