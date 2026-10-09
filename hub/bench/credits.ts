import type {Card} from '../demo/model.js';
import {stillSnapshot} from './still.js';
import {cellStart} from '../server/domain/history.js';

/** A held balance adds a drawing anchor at each cell after its observation. */
export function creditChartAnchors(observedAt:number,sentAt:number,drawnAt:number,cellMs:number):number[] {
  const anchors=[Math.max(observedAt,cellStart(sentAt,cellMs))];
  for(let at=cellStart(sentAt,cellMs)+cellMs;at<=drawnAt;at+=cellMs)anchors.push(at);
  return anchors;
}

/** An older quota sample can carry a newer independent credit observation. */
export function creditSnapshot(card:Card,start:number,observedAt:number,amount:string) {
  const {resets,...quota}=stillSnapshot(card,start,observedAt);
  return {...quota,balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount}]};
}
