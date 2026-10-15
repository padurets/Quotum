import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {HistoryStore, follow, type Shown} from '../lib/history';
import {createStore,shallowEqual} from '../lib/store';
import {INITIAL, reduce, type HubEvent, type Snapshot} from '../lib/board';
import type {Card, History} from '../lib/types';
import {EMPTY_VIEW} from '../../server/domain/view';
import {planEventsAt,planEventsDeadline,CLOCK_TOLERANCE_MS, cellStart, tileEnd, tileOf, type Chunk, type HistoryAnswer} from '../../server/domain/history';
import type {MeterSelection} from '../../server/domain/meterHistory';

export const H = 3_600_000;
export const NOW = Date.parse('2026-10-10T12:00:00Z');
const flush = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
export const card = (id: string, windows = ['weekly']): Card => ({id, provider: 'codex', plan: '', resets: null, owners: [], error: null,
  successAt: NOW, stale: false, staleAfterMs: 600_000, measureIntervalMs: null,
  windows: windows.map(id => ({id, kind: 'weekly', label: null, used: 20, remaining: 80, resetAt: null, minutes: 10080}))});
export type Frame = Shown & {drawing: History | null};

export function harness(activity = false) {
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
    pan:{active:()=>panning,onPhase:()=>()=>{}},hubNow:()=>NOW,planEventsAt,planEventsDeadline,shallowEqual,useClock: () => NOW, fundsHistory: {}, page, timeRange: () => null, prefs: () => ({range}),
    boardPeriod: {getProjectionRevision: () => revision, projectionState: () => ({ready, error}), project: (history: History) => history},
    read: null as unknown as (loader: HistoryStore, rolling: boolean) => Frame};
  const source = readFileSync(new URL('../lib/history.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function usePeriodHistory('), source.indexOf('export function useHistory('));
  runInNewContext(ts.transpileModule(body + '\nglobalThis.read=usePeriodHistory;', {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const render = () => {cursor = 0; return context.read(loader, true);};
  const event = (event: HubEvent) => page.dispatch({type: 'hub', event});
  const snapshot = (sources = [card('removed'), card('kept')]): Snapshot => ({board: {id: 'b', name: '', personal: false},
    view: EMPTY_VIEW, historyStart: 0, workAuthority: 'work-a', sources, sessions: {}, cadence: {}, refresh: {}, forecast: {}, mine: [], boards: [],
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
          activity: activity ? {sessions: cards.map(c => ['ref-' + c.id, c.id, c.id + ' project', 'device']), devices: {device: 'Device'}, cells: Array.from({length: (to - from) / read.cell}, (_, i) => [i, read.cell, cards.map((_, j) => j), []])} : {sessions: [], devices: {}, cells: []}, resets: [], grants: []});
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
