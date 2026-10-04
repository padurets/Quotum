import type {BodyCount, Transfer} from './historyProxy';
import {CLOCK_TOLERANCE_MS, MAX_READ_TILES, cellStart, tileOf, type HistoryAnswer} from '../server/domain/history';
import assert from 'node:assert/strict';

export class HistoryCutChanged extends Error {}
export function stableHistory(answer: Pick<HistoryAnswer, 'run' | 'now' | 'known'>, seed: Pick<HistoryAnswer, 'run' | 'now' | 'known'>, cell: number) {
  assert.equal(answer.run, seed.run); assert.deepEqual(answer.known, seed.known);
  if (cellStart(answer.now + CLOCK_TOLERANCE_MS, cell) !== cellStart(seed.now + CLOCK_TOLERANCE_MS, cell)) throw new HistoryCutChanged('history crossed its grid cutoff during this cohort');
}

/** A reference union is partitioned only by holes and the existing API tile cap. */
export function readUnion(cells: ReadonlySet<number>, cell: number): [number, number][] {
  const intervals: [number, number][] = [];
  for (const at of [...cells].sort((a, b) => a - b)) {
    const last = intervals.at(-1);
    if (last && last[1] === at && tileOf(at, cell) - tileOf(last[0], cell) < MAX_READ_TILES) last[1] += cell;
    else intervals.push([at, at + cell]);
  }
  return intervals;
}

export function bodyBounds(body: BodyCount, transfer?: Transfer) {
  if (!Number.isFinite(body.lower) || body.lower < 0) throw new Error('invalid encoded body lower bound');
  if (!body.complete) {
    if (transfer && !transfer.sent) {
      if (body.lower !== 0) throw new Error('body arrived before the fixture sent it');
      return {lower: 0, upper: 0, unknown: 0, partial: 1};
    }
    const upper = transfer?.encoded;
    return {lower: body.lower, upper: upper !== undefined && body.lower <= upper ? upper : null, unknown: 1, partial: 1};
  }
  if (!transfer || body.coding !== 'br' || body.length !== transfer.encoded || body.lower !== transfer.encoded || body.decoded !== transfer.decoded) throw new Error('complete history body has no matching Brotli payload proof');
  return {lower: body.lower, upper: body.lower, unknown: 0, partial: 0};
}

export function bodyTotals(reads: {count: BodyCount; transfer?: Transfer}[]) {
  const complete = {count: 0, decoded: 0, encoded: 0};
  const partial = {count: 0, encodedLower: 0, encodedUpper: 0 as number | null};
  let decoded: number | null = 0, encodedLower = 0, encodedUpper: number | null = 0, unknown = 0;
  for (const {count, transfer} of reads) {
    const bounds = bodyBounds(count, transfer);
    encodedLower += bounds.lower; encodedUpper = encodedUpper === null || bounds.upper === null ? null : encodedUpper + bounds.upper; unknown += bounds.unknown;
    const decodedUpper = count.complete ? count.decoded! : bounds.upper === 0 ? 0 : transfer?.decoded ?? null;
    decoded = decoded === null || decodedUpper === null ? null : decoded + decodedUpper;
    if (count.complete) {complete.count++; complete.decoded += count.decoded!; complete.encoded += bounds.lower;}
    else {partial.count++; partial.encodedLower += bounds.lower; partial.encodedUpper = partial.encodedUpper === null || bounds.upper === null ? null : partial.encodedUpper + bounds.upper;}
  }
  return {decoded, encodedLower, encodedUpper, unknown, complete, partial, byteVerdict: unknown ? encodedUpper === null || decoded === null ? 'unverified' : 'bounded' : 'exact'};
}

export function trafficProblems(reading: {name: string; attempts: number; maxAttempts?: number; decoded: number | null; encodedUpper: number | null; referenceDecoded: number; referenceEncoded: number; ratios: boolean}) {
  const problems: string[] = [];
  if (reading.maxAttempts !== undefined && reading.attempts > reading.maxAttempts) problems.push(`${reading.name}: ${reading.attempts} GET attempts exceed ${reading.maxAttempts}`);
  if (reading.ratios) {
    if (reading.decoded === null || reading.referenceDecoded <= 0 || reading.decoded > 1.5 * reading.referenceDecoded) problems.push(`${reading.name}: decoded history exceeds 1.5× reference or has unbounded partial transfers`);
    if (reading.encodedUpper === null || reading.referenceEncoded <= 0 || reading.encodedUpper > 2 * reading.referenceEncoded) problems.push(`${reading.name}: encoded history exceeds 2× reference or has unbounded partial transfers`);
  }
  return problems;
}
