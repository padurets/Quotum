import type {MeterHistory} from '../../server/domain/meterHistory';
export type {MeterHistory};
export const moneyIdentity=(series:MeterHistory)=>JSON.stringify([series.sourceId,series.meterId,series.kind,series.unit]);
