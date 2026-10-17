/** Numeric original-interval evidence; no layout reads, console work or payload strings. */
export function panEvidenceScript(enabled: boolean, limit = 10_000): string {
  return `(() => {
    if(!${enabled})return null;
    const limit=${limit},entries=new Array(limit);let count=0;
    return {
      add(kind,values){const id=++count;entries[(id-1)%limit]={id,at:performance.now(),kind,...values};},
      read(){const size=Math.min(count,limit),start=count>limit?count%limit:0;
        return {status:count>limit?'insufficient-evidence':'complete',count,omitted:Math.max(0,count-limit),entries:Array.from({length:size},(_,i)=>entries[(start+i)%limit])};}
    };
  })()`;
}

export type PanTransactions = {
  status: string; wheelEvents: number; invalidClocks: number; stampRegressions: number;
  maxStampGap: number | null; maxDeliveryGap: number | null; pushesDuring: number; omitted: number;
  writes: {at: number; segment: string; token: number | null; stamp: number | null; delivered: number | null; stampGap: number | null; deliveryGap: number | null; idleMs: number | null}[];
};

/** A native scroll command can stop producing input while its target is blocked. */
export function panTransactionsScript(limit = 32): string {
  return `(() => {
    const writes=[],limit=${limit};let wheelEvents=0,invalidClocks=0,stampRegressions=0,pushesDuring=0;
    let stamp=null,delivered=null,segment=null,stampGap=null,deliveryGap=null,maxStampGap=null,maxDeliveryGap=null;
    return {
      input(at,received,part){
        wheelEvents++;
        if(!Number.isFinite(at)||!Number.isFinite(received)){invalidClocks++;stamp=delivered=segment=stampGap=deliveryGap=null;return;}
        stampGap=segment===part?at-stamp:null;deliveryGap=segment===part?received-delivered:null;
        if(stampGap!==null){if(stampGap<0)stampRegressions++;maxStampGap=maxStampGap===null?stampGap:Math.max(maxStampGap,stampGap);maxDeliveryGap=maxDeliveryGap===null?deliveryGap:Math.max(maxDeliveryGap,deliveryGap);}
        stamp=at;delivered=received;segment=part;
      },
      push(part,token){
        pushesDuring++;
        if(writes.length>=limit)return;
        const at=performance.now();writes.push({at,segment:part,token:Number.isFinite(token)?token:null,stamp,delivered,stampGap,deliveryGap,idleMs:delivered===null?null:at-delivered});
      },
      read(){return {status:pushesDuring>limit||invalidClocks?'insufficient-evidence':'complete',wheelEvents,invalidClocks,stampRegressions,maxStampGap,maxDeliveryGap,pushesDuring,omitted:Math.max(0,pushesDuring-limit),writes};}
    };
  })()`;
}


/** Fault listeners outlive the motion sampler, through the same family's native postconditions. */
export function panErrorsScript(): string {
  return `(() => {
    let active=true,count=0,omitted=0,invalid=0,ended=null;
    const from=performance.now(),events=[],valid=at=>Number.isFinite(at)&&at>=from;
    const record=(kind,event)=>{
      if(!active)return;
      count++;if(events.length>=16){omitted++;return;}
      try{
        const at=performance.now();if(!valid(at)||events.length&&at<events.at(-1).at){invalid++;return;}
        const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
        let line=null,column=null,publicAsset=null;
        if(kind==='error'){
          line=integer(event.lineno);column=integer(event.colno);publicAsset=false;
          const filename=event.filename;
          if(typeof filename==='string'&&filename)try{const url=new URL(filename);publicAsset=url.origin===new URL(location.href).origin&&/^\\/assets\\/index-[\\w-]+\\.js$/.test(url.pathname);}catch{}
        }
        events.push({kind,at,line,column,publicAsset,trusted:typeof event?.isTrusted==='boolean'?event.isTrusted:null});
      }catch{invalid++;}
    };
    const error=event=>record('error',event),rejection=event=>record('unhandledrejection',event);
    window.addEventListener('error',error);window.addEventListener('unhandledrejection',rejection);
    const read=()=>{const to=active?performance.now():ended,ordered=valid(to)&&to>=(events.at(-1)?.at??from);return {status:invalid||omitted||!valid(from)||!ordered?'insufficient-evidence':active?'recording':'stopped',from:Number.isFinite(from)?from:null,to:valid(to)?to:null,count,omitted,invalid,events:events.map(row=>({...row}))};};
    return {get active(){return active;},read,stop(){
      if(active){active=false;ended=performance.now();window.removeEventListener('error',error);window.removeEventListener('unhandledrejection',rejection);}
      return read();
    }};
  })()`;
}

/** A failed scenario must retain its own probe rather than an earlier completed one. */
export function panPartialScript(initiator?: string, period?: string): string {
  return `(() => {
    const p=window.__quotumPan;
    if(!p||p.initiator!==${JSON.stringify(initiator??null)}||p.period!==${JSON.stringify(period??null)})return {status:'unavailable'};
    const errors=p.errors?.active?p.errors.read():undefined;
    if(!p.running)return errors?{status:'unavailable',errors}:{status:'unavailable'};
    return {status:'partial',errors,inputs:p.inputs,updated:p.updated,frames:p.frames,latency:p.latency,
      responses:p.responses,timeline:p.timeline?.read(),transactions:p.readTransactions(),
      pushesDuring:p.pushesDuring,forbiddenMutations:p.forbiddenMutations,
      pending:p.pending.map(input=>({inputId:input.id,stamp:input.at,delivered:input.delivered,pixels:input.pixels}))};
  })()`;
}
