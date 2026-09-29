/**
 * Where the surfaces that float over the page stand: a chart's tooltip and a panel that
 * opens from a button. Neither scrolls the page nor lengthens it: each stays whole in the
 * window, under the bars that stick at its top and above its bottom, cut to the room there.
 */

/**
 * Where a chart's tooltip stands to stay whole in the window, from where it stands unraised
 * (`top`) and its own `height`: how far it rises (`by`) and how tall it may be (`room`). It
 * rises as far as its bottom would pass the window's, less a margin, never above what covers
 * the top of the page (`cover`, the bars that stick there), and comes down under them when
 * its chart has scrolled beneath; one taller than the room left below where it stands is cut
 * to it. A tooltip that passed the bottom of the last widget would lengthen the page, so a
 * pointer near the page's end would scroll it, lose the cell, and the tooltip would come and go.
 */
export function placeOf(top: number, height: number, windowHeight: number, cover: number) {
  const by = Math.min(Math.max(0, top + height - (windowHeight - 8)), top - cover - 8);
  return {by, room: Math.max(0, windowHeight - 8 - (top - by))};
}

/**
 * Which side of its button a panel opens on, and how tall it may be (`cap`, null for as
 * tall as its content), from its own `height` and the room it has `above` and `below` the
 * button in the window. On its own side (above for one that opens `up`, from a card's tray;
 * below for the rest) when it fits there whole, else on the other when it fits there whole,
 * else on the side with more room, cut to it: it scrolls inside, never the page. A panel
 * the window has room for, but not on its side, is cut to that side, never to the window.
 * One already open on a side (`stands`, `up` being that side) keeps to it, cut to its room,
 * until the other would give it more than twice as much: it does not move from under its
 * reader's pointer for a few more rows.
 */
export function sideOf(height: number, above: number, below: number, up: boolean, stands = false) {
  const [own, other] = up ? [above, below] : [below, above];
  if (height <= own) return {up, cap: null};
  const stays = stands ? own * 2 >= Math.min(height, other) : height > other && own >= other;
  if (stays) return {up, cap: Math.max(0, own)};
  return {up: !up, cap: height <= other ? null : Math.max(0, other)};
}

/**
 * The room a panel has in the window above its button (`at`) and below it, set off from it by
 * `gap` either way: under what covers the window's top (`cover`) and above its bottom, 8 short
 * of each.
 */
export function roomOf(at: {top: number; bottom: number}, gap: number, cover: number, windowHeight: number) {
  return {above: at.top - gap - cover - 8, below: windowHeight - 8 - (at.bottom + gap)};
}

/**
 * Whether a panel cut to `cap` leaves its list, which scrolls on its own while the rest of the
 * panel (`rest` tall: its title, its legend) stays, less than the `least` room the list asks
 * for. Then the whole panel scrolls, the list with it.
 */
export function crampedOf(cap: number | null, rest: number, least: number) {
  return cap !== null && cap - rest < least;
}

/**
 * How far a panel standing from `left` to `right` moves sideways to keep 8 inside the `width`
 * it has, the page's or its dialog's; one wider than that keeps its left edge in.
 */
export function shiftOf(left: number, right: number, width: number) {
  return left < 8 ? 8 - left : right > width - 8 ? width - 8 - right : 0;
}

/**
 * A bar that sticks at the top of the window: where it stands and how far down the window it
 * sticks (its `top`), in CSS pixels, and whether it holds the button of the panel measured.
 */
export type Bar = {top: number; bottom: number; sticks: number; holds?: boolean};

/**
 * How far down the window the `bars` that stick at its top, listed as they lie over each other
 * (the one on top first), cover what stands at `y` (CSS pixels from the window's top). A chart's
 * tooltip lies under them wherever they stand, so for one those that end above it count. A
 * `panel` lies over them, so for one, `y` being the bottom of its button, a bar counts only where
 * it is stuck at the top and begins above that: the analytics' head standing lower on the page
 * is a heading like any other, and the bar that holds the button covers none of it, nor do those
 * under that bar (the head pushed up under the top bar at the end of its section). A button gone
 * under the bars is covered to their end.
 */
export function coverAt(bars: Bar[], y: number, panel: boolean) {
  const holder = bars.findIndex(bar => bar.holds);
  const over = (bar: Bar, i: number) => (panel ? (holder < 0 || i < holder) && bar.top < y && bar.top <= bar.sticks + 0.5 : bar.bottom <= y);
  return Math.max(0, ...bars.filter(over).map(bar => bar.bottom));
}

/** The page's bars that may stick at the top of the window, as they lie over each other: the top bar over the analytics' head. */
export function barsOf() {
  return [...document.querySelectorAll<HTMLElement>('.topbar, .analytics-head')];
}

/**
 * The cover (`coverAt`) of the page's `bars` over what stands at `y`: a chart's tooltip, or the
 * panel of a `button` whose bottom is at `y`. A dialog lies over them all, so a panel in one has none.
 */
export function coverOf(y: number, button?: Element, bars = barsOf()) {
  if (button?.closest('.overlay')) return 0;
  const stuck = bars.flatMap(bar => {
    const style = getComputedStyle(bar);
    if (style.position !== 'sticky') return [];
    const {top, bottom} = bar.getBoundingClientRect();
    return [{top, bottom, sticks: parseFloat(style.top) || 0, holds: !!button && bar.contains(button)}];
  });
  return coverAt(stuck, y, !!button);
}
