import type {Cdp} from './cdp.js';

/** Native input keeps its injection time and continues independently of renderer ACKs. */
export async function nativeScroll(cdp:Pick<Cdp,'send'>,point:{x:number;y:number},distance:number,reverse:number,pace:(ms:number)=>Promise<unknown>,now=Date.now) {
  const sent:Promise<unknown>[]=[];let failure:unknown;
  for(const leg of [distance,-Math.sign(distance)*Math.abs(reverse)]) {
    let remaining=Math.abs(leg);
    while(remaining>0&&!failure) {
      const pixels=Math.min(remaining,720*.016);remaining-=pixels;
      sent.push(cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:-Math.sign(leg)*pixels,deltaY:0,timestamp:now()/1000}).catch(error=>{failure??=error;}));
      await pace(16);
    }
  }
  await Promise.all(sent);
  if(failure)throw failure;
}
