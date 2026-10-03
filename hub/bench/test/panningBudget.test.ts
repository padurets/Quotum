import {test} from 'node:test';
import assert from 'node:assert/strict';
import {panningProblems, type PanReading} from '../panningBudget';

const good = (): PanReading => ({period: '24h', series: 12, charts: 2, rate: 4, frames: Array(100).fill(16.7), latency: Array(100).fill(16.7), inputs: 100, updated: 100, chartUpdates: [100, 100], synchronized: true, peakFlights: 2, maxTiles: 8, duplicateReads: 0, pushesDuring: 0, pushesAfter: 3, expectedPushes: 3, forbiddenMutations: 0, coldReads: 2, undimmed: true, sizeStable: true});
test('native panning budgets accept real proportional movement within every invariant', () => assert.deepEqual(panningProblems(good()), []));
test('panning fails empty callbacks, missing samples, frame outliers and extra history commits', () => {
  for (const patch of [{series: 0}, {charts: 1}, {updated: 0}, {chartUpdates: [100, 0]}, {synchronized: false}, {inputs: 101}, {frames: Array(100).fill(35)}, {frames: Array(98).fill(16).concat([51, 51])}, {latency: Array(100).fill(35)}, {peakFlights: 3}, {maxTiles: 9}, {duplicateReads: 1}, {pushesDuring: 1}, {pushesAfter: 4}, {forbiddenMutations: 1}, {coldReads: 0}, {undimmed: false}, {sizeStable: false}]) assert.ok(panningProblems({...good(), ...patch}).length, JSON.stringify(patch));
});
