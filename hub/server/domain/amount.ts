/** All stored amounts are whole millionths, bounded by signed SQLite INTEGER. */
export const AMOUNT_MAX = (1n << 63n) - 1n;
export type Unit = string;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
export const isUnit = (value: unknown): value is Unit => typeof value === 'string' && /^(?:[A-Z]{3}|credits:[a-z][a-z0-9_-]{0,31}|requests)$/.test(value);

export function amount(value: string): bigint {
  if (value.length > 20 || !INTEGER.test(value) || value === '-0') throw new Error('invalid_amount');
  const result = BigInt(value);
  if (result < -AMOUNT_MAX || result > AMOUNT_MAX) throw new Error('amount_overflow');
  return result;
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

/** Aggregate a provider bucket before rounding, so sub-micro lines do not accumulate error. */
export function sumDecimals(values:readonly string[]):bigint {
  const parts=values.map(value=>{
    if(value.length>128)throw new Error('invalid_amount');
    const m=/^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(value);
    if(!m||Math.abs(Number(m[4]??0))>100)throw new Error('invalid_amount');
    return {coefficient:BigInt(m[2]+(m[3]??''))*(m[1]?-1n:1n),scale:(m[3]?.length??0)-Number(m[4]??0)};
  });
  const scale=Math.max(6,...parts.map(p=>p.scale));
  const total=parts.reduce((sum,p)=>sum+p.coefficient*10n**BigInt(scale-p.scale),0n),divisor=10n**BigInt(scale-6),absolute=total<0n?-total:total;
  const rounded=(absolute/divisor+(absolute%divisor*2n>=divisor?1n:0n))*(total<0n?-1n:1n);
  return amount(rounded.toString());
}

/** Totals may exceed one stored amount's range, but never cross units. */
export function addAmounts(values: readonly {unit: Unit; amount: string}[]): {unit: Unit; amount: string} | null {
  if (!values.length) return null;
  const unit = values[0].unit;
  if (!isUnit(unit) || values.some(v => v.unit !== unit)) throw new Error('mixed_units');
  return {unit, amount: values.reduce((sum, v) => sum + amount(v.amount), 0n).toString()};
}
