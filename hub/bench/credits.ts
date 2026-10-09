import type {Card} from '../demo/model.js';
import {stillSnapshot} from './still.js';

/** An older quota sample can carry a newer independent credit observation. */
export function creditSnapshot(card:Card,start:number,observedAt:number,amount:string) {
  const {resets,...quota}=stillSnapshot(card,start,observedAt);
  return {...quota,balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount}]};
}
