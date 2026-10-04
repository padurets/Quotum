import {ConnectorStatus} from './connectors/transport.js';
import {providerOf} from './domain/providers.js';
import type {Refresh,RefreshRequest} from './domain/refresh.js';
import {Credentials,permanentAccess} from './secrets/credentials.js';
import {SecretError} from './secrets/crypto.js';
import type {Store} from './store/store.js';
import {tell,type Touches} from './touches.js';
import {realClock,type Clock} from './events.js';

type Job={generation:number;next:number|null;last:number|null;retryAt:number;interval:number;failures:number;controller:AbortController|null;request:RefreshRequest|null;requestedAt:number|null};

/** Hub authority has one job per source and never claims a device's duty. */
export class HubSources {
  private readonly jobs=new Map<string,Job>();
  private running=false;
  private active=0;
  private readonly activeSources=new Set<string>();
  private cancelTimer:(()=>void)|null=null;
  private observer:Touches|null=null;
  constructor(private readonly store:Store,private readonly credentials:Credentials,private readonly clock:Clock=realClock) {
    credentials.onChange=source=>this.changed(source);
  }
  setObserver(observer:Touches){this.observer=observer;}
  start(){if(this.running)return;this.running=true;this.credentials.reconcile();for(const source of this.credentials.sources())this.changed(source);}
  stop(){this.running=false;this.cancelTimer?.();this.cancelTimer=null;for(const job of this.jobs.values()){job.generation++;job.controller?.abort();}this.jobs.clear();}
  private changed(source:string) {
    if(!this.running)return;
    const old=this.jobs.get(source);old?.controller?.abort();if(old)old.generation++;
    if(!this.credentials.sources().includes(source)){this.jobs.delete(source);this.arm();return;}
    if(providerOf(this.store.state(source).provider)?.measuredBy!=='hub')return;
    const now=this.clock.now();
    const retryAt=Math.max(old?.retryAt??0,this.credentials.retryNotBefore(source));
    this.jobs.set(source,{generation:(old?.generation??0)+1,next:Math.max(now,(old?.last??-Infinity)+60_000,retryAt),last:old?.last??null,retryAt,interval:120_000,failures:0,controller:null,request:null,requestedAt:old?.requestedAt??null});
    this.arm();this.touch(source);
  }
  private touch(source:string){tell(this.observer,o=>o.touchSources([source]));}
  private arm() {
    this.cancelTimer?.();this.cancelTimer=null;if(!this.running||this.active>=2)return;
    const next=Math.min(...[...this.jobs].filter(([s,j])=>!this.activeSources.has(s)&&!j.controller&&j.next!==null).map(([,j])=>j.next!));
    if(!Number.isFinite(next))return;
    this.cancelTimer=this.clock.after(Math.min(2_147_483_647,Math.max(0,next-this.clock.now())),()=>{this.cancelTimer=null;this.pump();});
  }
  private pump() {
    if(!this.running)return;
    const now=this.clock.now();
    for(const [source,job] of this.jobs)if(this.active<2&&!this.activeSources.has(source)&&!job.controller&&job.next!==null&&job.next<=now)void this.run(source,job);
    this.arm();
  }
  private async run(source:string,job:Job) {
    const generation=job.generation,controller=job.controller=new AbortController();this.active++;this.activeSources.add(source);
    const at=this.clock.now();job.last=at;
    if(job.request){job.request.status='waiting';job.request.dispatchAt=at;}
    this.touch(source);
    const valid=()=>this.running&&this.jobs.get(source)===job&&job.generation===generation&&!controller.signal.aborted;
    const before=this.store.state(source).reportDigest??JSON.stringify(this.store.state(source).meters?.map(m=>[m.id,m.amount,m.limit,m.resetAt]));
    try {
      // The connector bounds its round and may retain successful account data when
      // inventory runs out of time. This signal cancels the source lifecycle only.
      const result=await this.credentials.measure(source,controller.signal,valid,result=>{
        const after=result.measurement?.reportDigest??JSON.stringify(result.measurement?.meters.map(m=>[m.id,m.amount,m.limit,m.resetAt]));
        return this.store.measureInterval(source)??(before===after?Math.min(job.interval*2,900_000):120_000);
      });
      if(!valid())return;if(!result)throw new SecretError('connector_timeout');
      const after=result.measurement?.reportDigest??JSON.stringify(result.measurement?.meters.map(m=>[m.id,m.amount,m.limit,m.resetAt]));
      const transient=result.attempt?.outcome==='transient';
      job.failures=transient?job.failures+1:0;job.interval=this.store.measureInterval(source)??(before===after?Math.min(job.interval*2,900_000):120_000);
      // Freshness belongs to the accepted observation; it is never extended after failure.
      job.retryAt=Math.max(job.retryAt,this.credentials.retryNotBefore(source),this.clock.now()+(result.retryAfterMs??0));
      job.next=Math.max(this.clock.now()+(transient?Math.min(120_000*2**Math.min(job.failures-1,3),900_000):job.interval),job.retryAt);
      if(job.request){job.request.status=transient?'failed':result.measurement?.reports?.status==='partial'?'updated_partially':'updated';job.request.finishedAt=this.clock.now();}
    }catch(error){
      if(!valid())return;
      const code=error instanceof SecretError?error.code:'credential_failed';
      this.store.fail(source,code);
      job.retryAt=Math.max(job.retryAt,this.credentials.retryNotBefore(source),this.clock.now()+(error instanceof ConnectorStatus?error.retryAfterMs??0:0));
      job.failures++;job.next=permanentAccess(code)?null:Math.max(this.clock.now()+Math.min(120_000*2**Math.min(job.failures-1,3),900_000),job.retryAt);
      if(job.request){job.request.status='failed';job.request.finishedAt=this.clock.now();}
    }finally{
      this.active--;this.activeSources.delete(source);if(job.controller===controller)job.controller=null;
      if(valid())this.touch(source);this.arm();
    }
  }
  cadence(source:string):{value:{by:'hub';next:number;why:'fixed'|'idle'|'changed'}|null;changesAt:number|null} {
    const job=this.jobs.get(source);
    return {value:job?.next===null||!job?null:{by:'hub',next:job.next,why:this.store.measureInterval(source)!==null?'fixed':job.interval===120_000?'changed':'idle'},changesAt:null};
  }
  refresh(source:string,now:number):{value:Refresh;changesAt:number|null} {
    const job=this.jobs.get(source),availableAt=Math.max(job?.retryAt??0,job?.requestedAt===null||job?.requestedAt===undefined?0:job.requestedAt+60_000);
    const request=job?.request&&job.request.finishedAt!==null&&now>=job.request.finishedAt+60_000?null:job?.request??null;
    const available=!!job&&this.credentials.refreshable(source,now);
    const ends=[available&&availableAt>now?availableAt:Infinity,request?.finishedAt!==null&&request?.finishedAt!==undefined?request.finishedAt+60_000:Infinity];
    return {value:{by:'hub',unavailable:available?null:'no_access',availableAt:available?availableAt:null,retryAt:available&&availableAt>now?availableAt:null,request},changesAt:Math.min(...ends)===Infinity?null:Math.min(...ends)};
  }
  requestRefresh(source:string,now:number):{status:'accepted'|'too_soon'|'unavailable';retryAt:number|null} {
    const job=this.jobs.get(source);if(!job||!this.credentials.refreshable(source,now))return {status:'unavailable',retryAt:null};
    if(job.request&&job.request.finishedAt===null)return {status:'accepted',retryAt:null};
    if(now<job.retryAt)return {status:'too_soon',retryAt:job.retryAt};
    if(job.controller){
      job.requestedAt=now;job.request={requestedAt:now,notBefore:job.last??now,dispatchAt:job.last,deadline:now+300_000,status:'waiting',finishedAt:null};
      this.touch(source);return {status:'accepted',retryAt:null};
    }
    if(job.requestedAt!==null&&now<job.requestedAt+60_000)return {status:'too_soon',retryAt:job.requestedAt+60_000};
    job.requestedAt=now;job.next=Math.max(now,(job.last??-Infinity)+60_000);
    job.request={requestedAt:now,notBefore:job.next,dispatchAt:null,deadline:job.next+300_000,status:'queued',finishedAt:null};
    this.touch(source);this.arm();return {status:'accepted',retryAt:null};
  }
  frequencyChanged(source:string,now:number) {
    this.touch(source);
    const job=this.jobs.get(source);if(!job||job.controller)return;
    const fixed=this.store.measureInterval(source);
    if(job.next!==null)job.next=Math.max(now,(this.store.state(source).successAt??now)+(fixed??job.interval),(job.last??-Infinity)+60_000,job.retryAt);
    this.arm();
  }
}
