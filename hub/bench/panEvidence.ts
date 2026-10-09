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
