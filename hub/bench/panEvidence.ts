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


/** A failed scenario must retain its own probe rather than an earlier completed one. */
export function panPartialScript(initiator?: string, period?: string): string {
  return `(() => {
    const p=window.__quotumPan;
    if(!p||p.initiator!==${JSON.stringify(initiator??null)}||p.period!==${JSON.stringify(period??null)}||!p.running)return {status:'unavailable'};
    const outliers=p.samples.filter(sample=>sample.ms>50);
    return {status:'partial',inputs:p.inputs,updated:p.updated,frames:p.frames,latency:p.latency,
      responses:p.responses,transactions:p.readTransactions(),outliers:outliers.slice(0,64),outliersOmitted:Math.max(0,outliers.length-64),
      pushesDuring:p.pushesDuring,forbiddenMutations:p.forbiddenMutations,
      pending:p.pending.map(input=>({inputId:input.id,stamp:input.at,delivered:input.delivered,pixels:input.pixels}))};
  })()`;
}
