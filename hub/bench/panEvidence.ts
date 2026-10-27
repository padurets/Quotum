export type PanInputPoint={ordinal:number;stamp:number;delivered:number;queued:number;ticks:number};
export type PanGapPair={kind:'capture-wheel';segment:string;previous:PanInputPoint;current:PanInputPoint;stampGap:number;deliveryGap:number};
export type PanTransactions = {
  status: string; wheelEvents: number; invalidClocks: number; stampRegressions: number;
  maxStampGap: number | null; maxDeliveryGap: number | null; pushesDuring: number; omitted: number;
  maxStampPair?:PanGapPair|null;maxDeliveryPair?:PanGapPair|null;
  writes: {at: number; segment: string; token: number | null; stamp: number | null; delivered: number | null; stampGap: number | null; deliveryGap: number | null; idleMs: number | null}[];
};

/** A native scroll command can stop producing input while its target is blocked. */
export function panTransactionsScript(limit = 32, detailed = false): string {
  return `(() => {
    const writes=[],limit=${limit};let wheelEvents=0,invalidClocks=0,stampRegressions=0,pushesDuring=0;
    let stamp=null,delivered=null,segment=null,stampGap=null,deliveryGap=null,maxStampGap=null,maxDeliveryGap=null;
    ${detailed?'let previous=null,maxStampPair=null,maxDeliveryPair=null;':''}
    return {
      input(at,received,part${detailed?',ticks':''}){
        wheelEvents++;
        if(!Number.isFinite(at)||!Number.isFinite(received)${detailed?'||!Number.isSafeInteger(ticks)||ticks<0':''}){invalidClocks++;stamp=delivered=segment=stampGap=deliveryGap=null;${detailed?'previous=null;':''}return;}
        stampGap=segment===part?at-stamp:null;deliveryGap=segment===part?received-delivered:null;
        ${detailed?`const current={ordinal:wheelEvents,stamp:at,delivered:received,queued:received-at,ticks};
        if(stampGap!==null){const pair={kind:'capture-wheel',segment:part,previous,current,stampGap,deliveryGap};if(maxStampGap===null||stampGap>maxStampGap)maxStampPair=pair;if(maxDeliveryGap===null||deliveryGap>maxDeliveryGap)maxDeliveryPair=pair;}
        previous=current;`:''}
        if(stampGap!==null){if(stampGap<0)stampRegressions++;maxStampGap=maxStampGap===null?stampGap:Math.max(maxStampGap,stampGap);maxDeliveryGap=maxDeliveryGap===null?deliveryGap:Math.max(maxDeliveryGap,deliveryGap);}
        stamp=at;delivered=received;segment=part;${detailed?'return wheelEvents;':''}
      },
      push(part,token){
        pushesDuring++;
        if(writes.length>=limit)return;
        const at=performance.now();writes.push({at,segment:part,token:Number.isFinite(token)?token:null,stamp,delivered,stampGap,deliveryGap,idleMs:delivered===null?null:at-delivered});
      },
      read(){return {status:pushesDuring>limit||invalidClocks?'insufficient-evidence':'complete',wheelEvents,invalidClocks,stampRegressions,maxStampGap,maxDeliveryGap,${detailed?'maxStampPair,maxDeliveryPair,':''}pushesDuring,omitted:Math.max(0,pushesDuring-limit),writes};}
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
      ...(p.readSettlements?{settlements:p.readSettlements()}:{}),
      responses:p.responses,transactions:p.readTransactions(),outliers:outliers.slice(0,64),outliersOmitted:Math.max(0,outliers.length-64),
      pushesDuring:p.pushesDuring,forbiddenMutations:p.forbiddenMutations,
      pending:p.pending.map(input=>({inputId:input.id,stamp:input.at,delivered:input.delivered,pixels:input.pixels}))};
  })()`;
}
