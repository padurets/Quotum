import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  cellOf,
  edgeScroll,
  heightIntent,
  landed,
  leftWidths,
  legacyLayout,
  MAX_ROWS,
  narrowed,
  ordered,
  placesOf,
  reading,
  rowsFor,
  rowsOf,
  samePlaces,
  settle,
  starts,
  stepped,
  widened,
  widenedLeft,
  widths,
  withArranged,
  withHeights,
  withPlaces,
  type Item,
  type Layout,
  type Place,
  type Spot,
} from '../lib/grid';
const item = (id: string, x = 0, w = 3, h = 7): Item => ({id, x, w, h});
const board = settle([item('P'), item('Q', 3), item('R'), item('S', 3)], 6);
const coords = (spots: Spot[]) => Object.fromEntries(spots.map(({id, x, y}) => [id, [x, y]]));
const at = (spots: Spot[], id: string) => spots.find(s => s.id === id)!;

test('Home on an already top-right card is a no-op regardless of the result order', () => {
  const next = stepped(board, 'Q', 'Home', 6);
  assert.notDeepEqual(next.map(item => item.id), board.map(item => item.id));
  assert.equal(samePlaces(next, board), true);
  assert.equal(samePlaces(board, next), true);
  assert.equal(samePlaces(stepped(board, 'R', 'Home', 6), board), false);
  assert.equal(samePlaces(widened(board, 'P', 2, 6), board), false);
  assert.equal(samePlaces(board.slice(1), board), false);
});

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

test('a chosen height is kept apart from what content needs: the widget takes the larger, the layout keeps the choice', () => {
  // Pixels whose rows are 7 and 10.
  const px = {7: 300, 10: 450};
  const size = (rows: 7 | 10) => ({min: px[rows], natural: px[rows]});
  assert.deepEqual([7, 10, 7].map(rows => rowsFor(size(rows as 7 | 10), 8)), [8, 10, 8]);
  assert.deepEqual([7, 10, 7].map(rows => rowsFor(size(rows as 7 | 10), undefined)), [7, 10, 7]);
  // A list can show fewer rows than all of it: its least is below what it needs whole.
  assert.equal(rowsFor({min: 150, natural: 2424}, undefined), 51);
  assert.equal(rowsFor({min: 150, natural: 2424}, 8), 8);
  // Before its content is measured a chosen height is taken as it is, never a guess.
  assert.equal(rowsFor(undefined, 8), 8);
  assert.equal(rowsFor(undefined, 2), 2);
  assert.equal(rowsFor(undefined, undefined), rowsOf(224));
  const layout = {columns: 6, places: {a: {x: 0, y: 0, w: 3, h: 9}, b: {x: 3, y: 0, w: 3}}};
  const items = ordered(layout, ['a', 'b']);
  assert.ok(items.every(item => !('h' in item)), 'the chosen height never becomes the measured one');
  assert.deepEqual(placesOf(settle(items.map(item => ({...item, h: 12})), 6)), {a: {x: 0, y: 0, w: 3}, b: {x: 3, y: 0, w: 3}});
});

test('the height asked for is saved only when it changes what shows, in the direction pulled', () => {
  for (const [what, [start, baseline, requested, min], expected] of [
    ['a card at its least, pulled up', [7, 7, 6, 7], undefined],
    ['a chosen 8 below its least of 10, pulled to 9', [10, 10, 9, 10], undefined],
    ['the same, pulled to 11', [10, 10, 11, 10], 11],
    ['a list of 51 rows that can show 4, pulled to 8', [51, 51, 8, 4], 8],
    ['the same list pulled past its least: it stops there', [51, 51, 2, 4], 4],
    ['a chosen 12 whose content needs 5, pulled to 2', [12, 12, 2, 5], 5],
    ['the corner moved only sideways, its least now 12', [10, 10, 10, 12], undefined],
    ['the corner narrowed a chart whose legend wraps, pulled up a row', [8, 9, 7, 9], undefined],
    ['a card grown from 6 to 7 meanwhile, pulled up', [6, 7, 5, 7], undefined],
    ['a card needing more than the most', [210, 210, 209, 210], undefined],
    ['a list of 250 rows, pulled down', [250, 250, 251, 4], undefined],
    ['two agents that need all their rows, one row up', [3, 3, 2, 3], undefined],
    ['pulled past the most', [10, 10, 250, 4], MAX_ROWS],
    ['at the most, one row down', [MAX_ROWS, MAX_ROWS, MAX_ROWS + 1, 4], undefined],
    ['before its least is known', [8, 8, 9, 1], 9],
    ['snapping on release wraps a card taller, pulled down a row', [6, 8, 7, 8], undefined],
    ['the corner widened a widget that now needs 6, pulled up to 7', [8, 6, 7, 6], undefined],
    ['not moved', [8, 8, 8, 1], undefined],
  ] as const)
    assert.equal(heightIntent(start, baseline, requested, min), expected, what);
  assert.equal(MAX_ROWS, 200);
});

test('the page scrolls under a pointer taken toward an edge of the window, never under a click or a drift', () => {
  // A window 900 px high under bars that end at 64: the bands are 64–136 and 828–900.
  const at = (y: number, from: number, {moved = true, sideways = false, pixel = 1} = {}) => edgeScroll({y, from, top: 64, bottom: 900, moved, sideways, pixel});
  for (const [what, scroll, expected] of [
    ['a click\'s jitter at the bottom', at(899, 895, {moved: false}), 0],
    ['pulled down into the band', at(880, 500), 52],
    ['above the band', at(820, 500), 0],
    ['pressed in the band, a drift short of half a row', at(870, 850), 0],
    ['the same, half a row on', at(875, 850), 47],
    ['pressed 20 px from the bottom, a drift of 16', at(896, 880), 0],
    ['the same, a pixel short of the edge\'s last two', at(897, 880), 0],
    ['the same, taken to the edge', at(898.5, 880), 70.5],
    ['the bottom edge pressed on the last pixel, moved along it', at(899, 899), 71],
    ['a corner pressed on the last pixel, moved along it', at(899, 899, {sideways: true}), 0],
    ['a corner pressed 2 px from the bottom, down to the last pixel', at(899, 898, {sideways: true}), 71],
    ['a corner pressed 3 px from the bottom, down to the last pixel', at(899, 897, {sideways: true}), 71],
    ['a corner pressed 20 px from the bottom, a drift sideways and down', at(890, 880, {sideways: true}), 0],
    // Zoomed out to a half or a quarter, the screen's last pixel begins 2 or 4 px above the window's bottom.
    ['at a half, pressed 10 px from the bottom, taken to the last pixel of the screen', at(898, 890, {pixel: 2}), 70],
    ['at a quarter, pressed 20 px from the bottom, taken to the last pixel of the screen', at(896, 880, {pixel: 4}), 68],
    ['the same without the zoom, 2 px short of the edge', at(896, 880), 0],
    ['at a third, the screen\'s last pixel, whose size comes a hair over 3', at(897, 880, {pixel: 1 / Math.fround(1 / 3)}), 69],
    ['pulled up under the bars', at(100, 400), -36],
    ['pressed under the bars, a drift up', at(120, 130), 0],
    ['the same, a pixel short of half a row', at(107, 130), 0],
    ['the same, exactly half a row on', at(106, 130), -30],
    ['the same, further on', at(100, 130), -36],
    ['in the band at the top, going down', at(120, 100), 0],
    ['pressed just under the bars, a drift up over them: half a row counts from the window\'s top', at(66, 80), 0],
    ['in the middle of the window', at(500, 400, {sideways: true}), 0],
  ] as const)
    assert.equal(scroll, expected, what);
});

test('saving places carries every chosen height over; only the height named changes, and null takes it away', () => {
  const saved: Record<string, Place> = {a: {x: 0, y: 0, w: 3, h: 8}, b: {x: 3, y: 0, w: 3}, hidden: {x: 0, y: 30, w: 6, h: 5}};
  const moved = {a: {x: 3, y: 0, w: 3}, b: {x: 0, y: 0, w: 3}};
  assert.deepEqual(withHeights(saved, moved), {a: {x: 3, y: 0, w: 3, h: 8}, b: {x: 0, y: 0, w: 3}});
  assert.deepEqual(withHeights(saved, moved, {id: 'b', rows: 4}), {a: {x: 3, y: 0, w: 3, h: 8}, b: {x: 0, y: 0, w: 3, h: 4}});
  const reset = withHeights(saved, moved, {id: 'a', rows: null});
  assert.deepEqual(reset, {a: {x: 3, y: 0, w: 3}, b: {x: 0, y: 0, w: 3}});
  assert.ok(!('h' in reset.a), 'no key, not undefined or null');
  // As the page applies it: every change works on the latest view, saved or not yet.
  const apply = withArranged<{layout: Layout}>;
  let view: {layout: Layout} = {layout: {columns: 6, places: saved}};
  view = apply(view, {a: {x: 0, y: 0, w: 3}, b: {x: 3, y: 0, w: 3}}, {id: 'b', rows: 12});
  view = apply(view, moved);
  assert.deepEqual(view.layout.places, {a: {x: 3, y: 0, w: 3, h: 8}, b: {x: 0, y: 0, w: 3, h: 12}, hidden: {x: 0, y: 30, w: 6, h: 5}}, 'a step then a move before saving keeps both, and the hidden place');
  view = apply(view, moved, {id: 'b', rows: null});
  assert.deepEqual(view.layout.places.b, {x: 0, y: 0, w: 3});
  view = apply(view, moved, {id: 'a', rows: 9});
  view = apply(view, moved, {id: 'a', rows: null});
  assert.ok(!('h' in view.layout.places.a), 'a step and a reset before saving leave no height');
});

test('the left edge keeps the right one in place and the widget in its row; what it covers goes after it', () => {
  assert.deepEqual([6, 4, 3, 2].map(right => leftWidths(6, right)), [[2, 3, 4, 6], [2, 4], [3], [2]]);
  // P and Q side by side, R and S under them: Q taken leftwards to two thirds.
  const wider = widenedLeft(board, 'Q', 4, 6);
  assert.deepEqual(coords(wider), {Q: [2, 0], P: [0, 7], S: [3, 7], R: [0, 14]});
  assert.equal(at(wider, 'Q').w, 4);
  assert.deepEqual(coords(widenedLeft(board, 'Q', 6, 6)), {Q: [0, 0], P: [0, 7], S: [3, 7], R: [0, 14]});
  // Narrower from the left: the right edge stays, nothing moves but it.
  const narrow = widenedLeft(board, 'Q', 2, 6);
  assert.deepEqual([at(narrow, 'Q').x, at(narrow, 'Q').w], [4, 2]);
  assert.deepEqual(coords(narrow), {P: [0, 0], Q: [4, 0], R: [0, 7], S: [3, 7]});
  // A widget above is not passed: over its columns the widget goes under it.
  const tall = settle([item('A', 0, 3, 12), item('B', 3, 3, 4), item('C', 3, 3, 4)], 6);
  assert.deepEqual(coords(widenedLeft(tall, 'C', 4, 6)), {A: [0, 0], B: [3, 0], C: [2, 12]});
  const copy = structuredClone(board);
  widenedLeft(board, 'P', 3, 6);
  assert.deepEqual(board, copy, 'the origin stays as it was');
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
