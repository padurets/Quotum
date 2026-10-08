import {snapshot, type Card} from '../demo/model.js';

/** An older quota sample can carry a newer independent credit observation. */
export function creditSnapshot(card:Card,start:number,observedAt:number,amount:string) {
  const {resets,...quota}=snapshot(card,start,observedAt-start,3*3_600_000);
  return {...quota,balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount}]};
}
