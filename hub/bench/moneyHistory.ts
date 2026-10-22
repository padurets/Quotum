/** A live counter balance can carry the same observation into a later valid cell. */
export function moneyHistoryReady(last:string|null|undefined,expected:string,observedAt:number,cell:number,now=Date.now()):boolean {
  if(!last)return false;
  const split=last.indexOf(':');
  if(split<1||last.slice(split+1)!==expected)return false;
  const at=Number(last.slice(0,split));
  return Number.isSafeInteger(at)&&at>=Math.floor(observedAt/cell)*cell&&at<=Math.floor(now/cell)*cell;
}
