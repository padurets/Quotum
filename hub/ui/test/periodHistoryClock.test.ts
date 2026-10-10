import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PeriodActivity} from '../lib/periodActivity';
import {PeriodIndex} from '../lib/periodIndex';
import type {History} from '../lib/types';

test('the actual period hook advances exact rolling work without invalidating drawing evidence', () => {
  const trace = {anchor: 0, cut: 60_000, knownFrom: 0, refs: [{ref: 'r', source: 's', device: {id: 'd', name: 'Laptop'}, origin: 'terminal' as const, project: null, folder: null, startedAt: 0}], spans: [[0, 0, 40_000]] as [number, number, number][]};
  const index = new PeriodIndex(trace), activity = new PeriodActivity(trace);
  const history: History = {board: 'b', range: '1m', live: true, since: 0, to: 60_000, cellMs: 15_000, historyStart: 0, events: [], series: [],
    activity: {since: 0, known: {from: 0, to: 60_000}, barMs: 60_000, activeMs: 40_000, agentMs: 40_000, agents: 1, cells: [[0, 40_000, 40_000, 1]], by: {source: [{key: 's', name: null, agentMs: 40_000, activeMs: 40_000, agents: 1, cells: [[0, 40_000]]}], project: [], device: []}}};
  let now = 60_000, revision = 0, panning: number | null = null, board = 'b';
  let shown: {history: History | null; loading: boolean} = {history, loading: false};
  let ready = true;
  const slots: {current: unknown}[] = []; let cursor = 0;
  const useRef = (current: unknown) => slots[cursor++] ?? (slots[cursor - 1] = {current});
  const useMemo = (read: () => unknown, deps: unknown[]) => {
    const box = useRef(null) as {current: {deps: unknown[]; value: unknown} | null};
    if (!box.current || deps.some((v, i) => !Object.is(v, box.current!.deps[i]))) box.current = {deps, value: read()};
    return box.current.value;
  };
  const loader = {scope: 'quota', subscribe: () => () => {}, get: () => shown};
  const context = {useRef, useMemo, useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(), usePanning: () => panning, useClock: () => now,
    fundsHistory: {}, page: {get: () => ({board: {id: board}})}, timeRange: () => null, prefs: () => ({range: '1m'}),
    boardPeriod: {getProjectionRevision: () => revision, projectionState: () => ({ready, error: null}), project: (base: History, _scope: string, at: number) => {
      const range = {from: at - 60_000, to: at}; activity.update(index.advance(range, at).rows);
      return {...base, since: range.from, to: range.to, activity: activity.project(base.activity, range)};
    }}, read: null as unknown as (loader: unknown, rolling: boolean) => {history: History | null; drawing: History | null; loading: boolean},
  };
  const source = readFileSync(new URL('../lib/history.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function usePeriodHistory('), source.indexOf('export function useHistory('));
  runInNewContext(ts.transpileModule(body + '\nglobalThis.read=usePeriodHistory;', {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const render = () => {cursor = 0; return context.read(loader, true);};
  const initial = render(); assert.equal(initial.history!.activity.agentMs, 40_000);
  now = 75_000;
  const moved = render(); assert.equal(moved.history!.activity.agentMs, 25_000);
  assert.equal(moved.history!.activity.by.source[0].cells[0][1], 25_000, 'the first bar retains exact clipping');
  assert.equal(moved.drawing, initial.drawing, 'a clock wake cannot schedule the full drawing again');
  revision++;
  const evidence = render(); assert.notEqual(evidence.drawing, initial.drawing, 'new evidence reaches every drawing consumer');
  panning = 1; now = 90_000;
  const held = render(); assert.equal(held.history, evidence.history); assert.equal(held.loading, false);
  panning = null;
  assert.equal(render().history!.activity.agentMs, 10_000, 'release resumes exact accounting');
  board = 'other'; shown = {history: null, loading: true}; ready = false;
  const retired = render(); assert.equal(retired.history, null); assert.equal(retired.drawing, null, 'the previous board cannot retain drawing evidence');
});
