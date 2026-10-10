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
