import {randomUUID} from 'node:crypto';
import {Cdp} from './cdp.js';

type Metrics=Record<string,number>;
type Receipt={title:string;metrics:{name:string;value:number}[]};
const values=(receipt:Receipt)=>Object.fromEntries(receipt.metrics.map(row=>[row.name,row.value])) as Metrics;

/** A second counter observes the same target without changing the required elapsed counter. */
export class ScriptClock {
  private aux:Cdp|undefined;
  private readonly title=`quotum-script-clock-${randomUUID()}`;
  private readonly wall=new Map<string,Metrics>();
  private readonly thread=new Map<string,Metrics>();
  private invalid=0;
  private navigations=0;
  private failed=false;
  private ready:(()=>void)|undefined;
  private readonly navigate=()=>{this.navigations++;};
  private readonly wallReceipt=(receipt:Receipt)=>this.receive(this.wall,receipt);
  private readonly threadReceipt=(receipt:Receipt)=>this.receive(this.thread,receipt);
  private constructor(private readonly primary:Cdp){}

  static async open(primary:Cdp,connect=Cdp.connect){
    const clock=new ScriptClock(primary);
    try{
      const signal=AbortSignal.timeout(1000);
      if(!primary.endpoint)throw Error('Missing target');
      clock.aux=await connect(primary.endpoint,signal);
      primary.on('Page.frameNavigated',clock.navigate);
      primary.on('Performance.metrics',clock.wallReceipt);
      clock.aux.on('Performance.metrics',clock.threadReceipt);
      await clock.aux.send('Performance.enable',{timeDomain:'threadTicks'},signal);
      await clock.mark('before',signal);
    }catch{clock.failed=true;await clock.close();}
    return clock;
  }
  private receive(into:Map<string,Metrics>,receipt:Receipt){
    if(receipt.title!==`${this.title}-before`&&receipt.title!==`${this.title}-after`)return;
    const row=values(receipt);
    if(into.has(receipt.title)||![row.Timestamp,row.ScriptDuration].every(value=>Number.isFinite(value)&&value>=0))this.invalid++;
    else into.set(receipt.title,row);
    this.ready?.();
  }
  private async mark(stage:'before'|'after',signal:AbortSignal){
    const title=`${this.title}-${stage}`;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const received=new Promise<void>((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error('Missing counter receipt')),1000);
      this.ready=()=>{if(this.wall.has(title)&&this.thread.has(title))resolve();};
    });
    try{
      // A fresh task with no layout gives a settled counter plus only this small callback.
      await Promise.all([received,this.aux!.evaluate(`new Promise(resolve=>setTimeout(()=>{console.timeStamp(${JSON.stringify(title)});resolve(null);},0))`,signal)]);
    }finally{clearTimeout(timer);this.ready=undefined;}
  }
  async after(before:Metrics,after:Metrics){
    if(!this.failed)try{await this.mark('after',AbortSignal.timeout(1000));}catch{this.failed=true;}
    await this.close();
    const wall=[this.wall.get(`${this.title}-before`),this.wall.get(`${this.title}-after`)],thread=[this.thread.get(`${this.title}-before`),this.thread.get(`${this.title}-after`)];
    const rows=[...wall,...thread,before,after];
    const complete=!this.failed&&!this.invalid&&!this.navigations&&rows.every(row=>row&&[row.Timestamp,row.ScriptDuration].every(value=>Number.isFinite(value)&&value>=0))
      &&wall[0]!.Timestamp<=before.Timestamp&&thread[0]!.Timestamp<=before.Timestamp&&after.Timestamp<=wall[1]!.Timestamp&&after.Timestamp<=thread[1]!.Timestamp
      &&before.Timestamp<=after.Timestamp&&before.ScriptDuration<=after.ScriptDuration&&wall[0]!.ScriptDuration<=wall[1]!.ScriptDuration&&thread[0]!.ScriptDuration<=thread[1]!.ScriptDuration;
    return {kind:'Gross Inspector script counters between outer timer tasks; observer overhead and clock resolution remain unqualified. No product CPU subtraction or budget verdict.',status:complete?'observed':'insufficient-evidence',invalid:this.invalid,navigations:this.navigations,wall,thread,
      ...(complete?{elapsedScriptMs:1000*(after.ScriptDuration-before.ScriptDuration),outerElapsedScriptMs:1000*(wall[1]!.ScriptDuration-wall[0]!.ScriptDuration),outerThreadScriptMs:1000*(thread[1]!.ScriptDuration-thread[0]!.ScriptDuration)}:{})};
  }
  async close(){
    this.primary.off('Page.frameNavigated',this.navigate);
    this.primary.off('Performance.metrics',this.wallReceipt);
    const aux=this.aux;this.aux=undefined;
    aux?.off('Performance.metrics',this.threadReceipt);
    if(aux)try{await aux.send('Performance.disable',{},AbortSignal.timeout(1000));}catch{this.failed=true;}finally{aux.close();}
  }
}
