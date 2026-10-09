/** Stored coefficients are bounded by signed SQLite INTEGER; money uses scale six. */
export const AMOUNT_MAX = (1n << 63n) - 1n;
export type Scalar = {amount: string; scale: number};
export const amountScale = (scale = 6): number => {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) throw new Error('invalid_scale');
  return scale;
};
export type Unit = string;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
export const isUnit = (value: unknown): value is Unit => typeof value === 'string' && /^(?:[A-Z]{3}|credits:[a-z][a-z0-9_-]{0,31}|requests)$/.test(value);

export function amount(value: string): bigint {
  if (value.length > 20 || !INTEGER.test(value) || value === '-0') throw new Error('invalid_amount');
  const result = BigInt(value);
  if (result < -AMOUNT_MAX || result > AMOUNT_MAX) throw new Error('amount_overflow');
  return result;
}

/** Native decimal observations keep every significant digit, without rounding. */
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

/** Parse the original JSON token once, with nearest rounding and ties away from zero. */
export function decimal(value: string): bigint {
  if (value.length > 128) throw new Error('invalid_amount');
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(value);
  if (!match) throw new Error('invalid_amount');
  const exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 100) throw new Error('invalid_amount');
  const digits = BigInt(match[2] + (match[3] ?? ''));
  const shift = 6 + exponent - (match[3]?.length ?? 0);
  let result: bigint;
  if (shift >= 0) result = digits * 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    result = digits / divisor + (digits % divisor * 2n >= divisor ? 1n : 0n);
  }
  if (match[1]) result = -result;
  if (result < -AMOUNT_MAX || result > AMOUNT_MAX) throw new Error('amount_overflow');
  return result;
}

/** Totals may exceed one stored amount's range, but never cross units. */
export function addAmounts(values: readonly {unit: Unit; amount: string}[]): {unit: Unit; amount: string} | null {
  if (!values.length) return null;
  const unit = values[0].unit;
  if (!isUnit(unit) || values.some(v => v.unit !== unit)) throw new Error('mixed_units');
  return {unit, amount: values.reduce((sum, v) => sum + amount(v.amount), 0n).toString()};
}
