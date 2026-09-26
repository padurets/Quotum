import {useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent} from 'react';
import {hubNow} from '../lib/api';
import {draggedRange, type TimeRange} from '../lib/timeRange';
import {SWIPE, swiped} from '../lib/swipe';

/** How long a finger rests on a chart before it starts a range. */
const HOLD_MS = 450;

/** How long a chart's content takes to slide in after a step through time. */
const SLIDE_MS = 220;

/**
 * How far a chart's content slides in after it steps through time, in pixels: from
 * where it was drawn to where it is now, so the eye follows which way it went. None
 * unless the period kept about its length (`end` is where measurements end, which for a
 * period ending now may be the hub's clock rather than the page's) and moved by a tenth of
 * it or more: a step, not a live period's clock moving on, nor another period.
 */
export function slideOf(before: {from: number; end: number}, after: {from: number; end: number; to: number}, plotWidth: number) {
  const length = after.end - after.from;
  const moved = after.from - before.from;
  if (length <= 0 || Math.abs(before.end - before.from - length) > length * 0.1 || Math.abs(moved) < length * 0.1 || Math.abs(moved) > length) return 0;
  return (moved / (after.to - after.from)) * plotWidth;
}

/**
 * What the analytics' charts share along their time axis, so each reads and moves the
 * same way: the width it is drawn at (never under 280, with `scale` CSS pixels to a unit),
 * where a moment stands across the plot between `left` and `right` (`x`) and the reverse
 * (`timeAt`), and the cell under the pointer (`hover`, its start), read anew after a step.
 * A mouse or a pen drags a range across it at once, as in Grafana; a finger sliding along
 * it reads its cells, and held still for a moment starts a range instead. A swipe sideways
 * on a touchpad, or Shift with the wheel, steps through time; after a step, what lies in
 * its `.slides` layers slides in from the side it came from, each layer's parent clipped
 * to the plot (`clip`, the id of a clip path the chart defines) meanwhile. `end` is where
 * measurements end. A label telling a time (`.is-pointed`) is read, not dragged from.
 */
export function useTimeAxis({
  from,
  to,
  end,
  cellMs,
  left,
  right,
  onSelect,
  onStep,
}: {
  from: number;
  to: number;
  end: number;
  cellMs: number;
  left: number;
  right: number;
  /** A time range dragged across the chart. */
  onSelect?: (range: TimeRange) => void;
  /** Back (-1) or forward (1) through time. */
  onStep?: (direction: -1 | 1) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  /** Where a drag across the chart started and where it is now, in chart pixels. */
  const [drag, setDrag] = useState<{start: number; end: number} | null>(null);
  /** A finger held on the chart, before it starts a range. */
  const holding = useRef<{px: number; timer: ReturnType<typeof setTimeout>} | null>(null);
  /** Where the pointer last was over the chart, in chart pixels: a step reads the cell under it anew. */
  const pointer = useRef<number | null>(null);
  const cancelHold = () => {
    if (holding.current) clearTimeout(holding.current.timer);
    holding.current = null;
  };
  useEffect(() => () => cancelHold(), []);

  // The wheel is heard natively, so the chart can keep a swipe from scrolling the page
  // sideways or going back in the browser. Nothing renders until the gesture steps.
  const swipe = useRef(SWIPE);
  const stepped = useRef(onStep);
  stepped.current = onStep;
  const dragging = useRef(false);
  dragging.current = drag !== null;
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!stepped.current || dragging.current) return;
      const result = swiped(swipe.current, event);
      swipe.current = result.state;
      if (result.own) event.preventDefault();
      if (result.step) stepped.current(result.step);
    };
    element.addEventListener('wheel', wheel, {passive: false});
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(entries => {
      const measured = entries[0].contentRect.width;
      const drawn = Math.max(280, Math.round(measured));
      setWidth(drawn);
      setScale(measured ? measured / drawn : 1);
    });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const span = Math.max(60_000, to - from);
  const x = (at: number) => left + ((Math.min(to, Math.max(from, at)) - from) / span) * (width - left - right);
  const timeAt = (px: number) => from + ((px - left) / (width - left - right)) * span;
  // After a step the pointer stands over another time: the chart reads that.
  useEffect(() => {
    const px = pointer.current;
    if (px !== null && px >= left && px <= width - right) setHover(Math.floor(timeAt(px) / cellMs) * cellMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, cellMs]);

  const toChart = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * width;
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const px = toChart(event);
    pointer.current = px;
    const held = holding.current;
    // A finger that moves before the hold is up reads the cells instead.
    if (held && Math.abs(px - held.px) > 8) cancelHold();
    if (drag) setDrag({...drag, end: Math.min(width - right, Math.max(left, px))});
    if (px < left || px > width - right) return setHover(null);
    setHover(Math.floor(timeAt(px) / cellMs) * cellMs);
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const px = toChart(event);
    if (!onSelect || event.button !== 0 || px < left || px > width - right || (event.target as Element).closest('.is-pointed')) return;
    const element = event.currentTarget;
    const {pointerId} = event;
    const start = () => {
      holding.current = null;
      element.setPointerCapture(pointerId);
      setDrag({start: px, end: px});
    };
    if (event.pointerType !== 'touch') return start();
    cancelHold();
    holding.current = {px, timer: setTimeout(start, HOLD_MS)};
  };
  // A drag of a few pixels is a click.
  const onPointerUp = () => {
    cancelHold();
    if (!drag || !onSelect) return;
    setDrag(null);
    const range = Math.abs(drag.end - drag.start) >= 6 ? draggedRange(timeAt(drag.start), timeAt(drag.end), Math.min(end, hubNow())) : null;
    if (range) onSelect(range);
  };
  const handlers = {
    onPointerMove,
    onPointerLeave: () => {
      pointer.current = null;
      setHover(null);
    },
    onPointerDown,
    onPointerUp,
    onPointerCancel: () => {
      cancelHold();
      setDrag(null);
    },
    // A held finger starts a range, not the page's menu.
    onContextMenu: (event: {preventDefault: () => void}) => (holding.current || drag) && event.preventDefault(),
  };

  const clip = useId();
  const shown = useRef<{from: number; end: number} | null>(null);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = {from, end};
    const element = svg.current;
    if (!before || !element || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dx = slideOf(before, {from, end, to}, width - left - right);
    if (!dx) return;
    for (const layer of element.querySelectorAll<SVGGElement>('.slides')) {
      const frame = layer.parentElement!;
      // A step taken while the last one still slides goes on from where that one is, not back.
      const moving = getComputedStyle(layer).transform;
      const start = dx + (moving === 'none' ? 0 : new DOMMatrix(moving).m41);
      layer.getAnimations().forEach(animation => animation.cancel());
      frame.setAttribute('clip-path', `url(#${CSS.escape(clip)})`);
      const animation = layer.animate([{transform: `translateX(${start}px)`}, {transform: 'none'}], {duration: SLIDE_MS, easing: 'cubic-bezier(.2, .7, .3, 1)'});
      animation.onfinish = () => frame.removeAttribute('clip-path');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, end]);

  return {box, svg, width, scale, hover, drag, x, timeAt, clip, handlers};
}
