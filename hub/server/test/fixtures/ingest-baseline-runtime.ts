// Runtime dependencies used by the frozen ingest parser from 072af2b.
const catalogue = [
  {id: 'claude', measuredBy: 'client'},
  {id: 'codex', measuredBy: 'client'},
  {id: 'antigravity', measuredBy: 'client'},
  {id: 'openrouter', measuredBy: 'hub'},
  {id: 'deepseek', measuredBy: 'hub'},
  {id: 'zai', measuredBy: 'hub'},
] as const;
export type Provider = (typeof catalogue)[number]['id'];
export type ClientProvider = Extract<(typeof catalogue)[number], {measuredBy: 'client'}>['id'];
export const providers = catalogue.map(provider => provider.id);
export const providerOf = (id: string) => catalogue.find(provider => provider.id === id);

const AMOUNT_MAX = (1n << 63n) - 1n;
type Scalar = {amount: string; scale: number};
const amountScale = (scale = 6): number => {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) throw new Error('invalid_scale');
  return scale;
};
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

function amount(value: string): bigint {
  if (value.length > 20 || !INTEGER.test(value) || value === '-0') throw new Error('invalid_amount');
  const result = BigInt(value);
  if (result < -AMOUNT_MAX || result > AMOUNT_MAX) throw new Error('amount_overflow');
  return result;
}

export function exactDecimal(value: string): Scalar {
  if (value.length > 128 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error('invalid_amount');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const decimals = fraction.replace(/0+$/, '');
  const scale = amountScale(decimals.length);
  const coefficient = BigInt(whole + decimals) * (negative ? -1n : 1n);
  const normalized = amount(coefficient.toString()).toString();
  return {amount: normalized, scale: normalized === '0' ? 0 : scale};
}

export function scalarDecimal(value: {amount: string; scale?: number}): string {
  const coefficient = amount(value.amount), scale = amountScale(value.scale);
  const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  return (coefficient < 0n ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
