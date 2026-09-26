/**
 * A horizontal swipe on a touchpad, or the wheel with Shift, steps the analytics through
 * time (periods.ts `step`): once per gesture, however long it runs on, momentum included.
 * Which way a gesture goes is settled by its first event: one that starts along the page
 * scrolls it to the end, even if it then turns sideways.
 */
export type Swipe = {axis: 'x' | 'y' | null; sum: number; last: number; stepped: boolean};

export const SWIPE: Swipe = {axis: null, sum: 0, last: -Infinity, stepped: false};

/** A pause this long ends a gesture. */
const END_MS = 200;
/** How far a gesture goes before it steps, in pixels. */
const THRESHOLD = 40;
/** Pixels in a line and a page of a wheel that counts in those (`deltaMode` 1 and 2). */
const SCALE = [1, 16, 400];

type Wheel = {deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean; cancelable: boolean; timeStamp: number};

/**
 * One wheel event of a gesture: the gesture as it goes on, the step it makes (-1 back,
 * 1 forward, 0 none) and whether the event is the chart's, so the page neither scrolls
 * sideways nor goes back in the browser's history. An event that cannot be held back is
 * left alone.
 */
export function swiped(state: Swipe, event: Wheel): {state: Swipe; step: -1 | 0 | 1; own: boolean} {
  if (!event.cancelable) return {state, step: 0, own: false};
  const scale = SCALE[event.deltaMode] ?? 1;
  const [dx, dy] = [event.deltaX * scale, event.deltaY * scale];
  // Shift turns the wheel sideways; some browsers do that themselves and report deltaX.
  const along = event.shiftKey && !dx ? dy : dx;
  let next = event.timeStamp - state.last > END_MS ? SWIPE : state;
  if (!next.axis && (dx || dy)) next = {...next, axis: event.shiftKey || Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'};
  next = {...next, last: event.timeStamp};
  if (next.axis !== 'x') return {state: next, step: 0, own: false};
  if (next.stepped) return {state: next, step: 0, own: true};
  const sum = next.sum + along;
  if (Math.abs(sum) < THRESHOLD) return {state: {...next, sum}, step: 0, own: true};
  return {state: {...next, sum, stepped: true}, step: sum > 0 ? 1 : -1, own: true};
}
