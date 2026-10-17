import {moneyWorkRate,type MoneyWork} from '../../server/domain/moneyWork';
import {convertDerivedBy} from '../../server/domain/currency';
import {currencySymbol, type CurrencyContext} from '../../server/domain/currency';
import type {MoneyFamily} from '../../server/domain/providers';
import {t} from '../i18n';
import {capName, unitLabel} from './money';
import {moneyTotal, type MeterHistory} from './moneyView';
import {nextTableSort, visibleTableSort, type TableSort} from './table';

export const MONEY_COLUMNS = ['value','topup','active','rate','remaining'] as const;
export type MoneyColumn = typeof MONEY_COLUMNS[number];
export const moneyBalanceSeries=(series:MeterHistory)=>
  series.kind==='balance'&&(!series.role||series.role==='total') || series.kind==='cap';
export type MoneySort = TableSort<MoneyColumn | 'name'>;
export const nextMoneySort = nextTableSort<MoneyColumn | 'name'>;

export function readMoneySort(value: unknown): MoneySort {
  if (!value || typeof value !== 'object') return null;
  const sort = value as Record<string, unknown>;
  const column = sort.column === 'limit' ? 'name' : sort.column;
  return ['name', ...MONEY_COLUMNS].includes(column as string) && typeof sort.descending === 'boolean'
    ? {column: column as NonNullable<MoneySort>['column'], descending: sort.descending} : null;
}

export const visibleMoneySort = (sort: MoneySort, columns: readonly MoneyColumn[]): MoneySort =>
  visibleTableSort(sort, ['name', ...columns]);

/** The account name already identifies its total; only distinct scopes need a suffix. */
export function moneySeriesName(series: MeterHistory, title: string, _context: CurrencyContext, family: MoneyFamily = 'budget') {
  if (family === 'funds' || series.role === 'total' || !series.role && series.meterId === 'balance') return title;
  if (series.role) return [title, t(`money.${series.role}`)].join(' — ');
  const detail = series.kind === 'cap' ? capName({id: series.meterId, scope: series.semantics?.scope ?? null, label: series.semantics?.label ?? null}) : series.semantics?.label ?? series.meterId;
  return [title, detail].filter(Boolean).join(' — ');
}

/** Currency provenance stays reachable without lengthening every name. */
export function moneySeriesDetail(series: MeterHistory, context: CurrencyContext) {
  const conversion = series.semantics?.conversion;
  return [series.role ? t(`money.${series.role}`) : null, series.semantics?.label,
    conversion ? `≈ ${unitLabel(conversion.original.unit)} → ${currencySymbol(series.unit, context)} (${conversion.rate.source === 'manual' ? t('money.personalRate') : conversion.rate.source === 'codex-default' ? t('money.defaultEstimate') : conversion.rate.source.toUpperCase()})` : null,
  ].filter((part, i, parts) => part && parts.indexOf(part) === i).join('\n');
}

/** Sort and cells read the same exact millionths and accounting capabilities. */
export function moneyTableValues(series: MeterHistory, from: number, to: number,work?:MoneyWork): Record<MoneyColumn, string | null> {
  return {...moneyWorkValues(series,work),value: series.end,
    topup: series.kind !== 'balance' || series.topup === null ? null : moneyTotal(series, from, to, true).amount};
}

/** Estimates use the native end balance and its recorded display conversion. */
export function moneyWorkValues(series:MeterHistory,work?:MoneyWork):Record<'active'|'rate'|'remaining',string|null> {
  if(!work||series.kind!=='balance'||series.role&&series.role!=='total')return {active:null,rate:null,remaining:null};
  const conversion=series.semantics?.conversion;
  const original=series.end===null?null:series.unit===work.unit?series.end:conversion?.original.unit===work.unit?conversion.original.amount:null;
  const estimate=moneyWorkRate(work,original,series.end===null);
  const rate=estimate.rate===null?null:series.unit===work.unit?estimate.rate:conversion?.original.unit===work.unit?convertDerivedBy(BigInt(estimate.rate),conversion.steps??[conversion.rate]):null;
  return {active:String(work.activeMs),rate,remaining:estimate.remainingMs};
}

export function moneyComparator(sort: NonNullable<MoneySort>, locale: string) {
  const collator = new Intl.Collator(locale, {numeric: true, sensitivity: 'base'});
  return (a: {key: string; name: string; values: Record<MoneyColumn, string | null>}, b: typeof a) => {
    const names = collator.compare(a.name, b.name) || a.key.localeCompare(b.key);
    if (sort.column === 'name') return (sort.descending ? -1 : 1) * collator.compare(a.name, b.name) || a.key.localeCompare(b.key);
    const av = a.values[sort.column], bv = b.values[sort.column];
    if (av === null || bv === null) return av === bv ? names : av === null ? 1 : -1;
    const delta = BigInt(av) - BigInt(bv);
    return delta === 0n ? names : (delta < 0n ? -1 : 1) * (sort.descending ? -1 : 1);
  };
}
