import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {HistoryStore} from '../lib/history';
import {cellsOf} from '../../server/domain/cells';
import {CLOCK_TOLERANCE_MS, cellStart, type Chunk, type HistoryAnswer} from '../../server/domain/history';
import {covered, type PlotBuffer} from '../lib/historyPlot';
import {readout as readCell, type ForecastLine, type PlanLine, type ReadoutRow} from '../lib/readout';
import type {PlotSeries} from '../lib/lines';

test('the actual chart does not carry a held value through unread history after a pan', async () => {
  const M = 60_000, H = 60 * M, now = Date.parse('2026-09-26T12:05:00Z');
  const at = (time: string) => Date.parse(`2026-09-26T${time}:00Z`);
  const known = {work: now - 24 * H, sources: {s: now - 24 * H}};
  const reads: {cell: number; from: number; to: number; signal?: AbortSignal; settled: boolean; resolve(answer: HistoryAnswer): void}[] = [];
  const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
  const samples = [
    {at: at('10:58'), used: 20, resetAt: null, staleAfterMs: 15 * M},
    {at: at('11:03'), used: 80, resetAt: null, staleAfterMs: 15 * M},
  ];
  const store = new HistoryStore({now: () => now, elapsedNow: () => 0,
    setTimeout: () => ({}), clearTimeout: () => {}, dropTimeRange: () => {throw new Error('unexpected range drop');},
    read: (_board, cell, from, to, signal) => new Promise(resolve => reads.push({cell, from, to, signal, resolve, settled: false})),
  });
  const pending = () => reads.find(read => !read.settled && !read.signal?.aborted)!;
  const answer = async (read: typeof reads[number]) => {
    read.settled = true;
    const end = Math.min(read.to, cellStart(now + CLOCK_TOLERANCE_MS, read.cell) + read.cell);
    const chunks = cellsOf([{source: 's', window: 'w', samples}], [], {}, read.cell, read.from, end, known).map(chunk => ({...chunk,
      activity: {...chunk.activity, sessions: chunk.activity.sessions.map(([id, ...rest]) => [String(id), ...rest] as Chunk['activity']['sessions'][number])},
    }));
    read.resolve({run: 'r', now, historyStart: now - 24 * H, known, chunks});
    await flush();
  };
  const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
  const hoverSource = source.match(/  const hover = incomingReady[^\n]+/)![0];
  const rowsSource = source.slice(source.indexOf('  const none = {'), source.indexOf('  const columnCount'));
  const chart = (strip: PlotBuffer | null, lines: PlotSeries[], hover = at('11:06'), to = at('11:40'), plans: PlanLine[] = [], forecasts: ForecastLine[] = []) =>
    runInNewContext(hoverSource + '\n' + rowsSource + '\n({hover,rows});', {
      axis: {hover}, incomingReady: true, prepared: {ready: true}, strip, now, cellMs: M, covered, plans, forecasts, to, readCell,
      lines: lines.map(line => ({...line, key: 's w'})),
    }) as {hover: number | null; rows: ReadoutRow[]};
  try {
    store.choose('1h', null); store.open('b'); store.hello('r'); store.snapshot(['s'], ['s w']);
    await flush(); await answer(pending());
    const range = {from: at('10:40'), to: at('11:40')};
    store.pan({token: 1, length: H, ...range, direction: 0}); await flush(); await answer(pending());
    store.choose('1h', range); store.endPan(true); await flush();
    const strip = store.getPlot()!;
    assert.ok(covered(strip.coverage, at('11:06'), at('11:07')));
    assert.equal(covered(strip.coverage, at('10:58'), at('11:07')), false);
    assert.equal(chart(strip, strip.series).rows[0].value, null, 'unknown bridge must prevent carry into covered tail');
    assert.equal(chart(strip, strip.series, at('10:59')).rows[0].value, 80, 'known empty cells still carry a fresh measurement');
    assert.equal(chart({...strip, coverage: [[at('10:40'), at('11:00')], [at('11:00'), at('12:10')]]}, strip.series).rows[0].value, 80, 'adjacent read intervals are continuous');
    const future = chart({...strip, coverage: []}, strip.series, now + M, now + 15 * M,
      [{key: 'p', lines: ['s w'], color: 'blue', runs: [[[now, 70], [now + 15 * M, 40]]]}],
      [{key: 's w', name: 'Test', color: 'blue', dash: '', points: [[now, 80], [now + 15 * M, 20]], zero: null, at: null}]);
    assert.deepEqual([future.hover, future.rows[0].value, future.rows[0].plan, future.rows[0].forecast], [now + M, null, 67, 74]);
    await answer(pending());
    assert.equal(store.getPlot(), null);
    assert.equal(chart(null, store.get().history!.series).rows[0].value, 20, 'the completed answer reveals the newer measurement');
  } finally {store.close();}
});
