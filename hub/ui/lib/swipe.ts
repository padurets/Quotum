/**
 * A horizontal swipe on a touchpad, or the wheel with Shift, moves the analytics through
 * time continuously, including touchpad momentum.
 * Which way a gesture goes is settled by its first event: one that starts along the page
 * scrolls it to the end, even if it then turns sideways.
 */
export type Swipe = {axis: 'x' | 'y' | null; last: number};

export const SWIPE: Swipe = {axis: null, last: -Infinity};

/** A pause this long ends a gesture. */
export const WHEEL_END_MS = 200;
/** Pixels in a line and a page of a wheel that counts in those (`deltaMode` 1 and 2). */
const SCALE = [1, 16, 400];

type Wheel = {deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean; cancelable: boolean; timeStamp: number};

/**
 * One wheel event of a gesture: its normalized CSS pixels and whether it is the chart's,
 * so the page neither scrolls
 * sideways nor goes back in the browser's history. An event that cannot be held back is
 * left alone.
 */
export function swiped(state: Swipe, event: Wheel): {state: Swipe; delta: number; own: boolean; ended: boolean} {
  if (!event.cancelable) return {state, delta: 0, own: false, ended: false};
  const scale = SCALE[event.deltaMode] ?? 1;
  const [dx, dy] = [event.deltaX * scale, event.deltaY * scale];
  // Shift turns the wheel sideways; some browsers do that themselves and report deltaX.
  const along = event.shiftKey && !dx ? dy : dx;
  const ended = event.timeStamp - state.last >= WHEEL_END_MS;
  let next = ended ? SWIPE : state;
  if (!next.axis && (dx || dy)) next = {...next, axis: event.shiftKey || Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'};
  next = {...next, last: event.timeStamp};
  return {state: next, delta: next.axis === 'x' ? along : 0, own: next.axis === 'x', ended};
}
