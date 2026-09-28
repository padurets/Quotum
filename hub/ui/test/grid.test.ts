import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  cellOf,
  landed,
  legacyLayout,
  narrowed,
  ordered,
  placesOf,
  reading,
  rowsOf,
  settle,
  starts,
  stepped,
  widened,
  widths,
  withPlaces,
  type Item,
  type Spot,
} from '../lib/grid';
const item = (id: string, x = 0, w = 3, h = 7): Item => ({id, x, w, h});
const board = settle([item('P'), item('Q', 3), item('R'), item('S', 3)], 6);
const coords = (spots: Spot[]) => Object.fromEntries(spots.map(({id, x, y}) => [id, [x, y]]));
const at = (spots: Spot[], id: string) => spots.find(s => s.id === id)!;

test('content fills whole rows supported only by the columns beneath it', () => {
  assert.deepEqual([274, 293, 305].map(rowsOf), [7, 7, 7]);
  assert.deepEqual(coords(settle([item('A'), item('B', 3, 3, 9), item('C')], 6)), {A: [0, 0], B: [3, 0], C: [0, 7]});
  assert.equal(at(settle([item('A'), item('B', 3, 3, 12), item('W', 0, 6, 5)], 6), 'W').y, 12);
});

test('occupied and free slots can be taken in every direction', () => {
  for (const [id, x, y, expected] of [
    ['Q', 0, 0, {Q: [0, 0], S: [3, 0], P: [0, 7], R: [0, 14]}],
    ['S', 3, 0, {P: [0, 0], S: [3, 0], R: [0, 7], Q: [3, 7]}],
    ['R', 0, 0, {R: [0, 0], Q: [3, 0], P: [0, 7], S: [3, 7]}],
    ['P', 0, 7, {R: [0, 0], Q: [3, 0], P: [0, 7], S: [3, 7]}],
    ['P', 3, 7, {R: [0, 0], Q: [3, 0], P: [3, 7], S: [3, 14]}],
  ] as const)
    assert.deepEqual(coords(landed(board, id, {x, y}, 6)), expected);
  assert.deepEqual(coords(landed(settle([item('A'), item('B')], 6), 'B', {x: 3, y: 0}, 6)), {A: [0, 0], B: [3, 0]});
});

test('a tall neighbour determines the landing; live heights only change its geometry', () => {
  const origin = settle([item('A'), item('B', 0, 3, 50), item('C', 3, 3, 9)], 6);
  const copy = structuredClone(origin);
  for (const y of [1, 6, 7, 20]) assert.equal(at(landed(origin, 'A', {x: 0, y}, 6), 'A').y, y < 7 ? 0 : 50);
  const below = landed(origin, 'A', {x: 0, y: 7}, 6);
  for (const y of [49, 1, 0]) assert.equal(at(landed(below, 'A', {x: 0, y}, 6), 'A').y, y === 0 ? 0 : 50);
  for (const h of [51, 49]) {
    const live = settle(
      below.map(i => (i.id === 'B' ? {...i, h} : i)),
      6,
    );
    assert.equal(at(live, 'A').y, h);
    assert.deepEqual(
      live.map(i => i.id),
      below.map(i => i.id),
    );
  }
  assert.equal(at(landed(origin, 'A', {x: 0, y: 0}, 6), 'A').y, 0);
  assert.deepEqual(origin, copy);
});

test('corners snap left on a tie, widths fit the remaining columns', () => {
  assert.deepEqual(cellOf({x: 290, y: 326}, 100, 3, 6), {x: 3, y: 7});
  assert.deepEqual(cellOf({x: 250, y: -50}, 100, 3, 6), {x: 2, y: 0});
  assert.deepEqual(cellOf({x: 500, y: 49}, 100, 6, 6), {x: 0, y: 1});
  assert.deepEqual([widths(6, 2), widths(6, 3), widths(6, 4)], [[2, 3, 4], [2, 3], [2]]);
  assert.equal(at(widened(board, 'P', 4, 6), 'Q').y, 7);
});

test('keyboard steps reach the next distinct place, including across a tall neighbour', () => {
  const right = stepped(settle([item('A')], 6), 'A', 'ArrowRight', 6);
  assert.equal(at(right, 'A').x, 2);
  const last = stepped(right, 'A', 'ArrowRight', 6);
  assert.equal(at(last, 'A').x, 3);
  assert.deepEqual(stepped(last, 'A', 'ArrowRight', 6), last);
  const down = stepped(board, 'P', 'ArrowDown', 6);
  assert.equal(at(down, 'P').y, 7);
  assert.deepEqual(stepped(down, 'P', 'ArrowDown', 6), down);
  assert.equal(at(stepped(down, 'P', 'ArrowUp', 6), 'P').y, 0);
  const tall = settle([item('A'), item('B', 0, 3, 50)], 6);
  assert.equal(at(stepped(tall, 'A', 'ArrowDown', 6), 'A').y, 50);
  assert.equal(at(stepped(tall, 'A', 'End', 6), 'A').y, 50);
  assert.equal(at(stepped(stepped(tall, 'A', 'End', 6), 'A', 'Home', 6), 'A').y, 0);
});

test('new widgets follow natural neighbours and hidden places survive changes', () => {
  const ids = ['source:a', 'source:b', 'source:c', 'agents'];
  assert.deepEqual(
    ordered({columns: 6, places: {}}, ids).map(i => [i.x, i.w]),
    [
      [0, 3],
      [3, 3],
      [0, 3],
      [0, 6],
    ],
  );
  const layout = {columns: 6, places: {'source:c': {x: 0, y: 0, w: 3}, 'source:a': {x: 0, y: 7, w: 3}}};
  assert.deepEqual(
    ordered(layout, ids).map(i => i.id),
    ['source:c', 'agents', 'source:a', 'source:b'],
  );
  assert.deepEqual(
    ordered(layout, ids, ['source:c']).map(i => i.id),
    ['source:a', 'source:b', 'agents'],
  );
  const next = withPlaces({layout, order: [], sizes: {}}, {agents: {x: 0, y: 12, w: 6}});
  assert.deepEqual(next.layout.places['source:c'], layout.places['source:c']);
  assert.ok(!('order' in next) && !('sizes' in next));
});

test('narrow screens keep sides and reading order; the middle third takes the shorter stack', () => {
  assert.deepEqual(
    narrowed(board, 2, 6).map(i => i.x),
    [0, 1, 0, 1],
  );
  assert.deepEqual(
    narrowed([item('A', 0, 2), item('B', 2, 2), item('C', 4, 2)], 2, 6).map(i => [i.x, i.y]),
    [
      [0, 0],
      [1, 0],
      [1, 7],
    ],
  );
  assert.deepEqual(
    narrowed([item('A', 0, 4), item('B', 0, 6)], 2, 6).map(i => i.w),
    [2, 2],
  );
  assert.deepEqual(
    narrowed(board, 1, 6).map(i => [i.id, i.x, i.y]),
    [
      ['P', 0, 0],
      ['Q', 0, 7],
      ['R', 0, 14],
      ['S', 0, 21],
    ],
  );
});

const migrate = (spans: number[]) => {
  const cards = spans.map((_, i) => `source:${i}`);
  return legacyLayout({order: cards, sizes: Object.fromEntries(cards.map((id, i) => [id, spans[i]]))}, {cards, analytics: []}, []).layout;
};
test('legacy widths snap wider on a tie; y records rank and areas start separately', () => {
  assert.deepEqual(
    Object.values(migrate([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).places).map(p => p.w),
    [2, 2, 3, 3, 4, 4, 4, 6, 6, 6],
  );
  for (const [spans, xs] of [
    [
      [4, 4, 4],
      [0, 2, 4],
    ],
    [
      [6, 4],
      [0, 3],
    ],
    [
      [4, 6],
      [0, 2],
    ],
    [
      [8, 4],
      [0, 4],
    ],
    [
      [5, 7],
      [0, 0],
    ],
    [
      [12, 6, 6],
      [0, 0, 3],
    ],
  ]) {
    const layout = migrate(spans);
    assert.deepEqual(
      Object.values(layout.places).map(p => p.x),
      xs,
    );
    assert.deepEqual(
      Object.values(layout.places).map(p => p.y),
      spans.map((_, i) => i),
    );
  }
  const layout = migrate([5, 7]);
  assert.deepEqual(
    settle(
      ordered(layout, Object.keys(layout.places)).map(i => ({...i, h: 7})),
      6,
    ).map(i => i.y),
    [0, 7],
  );
  const view = legacyLayout({order: ['source:a', 'history'], sizes: {}}, {cards: ['source:a'], analytics: ['history']}, []);
  assert.deepEqual(view.layout.places.history, {x: 0, y: 0, w: 6});
  assert.equal(legacyLayout(view, {cards: [], analytics: []}, []), view);
});

test('migration retains hidden, absent and sizes-only settings without visible holes', () => {
  const cards = ['source:a', 'source:b', 'source:c', 'agents'];
  const view = legacyLayout(
    {order: ['source:a', 'source:gone', 'source:b', 'source:c', 'agents'], sizes: {'source:a': 12, agents: 4, 'source:gone': 12, unknown: 8}},
    {cards, analytics: []},
    ['source:a', 'agents'],
  );
  assert.deepEqual([view.layout.places['source:b'].x, view.layout.places['source:c'].x], [0, 3]);
  const saved = withPlaces({...view, names: {a: 'Renamed'}}, {});
  assert.deepEqual(
    ['agents', 'source:a', 'source:gone', 'unknown'].map(id => saved.layout.places[id].w),
    [2, 6, 6, 4],
  );
  assert.deepEqual(
    ordered(saved.layout, [...cards, 'source:gone']).map(i => i.id),
    ['source:a', 'source:gone', 'source:b', 'source:c', 'agents'],
  );
  const many = legacyLayout(
    {order: Array.from({length: 200}, (_, i) => `source:o${i}`), sizes: Object.fromEntries(Array.from({length: 200}, (_, i) => [`source:s${i}`, 4]))},
    {cards: ['source:new'], analytics: []},
    [],
  );
  assert.equal(Object.keys(many.layout.places).length, 400);
  assert.ok(!Object.hasOwn(many.layout.places, 'source:new'));
});

test('settling is idempotent and dragging down never moves back, on 1000 generated boards', () => {
  let seed = 52;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let n = 0; n < 1000; n++) {
    const items = Array.from({length: 2 + random(5)}, (_, i) => {
      const w = widths(6)[random(4)];
      const xs = starts(6, w);
      return item(String(i), xs[random(xs.length)], w, 1 + random(12));
    });
    const origin = reading(settle(items, 6));
    assert.deepEqual(reading(settle(origin, 6)), origin);
    const moving = origin[random(origin.length)];
    for (const x of starts(6, moving.w)) {
      let previous = -1;
      for (let y = 0; y <= Math.max(...origin.map(i => i.y + i.h)) + 5; y++) {
        const next = at(landed(origin, moving.id, {x, y}, 6), moving.id).y;
        assert.ok(next >= previous, `board ${n}, x${x}, y${y}`);
        previous = next;
      }
    }
    assert.equal(Object.keys(placesOf(origin)).length, origin.length);
  }
});
