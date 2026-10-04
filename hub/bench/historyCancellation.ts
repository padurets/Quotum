import assert from 'node:assert/strict';
import {cellOf, cellStart, compose, targetOf, type Chunk, type HistoryAnswer} from '../server/domain/history';
import {HistoryStore, followPan} from '../ui/lib/history';
import {Pan} from '../ui/lib/pan';
import {Preparations} from '../ui/lib/prepare';
import {historyBody, type BodyCount, type historyProxy} from './historyProxy';
import {bodyTotals, readUnion, stableHistory, transferFor} from './historyTrafficBudget';

const DAY = 86_400_000;
const flush = async () => {for (let n = 0; n < 5; n++) await Promise.resolve();};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Attempt = {phase: string; cell: number; from: number; to: number; signal?: AbortSignal; count?: BodyCount; failed?: boolean};

/** Real HTTP completion and numerical staging have different cancellation boundaries. */
export async function cancellationTraffic(proxy: Awaited<ReturnType<typeof historyProxy>>, cookie: string, board: string, windows: string[]) {
  const reports = [];
  for (const length of [DAY, 30 * DAY]) for (const mode of ['before-headers', 'during-staging', 'reversal'] as const) {
    const name = `controlled/${length / DAY}d/${mode}`, anchor = cellStart(Date.now() - 60_000, 60_000), cell = cellOf(length);
    const origin = {from: anchor - length, to: anchor}; let selected = origin, phase = `${name}/seed`, latest: HistoryAnswer | undefined, clock = 0;
    const tasks: (() => void)[] = [], frames: (() => void)[] = [], pending = new Set<Promise<HistoryAnswer>>(), reads: Attempt[] = [];
    const preparations = new Preparations({now: () => clock++, post: run => tasks.push(run)});
    const url = (from: number, to: number) => `${proxy.url}/api/history?board=${encodeURIComponent(board)}&cell=${cell}&from=${from}&to=${to}`;
    const store = new HistoryStore({now: () => anchor, preparations,
      read: (_board, requestedCell, from, to, signal) => {
        assert.equal(requestedCell, cell);
        const attempt: Attempt = {phase, cell, from, to, signal}; reads.push(attempt);
        const work = historyBody(url(from, to), cookie, signal, count => {attempt.count = count;}).then(value => {latest = value as HistoryAnswer; return latest;}, error => {attempt.failed = true; throw error;});
        pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
      },
      setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>), dropTimeRange: () => {throw new Error(`${name}: invalid range`);},
    });
    const network = async () => {await flush(); while (pending.size) {await Promise.allSettled([...pending]); await flush();}};
    const drain = async () => {for (let n = 0; n < 100; n++) {await network(); while (tasks.length) tasks.shift()!(); await flush(); if (!tasks.length && !pending.size) return;} throw new Error(`${name}: preparation did not finish`);};
    const waitRead = async () => {const until = Date.now() + 2000; while (!proxy.transfers.some(t => t.phase === phase)) {await flush(); if (Date.now() > until) throw new Error(`${name}: no foreground IO`); await pause(1);}};
    const internals = store as unknown as {responses: Map<object, unknown>; reservations: Map<string, object>};
    const gesture = new Pan({now: () => anchor, commit: range => {assert.ok(range); selected = range; store.choose('24h', range);}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
    const source = Symbol('history'); gesture.register(source, () => ({end: selected.to, future: 0}));
    const unsubscribe = followPan(store, gesture, () => selected);
    try {
      proxy.phase(phase);
      const hello = await historyBody(url(cellStart(origin.from, cell), Math.ceil(origin.to / cell) * cell), cookie) as HistoryAnswer;
      store.choose('24h', origin); store.open(board); store.hello(hello.run); store.snapshot([], windows); await drain();
      const retained = store.get().history!, seed = latest!; assert.ok(retained.series.length >= 12);
      phase = `${name}/gesture`; proxy.phase(phase, mode === 'during-staging' ? 0 : 400);
      const token = gesture.begin({source, input: 'pointer', selected, length, now: anchor, historyStart: seed.historyStart, span: length, width: 1000})!;
      const move = async (pixels: number) => {gesture.move(token, pixels); frames.shift()!(); await flush();};
      await move(-100); await waitRead();
      if (mode === 'during-staging') {
        await network(); assert.ok(internals.responses.size && internals.reservations.size);
        for (let n = 0; n < 20; n++) tasks.shift()?.();
        assert.ok(internals.responses.size && internals.reservations.size, 'the delivered answer must still be staging');
        assert.equal(store.get().history, retained);
      }
      if (mode === 'reversal') {
        await move(100); await network();
        await move(-100); await drain(); gesture.finish(token); await drain();
        const attempts = reads.filter(r => r.phase === phase);
        assert.ok(attempts.length >= 2 && attempts[0].signal?.aborted);
        assert.equal(attempts[0].from, attempts[1].from); assert.equal(attempts[0].to, attempts[1].to, 'the same range is legitimately requested again');
      } else {
        gesture.cancel(token); await drain();
        assert.equal(store.get().history, retained, 'a cancelled raw/staged answer cannot replace the complete frame');
        assert.equal(internals.responses.size, 0); assert.equal(internals.reservations.size, 0);
      }
      await proxy.settled(phase);
      const attempts = reads.filter(r => r.phase === phase); assert.ok(attempts.every(r => r.count?.id));
      const totals = bodyTotals(attempts.map(r => ({count: r.count!, transfer: transferFor(r.count!, proxy.transfers)})));
      const aborted = attempts.filter(r => r.signal?.aborted).length;
      const discardedDelivered = attempts.filter(r => r.signal?.aborted && r.count?.complete).length;
      assert.ok(aborted > 0); if (mode === 'during-staging') assert.equal(discardedDelivered, 1);
      proxy.phase(`${name}/reference`);
      const target = targetOf(length, anchor, `${selected.from}-${selected.to}`, selected), cells = new Set<number>(), chunks: Chunk[] = [];
      for (let k = target.k0; k <= target.k1; k++) cells.add(k * cell);
      for (const [from, to] of readUnion(cells, cell)) {const answer = await historyBody(url(from, to), cookie) as HistoryAnswer; stableHistory(answer, seed, cell); chunks.push(...answer.chunks);}
      const meta = mode === 'reversal' ? latest! : seed;
      assert.deepEqual(store.get().history, {...compose(chunks, meta, target, new Set(windows)), board});
      const report = {name, attempted: attempts.length, completed: attempts.filter(r => r.count?.complete).length, failed: attempts.filter(r => r.failed && !r.signal?.aborted).length, aborted, discardedDelivered, ...totals, finalComplete: true, requests: attempts.map(r => ({from: r.from, to: r.to, id: r.count!.id, aborted: r.signal?.aborted}))};
      reports.push(report); console.error(`bench: ${name}: ${report.attempted} attempts, ${aborted} aborted, ${discardedDelivered} delivered/discarded, ${totals.byteVerdict} body proof`);
    } finally {unsubscribe(); store.close(); preparations.dispose(); await Promise.allSettled([...pending]);}
  }
  return reports;
}
