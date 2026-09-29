import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coverAt, placeOf, sideOf} from '../lib/place';

test('a chart\'s tooltip stands whole in the window where it can, never under the bars, and the same once found again', () => {
  // Unraised at 400, 350 tall, in a window 800 tall under bars ending at 60.
  assert.deepEqual(placeOf(400, 350, 800, 60), {by: 0, room: 392}, 'it fits');
  assert.deepEqual(placeOf(500, 350, 800, 60), {by: 58, room: 350}, 'its bottom kept 8 above the window’s');
  assert.deepEqual(placeOf(300, 700, 800, 60), {by: 208, room: 700}, 'taller: higher, still under the bars');
  assert.deepEqual(placeOf(300, 800, 800, 60), {by: 232, room: 724}, 'too tall to fit: 8 under the bars, cut 8 above the window’s bottom');
  // Its chart scrolled under bars ending at 114, in a window 640 tall: it comes down to 8
  // under them, and is cut to what is left below there, not to where it stood hidden.
  assert.deepEqual(placeOf(-38, 548, 640, 114), {by: -160, room: 510});
  assert.deepEqual(placeOf(100, 300, 640, 114), {by: -22, room: 510}, 'partly under them');
  // Measured from where it was drawn, raised, it would find less and sink back, then rise
  // again: that is why where it stands unraised is read from the chart.
  assert.notDeepEqual(placeOf(500 - 58, 350, 800, 60), placeOf(500, 350, 800, 60));
});

test('a panel opens on its own side of its button when it fits there whole', () => {
  // A card's tray at 469 in a window 720 tall under a bar ending at 60: 395 above, 211 below.
  assert.deepEqual(sideOf(300, 395, 211, true), {up: true, cap: null}, 'from a tray, above');
  assert.deepEqual(sideOf(200, 395, 211, false), {up: false, cap: null}, 'a menu, below');
  assert.deepEqual(sideOf(395, 395, 211, true), {up: true, cap: null}, 'just as tall as the room');
});

test('a panel that does not fit on its own side opens on the other where it fits whole', () => {
  // A widget's menu near the window's bottom: 200 below it, 400 above.
  assert.deepEqual(sideOf(362, 400, 200, false), {up: true, cap: null});
  // A card's tray near the window's top: 150 above it, 500 below.
  assert.deepEqual(sideOf(362, 150, 500, true), {up: false, cap: null});
});

test('a panel that fits neither side opens where there is more room, cut to that room rather than to the window', () => {
  // The agents of the first card with the page at its top: 472 tall, which the window has
  // room for (395 above the button and 211 below), but neither side has. Above, cut to 395:
  // it never opens below and scrolls the page to show the rest.
  assert.deepEqual(sideOf(472, 395, 211, true), {up: true, cap: 395});
  assert.deepEqual(sideOf(472, 211, 395, true), {up: false, cap: 395}, 'the tray higher up: below');
  assert.deepEqual(sideOf(472, 211, 395, false), {up: false, cap: 395}, 'a menu, on its own side');
  assert.deepEqual(sideOf(472, 395, 211, false), {up: true, cap: 395}, 'a menu low in the window: above');
  // A menu in the top bar has next to no room above it.
  assert.deepEqual(sideOf(824, 3, 663, false), {up: false, cap: 663});
  // With as much room either way, it stays on its own side.
  assert.deepEqual(sideOf(500, 300, 300, true), {up: true, cap: 300});
  assert.deepEqual(sideOf(500, 300, 300, false), {up: false, cap: 300});
});

test('the bars cover what stands below where they end; a panel, only where they are stuck at the top', () => {
  const topbar = {top: 0, bottom: 60, sticks: 0};
  // The analytics' head sticks under the top bar, 60 down the window.
  const stuck = {top: 60, bottom: 114, sticks: 60};
  const inFlow = {top: 603, bottom: 657, sticks: 60};
  const below = {top: 664, bottom: 718, sticks: 60};
  // A widget of the analytics at the window's bottom, under the head where it stands on the page:
  // a chart's tooltip lies under the head, a panel over it.
  assert.equal(coverAt([topbar, inFlow], 690, false), 657, 'a tooltip');
  assert.equal(coverAt([topbar, inFlow], 690, true), 60, 'a panel');
  assert.equal(coverAt([topbar, stuck], 300, true), 114, 'the head stuck: it covers a panel too');
  assert.equal(coverAt([topbar, stuck], 73, true), 60, 'a button in the head is not under it');
  assert.equal(coverAt([topbar, below], 469, true), 60, 'a card above the analytics');
  assert.equal(coverAt([topbar, {top: 40, bottom: 94, sticks: 60}], 300, true), 94, 'the head pushed up at the end of its section');
  assert.equal(coverAt([topbar], 17, true), 0, 'a button in the top bar');
});
