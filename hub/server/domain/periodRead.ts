import type {HistoryReply} from './history.js';
import type {PeriodBasis, PeriodSection, PeriodSelection} from './period.js';
import type {PeriodValues} from './periodValues.js';
import type {WorkTrace, WorkDelta} from './periodWork.js';

export const PERIOD_SCOPES = ['quota','budget','funds'] as const;
export type PeriodScope = typeof PERIOD_SCOPES[number];

export type HistoryQuery = {cell?:string;from?:string;to?:string;meters?:string;unit?:string;currency?:string;meta?:string;scope?:string;evidence?:string;cells?:string};
export type PeriodRequest = {
  version:1;selection:PeriodSelection;evaluatedAt:number;
  quota?:HistoryQuery;budget?:HistoryQuery;funds?:HistoryQuery;
  values?:string[];sessions?:{cursor?:string};
};
export type PeriodReply = {
  basis:PeriodBasis;
  quota?:PeriodSection<HistoryReply>;budget?:PeriodSection<HistoryReply>;funds?:PeriodSection<HistoryReply>;
  values?:PeriodSection<PeriodValues[]>;
  sessions?:PeriodSection<WorkTrace & {cursor:string}> | {state:'delta';basis:PeriodBasis;value:WorkDelta & {cursor:string}};
};
