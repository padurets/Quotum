import {test} from 'node:test';
import assert from 'node:assert/strict';
import {panningProblems, type PanReading} from '../panningBudget';
const edgeSeries=():PanReading['edgeSeries']=>['wheel','drag'].map(stage=>({stage:stage as 'wheel'|'drag',series:12,sessionSeries:12,budgetSeries:12,fundsSeries:12}));

const good = (): PanReading => ({initiator: 'quota', period: '24h', wheelGapMs:16.7,edgeSeries:edgeSeries(),series: 12, budgetSeries: 12, fundsSeries: 12, sessionSeries:12,  charts: 5, rate: 4, frames: Array(100).fill(16.7), latency: Array(100).fill(16.7), inputs: 100, updated: 100, chartUpdates:Array(5).fill(100), synchronized: true, peakFlights: 2, maxTiles: 8, duplicateReads: 0, pushesDuring: 0, pushesAfter: 3, expectedPushes: 3, forbiddenMutations: 0, coldReads: 2, undimmed: true, sizeStable: true});
test('native panning budgets accept real proportional movement within every invariant', () => {
  assert.deepEqual(panningProblems(good()), []);
  assert.deepEqual(panningProblems({...good(),frames:Array(98).fill(34).concat([80,80]),latency:Array(100).fill(50)}), []);
});
test('panning fails empty callbacks, missing samples, frame outliers and extra history commits', () => {
  for (const patch of [{sessionSeries:0},{fundsSeries: 0}, {budgetSeries: 0}, {series: 0}, {charts: 1}, {updated: 0}, {chartUpdates: [100, 0]}, {synchronized: false}, {inputs: 101}, {frames: Array(100).fill(35)}, {frames: Array(98).fill(16).concat([81, 81])}, {latency: Array(100).fill(51)}, {peakFlights: 3}, {maxTiles: 9}, {duplicateReads: 1}, {pushesDuring: 1}, {pushesAfter: 4}, {forbiddenMutations: 1}, {coldReads: 0}, {undimmed: false}, {sizeStable: false}]) assert.ok(panningProblems({...good(), ...patch}).length, JSON.stringify(patch));
});

test('initial density cannot hide missing series at an unread or rebuilt edge',()=>{
  for(const field of ['series','sessionSeries','budgetSeries','fundsSeries'] as const)for(const stage of [0,1]) {
    const reading=good();reading.edgeSeries[stage][field]=11;
    assert.ok(panningProblems(reading).some(problem=>problem.includes('history edge')),field+':'+stage);
  }
  assert.ok(panningProblems({...good(),edgeSeries:[]}).some(problem=>problem.includes('history edge')));
});

test('a discontinuous native wheel stream cannot pass as continuous movement',()=>{
  assert.ok(panningProblems({...good(),wheelGapMs:200}).some(problem=>problem.includes('stay continuous')));
});
