import type {Card} from '../demo/model.js';
import {stillSnapshot} from './still.js';
import {cellStart} from '../server/domain/history.js';

/** An observed balance continues at the grid edge when its sample precedes this cell. */
export function creditChartMarks(observedAt:number,now:number,cell:number,value:string):string[] {
  return [...new Set([observedAt,Math.max(observedAt,cellStart(now,cell))])].map(at=>at+':'+value);
}

/** An older quota sample can carry a newer independent credit observation. */
export function creditSnapshot(card:Card,start:number,observedAt:number,amount:string) {
  const {resets,...quota}=stillSnapshot(card,start,observedAt);
  return {...quota,balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount}]};
}
