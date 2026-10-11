/** A formatted monotone value can change only within a proven linear piece or at its boundary. */
export function periodTextChangesAt(now:number,nextBoundary:(at:number)=>number|null,read:(at:number)=>string):number|null {
  const seen=read(now),horizon=now+3_600_000;
  for(let from=now;from<horizon;){
    const boundary=nextBoundary(from);
    if(boundary===null)return null;
    const to=Math.min(horizon,Math.max(from+1,boundary)),last=to-1;
    if(read(last)!==seen){
      let same=from,other=last;
      while(other-same>1){const middle=Math.floor((same+other)/2);if(read(middle)===seen)same=middle;else other=middle;}
      return other;
    }
    if(read(to)!==seen)return to;
    from=to;
  }
  return horizon;
}
