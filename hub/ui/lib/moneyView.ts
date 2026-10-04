import type {MeterHistory} from '../../server/domain/meterHistory';
export type {MeterHistory};
export const moneyIdentity=(series:MeterHistory)=>JSON.stringify([series.sourceId,series.meterId,series.kind,series.unit]);

/** A known subtotal cannot stand in for an unobserved part of the requested interval. */
export function moneyTotal(series:MeterHistory,from:number,to:number,topup=false) {
  const unknown=series.coveredMs===0;
  return {amount:unknown?null:topup?series.topup:series.spent,unknown,
    partial:unknown||series.coveredMs<to-from||(topup?series.topupUnlocated:series.unlocated).length>0};
}
