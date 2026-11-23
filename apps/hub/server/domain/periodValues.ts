import {ValueChanges, applyValueChanges, type ValuePath, type ValueChange} from './valueChanges.js';
import {observationDeadline, type CreditBalanceState, type ObservationTiming} from './resources.js';
import type {Win} from './quota.js';
import {keyPresenceAt, type KeyPart, type Meter} from './meters.js';
import {drain, type Preparation} from './prepare.js';

export type WindowValue = Win & {observedAt: number; validUntil: number; stale: boolean};
/** Measurements only. Operational status, account names and actions come from the live board. */
export type PeriodValues = {
  id: string;
  provider: string;
  windows: WindowValue[];
  meters: Meter[];
  keys: (KeyPart & ObservationTiming)[];
  creditBalance?: CreditBalanceState;
  validFor?: {from: number; to: number};
  states?: {
    start?: Omit<PeriodValues, 'states'>;
    paths: ValuePath[];
    pieces: [number, number, ValueChange[]][];
  };
  currencyUnavailable?: boolean;
};

const contains = (range: PeriodValues['validFor'], to: number) =>
  !!range && range.from <= to && to < range.to;

/** Availability lookup does not allocate a replay while the LRU is finding a candidate. */
export function hasPeriodValue(value: PeriodValues | null | undefined, to: number): boolean {
  return (
    !!value &&
    (contains(value.validFor, to) ||
      contains(value.states?.start?.validFor, to) ||
      !!value.states?.pieces.some(([from, until]) => from <= to && to < until))
  );
}
export function periodValueAt(
  value: PeriodValues | null | undefined,
  to: number,
  reserve?: (bytes: number) => void,
): PeriodValues | undefined {
  if (!value || !hasPeriodValue(value, to)) return;
  if (contains(value.validFor, to)) return value;
  const {states: sequence, ...base} = value,
    start = sequence!.start ?? base,
    states = sequence!.start ? sequence! : {...sequence!, start};
  if (contains(start.validFor, to)) return {...start, states};
  if (reserve) reserve(JSON.stringify(start).length * 3 + 48);
  const copy = structuredClone(start);
  for (const [from, until, changes] of states.pieces) {
    if (reserve && changes.length) {
      // The preceding piece may have discarded a large array. Only this native
      // snapshot and the payload that this piece can add are needed together.
      let growth = 0;
      for (const change of changes) {
        if (change.length === 4) growth += JSON.stringify(change[3]).length;
        else if (change.length === 3) growth += String(change[1]).length + 1;
        else if (change.length === 2)
          growth +=
            JSON.stringify(change[1]).length +
            JSON.stringify(states.paths[change[0]].at(-1)).length +
            2;
      }
      reserve((JSON.stringify(copy).length + growth) * 3 + 48);
    }
    applyValueChanges(copy, states.paths, changes);
    if (from <= to && to < until) return {...copy, states};
  }
}

/** Every actual state remains recoverable; only repeated fields are omitted. */
export function withValueStates(
  base: PeriodValues,
  values: Iterable<PeriodValues>,
  reserve: (bytes: number) => void,
): PeriodValues {
  return drain(prepareValueStates(base, values, reserve));
}
export function* prepareValueStates(
  base: PeriodValues,
  values: Iterable<PeriodValues>,
  reserve: (bytes: number) => void,
): Preparation<PeriodValues> {
  const changes = new ValueChanges(reserve);
  let states: PeriodValues['states'],
    previous: PeriodValues = base;
  for (const value of values) {
    if (!states) {
      reserve(128);
      states = {paths: changes.paths, pieces: []};
    }
    const patch = changes.between(previous, value);
    reserve(JSON.stringify(patch).length * 3 + 64);
    states.pieces.push([value.validFor!.from, value.validFor!.to, patch]);
    previous = value;
    yield;
  }
  return states ? {...base, states} : base;
}

function updateItems<T>(items: T[], update: (item: T) => T): T[] {
  let result = items;
  for (let i = 0; i < items.length; i++) {
    const item = update(items[i]);
    if (item === items[i]) continue;
    if (result === items) result = items.slice();
    result[i] = item;
  }
  return result;
}

/** A captured value can expire with the shared clock without admitting a future observation. */
export function periodValueNow(
  value: PeriodValues,
  at: number,
  reserve?: (bytes: number) => void,
): PeriodValues {
  const known = periodValueAt(value, at, reserve) ?? value,
    // A patched replay owns its mutable snapshot. Returning to the start shares it.
    copied = known !== value && !contains(known.states?.start?.validFor, at);
  let reserved = !reserve;
  const update = <T, K extends keyof T>(item: T, key: K, next: T[K]): T => {
    if (item[key] === next) return item;
    if (!reserved) {
      reserved = true;
      // A reversed clock can spell each status one character longer.
      reserve!(
        (JSON.stringify({...known, states: undefined}).length +
          known.windows.length +
          known.keys.length +
          known.meters.length) *
          3 +
          48,
      );
    }
    if (copied) {
      item[key] = next;
      return item;
    }
    return {...item, [key]: next};
  };
  const windows = updateItems(known.windows, w => update(w, 'stale', at >= w.validUntil)),
    meters = updateItems(known.meters, m => update(m, 'stale', at >= observationDeadline(m))),
    keys = updateItems(known.keys, k => update(k, 'presence', keyPresenceAt(k, at)));
  return windows === known.windows && meters === known.meters && keys === known.keys
    ? known
    : {...known, windows, meters, keys};
}
export function periodValueChangesAt(value: PeriodValues, now: number): number | null {
  const next = Math.min(
    ...[
      ...value.windows.map(w => w.validUntil),
      ...value.meters.map(observationDeadline),
      ...value.keys.map(observationDeadline),
      ...(value.states?.pieces.flatMap(([from, to]) => [from, to]) ?? []),
    ].filter(at => at > now),
  );
  return next > now && Number.isFinite(next) ? next : null;
}
