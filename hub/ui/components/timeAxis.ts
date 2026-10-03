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

export type DrawingGeometry = {from: number; to: number; end: number};
type Pose = {a: number; b: number; offset: number};

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
 * transaction. Holding Shift also hides readouts before movement starts. HTML owners
 * move the prepared SVG within stationary clips. After an arrow step
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
  ready = true,
}: {
  from: number;
  to: number;
  end: number;
  cellMs: number;
  left: number;
  right: number;
  /** A time range dragged across the chart. */
  onSelect?: (range: TimeRange) => void;
  ready?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const [folding, setFolding] = useState(false);
  const [, present] = useState(0);
  const foldTicket = useRef(0);
  const animations = useRef(new Map<SVGGElement, Animation>());
  // The axis owns these animations; finding them through the DOM flushes styles.
  const animateSlide = (layer: SVGGElement, frames: Keyframe[], options: KeyframeAnimationOptions) => {
    animations.current.get(layer)?.cancel();
    const animation = layer.animate(frames, options);
    animations.current.set(layer, animation);
    const release = () => {if (animations.current.get(layer) === animation) animations.current.delete(layer);};
    animation.finished.then(release, release);
    return animation;
  };
  const cancelSlides = () => {
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();
  };
  useEffect(() => cancelSlides, []);
  const source = useRef(Symbol('chart'));
  const panning = usePanning();
  const shifting = useShifting();
  const historyStart = useHistoryBegins();
  const panPointer = useRef<{token: number; id: number; x: number; left: number; width: number} | null>(null);
  const captured = useRef<(DrawingGeometry & {token: number; visual: DrawingGeometry; pose: Pose; pixelsPerMs: number}) | null>(null);
  const drawing = useRef<DrawingGeometry>({from, to, end});
  const pose = useRef<Pose>({a: 1, b: 0, offset: 0});
  const finalFrame = useRef<number | null>(null);
  const finished = useRef<{visual: DrawingGeometry; stop: PanStop} | null>(null);
  const wheelBounds = useRef<DOMRect | null>(null);
  const panLayers = useRef<HTMLElement[]>([]);
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
    const length = selected ? selected.to - selected.from : periodOf(prefs().range).ms;
    return {source: source.current, input, selected, length, semanticEnd: Math.min(now, visual.from + length), now, historyStart, span: visual.to - visual.from, width: (width - left - right) * scale};
  };
  const wheelPan = useRef<(event: WheelEvent) => boolean>(() => false);
  const wheelInput = (event: WheelEvent) => {
    if (!onSelect || dragging.current) return false;
    const rect = pan.active() && wheelBounds.current ? wheelBounds.current : svg.current?.getBoundingClientRect();
    if (!rect || event.clientX < rect.left + left * scale || event.clientX > rect.right - right * scale) return false;
    wheelBounds.current = rect;
    return pan.wheel(() => startPan('wheel'), event);
  };
  const dragging = useRef(false);
  useLayoutEffect(() => {wheelPan.current = wheelInput; dragging.current = drag !== null;});
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (wheelPan.current(event)) event.preventDefault();
    };
    element.addEventListener('wheel', wheel, {passive: false});
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  const paintPan = useRef(() => {});
  const visualGeometry = (): DrawingGeometry => {
    const base = drawing.current;
    const layer = box.current?.querySelector<SVGGElement>('[data-plot-main] .slides');
    let {a, b, offset} = pose.current;
    if (layer && animations.current.has(layer)) {
      const moving = getComputedStyle(layer).transform;
      if (moving !== 'none') {const matrix = new DOMMatrix(moving); a = matrix.a || 1; b = matrix.e;}
    }
    const span = Math.max(60_000, base.to - base.from);
    const inverse = (px: number) => base.from + (((px - offset) / scale - b) / a - left) / (width - left - right) * span;
    const start = inverse(left * scale), finish = inverse((width - right) * scale);
    return {from: start, to: finish, end: Math.min(base.end, finish)};
  };
  const freezeSlides = () => {
    const layer = box.current?.querySelector<SVGGElement>('[data-plot-main] .slides');
    if (layer && animations.current.has(layer)) {
      const moving = getComputedStyle(layer).transform;
      if (moving !== 'none') {const matrix = new DOMMatrix(moving); pose.current.a = matrix.a || 1; pose.current.b = matrix.e;}
    }
    cancelSlides();
    for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) layer.style.transform = `translateX(${pose.current.b}px) scaleX(${pose.current.a})`;
  };
  const geometry = useRef({end, future: to - end});
  useLayoutEffect(() => {geometry.current = {end: drawing.current.end, future: Math.max(0, visualGeometry().to - visualGeometry().from - (timeRange() ? timeRange()!.to - timeRange()!.from : periodOf(prefs().range).ms))};});
  useLayoutEffect(() => pan.register(source.current, () => {
    const visual = visualGeometry();
    return {end: drawing.current.end, future: Math.max(0, visual.to - visual.from - (timeRange() ? timeRange()!.to - timeRange()!.from : periodOf(prefs().range).ms))};
  }), []);
  const paint = () => {
    const element = svg.current;
    if (!element) return;
    const frame = pan.get();
    if (frame && captured.current?.token !== frame.token) {
      if (finalFrame.current !== null) {cancelAnimationFrame(finalFrame.current); finalFrame.current = null;}
      finished.current = null;
      foldTicket.current++;
      const visual = visualGeometry();
      freezeSlides();
      captured.current = {token: frame.token, ...drawing.current, visual, pose: {...pose.current}, pixelsPerMs: (width - left - right) * scale / (visual.to - visual.from)};
      element.dataset.panToken = String(frame.token);
      element.dataset.panOrigin = String(frame.originEnd);
      element.dataset.panScale = String((visual.to - visual.from) / ((width - left - right) * scale));
      element.dataset.panBase = String(pose.current.offset);
      setFolding(false);
    }
    const origin = captured.current;
    if (frame && origin) pose.current.offset = origin.pose.offset - (frame.to - frame.originEnd) * origin.pixelsPerMs;
    for (const layer of panLayers.current) layer.style.transform = pose.current.offset ? `translateX(${pose.current.offset}px)` : '';
    if (frame) {
      element.dataset.panEnd = String(frame.to);
      if (!element.classList.contains('is-panning')) element.classList.add('is-panning');
      element.classList.toggle('is-grabbing', frame.source === source.current && frame.input === 'pointer');
    } else {
      delete element.dataset.panEnd;
      delete element.dataset.panToken;
      delete element.dataset.panOrigin;
      delete element.dataset.panScale;
      delete element.dataset.panBase;
      element.classList.remove('is-grabbing');
      element.classList.toggle('is-panning', finished.current !== null || folding);
      captured.current = null;
      const held = panPointer.current;
      panPointer.current = null;
      if (held && box.current?.hasPointerCapture(held.id)) box.current.releasePointerCapture(held.id);
      wheelBounds.current = null;
    }
  };
  // Native input keeps the committed surface owners while React prepares a strip.
  useLayoutEffect(() => {
    panLayers.current = [...(box.current?.querySelectorAll<HTMLElement>('.plot-move') ?? [])];
    paintPan.current = paint;
    if (pan.active()) paint();
  });
  useLayoutEffect(() => {
    const unsubscribe = pan.subscribe(() => paintPan.current());
    if (pan.active()) paintPan.current();
    return unsubscribe;
  }, []);
  useLayoutEffect(() => pan.onStop(stop => {
    const origin = captured.current;
    if (!origin || origin.token !== stop.draft.token) return;
    const delta = stop.draft.to - stop.draft.originEnd;
    finished.current = {visual: {...origin.visual, from: origin.visual.from + delta, to: origin.visual.to + delta}, stop};
    setFolding(true);
    // Logical completion is immediate; the last accepted delta still reaches a real RAF.
    finalFrame.current = requestAnimationFrame(() => {
      finalFrame.current = null;
      if (pan.active() || finished.current?.stop !== stop) return;
      pose.current.offset = origin.pose.offset - delta * origin.pixelsPerMs;
      for (const layer of panLayers.current) layer.style.transform = pose.current.offset ? `translateX(${pose.current.offset}px)` : '';
      present(value => value + 1);
    });
    captured.current = null;
  }), []);
  useEffect(() => () => {
    foldTicket.current++;
    if (finalFrame.current !== null) cancelAnimationFrame(finalFrame.current);
    if (pan.source === source.current) pan.cancel();
  }, []);
  useEffect(() => {
    if (panning) {cancelHold(); setDrag(null); setHover(null);}
  }, [panning]);
  useLayoutEffect(() => {svg.current?.classList.toggle('is-panning', panning !== null || folding || finished.current !== null);}, [panning, folding]);
  useLayoutEffect(() => {svg.current?.classList.toggle('is-grabbable', shifting);}, [shifting]);

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

  const basis: DrawingGeometry = captured.current ?? (finished.current && !ready ? drawing.current : {from, to, end});
  const span = Math.max(60_000, basis.to - basis.from);
  const drawX = (at: number) => left + ((at - basis.from) / span) * (width - left - right);
  const x = (at: number) => drawX(Math.min(basis.to, Math.max(basis.from, at)));
  const timeAt = (px: number) => {const visual = visualGeometry(); return visual.from + ((px - left) / (width - left - right)) * (visual.to - visual.from);};
  // After a step the pointer stands over another time: the chart reads that.
  useEffect(() => {
    const px = pointer.current;
    if (!shifting && !panning && !folding && px !== null && px >= left && px <= width - right) setHover(Math.floor(timeAt(px) / cellMs) * cellMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, cellMs, shifting, panning, folding]);

  const toChart = (event: PointerEvent<HTMLDivElement>) => {
    const rect = svg.current!.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * width;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (panPointer.current?.id === event.pointerId) {
      const held = panPointer.current;
      pointer.current = (event.clientX - held.left) / held.width * width;
      pan.move(held.token, held.x - event.clientX);
      held.x = event.clientX;
      return;
    }
    const px = toChart(event);
    pointer.current = px;
    if (panning || folding || (shifting && event.pointerType !== 'touch' && !drag)) return;
    const held = holding.current;
    // A finger that moves before the hold is up reads the cells instead.
    if (held && Math.abs(px - held.px) > 8) cancelHold();
    if (drag) setDrag({...drag, end: Math.min(width - right, Math.max(left, px))});
    if (px < left || px > width - right) return setHover(null);
    setHover(Math.floor(timeAt(px) / cellMs) * cellMs);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const px = toChart(event);
    const shiftPan = event.shiftKey && event.pointerType !== 'touch';
    if (!onSelect || event.button !== 0 || px < left || px > width - right || (!shiftPan && (event.target as Element).closest('.is-pointed'))) return;
    const element = event.currentTarget;
    const {pointerId} = event;
    if (shiftPan) {
      const token = pan.begin(startPan('pointer'));
      if (token !== null) {
        element.setPointerCapture(pointerId);
        const rect = svg.current!.getBoundingClientRect();
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
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
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
    'data-axis-end': basis.end,
    onPointerMove,
    onPointerLeave: () => {
      pointer.current = null;
      setHover(null);
    },
    onPointerDown,
    onPointerUp,
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
      cancelHold();
      setDrag(null);
      if (panPointer.current?.id === event.pointerId) pan.cancel(panPointer.current.token);
    },
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
      if (panPointer.current?.id === event.pointerId && !event.currentTarget.hasPointerCapture(event.pointerId)) pan.cancel(panPointer.current.token);
    },
    // A held finger starts a range, not the page's menu.
    onContextMenu: (event: {preventDefault: () => void}) => (holding.current || drag) && event.preventDefault(),
  };

  const clip = useId();
  const shown = useRef<DrawingGeometry | null>(null);
  const commitDrawing = (next: DrawingGeometry, ready: boolean) => {
    const before = shown.current;
    shown.current = next;
    drawing.current = next;
    const element = svg.current;
    if (!element) return;
    element.dataset.drawFrom = String(next.from);
    element.dataset.drawTo = String(next.to);
    element.dataset.drawReady = String(ready);
    if (pan.active()) {
      // A prepared strip uses the captured base and its frozen matrix, plus the current input offset.
      for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) layer.style.transform = `translateX(${pose.current.b}px) scaleX(${pose.current.a})`;
      paintPan.current();
      return;
    }
    const previous = finished.current;
    if (previous && (!ready || finalFrame.current !== null)) return;
    if (previous) {
      const selected = timeRange(), expected = previous.stop.range;
      const matches = selected === expected || !!selected && !!expected && selected.from === expected.from && selected.to === expected.to;
      if (!matches && !previous.stop.canceled) return;
      finished.current = null;
      const visual = previous.visual;
      const ratio = (next.to - next.from) / (visual.to - visual.from);
      const offset = left * (1 - ratio) + (next.from - visual.from) / (visual.to - visual.from) * (width - left - right);
      pose.current = {a: ratio, b: offset, offset: 0};
      for (const layer of panLayers.current) layer.style.transform = '';
      const ticket = ++foldTicket.current;
      const folds: Animation[] = [];
      for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) {
        layer.style.transform = '';
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches && (Math.abs(ratio - 1) > 1e-9 || Math.abs(offset) > 1e-9)) folds.push(animateSlide(layer, [{transform: `translateX(${offset}px) scaleX(${ratio})`}, {transform: 'none'}], {duration: 160, easing: 'ease-out'}));
      }
      if (!folds.length) {pose.current = {a: 1, b: 0, offset: 0}; setFolding(false);}
      else Promise.allSettled(folds.map(animation => animation.finished)).then(() => {if (foldTicket.current === ticket && !pan.active()) {pose.current = {a: 1, b: 0, offset: 0}; setFolding(false);}});
      return;
    }
    if (!ready) {
      // Navigation can borrow matching old data in the requested projection while its model prepares.
      const ratio = (next.to - next.from) / (to - from);
      pose.current = {a: ratio, b: left * (1 - ratio) + (next.from - from) / (to - from) * (width - left - right), offset: 0};
      for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) layer.style.transform = `translateX(${pose.current.b}px) scaleX(${ratio})`;
      return;
    }
    if (!before || before === next || animations.current.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dx = slideOf(before, next, width - left - right);
    for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) {
      layer.style.transform = '';
      if (dx) animateSlide(layer, [{transform: `translateX(${dx}px)`}, {transform: 'none'}], {duration: SLIDE_MS, easing: 'cubic-bezier(.2, .7, .3, 1)'});
    }
    pose.current = {a: 1, b: 0, offset: 0};
  };

  return {box, svg, width, scale, commitDrawing, visualGeometry, screenX: (at: number) => {const base = drawing.current; return pose.current.a * (left + (at - base.from) / (base.to - base.from) * (width - left - right)) + pose.current.b + pose.current.offset / scale;}, held: finished.current !== null, hover: shifting || panning || folding || finished.current !== null ? null : hover, drag, x, drawX, timeAt, clip, handlers, basis, active: panning !== null, panning: shifting || panning !== null || folding || finished.current !== null};
}
