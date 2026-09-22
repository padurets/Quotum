import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dropIndex} from '../components/Widgets';

// A grid of three 100px columns with 16px gaps; rows are 200px high.
const card = (id: string, column: number, row: number) => ({id, left: column * 116, right: column * 116 + 100, top: row * 216, bottom: row * 216 + 200, full: false});
const wide = (id: string, row: number) => ({id, left: 0, right: 332, top: row * 216, bottom: row * 216 + 200, full: true});
const row = [card('a', 0, 0), card('b', 1, 0), card('c', 2, 0)];

test('a wide widget goes before or after a whole row, never into one card’s place', () => {
  assert.equal(dropIndex(row, {x: 166, y: 40}, true), 0, 'upper half of the row: before it');
  assert.equal(dropIndex(row, {x: 166, y: 160}, true), 3, 'lower half: after it');
  assert.equal(dropIndex([...row, card('d', 0, 1)], {x: 20, y: 250}, true), 3, 'upper half of the next row: between the rows');
});

test('a card goes between the cards of a row by their middles, and before or after a wide row', () => {
  assert.equal(dropIndex(row, {x: 40, y: 100}, false), 0);
  assert.equal(dropIndex(row, {x: 70, y: 100}, false), 1, 'right of a’s middle: after a');
  assert.equal(dropIndex(row, {x: 320, y: 100}, false), 3);
  const withChart = [wide('chart', 0), ...[card('a', 0, 1), card('b', 1, 1)]];
  assert.equal(dropIndex(withChart, {x: 166, y: 50}, false), 0, 'over the chart’s upper half: before it');
  assert.equal(dropIndex(withChart, {x: 166, y: 150}, false), 1, 'lower half: after it');
});

test('between or beyond rows the nearest row decides; one column works top to bottom', () => {
  assert.equal(dropIndex(row, {x: 166, y: -80}, false), 0);
  assert.equal(dropIndex(row, {x: 166, y: 900}, false), 3);
  const phone = [0, 1, 2].map(i => ({...wide(`card${i}`, i), full: true}));
  assert.equal(dropIndex(phone, {x: 300, y: 216 + 60}, false), 1);
  assert.equal(dropIndex(phone, {x: 300, y: 216 + 150}, false), 2);
});
