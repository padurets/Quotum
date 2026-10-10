import {test} from 'node:test';
import assert from 'node:assert/strict';
import {panningProblems, type PanReading} from '../panningBudget';

const good = (): PanReading => ({initiator: 'quota', period: '24h', series: 12, budgetSeries: 12, fundsSeries: 12, charts: 4, rate: 4, frames: Array(100).fill(16.7), latency: Array(100).fill(16.7), inputs: 100, updated: 100, chartUpdates: [100, 100, 100, 100], synchronized: true, peakFlights: 2, maxTiles: 8, duplicateReads: 0, pushesDuring: 0, pushesAfter: 3, expectedPushes: 3, forbiddenMutations: 0, coldReads: 2, undimmed: true, sizeStable: true});
test('native panning budgets accept real proportional movement within every invariant', () => assert.deepEqual(panningProblems(good()), []));
test('a recorded native pause never excuses an address write or unrelated mutation during feeding', () => {
  const transactions = {status:'complete',wheelEvents:2,invalidClocks:0,stampRegressions:0,maxStampGap:332.5,maxDeliveryGap:318.3,pushesDuring:1,omitted:0,
    writes:[{at:432.5,segment:'wheel',token:1,stamp:432.5,delivered:432.5,stampGap:332.5,deliveryGap:318.3,idleMs:0}]};
  const problems=panningProblems({...good(),pushesDuring:1,forbiddenMutations:2,transactions});
  assert.ok(problems.includes('panning did not commit exactly once per completed changed gesture'));
  assert.ok(problems.includes('panning changed cards, header, agents, table or activity totals while moving'));
});
test('panning fails empty callbacks, missing samples, frame outliers and extra history commits', () => {
  for (const patch of [{fundsSeries: 0}, {budgetSeries: 0}, {series: 0}, {charts: 1}, {updated: 0}, {chartUpdates: [100, 0]}, {synchronized: false}, {inputs: 101}, {frames: Array(100).fill(35)}, {frames: Array(98).fill(16).concat([51, 51])}, {latency: Array(100).fill(35)}, {peakFlights: 3}, {maxTiles: 9}, {duplicateReads: 1}, {pushesDuring: 1}, {pushesAfter: 4}, {forbiddenMutations: 1}, {coldReads: 0}, {undimmed: false}, {sizeStable: false}]) assert.ok(panningProblems({...good(), ...patch}).length, JSON.stringify(patch));
});
