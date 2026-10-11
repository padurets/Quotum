import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {HistoryStore, follow, type Shown} from '../lib/history';
import {createStore} from '../lib/store';
import {INITIAL, reduce, type HubEvent, type Snapshot} from '../lib/board';
import {ApiError} from '../lib/http';
import type {Card, History} from '../lib/types';
import {EMPTY_VIEW} from '../../server/domain/view';
import {CLOCK_TOLERANCE_MS, cellStart, tileEnd, tileOf, type Chunk, type HistoryAnswer} from '../../server/domain/history';
import type {MeterSelection} from '../../server/domain/meterHistory';

const H = 3_600_000;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const flush = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
const card = (id: string, windows = ['weekly']): Card => ({id, provider: 'codex', plan: '', resets: null, owners: [], error: null,
  successAt: NOW, stale: false, staleAfterMs: 600_000, measureIntervalMs: null,
  windows: windows.map(id => ({id, kind: 'weekly', label: null, used: 20, remaining: 80, resetAt: null, minutes: 10080}))});
const quotaIds = (history: History | null) => history?.series.map(s => `${s.sourceId}/${s.windowId}`).sort() ?? [];
const meterIds = (history: History | null) => history?.meterSeries?.map(s => `${s.sourceId}/${s.meterId}/${s.unit}`).sort() ?? [];
type Frame = Shown & {drawing: History | null};

function harness() {
  const page = createStore(reduce, INITIAL);
  const reads: {cell: number; from: number; to: number; signal?: AbortSignal; meters?: MeterSelection; settled: boolean;
    resolve(answer: HistoryAnswer): void; reject(error: unknown): void}[] = [];
  const loader = new HistoryStore({now: () => NOW, elapsedNow: () => 0, preparations: null,
    read: (_board, cell, from, to, signal, meters) => new Promise((resolve, reject) => reads.push({cell, from, to, signal, meters, settled: false, resolve, reject})),
    setTimeout: () => ({}), clearTimeout: () => {}, dropTimeRange: () => {},
  }, undefined, 'quota');
  const stop = follow(loader, page);
  let range = '1h', panning: number | null = null, run = 'run', ready = true, revision = 0;
  let error: 'history_failed' | undefined;
  loader.choose(range, null);

  // Execute the production hook with persistent React slots. Only the independent
  // exact-evidence readiness is controlled; shown and drawing cells come from the
  // real reducer, follower, reads, packing and HistoryStore publication.
  const slots: {current: unknown}[] = []; let cursor = 0;
  const useRef = (current: unknown) => slots[cursor++] ?? (slots[cursor - 1] = {current});
  const useMemo = (read: () => unknown, deps: unknown[]) => {
    const box = useRef(null) as {current: {deps: unknown[]; value: unknown} | null};
    if (!box.current || deps.some((v, i) => !Object.is(v, box.current!.deps[i]))) box.current = {deps, value: read()};
    return box.current.value;
  };
  const context = {useRef, useMemo, useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
    usePanning: () => panning, useClock: () => NOW, fundsHistory: {}, page, timeRange: () => null, prefs: () => ({range}),
    boardPeriod: {getProjectionRevision: () => revision, projectionState: () => ({ready, error}), project: (history: History) => history},
    read: null as unknown as (loader: HistoryStore, rolling: boolean) => Frame};
  const source = readFileSync(new URL('../lib/history.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function usePeriodHistory('), source.indexOf('export function useHistory('));
  runInNewContext(ts.transpileModule(body + '\nglobalThis.read=usePeriodHistory;', {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const render = () => {cursor = 0; return context.read(loader, true);};
  const event = (event: HubEvent) => page.dispatch({type: 'hub', event});
  const snapshot = (sources = [card('removed'), card('kept')]): Snapshot => ({board: {id: 'b', name: '', personal: false},
    view: EMPTY_VIEW, historyStart: 0, sources, sessions: {}, cadence: {}, refresh: {}, forecast: {}, mine: [], boards: [],
    resets: {resets: {}, trackers: [], past: {}}});
  const pending = () => reads.filter(read => !read.settled && !read.signal?.aborted);
  async function answerCells() {
    await flush();
    for (let count = 0; pending().length; count++) {
      assert.ok(count < 40, 'the real store finishes its requested cells');
      const read = pending()[0]; read.settled = true;
      const end = Math.min(read.to, cellStart(NOW + CLOCK_TOLERANCE_MS, read.cell) + read.cell), chunks: Chunk[] = [];
      const cards = Object.values(page.get().board?.cards ?? {});
      for (let from = read.from; from < end;) {
        const to = Math.min(end, tileEnd(tileOf(from, read.cell), read.cell));
        chunks.push({from, to,
          series: cards.flatMap(card => card.windows.map(window => ({source: card.id, window: window.id, hold: 600_000, open: 80,
            cells: [[0, 80, 0, 0]] as [number, number, number, number][]}))),
          ...(read.meters ? {meterSeries: read.meters.ids.map(([source, meter]) => ({source, meter, unit: read.meters!.unit,
            kind: 'balance' as const, semantics: null, cells: [[0, '9000000', '0', '0', read.cell]] as [number, string, string, string, number][]}))} : {}),
          activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []});
        from = to;
      }
      read.resolve({run, now: NOW, historyStart: page.get().board?.historyStart ?? 0,
        known: {work: 0, sources: Object.fromEntries(cards.map(card => [card.id, 0]))}, chunks});
      await flush();
    }
  }
  return {page, loader, event, snapshot, render, answerCells, pending,
    async start(sources?: Card[]) {
      page.dispatch({type: 'board-open', id: 'b'}); event({type: 'hello', data: {epoch: run}});
      event({type: 'snapshot', data: snapshot(sources)}); await answerCells();
      const frame = render(); assert.ok(frame.history); assert.equal(frame.drawing, frame.history); return frame;
    },
    exact(next: boolean, failure?: 'history_failed') {ready = next; error = failure; revision++;},
    choose(next: string) {range = next; loader.choose(next, null);},
    async pan() {panning = 1; loader.pan({token: 1, length: H, from: NOW - H, to: NOW, direction: 0}); await flush();},
    endPan() {panning = null; loader.endPan(false);},
    async fail(error: unknown) {await flush(); const read = pending()[0]; assert.ok(read, 'a real read must fail'); read.settled = true; read.reject(error); await flush();},
    reconnect() {run = 'restarted'; event({type: 'hello', data: {epoch: run}}); event({type: 'snapshot', data: snapshot()});},
    close() {stop(); loader.close();},
  };
}

function emptyFrame(frame: Frame, why: string) {
  assert.equal(frame.history, null, `${why}: accounting cannot borrow the retired frame`);
  assert.equal(frame.drawing, null, `${why}: drawing cannot borrow the retired frame`);
}

test('a lineup removal cannot return through retained accounting or drawing while exact evidence waits or fails', async () => {
  const h = harness();
  try {
    assert.deepEqual(quotaIds((await h.start()).history), ['kept/weekly', 'removed/weekly']);
    h.exact(false);
    h.event({type: 'lineup', data: {sources: ['kept']}});
    assert.deepEqual(h.page.get().board!.lineup, ['kept']);
    assert.equal(h.loader.get().history, null, 'the actual follower retires removed source cells');
    emptyFrame(h.render(), 'immediately after removal');
    await h.answerCells();
    assert.deepEqual(quotaIds(h.loader.get().history), ['kept/weekly'], 'clean drawing cells arrive before the exact tape');
    emptyFrame(h.render(), 'exact evidence still pending');
    assert.equal(h.render().loading, true);
    h.exact(false, 'history_failed');
    emptyFrame(h.render(), 'exact evidence failed');
    assert.equal(h.render().error, 'history_failed'); assert.equal(h.render().loading, false);
    h.exact(true);
    assert.deepEqual(quotaIds(h.render().history), ['kept/weekly']);
    assert.deepEqual(quotaIds(h.render().drawing), ['kept/weekly']);
  } finally {h.close();}
});

test('a removal during panning retires both the held frame and the live drawing strip', async () => {
  const h = harness();
  try {
    const initial = await h.start(); await h.pan();
    assert.equal(h.render().history, initial.history, 'ordinary panning holds the complete frame');
    assert.ok(h.loader.getPlot()!.series.some(series => series.sourceId === 'removed'));
    h.exact(false); h.event({type: 'lineup', data: {sources: ['kept']}});
    emptyFrame(h.render(), 'removal during a gesture');
    assert.equal(h.loader.getPlot(), null, 'the drawing strip loses removed membership immediately');
    await h.answerCells();
    assert.ok(h.loader.getPlot()!.series.every(series => series.sourceId === 'kept'));
    emptyFrame(h.render(), 'a new strip cannot restore the retired complete frame');
    h.endPan(); await h.answerCells();
    emptyFrame(h.render(), 'release while exact evidence is pending');
    h.exact(true); assert.deepEqual(quotaIds(h.render().drawing), ['kept/weekly']);
  } finally {h.close();}
});

test('a later history access boundary retires the old frame even when source IDs are unchanged', async () => {
  const h = harness();
  try {
    const initial = await h.start(), historyStart = NOW - H / 2;
    h.exact(false); h.event({type: 'snapshot', data: {...h.snapshot(), historyStart}});
    assert.deepEqual(h.page.get().board!.lineup, ['removed', 'kept']);
    emptyFrame(h.render(), 'the snapshot moved the access boundary');
    await h.answerCells();
    assert.equal(h.loader.get().history!.historyStart, historyStart);
    emptyFrame(h.render(), 'cells obey the new boundary while exact accounting waits');
    h.exact(false, 'history_failed'); emptyFrame(h.render(), 'exact accounting for the new boundary failed');
    h.exact(true); assert.notEqual(h.render().drawing, initial.drawing);
    assert.equal(h.render().drawing!.historyStart, historyStart);
  } finally {h.close();}
});

for (const panning of [false, true]) test(`removing a window from a live card retires its complete frame${panning ? ' during panning' : ''}`, async () => {
  const h = harness();
  try {
    await h.start([card('kept', ['old-window', 'weekly'])]);
    if (panning) await h.pan();
    h.exact(false); h.event({type: 'card', data: card('kept')});
    emptyFrame(h.render(), 'the card event removed a window');
    if (panning) h.endPan();
    await h.answerCells();
    assert.deepEqual(quotaIds(h.loader.get().history), ['kept/weekly']);
    emptyFrame(h.render(), 'cached cells were recomposed before the exact evidence');
    h.exact(true); assert.deepEqual(quotaIds(h.render().drawing), ['kept/weekly']);
  } finally {h.close();}
});

const initialMeters: MeterSelection = {unit: 'USD', ids: [['kept', 'balance'], ['removed', 'balance']]};
for (const [name, selection] of [
  ['meter removal', {unit: 'USD', ids: [['kept', 'balance']]}],
  ['display currency', {...initialMeters, unit: 'EUR'}],
  ['resource revision with unchanged IDs', {...initialMeters, resourceRevision: 'new-resource'}],
] satisfies [string, MeterSelection][]) test(`a ${name} cannot retain the previous money projection`, async () => {
  const h = harness();
  try {
    await h.start(); h.loader.setMeters(initialMeters); await h.answerCells();
    assert.deepEqual(meterIds(h.render().history), ['kept/balance/USD', 'removed/balance/USD']);
    h.exact(false); h.loader.setMeters(selection);
    emptyFrame(h.render(), 'resource selection changed');
    await h.answerCells();
    assert.deepEqual(meterIds(h.loader.get().history), selection.ids.map(([source, meter]) => `${source}/${meter}/${selection.unit}`).sort());
    emptyFrame(h.render(), 'new money cells arrived before exact accounting');
    h.exact(false, 'history_failed'); emptyFrame(h.render(), 'replacement accounting failed');
    h.exact(true); assert.deepEqual(meterIds(h.render().drawing), meterIds(h.loader.get().history));
  } finally {h.close();}
});

test('a missing resource response cannot be followed by resurrection of its retained frame', async () => {
  const h = harness();
  try {
    await h.start(); h.exact(false); h.loader.news(NOW);
    await h.fail(new ApiError(404, 'not_found'));
    emptyFrame(h.render(), 'the server confirmed a missing resource');
    assert.equal(h.render().error, 'history_failed');
    h.choose('6h'); await h.answerCells();
    assert.ok(h.loader.get().history, 'the recovery reads really published new cells');
    emptyFrame(h.render(), 'recovery cannot reuse accounting from before not_found');
  } finally {h.close();}
});

test('closing the board during a gesture clears accounting, drawing and pending reads', async () => {
  const h = harness();
  try {
    await h.start(); await h.pan(); h.exact(false);
    h.page.dispatch({type: 'board-close'});
    assert.equal(h.page.get().board, null); assert.equal(h.loader.getPlot(), null);
    emptyFrame(h.render(), 'board access ended');
    assert.equal(h.pending().length, 0);
  } finally {h.close();}
});

test('ordinary period changes and same-membership reconnects keep the last complete frame while exact evidence waits', async () => {
  const h = harness();
  try {
    const initial = await h.start(); h.exact(false); h.choose('6h'); await h.answerCells();
    assert.equal(h.loader.get().history!.range, '6h', 'the period change published a different cell frame');
    assert.equal(h.render().history, initial.history); assert.equal(h.render().drawing, initial.drawing);
    h.exact(false, 'history_failed');
    assert.equal(h.render().history, initial.history, 'an ordinary evidence error does not revoke membership');
    assert.equal(h.render().drawing, initial.drawing); assert.equal(h.render().loading, false);
    h.exact(false); h.reconnect(); await h.answerCells();
    assert.equal(h.render().history, initial.history, 'a reconnect with unchanged membership preserves the complete frame');
    assert.equal(h.render().drawing, initial.drawing);
    h.exact(true); assert.equal(h.render().history!.range, '6h'); assert.notEqual(h.render().drawing, initial.drawing);
  } finally {h.close();}
});

for (const code of ['history_failed', 'history_limit']) test(`${code} recovery preserves the complete frame when resource membership is unchanged`, async () => {
  const h = harness();
  try {
    const initial = await h.start(); h.exact(false); h.loader.news(NOW);
    await h.fail(new ApiError(503, code));
    assert.equal(h.loader.get().error, code);
    h.choose('6h'); await h.answerCells();
    assert.equal(h.loader.get().history!.range, '6h');
    assert.equal(h.render().history, initial.history, 'a transient failure does not retire the authorized accounting frame');
    assert.equal(h.render().drawing, initial.drawing);
    h.exact(true); assert.equal(h.render().drawing!.range, '6h');
  } finally {h.close();}
});
