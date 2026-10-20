import type {HistoryReply} from './history.js';
import type {PeriodBasis, PeriodSection, PeriodSelection} from './period.js';
import type {PeriodValues} from './periodValues.js';
import type {WorkTrace, WorkDelta} from './periodWork.js';
import type {WorkFilter} from './dataFilters.js';

export const PERIOD_SCOPES = ['quota','budget','funds'] as const;
export const PERIOD_BODY_BYTES = 256 * 1024;
export type PeriodScope = typeof PERIOD_SCOPES[number];
export type WorkChoices = {projects:(string|null)[];devices:{id:string;name:string}[];clients:(string|null)[];funding:('unknown'|'notProvided')[]};
export type WorkFacets = WorkChoices & {retained?:WorkChoices};

export type HistoryQuery = {cell?:string;from?:string;to?:string;meters?:string;unit?:string;currency?:string;meta?:string;scope?:string;work?:string;evidence?:string;cells?:string;sources?:string};
export type PeriodRequest = {
  version:1;selection:PeriodSelection;evaluatedAt:number;
  quota?:HistoryQuery;budget?:HistoryQuery;funds?:HistoryQuery;
  values?:string[];sessions?:{cursor?:string};
  workFilter?:WorkFilter;facets?:true;sourceWork?:{cursor?:string};
};
export type PeriodReply = {
  basis:PeriodBasis;
  quota?:PeriodSection<HistoryReply>;budget?:PeriodSection<HistoryReply>;funds?:PeriodSection<HistoryReply>;
  values?:PeriodSection<PeriodValues[]>;
  sessions?:PeriodSection<WorkTrace & {cursor:string}> | {state:'delta';basis:PeriodBasis;value:WorkDelta & {cursor:string}};
  facets?:PeriodSection<WorkFacets>;
  sourceWork?:PeriodSection<import('./periodCurves.js').SourceWorkTape & {cursor:string}>|{state:'delta';basis:PeriodBasis;value:import('./periodCurves.js').SourceWorkTape & {cursor:string}};
};
