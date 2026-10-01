import {useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent} from 'react';
import {hubNow} from '../lib/clock';
import {draggedRange, timeRange, type TimeRange} from '../lib/timeRange';
import {pan, usePanning, useShifting, type PanStart, type PanStop} from '../lib/pan';
import {prefs} from '../lib/prefs';
import {periodOf} from '../lib/periods';
import {useHistoryBegins} from '../lib/history';
import {useSizing} from './sizing';

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
 * on a touchpad, Shift with the wheel, or Shift-drag pans both charts through one shared
 * transaction. Holding Shift also hides readouts before movement starts. Its `.slides`
 * layers move within the plot's clip. After an arrow step
 * they slide in from the side it came from. `end` is where
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
}: {
  from: number;
  to: number;
  end: number;
  cellMs: number;
  left: number;
  right: number;
  /** A time range dragged across the chart. */
  onSelect?: (range: TimeRange) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const [folding, setFolding] = useState(false);
  const foldTicket = useRef(0);
  const source = useRef(Symbol('chart'));
  const panning = usePanning();
  const shifting = useShifting();
  const historyStart = useHistoryBegins();
  const panPointer = useRef<{token: number; id: number; x: number; left: number; width: number} | null>(null);
  const captured = useRef<{token: number; from: number; to: number; end: number} | null>(null);
  const finished = useRef<{from: number; to: number; end: number; stop: PanStop} | null>(null);
  const wheelBounds = useRef<DOMRect | null>(null);
  const panLayers = useRef<SVGGElement[]>([]);
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

  const startPan = (input: 'wheel' | 'pointer'): PanStart => {
    const selected = timeRange();
    const now = Math.max(hubNow(), end);
    const visual = visualGeometry();
    return {source: source.current, input, selected, length: selected ? selected.to - selected.from : periodOf(prefs().range).ms, now, historyStart, span: visual.to - visual.from, width: (width - left - right) * scale};
  };
  const wheelPan = useRef<(event: WheelEvent) => boolean>(() => false);
  wheelPan.current = event => {
    if (!onSelect || dragging.current) return false;
    const rect = pan.active() && wheelBounds.current ? wheelBounds.current : svg.current?.getBoundingClientRect();
    if (!rect || event.clientX < rect.left + left * scale || event.clientX > rect.right - right * scale) return false;
    wheelBounds.current = rect;
    return pan.wheel(() => startPan('wheel'), event);
  };
  const dragging = useRef(false);
  dragging.current = drag !== null;
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (wheelPan.current(event)) event.preventDefault();
    };
    element.addEventListener('wheel', wheel, {passive: false});
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  const paintPan = useRef(() => {});
  const visualGeometry = () => {
    const layer = svg.current?.querySelector<SVGGElement>('.slides');
    const moving = layer ? getComputedStyle(layer).transform : 'none';
    if (moving === 'none' || !layer?.getAnimations().length) return {from, to, end};
    const matrix = new DOMMatrix(moving);
    const ratio = matrix.a || 1;
    const span = (to - from) / ratio;
    const start = from + (left * (1 - ratio) - matrix.e) / (width - left - right) * span;
    return {from: start, to: start + span, end};
  };
  const geometry = useRef({end, future: to - end});
  geometry.current = {end, future: to - end};
  useLayoutEffect(() => pan.register(source.current, () => geometry.current), []);
  paintPan.current = () => {
    const element = svg.current;
    if (!element) return;
    const frame = pan.get();
    if (frame && captured.current?.token !== frame.token) {
      finished.current = null;
      foldTicket.current++;
      captured.current = {token: frame.token, ...visualGeometry()};
      panLayers.current = [...element.querySelectorAll<SVGGElement>('.slides')];
      for (const layer of panLayers.current) {
        layer.getAnimations().forEach(animation => animation.cancel());
        layer.parentElement!.setAttribute('clip-path', `url(#${CSS.escape(clip)})`);
      }
      setFolding(false);
    }
    const origin = captured.current;
    const dx = frame && origin ? -(frame.to - frame.originEnd) / (origin.to - origin.from) * (width - left - right) : 0;
    for (const layer of panLayers.current) {
      layer.style.transform = frame ? `translateX(${dx}px)` : '';
    }
    if (frame) {
      element.dataset.panEnd = String(frame.to);
      element.classList.add('is-panning');
      element.classList.toggle('is-grabbing', frame.source === source.current && frame.input === 'pointer');
    } else {
      delete element.dataset.panEnd;
      element.classList.remove('is-grabbing');
      element.classList.remove('is-panning');
      captured.current = null;
      const held = panPointer.current;
      panPointer.current = null;
      if (held && element.hasPointerCapture(held.id)) element.releasePointerCapture(held.id);
      wheelBounds.current = null;
      panLayers.current = [];
    }
  };
  useLayoutEffect(() => {
    const unsubscribe = pan.subscribe(() => paintPan.current());
    if (pan.active()) paintPan.current();
    return unsubscribe;
  }, []);
  useLayoutEffect(() => pan.onStop(stop => {
    const origin = captured.current;
    if (!origin || origin.token !== stop.draft.token) return;
    const delta = stop.presented.to - stop.draft.originEnd;
    finished.current = {from: origin.from + delta, to: origin.to + delta, end: stop.presented.to, stop};
    captured.current = null;
  }), []);
  useEffect(() => () => {
    foldTicket.current++;
    if (pan.source === source.current) pan.cancel();
  }, []);
  useEffect(() => {
    if (panning) {cancelHold(); setDrag(null); setHover(null);}
  }, [panning]);
  useLayoutEffect(() => {svg.current?.classList.toggle('is-panning', panning !== null || folding);}, [panning, folding]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => svg.current?.classList.toggle('is-grabbable', event.shiftKey);
    const blur = () => svg.current?.classList.remove('is-grabbable');
    addEventListener('keydown', key);
    addEventListener('keyup', key);
    addEventListener('blur', blur);
    return () => {removeEventListener('keydown', key); removeEventListener('keyup', key); removeEventListener('blur', blur);};
  }, []);

  const measured = useRef<number | null>(null);
  const measure = (next: number) => {
    // At a fractional scale the same box reads a hair apart (a 60th of a pixel) by its rect and by the observer: no new width.
    if (measured.current !== null && Math.abs(next - measured.current) < 1 / 32) return;
    if (pan.source === source.current) pan.cancel();
    measured.current = next;
    const drawn = Math.max(280, Math.round(next));
    setWidth(drawn);
    setScale(next ? next / drawn : 1);
  };
  // Read before paint too, first and whenever the board gives the chart another width: shown for a frame
  // at a width it is not at, it would be as tall as that width draws it, and move whatever is below it.
  const given = useSizing()?.width;
  useLayoutEffect(() => {
    if (box.current) measure(box.current.getBoundingClientRect().width);
  }, [given]);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(entries => measure(entries[0].contentRect.width));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const basis = captured.current ?? {from, to, end};
  const span = Math.max(60_000, basis.to - basis.from);
  const drawX = (at: number) => left + ((at - basis.from) / span) * (width - left - right);
  const x = (at: number) => drawX(Math.min(basis.to, Math.max(basis.from, at)));
  const timeAt = (px: number) => basis.from + ((px - left) / (width - left - right)) * span;
  // After a step the pointer stands over another time: the chart reads that.
  useEffect(() => {
    const px = pointer.current;
    if (!shifting && !panning && !folding && px !== null && px >= left && px <= width - right) setHover(Math.floor(timeAt(px) / cellMs) * cellMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, cellMs, shifting, panning, folding]);

  const toChart = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * width;
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (panPointer.current?.id === event.pointerId) {
      const held = panPointer.current;
      pointer.current = (event.clientX - held.left) / held.width * width;
      pan.move(held.token, held.x - event.clientX);
      held.x = event.clientX;
      return;
    }
    const px = toChart(event);
    pointer.current = px;
    if (panning || folding || (shifting && !drag)) return;
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
    if (event.shiftKey && event.pointerType !== 'touch') {
      const token = pan.begin(startPan('pointer'));
      if (token !== null) {
        element.setPointerCapture(pointerId);
        const rect = element.getBoundingClientRect();
        panPointer.current = {token, id: pointerId, x: event.clientX, left: rect.left, width: rect.width};
        event.preventDefault();
      }
      return;
    }
    if (pan.active() || folding) return;
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
  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    cancelHold();
    const held = panPointer.current;
    if (held?.id === event.pointerId) {
      panPointer.current = null;
      pan.finish(held.token);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
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
    onPointerCancel: (event: PointerEvent<SVGSVGElement>) => {
      cancelHold();
      setDrag(null);
      if (panPointer.current?.id === event.pointerId) pan.cancel(panPointer.current.token);
    },
    onLostPointerCapture: (event: PointerEvent<SVGSVGElement>) => {
      if (panPointer.current?.id === event.pointerId && !event.currentTarget.hasPointerCapture(event.pointerId)) pan.cancel(panPointer.current.token);
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
    const previous = finished.current;
    if (!before || !element || panning) return;
    if (previous) {
      const selected = timeRange();
      const expected = previous.stop.range;
      const matches = selected === expected || !!selected && !!expected && selected.from === expected.from && selected.to === expected.to;
      if (!matches && !previous.stop.canceled) return;
      finished.current = null;
      if (matches && !previous.stop.changed) return;
      if (matches && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (matches) {
        const ratio = (to - from) / (previous.to - previous.from);
        const offset = left * (1 - ratio) + (from - previous.from) / (previous.to - previous.from) * (width - left - right);
        setFolding(true);
        const ticket = ++foldTicket.current;
        const animations: Animation[] = [];
        for (const layer of element.querySelectorAll<SVGGElement>('.slides')) {
          layer.parentElement!.setAttribute('clip-path', `url(#${CSS.escape(clip)})`);
          animations.push(layer.animate([{transform: `translateX(${offset}px) scaleX(${ratio})`}, {transform: 'none'}], {duration: 160, easing: 'ease-out'}));
        }
        Promise.allSettled(animations.map(animation => animation.finished)).then(() => {if (foldTicket.current === ticket && !pan.active()) setFolding(false);});
        return;
      }
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dx = slideOf(before, {from, end, to}, width - left - right);
    if (!dx) return;
    for (const layer of element.querySelectorAll<SVGGElement>('.slides')) {
      const frame = layer.parentElement!;
      // A step taken while the last one still slides goes on from where that one is, not back.
      const moving = getComputedStyle(layer).transform;
      const start = dx + (moving === 'none' ? 0 : new DOMMatrix(moving).m41);
      layer.getAnimations().forEach(animation => animation.cancel());
      frame.setAttribute('clip-path', `url(#${CSS.escape(clip)})`);
      layer.animate([{transform: `translateX(${start}px)`}, {transform: 'none'}], {duration: SLIDE_MS, easing: 'cubic-bezier(.2, .7, .3, 1)'});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, end, to, panning]);

  return {box, svg, width, scale, hover: shifting || panning || folding ? null : hover, drag, x, drawX, timeAt, clip, handlers, basis, panning: shifting || panning !== null || folding};
}
