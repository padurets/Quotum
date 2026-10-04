import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plotPath} from '../lib/plotPath';

test('money steps hold the previous value until the next observation and preserve gaps',()=>{
  assert.equal(plotPath([[[0,12],[1,10],[2,15]],[[4,9],[5,8]]],true),'M0.0,12.0H1.0V10.0H2.0V15.0M4.0,9.0H5.0V8.0');
});

test('straight rounded runs retain their endpoints without redundant vertices', () => {
  assert.equal(plotPath([Array.from({length: 60}, (_, i): [number, number] => [i, 80])]), 'M0.0,80.0L59.0,80.0');
  assert.equal(plotPath([[[.12, .21], [.22, .31], [.32, .41]]]), 'M0.1,0.2L0.3,0.4');
});

test('steps and holes retain every turning point and their separate runs', () => {
  assert.equal(plotPath([[[0, 0], [1, 0], [1, 1], [2, 1]], [[3, 1], [4, 1]]]), 'M0.0,0.0L1.0,0.0L1.0,1.0L2.0,1.0M3.0,1.0L4.0,1.0');
});

test('collinear reversal keeps the far corner rather than shortening the drawn line', () => {
  assert.equal(plotPath([[[0, 0], [10, 10], [0, 0]]]), 'M0.0,0.0L10.0,10.0L0.0,0.0');
});

test('numeric simplification matches decimal formatting at ties, negative zero and ordinary plot coordinates', () => {
  const reference = (runs: [number, number][][]) => runs.map(run => {
    const kept: {x: number; y: number; text: string}[] = [];
    let before: typeof kept[number] | null = null, last: typeof kept[number] | null = null;
    for (const [x, y] of run) {
      const sx = x.toFixed(1), sy = y.toFixed(1);
      const next = {x: Math.round(Number(sx) * 10), y: Math.round(Number(sy) * 10), text: `${kept.length ? 'L' : 'M'}${sx},${sy}`};
      if (before && last && (last.x - before.x) * (next.y - last.y) === (last.y - before.y) * (next.x - last.x) && (last.x - before.x) * (next.x - last.x) + (last.y - before.y) * (next.y - last.y) >= 0) kept[kept.length - 1] = next;
      else {kept.push(next); before = last;}
      last = next;
    }
    return kept.map(p => p.text).join('');
  }).join('');
  const special = [-0, -.0001, .0001, 2.55, -2.55, 1e22, -1e22, Infinity, -Infinity, NaN];
  let seed = 77;
  const random = () => {seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2 ** 32;};
  const runs: [number, number][][] = [special.map((x, i) => [x, special[special.length - i - 1]])];
  for (let run = 0; run < 200; run++) runs.push(Array.from({length: 200}, (_, i) => {
    const x = run % 3 === 0 ? (i - 100) / 10 + .05 : (random() - .5) * 100_000;
    return [x, run % 2 ? x : (random() - .5) * 1000];
  }));
  assert.equal(plotPath(runs), reference(runs));
});
