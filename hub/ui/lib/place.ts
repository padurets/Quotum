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
 */
export function sideOf(height: number, above: number, below: number, up: boolean) {
  const [own, other] = up ? [above, below] : [below, above];
  if (height <= own) return {up, cap: null};
  if (height <= other) return {up: !up, cap: null};
  const stays = own >= other;
  return {up: stays ? up : !up, cap: Math.max(0, stays ? own : other)};
}

/** A bar that sticks at the top of the window: where it stands and how far down the window it sticks (its `top`), in CSS pixels. */
export type Bar = {top: number; bottom: number; sticks: number};

/**
 * How far down the window the `bars` that stick at its top cover what stands at `y` (CSS
 * pixels from the window's top): those that end above it. A chart's tooltip lies under them
 * wherever they stand. A `panel` lies over them, so for one a bar counts only where it is
 * stuck at the top: the analytics' head standing lower on the page is a heading like any other.
 */
export function coverAt(bars: Bar[], y: number, panel: boolean) {
  return Math.max(0, ...bars.filter(bar => bar.bottom <= y && (!panel || bar.top <= bar.sticks + 0.5)).map(bar => bar.bottom));
}

/**
 * The cover (`coverAt`) of the page's bars over what stands at `y`: a chart's tooltip, or the
 * panel of a `button`. A dialog lies over them all, so a panel in one has none.
 */
export function coverOf(y: number, button?: Element) {
  if (button?.closest('.overlay')) return 0;
  const bars = [...document.querySelectorAll<HTMLElement>('.topbar, .analytics-head')].flatMap(bar => {
    const style = getComputedStyle(bar);
    if (style.position !== 'sticky') return [];
    const {top, bottom} = bar.getBoundingClientRect();
    return [{top, bottom, sticks: parseFloat(style.top) || 0}];
  });
  return coverAt(bars, y, !!button);
}
