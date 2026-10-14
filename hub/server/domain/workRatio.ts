/** Durations stay integer facts for ordering; division is only for display. */
export function compareWorkRatio(a:number,ae:number,b:number,be:number) {
  const left=BigInt(ae?a:0)*BigInt(be||1),right=BigInt(be?b:0)*BigInt(ae||1);
  return left<right?-1:left>right?1:0;
}

const sign=(value:bigint)=>value<0n?-1:value>0n?1:0;
const floorDiv=(a:bigint,b:bigint)=>{if(b<0n){a=-a;b=-b;}const q=a/b;return a%b<0n?q-1n:q;};

/** Search each monotone integer piece, including equality before strict inversion. */
export function firstPolynomialChange(c0:bigint,c1:bigint,c2:bigint,limit:number,before:number):number|null {
  if(!Number.isFinite(limit)||limit<1||!c1&&!c2)return null;
  const end=BigInt(Math.floor(limit)),value=(t:bigint)=>sign(c0+c1*t+c2*t*t);
  const split=c2?floorDiv(-c1,2n*c2):0n;
  const points=[1n,...(c2?[split,split+1n].filter(t=>t>1n&&t<end):[]),end].sort((a,b)=>a<b?-1:a>b?1:0);
  for(let i=0;i<points.length;i++){
    let lo=points[i],hi=points[i+1]??lo;
    if(value(lo)!==before)return Number(lo);
    if(value(hi)===before)continue;
    while(lo+1n<hi){const middle=(lo+hi)/2n;if(value(middle)===before)lo=middle;else hi=middle;}
    return Number(hi);
  }
  return null;
}
