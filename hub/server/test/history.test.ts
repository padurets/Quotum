import {activity} from './activityReference.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cellOf, compose, decodeCells, encodeCells, expandHistory, targetOf, tileOf, type Chunk, type DecodedCell} from '../domain/history.js';
import {cellsOf, workFrom, type CellSamples} from '../domain/cells.js';
import {edge} from '../domain/quota.js';
import {barOf, overlap, union, type Stretch} from '../domain/work.js';

const M = 60_000;
const meta = {now: 120 * M, historyStart: 0, known: {work: 0, sources: {s: 0}}};
const windows = new Set(['s w']);
const empty = (from: number, to: number): Chunk => ({from, to, series: [], activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []});
const value = (at: number, low: number, extra: Partial<DecodedCell> = {}): DecodedCell => ({at, low, first: low, last: low, open: low + 1, gap: false, hold: 5 * M, spent: 1, covered: M, work: [1, 0, 0], ...extra});

test('compact history uses the requesting flight metadata and refuses another revision or run', () => {
  const prior = {...meta, run: 'first', meta: 'old'};
  const compact = {now: meta.now + M, run: prior.run, meta: prior.meta, chunks: [empty(0, M)]};
  assert.deepEqual(expandHistory(compact, prior), {...compact, historyStart: prior.historyStart, known: prior.known});
  for (const invalid of [undefined, {...prior, meta: 'new'}, {...prior, run: 'restarted'}, {...prior, meta: undefined}]) assert.throws(() => expandHistory(compact, invalid), /metadata mismatch/);
  const full = {...meta, run: 'restarted', chunks: []};
  assert.equal(expandHistory(full, prior), full, 'legacy and changed full metadata replace the prior basis');
});

test('a target keeps its left cell, admits fast clocks and shares the grid between periods', () => {
  assert.equal(cellOf(6 * 60 * M), M);
  assert.equal(cellOf(12 * 60 * M), cellOf(24 * 60 * M));
  assert.equal(cellOf(31 * 24 * 60 * M), 120 * M);
  assert.equal(tileOf(61 * M, M), 1);
  const now = 60 * M - 10_000;
  assert.deepEqual(targetOf(15 * M, now, 'live'), {cell: M, k0: 44, k1: 60, length: 15 * M, live: true, key: 'live', now});
  assert.equal(targetOf(15 * M, now, 'past', {from: 20 * M, to: 35 * M}).k1, 34);
  assert.equal(targetOf(15 * M, now, 'future', {from: 80 * M, to: 95 * M}).k1, 60);
});

test('compact cells preserve open across a reset, precise last values, and work defaults', () => {
  const cells = [value(0, 87.655, {first: 90, last: 87.655}), value(M, 20, {open: null, first: 25, last: 21, work: [0, 0, 0]}), value(2 * M, 19, {open: 21})];
  const encoded = encodeCells('s', 'w', 0, M, M, cells);
  assert.deepEqual(encoded.cells[0], [0, 87.66, 1, M, {l: 87.655, w: [1, 0, 0]}]);
  assert.deepEqual(encoded.cells[1][4], {o: null, f: 25, l: 21, w: [0, 0, 0]});
  assert.equal(encoded.cells[2].length, 4);
  const decoded = decodeCells(encoded, 0, M, M);
  assert.equal(decoded[0].last, 87.655);
  assert.equal(decoded[1].open, null);
  assert.equal(decoded[1].first, 25);
  assert.equal(decoded[2].open, 21);
});

test('a read empty chunk continues a line, while an unread stretch and a recorded gap break it', () => {
  const chunks = [empty(0, M), empty(M, 2 * M), empty(2 * M, 3 * M)];
  chunks[0].series = [encodeCells('s', 'w', 0, M, 0, [value(0, 90)])];
  chunks[2].series = [encodeCells('s', 'w', 2 * M, M, 0, [value(2 * M, 88)])];
  const target = targetOf(3 * M, 3 * M, 'past', {from: 0, to: 3 * M});
  assert.deepEqual(compose(chunks, meta, target, windows).series[0].points.map(p => p[2]), [1, 1]);
  assert.deepEqual(compose([chunks[0], chunks[2]], meta, target, windows).series[0].points.map(p => p[2]), [1, 2]);
  chunks[2].series[0].cells[0][4] = {g: 1};
  assert.deepEqual(compose(chunks, meta, target, windows).series[0].points.map(p => p[2]), [1, 2]);
});

test('activity counts each session once in a bar and frame and decodes group unions', () => {
  const chunk = empty(0, 30 * M);
  chunk.activity = {sessions: [['a', 's', 'P', 'd'], ['b', 's', 'P', 'd']], devices: {d: 'Laptop'}, cells: [[0, M, [0, [1, M / 2]], []], [1, M, [[0, M / 2], [1, M / 2]], [['s', 's', M], ['p', '"P"', M], ['d', 'd', M]]]]};
  const target = targetOf(30 * M, 30 * M, 'past', {from: 0, to: 30 * M});
  const result = compose([chunk], meta, target, windows).activity;
  assert.equal(result.agentMs, 2.5 * M);
  assert.equal(result.activeMs, 2 * M);
  assert.equal(result.agents, 2);
  assert.equal(result.by.source[0].activeMs, 2 * M);
  assert.equal(result.by.project[0].agentMs, 2.5 * M);
  assert.equal(result.by.device[0].name, 'Laptop');
  assert.equal(result.cells[0][3], 2);
});

test('random cell partitions preserve totals, edges, events and points', () => {
  let seed = 44;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let trial = 0; trial < 200; trial++) {
    const cells = Array.from({length: 100}, (_, i) => value(i * M, 100 - i / 2, {open: i ? 100 - (i - 1) / 2 : null, spent: i ? .5 : 0, covered: i ? M : 0, work: [i ? .5 : 0, 0, 0], gap: random() < .05}));
    const whole = empty(0, 100 * M);
    whole.series = [encodeCells('s', 'w', 0, M, 0, cells)];
    whole.resets = [['s', 'w', 3 * M], ['s', 'other', 4 * M], ['s', 'w', 19 * M]];
    const chunks: Chunk[] = [];
    for (let from = 0; from < 100;) {
      const to = Math.min(100, from + 1 + Math.floor(random() * 20));
      const chunk = empty(from * M, to * M);
      chunk.series = [encodeCells('s', 'w', from * M, M, 0, cells.slice(from, to))];
      chunk.resets = whole.resets.filter(([, , at]) => at >= chunk.from && at < chunk.to);
      chunks.push(chunk);
      from = to;
    }
    const from = Math.floor(random() * 50) * M;
    const to = from + (1 + Math.floor(random() * 50)) * M;
    const target = targetOf(to - from, to, 'range', {from, to});
    const expected = compose([whole], meta, target, windows);
    const actual = compose(chunks.reverse(), meta, target, windows);
    assert.deepEqual(actual, expected);
    const line = actual.series[0];
    assert.equal(line.consumed, (to - from) / M * .5 - (from === 0 ? .5 : 0));
    assert.equal(line.remainingAtEnd, 100 - (to / M - 1) / 2);
    assert.equal(line.remainingAtStart, 100 - Math.max(0, from / M - 1) / 2);
  }
});

test('random measurements and parallel work compose as the direct definitions, across arbitrary cuts', () => {
  let seed = 44065;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places;
  for (let trial = 0; trial < 150; trial++) {
    const samples: CellSamples['samples'] = [];
    let at = -M;
    let used = 4.12345;
    let resetAt = 300 * M;
    for (let n = 0; n < 150; n++) {
      at += Math.floor(random() * (random() < .1 ? 10 : 1.5) * M) + 1;
      const movement = random();
      if (movement < .08) {used = random() * 5; resetAt = at + 300 * M;}
      else if (movement < .15) used = Math.max(0, used - random());
      else used = Math.min(99, used + random() * 2);
      samples.push({at, used, resetAt, staleAfterMs: (1 + Math.floor(random() * 5)) * M});
    }
    const from = Math.floor(random() * 50) * M;
    const to = from + (10 + Math.floor(random() * 60)) * M;
    const threshold = Math.floor(random() * 40) * M;
    const known = {work: threshold, sources: {s: threshold}};
    const allWork: Stretch[] = [];
    for (let session = 0; session < 5; session++) {
      let start = threshold;
      for (let n = 0; n < 20; n++) {
        start += random() * 5 * M;
        const end = start + random() * 6 * M;
        allWork.push({session, source: 's', device: `d${session % 2}`, project: session % 2 ? 'P' : null, user: 'u', origin: 'terminal', folder: null, startedAt: 0, from: start, to: end});
        start = end;
      }
    }
    const work = allWork.filter(s => s.from < to && s.to > workFrom([{source: 's', window: 'w', samples}], from)).map(s => ({...s, to: Math.min(s.to, to)}));
    const chunks: Chunk[] = [];
    const names = {d0: 'Zero', d1: 'One'};
    for (let a = from; a < to;) {
      const b = Math.min(to, a + (1 + Math.floor(random() * 12)) * M);
      const before = samples.filter(s => s.at < a).at(-1);
      const rows = [...(before ? [before] : []), ...samples.filter(s => s.at >= a && s.at < b)];
      const built = cellsOf([{source: 's', window: 'w', samples: rows}], work, names, M, a, b, known);
      chunks.push(...built.map((c): Chunk => ({...c, activity: {...c.activity, sessions: c.activity.sessions.map(([id, ...rest]) => [String(id), ...rest])}})));
      a = b;
    }
    const target = targetOf(to - from, to, 'past', {from, to});
    const result = compose(chunks.reverse(), {...meta, now: to, known}, target, windows);
    const rows = samples.filter(s => s.at >= from && s.at < to);
    const expected = new Map<number, {low: number; spent: number; covered: number; ws: number; wc: number; wd: number}>();
    const active = union(work);
    let segments = 1;
    const points: [number, number, number][] = [];
    for (const b of rows) {
      const a = samples[samples.indexOf(b) - 1];
      const k = Math.floor(b.at / M) * M;
      const v = expected.get(k) ?? {low: 100 - b.used, spent: 0, covered: 0, ws: 0, wc: 0, wd: 0};
      if (!expected.has(k)) {
        if (points.length && a && k - Math.floor(a.at / M) * M > Math.max(M, a.staleAfterMs)) segments++;
        points.push([k, 0, segments]);
      }
      v.low = Math.min(v.low, 100 - b.used);
      if (a && edge(a, b).valid) {
        const delta = edge(a, b).delta;
        v.spent += delta;
        v.covered += b.at - a.at;
        if (a.at >= threshold) {
          const covered = overlap(active, a.at, b.at);
          v.ws += delta;
          v.wc += covered;
          if (covered) v.wd += delta;
        }
      }
      expected.set(k, v);
    }
    points.forEach(p => p[1] = round(expected.get(p[0])!.low, 2));
    const line = result.series[0];
    assert.deepEqual(line.points, points);
    const sum = (field: 'spent' | 'covered' | 'ws' | 'wc' | 'wd') => [...expected.values()].reduce((s, v) => s + (field === 'covered' || field === 'wc' ? v[field] : round(v[field])), 0);
    assert.ok(Math.abs(line.consumed - sum('spent')) < 1e-10);
    assert.equal(line.coveredMs, sum('covered'));
    const first = rows[0];
    const prev = samples[samples.indexOf(first) - 1];
    const firstCell = Math.floor(first.at / M) * M;
    const held = prev && edge(prev, first).reason !== 'gap' && (edge(prev, first).reason !== 'reset' || (prev.resetAt !== null && prev.resetAt > firstCell));
    assert.equal(line.remainingAtStart, round(100 - (held ? prev.used : first.used)));
    assert.equal(line.remainingAtEnd, round(100 - rows.at(-1)!.used));
    if (threshold < to) {
      assert.ok(Math.abs(line.work!.consumed - sum('ws')) < 1e-10);
      assert.ok(Math.abs(line.work!.coveredMs - sum('wc')) < 1e-6);
      assert.ok(Math.abs(line.work!.duringWork - sum('wd')) < 1e-10);
    } else assert.equal(line.work!.ms, null);
    const direct = activity(allWork, {from: Math.max(from, threshold), to}, barOf(M, to - from), new Map(Object.entries(names)));
    const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
    close(result.activity.activeMs, direct.activeMs);
    close(result.activity.agentMs, direct.agentMs);
    assert.equal(result.activity.agents, direct.agents);
    for (const dim of ['source', 'project', 'device'] as const) {
      assert.equal(result.activity.by[dim].length, direct.by[dim].length);
      result.activity.by[dim].forEach((g, i) => {assert.equal(g.key, direct.by[dim][i].key); assert.equal(g.agents, direct.by[dim][i].agents); close(g.activeMs, direct.by[dim][i].activeMs); close(g.agentMs, direct.by[dim][i].agentMs);});
    }
  }
});
