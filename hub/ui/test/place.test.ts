import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coverAt, crampedOf, placeOf, roomOf, shiftOf, sideOf} from '../lib/place';

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
  // A window lower than the bars leave room for: no room, never less.
  assert.deepEqual(sideOf(100, -20, -30, false), {up: true, cap: 0});
});

test('a panel already open keeps to its side while it has room there worth having', () => {
  // Grown by a row with 293 below and 313 above: cut where it is rather than moved from under
  // the pointer, though it would fit above whole, or open there were it opening now.
  assert.deepEqual(sideOf(300, 313, 293, false, true), {up: false, cap: 293});
  assert.deepEqual(sideOf(300, 313, 293, false), {up: true, cap: null});
  assert.deepEqual(sideOf(400, 313, 293, false, true), {up: false, cap: 293});
  assert.deepEqual(sideOf(700, 586, 293, false, true), {up: false, cap: 293}, 'just half the room it would have above');
  assert.deepEqual(sideOf(700, 588, 293, false, true), {up: true, cap: 588}, 'less than half');
  // The window turned, the tray now high in it: moved over where it has twice as much and more.
  assert.deepEqual(sideOf(400, 50, 280, true, true), {up: false, cap: 280});
  assert.deepEqual(sideOf(200, 50, 280, true, true), {up: false, cap: null}, 'and whole there');
  assert.deepEqual(sideOf(200, 250, 280, true), {up: true, cap: null}, 'still on its side where it fits whole');
  // A button partly under the bars leaves no room above it.
  assert.deepEqual(sideOf(200, -20, 280, true, true), {up: false, cap: null});
  // What the other side would give it is what it would take there, not all the room there is.
  assert.deepEqual(sideOf(250, 400, 150, false, true), {up: false, cap: 150}, 'above it would take 250, less than twice the 150 below');
  assert.deepEqual(sideOf(100, -30, -10, false, true), {up: false, cap: 0}, 'no room either way: none, never less');
});

test('a panel has the room between its button, set off by the gap, and the bars or the window\'s bottom', () => {
  // A card's tray from 469 to 495 in a window 720 tall under a bar ending at 60, the panel 6 off it.
  assert.deepEqual(roomOf({top: 469, bottom: 495}, 6, 60, 720), {above: 395, below: 211});
  assert.deepEqual(roomOf({top: 469, bottom: 495}, 6, 114, 720), {above: 341, below: 211}, 'under the analytics\' head as well');
  // A button in the top bar, its panel lying over the bar.
  assert.deepEqual(roomOf({top: 17, bottom: 45}, 6, 0, 720), {above: 3, below: 661});
  assert.deepEqual(roomOf({top: 50, bottom: 78}, 6, 60, 720).above, -24, 'partly under the bar: less than none');
});

test('a cut panel scrolls whole when its list would have less room than it asks for', () => {
  // The agents' list asks for 116 beside the panel's title and legend, 120 tall.
  assert.equal(crampedOf(null, 120, 116), false, 'not cut');
  assert.equal(crampedOf(395, 120, 116), false);
  assert.equal(crampedOf(236, 120, 116), false, 'just the room it asks for');
  assert.equal(crampedOf(235, 120, 116), true);
  assert.equal(crampedOf(0, 120, 116), true);
  assert.equal(crampedOf(100, 0, 0), false, 'a panel whose list asks for nothing');
});

test('a panel moves sideways to keep 8 inside its width', () => {
  assert.equal(shiftOf(100, 380, 390), 0, 'inside');
  assert.equal(shiftOf(8, 382, 390), 0, 'at the margins');
  assert.equal(shiftOf(4, 284, 390), 4, 'inside the window, not its margin');
  assert.equal(shiftOf(100, 386, 390), -4);
  assert.equal(shiftOf(-92, 188, 390), 100, 'past the left');
  assert.equal(shiftOf(150, 430, 390), -48, 'past the right');
  assert.equal(shiftOf(-20, 420, 390), 28, 'wider than the width: its left edge in');
});

test('the bars cover what stands below where they end; a panel, only where they are stuck at the top', () => {
  const topbar = {top: 0, bottom: 60, sticks: 0};
  // The analytics' head sticks under the top bar, 60 down the window.
  const stuck = {top: 60, bottom: 114, sticks: 60};
  const inFlow = {top: 603, bottom: 657, sticks: 60};
  const below = {top: 664, bottom: 718, sticks: 60};
  // A widget of the analytics at the window's bottom, under the head where it stands on the page:
  // a chart's tooltip lies under the head, a panel over it. A panel's button is 28 tall.
  assert.equal(coverAt([topbar, inFlow], 690, false), 657, 'a tooltip');
  assert.equal(coverAt([topbar, stuck], 100, false), 60, 'a tooltip beside the head, not below it');
  assert.equal(coverAt([topbar, stuck], 114, false), 114, 'a tooltip right under the head');
  assert.equal(coverAt([topbar, inFlow], 718, true), 60, 'a panel');
  assert.equal(coverAt([topbar, stuck], 328, true), 114, 'the head stuck: it covers a panel too');
  assert.equal(coverAt([topbar, {...stuck, holds: true}], 101, true), 60, 'a button in the head is not under it');
  assert.equal(coverAt([topbar, below], 497, true), 60, 'a card above the analytics');
  assert.equal(coverAt([topbar, {top: 40, bottom: 94, sticks: 60}], 328, true), 94, 'the head pushed up at the end of its section');
  assert.equal(coverAt([{...topbar, holds: true}, stuck], 45, true), 0, 'a button in the top bar, over the head');
  assert.equal(coverAt([topbar, stuck], 142, true), 114, 'a button right under the head');
  assert.equal(coverAt([topbar, {top: 60.3, bottom: 114.3, sticks: 60}], 328, true), 114.3, 'stuck, to a fraction of a pixel');
  assert.equal(coverAt([topbar, {top: 61, bottom: 115, sticks: 60}], 328, true), 60, 'a pixel short of sticking: in the page still');
  // A button scrolled under the bars is covered to their end, out of sight where it ends above that.
  assert.equal(coverAt([topbar, stuck], 108, true), 114, 'under the head');
  assert.equal(coverAt([topbar, stuck], 48, true), 60, 'under the top bar');
  assert.equal(coverAt([topbar, stuck], 21, true), 60, 'past the window\'s top, the rest under the top bar');
  assert.equal(coverAt([topbar, {top: 40, bottom: 94, sticks: 60}], 58, true), 94, 'under the top bar and the head pushed up under it');
  // The bars listed as they lie over each other: the head pushed up lies under the top bar and
  // covers none of its buttons, while the top bar covers the head's.
  assert.equal(coverAt([{...topbar, holds: true}, {top: 30, bottom: 84, sticks: 60}], 43, true), 0, 'a button in the top bar, the head pushed up under it');
  assert.equal(coverAt([topbar, {top: 40, bottom: 94, sticks: 60, holds: true}], 80, true), 60, 'a button in the head pushed up under the top bar');
  assert.equal(coverAt([topbar, {top: -10, bottom: 44, sticks: 60}], 328, true), 60, 'the head pushed up wholly under the top bar');
});
