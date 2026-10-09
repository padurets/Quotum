import {test} from 'node:test';
import assert from 'node:assert/strict';
import {panning} from '../panning.js';
import {safeEvidence} from '../evidence.js';

async function failedSettlement(message: string) {
  const error = new Error(message), saved = new Map<string, unknown>();
  let loaded = () => {};
  const cdp = {
    send: async <T>(method: string) => {if (method === 'Page.reload') loaded(); return undefined as T;},
    evaluate: async <T>(expression: string) => {
      if (expression.includes('charts and complete totals did not settle: ')) throw error;
      if (expression.includes('const p=window.__quotumPan')) return {status: 'unavailable'} as T;
      return (expression.includes('horizon') ? 'auto' : {x: 1, y: 1}) as T;
    },
    on: <T>(_method: string, callback: (params: T) => void) => {loaded = () => callback(undefined as T);}, off() {},
  };
  await assert.rejects(panning(cdp, async () => {}, {save: (name, value) => saved.set(name, safeEvidence(value))}), value => value === error);
  return saved.get('panning-failure') as {settlement?: unknown};
}

test('an original settlement failure retains safe per-plot state from the error already returned by the page', async () => {
  const canary = 'private-page-value', wanted = '1790000000000-1790086400000';
  const detail = {wanted, panels: [
    {class: 'panel history', panning: false, plot: {drawReady: 'true', drawFrom: '1790000000000', drawTo: '1790086400000'}},
    {class: 'panel activity is-loading', panning: true, error: canary, plot: {drawReady: 'false', panEnd: '1790086400000'}},
    {class: 'panel forecast', range: wanted},
    {class: 'panel budget-table', range: 'other-private-range'},
  ], flights: [{scope: canary}]};
  const failure = await failedSettlement('in the page: Error: charts and complete totals did not settle: ' + JSON.stringify(detail) + '\n    at private-frame');
  assert.deepEqual(failure.settlement, {status: 'available', panels: [
    {index: 0, kind: 'history', loading: false, error: false, rangeMatch: null, ready: true, panning: false, panEnd: null, from: 1790000000000, to: 1790086400000},
    {index: 1, kind: 'activity', loading: true, error: true, rangeMatch: null, ready: false, panning: true, panEnd: 1790086400000, from: null, to: null},
    {index: 2, kind: 'forecast', loading: false, error: false, rangeMatch: true, ready: null, panning: null, panEnd: null, from: null, to: null},
    {index: 3, kind: 'budget-table', loading: false, error: false, rangeMatch: false, ready: null, panning: null, panEnd: null, from: null, to: null},
  ], flights: 1});
  assert.equal(JSON.stringify(failure).includes('private'), false);
});

test('unrelated, malformed or excessive page text cannot become settlement evidence', async () => {
  for (const message of ['private-page-value', 'charts and complete totals did not settle: {broken',
    'charts and complete totals did not settle: ' + 'x'.repeat(20000),
    'charts and complete totals did not settle: ' + JSON.stringify({wanted: {}, panels: [], flights: []})]) {
    const failure = await failedSettlement(message);
    assert.deepEqual(failure.settlement, {status: 'unavailable'});
    assert.equal(JSON.stringify(failure).includes('private-page-value'), false);
  }
});
