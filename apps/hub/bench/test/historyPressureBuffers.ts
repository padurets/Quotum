import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {runInNewContext} from 'node:vm';
import {HistoryPool} from '../../ui/lib/historyPool';
import {historyPressureScript} from '../historyPressure';

type PressurePage = {
  __quotumInspectHistoryPool(pool: HistoryPool): void;
  __quotumHistoryPressure: {read(): {errors: number; rows: {kind: string}[]}};
};

for (const observed of [false, true]) {
  const pool = new HistoryPool(192);
  const page = observed
    ? (runInNewContext(historyPressureScript() + ';window', {
        window: {},
        Map,
        Set,
        performance,
      }) as PressurePage)
    : undefined;
  page?.__quotumInspectHistoryPool(pool);
  const cache = new Set([new ArrayBuffer(64), new ArrayBuffer(128)]);
  const first = new WeakRef([...cache][0]);
  const dropped: number[] = [];
  const member = {
    grids: new Map(),
    get estimatedBytes() {
      return [...cache].reduce((sum, buffer) => sum + buffer.byteLength, 0);
    },
    evictionCandidates: () =>
      [...cache].map(buffer => ({
        bytes: buffer.byteLength,
        shownAt: 0,
        drop() {
          if (dropped.length) {
            global.gc!();
            assert.equal(first.deref(), undefined, 'the first drop has already returned');
          }
          dropped.push(buffer.byteLength);
          cache.delete(buffer);
        },
      })),
  };
  pool.register(member);
  // A WeakRef keeps its target alive until the turn that created it ends.
  await setImmediate();
  assert.ok(pool.reserve({role: 'visible'}, 128));
  assert.deepEqual(dropped, [64, 128]);
  if (page) {
    const {errors, rows} = page.__quotumHistoryPressure.read();
    assert.equal(errors, 0);
    assert.equal(rows.filter(row => row.kind === 'drop-before').length, 2);
  }
}
