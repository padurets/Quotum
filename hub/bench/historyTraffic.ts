import assert from 'node:assert/strict';
import {cellStart, compose, expandHistory, targetOf, tileOf, type Chunk, type HistoryAnswer, type HistoryReply} from '../server/domain/history';
import {followPan, HistoryStore} from '../ui/lib/history';
import {Pan} from '../ui/lib/pan';
import type {HistoryTile} from '../ui/lib/historyTiles';
import {HistoryCutChanged, bodyTotals, readUnion, stableHistory, trafficProblems, transferFor} from './historyTrafficBudget';
import {HISTORY_CODEC, historyBody, historyProxy, type BodyCount} from './historyProxy';
import {browserCancellationTraffic, browserHistoryTraffic} from './historyTrafficBrowser';
import type {Browser} from './cdp';
import {cancellationTraffic} from './historyCancellation';

const DAY = 86_400_000;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const flush = async () => {for (let i = 0; i < 5; i++) await Promise.resolve();};
const cellsOf = (from: number, to: number, cell: number) => Array.from({length: (to - from) / cell}, (_, i) => from + i * cell);
const gridsOf = (store: HistoryStore) => (store as unknown as {grids: Map<number, Map<number, HistoryTile>>}).grids;

/** Controlled traffic uses the production gesture, loader and actual HTTP parser;
 * native presentation is measured separately on the unchanged browser route. */
export async function historyTraffic(upstream: string, cookie: string, board: string, windows: string[], browser?: Browser) {
  const proxy = await historyProxy(upstream, browser?.owner), reports = [], invalidated = [], problems: string[] = [];
  try {
    for (const length of [DAY, 30 * DAY]) for (const future of [DAY, 0]) for (const latency of [0, 100, 400]) for (const fraction of [.5, .04]) {
      for (let take = 1; take <= 3; take++) {
        const name = `${length / DAY}d/${future ? 'history' : 'activity'}/${latency}ms/${fraction}/take${take}`, anchor = cellStart(Date.now() - 60_000, 60_000);
        let selected: {from: number; to: number} | null = {from: anchor - length, to: anchor};
        let phase = `${name}/seed`, inFlight = 0, peakFlights = 0, latest: HistoryAnswer | undefined;
        const bodies: {phase: string; count: BodyCount; from: number; to: number}[] = [], attempts: {from: number; to: number; cell: number; phase: string}[] = [];
        const requested = new Set<number>(), visited = new Set<number>(), bridges = new Set<number>();
        let interest: {from: number; to: number} | null = null, freshOverlap = 0, ownershipOverlap = 0;
        const pending = new Set<Promise<unknown>>();
        const store = new HistoryStore({now: () => anchor, preparations: null,
          read: (_board, cell, from, to, signal, _meters, meta) => {
            const readPhase = phase; attempts.push({from, to, cell, phase: readPhase});
            if (readPhase.endsWith('/cold')) {
              const tiles = gridsOf(store).get(cell);
              for (const at of cellsOf(from, to, cell)) {
                const tile = tiles?.get(tileOf(at, cell));
                if (tile && at >= tile.readFrom && at < tile.validTo) freshOverlap++;
                requested.add(at);
              }
              const flights = (store as unknown as {flights: Set<{cell: number; from: number; to: number; controller: AbortController}>}).flights;
              for (const f of flights) if (f.controller.signal !== signal && f.cell === cell && tileOf(from, cell) <= tileOf(f.to - 1, cell) && tileOf(f.from, cell) <= tileOf(to - 1, cell)) ownershipOverlap++;
              for (const tile of tiles?.values() ?? []) {
                if (tile.readTo <= tile.readFrom || tile.to <= from || tile.from >= to || !interest) continue;
                const needed = cellsOf(Math.max(from, tile.from), Math.min(to, tile.to), cell).filter(at => at >= cellStart(interest!.from, cell) && at < Math.ceil(interest!.to / cell) * cell && !(at >= tile.readFrom && at < tile.validTo));
                if (!needed.length) continue;
                const a = needed[0], b = needed.at(-1)! + cell;
                const gap = b < tile.readFrom ? [b, tile.readFrom] : a > tile.validTo && a >= tile.readFrom ? [tile.validTo, a] : null;
                if (gap) {assert.ok((gap[1] - gap[0]) / cell < 60, 'a bridge belongs to one held tile'); for (const at of cellsOf(gap[0], gap[1], cell)) bridges.add(at);}
              }
            }
            inFlight++; peakFlights = Math.max(peakFlights, inFlight);
            const result = historyBody(`${proxy.url}/api/history?board=${encodeURIComponent(board)}&cell=${cell}&from=${from}&to=${to}&meta=${encodeURIComponent(meta?.meta ?? '')}`, cookie, signal, count => bodies.push({phase: readPhase, count, from, to})).then(value => {latest = expandHistory(value as HistoryReply, meta); return latest;});
            pending.add(result);
            void result.then(() => {pending.delete(result); inFlight--;}, () => {pending.delete(result); inFlight--;});
            return result;
          },
          setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>), dropTimeRange: () => {throw new Error('controlled history range was rejected');},
        });
        const settle = async () => {
          const deadline = Date.now() + 15_000;
          for (;;) {
            await flush();
            if (!pending.size) {await pause(20); if (!pending.size) break;}
            await Promise.allSettled([...pending]);
            if (Date.now() > deadline) throw new Error(`${name}: history did not complete`);
          }
        };
        try {
          proxy.phase(phase); store.choose('24h', selected); store.open(board); store.hello((await historyBody(`${proxy.url}/api/history?board=${encodeURIComponent(board)}&cell=300000&from=${cellStart(anchor - DAY, 300000)}&to=${cellStart(anchor, 300000) + 300000}`, cookie) as HistoryAnswer).run); store.snapshot([], windows);
          await settle();
          const seed = latest!; assert.ok(store.get().history);
          const cell = store.get().history!.cellMs;
          phase = `${name}/cold`; proxy.phase(phase, latency);
          const frames: (() => void)[] = [], gesture = new Pan({now: () => anchor, commit: range => {selected = range; store.choose('24h', range);}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
          const history = Symbol('history'), activity = Symbol('activity');
          gesture.register(history, () => ({end: selected?.to ?? anchor, future: selected ? 0 : DAY})); gesture.register(activity, () => ({end: selected?.to ?? anchor, future: 0}));
          const unsubscribe = followPan(store, gesture, () => selected);
          selected = null;
          const token = gesture.begin({source: future ? history : activity, input: 'pointer', selected, length, now: anchor, historyStart: seed.historyStart, span: length + future, width: 1000})!;
          const collect = () => {const frame = gesture.get()!; interest = {from: frame.from, to: Math.min(anchor, frame.to + frame.lookAhead)}; const target = targetOf(length, anchor, 'plot', interest); for (let k = target.k0; k <= target.k1; k++) visited.add(k * cell);};
          collect();
          for (let n = 0; n < 30; n++) {gesture.move(token, -1000 * fraction / 30); frames.shift()!(); collect(); await pause(25);}
          gesture.finish(token); await settle();
          assert.ok(store.get().history); assert.equal(store.get().history!.range, `${selected!.from}-${selected!.to}`);
          const final = store.get().history!, meta = latest!;
          stableHistory(meta, seed, cell);
          assert.equal(freshOverlap, 0, 'fresh cells were read again'); assert.equal(ownershipOverlap, 0, 'conflicting tile writers'); assert.ok(peakFlights <= 2);
          assert.ok([...requested].filter(at => !visited.has(at) && !bridges.has(at)).length <= Math.min(60, Math.ceil(length / cell / 4)), 'unvisited optional cells exceeded the buffer');
          const coldBodies = bodies.filter(b => b.phase === phase);
          await proxy.settled(phase);
          const totals = bodyTotals(coldBodies.map(({count}) => ({count, transfer: transferFor(count, proxy.transfers)})));
          proxy.phase(`${name}/reference`);
          let referenceDecoded = 0, referenceEncoded = 0;
          const readReference = async (from: number, to: number) => {
            const answer = await historyBody(`${proxy.url}/api/history?board=${encodeURIComponent(board)}&cell=${cell}&from=${from}&to=${to}`, cookie, undefined, count => {assert.ok(count.complete); referenceDecoded += count.decoded!; referenceEncoded += count.lower;}) as HistoryAnswer;
            stableHistory(answer, seed, cell); return answer;
          };
          for (const [from, to] of readUnion(requested, cell)) await readReference(from, to);
          const referenceCells = new Set(cellsOf(cellStart(selected!.from, cell), Math.ceil(selected!.to / cell) * cell, cell)), chunks: Chunk[] = [];
          for (const [from, to] of readUnion(referenceCells, cell)) {
            const answer = await historyBody(`${proxy.url}/api/history?board=${encodeURIComponent(board)}&cell=${cell}&from=${from}&to=${to}`, cookie) as HistoryAnswer;
            stableHistory(answer, seed, cell); chunks.push(...answer.chunks);
          }
          assert.deepEqual(final, {...compose(chunks, meta, targetOf(length, anchor, final.range, selected), new Set(windows)), board}, 'independently read series, activity and events differ');
          assert.ok(final.series.length >= 12, 'dense fixture must contain twelve actual series');
          phase = `${name}/warm`; proxy.phase(phase);
          const warmStart = attempts.length;
          for (const direction of [1, -1, 1, -1] as const) for (let n = 0; n <= 30; n++) {
            const delta = (length + future) * fraction * (direction === -1 ? n : 30 - n) / 30;
            store.pan({token: 10, length, from: anchor - length - delta, to: Math.min(anchor, anchor - delta + DAY), direction}); await flush();
          }
          assert.equal(attempts.length, warmStart, 'warm return and repeat must start zero GETs');
          const report = {name, attempts: attempts.filter(r => r.phase.endsWith('/cold')).length, maxAttempts: fraction === .04 ? 2 : future ? 7 : 5, ...totals, referenceDecoded, referenceEncoded, ratios: fraction === .5, warmAttempts: attempts.length - warmStart, bridgeCells: bridges.size, optionalUnvisitedCells: [...requested].filter(at => !visited.has(at) && !bridges.has(at)).length, peakFlights, freshOverlap, ownershipOverlap, series: final.series.length, range: final.range, requests: attempts.filter(r => r.phase.endsWith('/cold'))};
          reports.push(report); problems.push(...trafficProblems(report)); unsubscribe();
          console.error(`bench: ${name}: ${report.attempts} GETs, ${report.warmAttempts} warm GETs, decoded ratio ${report.decoded === null ? 'unknown' : report.decoded / referenceDecoded}, encoded ratio ${report.encodedUpper === null ? 'unknown' : report.encodedUpper / referenceEncoded}`);
          break;
        } catch (error) {
          if (!(error instanceof HistoryCutChanged) || take === 3) throw new Error(`${name}: ${String(error)}`, {cause: error});
          invalidated.push({name, reason: error.message, attempts, bodies});
        } finally {store.close(); await Promise.allSettled([...pending]);}
      }
    }
    const cancellations = await cancellationTraffic(proxy, cookie, board, windows);
    const native = browser ? await browserHistoryTraffic(browser, proxy, cookie, board) : null;
    const nativeCancellations = browser ? await browserCancellationTraffic(browser, proxy, cookie) : null;
    if (native) problems.push(...native.problems);
    return {codec: HISTORY_CODEC, reports, invalidated, cancellations, native, nativeCancellations, problems};
  } finally {await proxy.close();}
}
