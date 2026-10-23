import {useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent} from 'react';
import {hubNow} from '../lib/clock';
import {draggedRange, timeRange, type TimeRange} from '../lib/timeRange';
import {pan, usePanning, useShifting, type PanStart, type PanStop} from '../lib/pan';
import {prefs} from '../lib/prefs';
import {periodOf} from '../lib/periods';
import {useHistoryBegins} from '../lib/history';
import {useSizing} from './sizing';
import {axisNavigation, navigationAt, navigationKey, type AxisNavigation} from '../lib/axisNavigation';
import {tickKeyframes,tickPresentation,tickVisible} from '../lib/axisTicks';

/** How long a finger rests on a chart before it starts a range. */
const HOLD_MS = 450;

/** How long a chart's content takes to slide in after a step through time. */
const SLIDE_MS = 220;

export type DrawingGeometry = {from: number; to: number; end: number};
type Pose = {a: number; b: number; offset: number};
type Motion = {key: string; until: number; fold: boolean; start: Pose; end: Pose; boundary: {start: number; end: number}; options: KeyframeAnimationOptions; started: Animation['startTime']};
type Tick = {element: SVGTextElement; x: number; length: number};

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
 * A precise readout also keeps `hoverAt`, the pointer's time inside that cell.
 * A mouse or a pen drags a range across it at once, as in Grafana; a finger sliding along
 * it reads its cells, and held still for a moment starts a range instead. A swipe sideways
 * on a touchpad, Shift with the wheel, or Shift-drag pans all five charts through one shared
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
  rawPointer = false,
  precise = rawPointer,
  navigation = axisNavigation(null, timeRange(), prefs()),
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
  rawPointer?:boolean;
  /** Explicit quota and monetary bounds can end inside a grid cell. */
  precise?: boolean;
  navigation?: AxisNavigation;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const [folding, setFolding] = useState(false);
  const [, present] = useState(0);
  const foldTicket = useRef(0);
  const animations = useRef(new Map<SVGElement, Animation>());
  const animationPoses = useRef(new WeakMap<Animation, {from: Pose; to: Pose}>());
  // The axis owns these animations; finding them through the DOM flushes styles.
  const animateSlide = (layer: SVGElement, frames: Keyframe[], options: KeyframeAnimationOptions, owner: Element = layer, started: Animation['startTime'] = null) => {
    animations.current.get(layer)?.cancel();
    const animation = owner.animate(frames, options);
    if (started !== null) animation.startTime = started;
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
  const captured = useRef<(DrawingGeometry & {token: number; visual: DrawingGeometry; pose: Pose; pixelsPerMs: number; navigation: AxisNavigation; innerWidth: number; cssScale: number; left: number}) | null>(null);
  const drawing = useRef<DrawingGeometry>({from, to, end});
  const pose = useRef<Pose>({a: 1, b: 0, offset: 0});
  const finalFrame = useRef<number | null>(null);
  const finishPresentation = useRef<(() => void) | null>(null);
  const requestedNavigation: AxisNavigation = {context: `${navigation.context}:${left}:${right}:${width}:${scale}`, range: navigation.range};
  const wanted = useRef({navigation: requestedNavigation, projection: {from, to, end}, positioned: false});
  const motion = useRef<Motion | null>(null);
  const finished = useRef<{visual: DrawingGeometry; stop: PanStop; navigation: AxisNavigation} | null>(null);
  const wheelBounds = useRef<DOMRect | null>(null);
  const panLayers = useRef<HTMLElement[]>([]);
  const paintTicks = useRef(() => {});
  const animateTicks = useRef<(running: Motion) => Animation[]>(() => []);
  const paintDrawing = useRef<((stop?: PanStop) => void) | undefined>(undefined);
  // Strips replace nodes; their shared axis font keeps the same shaped glyphs.
  const tickWidths=useRef(new Map<string,number>());
  const tickGlyphs=useRef(new WeakMap<SVGTextElement,{x:number;a:number;b:number;transform:string;motion?:Motion;length?:number}>());
  const tickElements=useRef<Tick[]>([]);
  useEffect(()=>{
    const fonts=document.fonts;
    const changed=()=>{tickWidths.current.clear();present(value=>value+1);};
    fonts.addEventListener('loadingdone',changed);
    return()=>fonts.removeEventListener('loadingdone',changed);
  },[]);
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
    // Accepted input belongs to the next origin even before its final RAF.
    if (!finished.current?.stop.canceled) finishPresentation.current?.();
    const selected = timeRange();
    const now = Math.max(hubNow(), end);
    const visual = visualGeometry();
    const length = selected ? selected.to - selected.from : periodOf(prefs().range).ms;
    return {source: source.current, input, selected, length, semanticEnd: Math.min(now, visual.end), now, historyStart, span: visual.to - visual.from, width: (width - left - right) * scale};
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
  const readPose = (layer: SVGGElement): Pose => {
    const animation = animations.current.get(layer);
    if (!animation) return pose.current;
    const frames = animationPoses.current.get(animation);
    if (frames) {
      // Effect progress includes easing without reading the surface's computed style.
      const progress = animation.effect?.getComputedTiming().progress;
      if (progress === null) return pose.current;
      if (progress !== undefined) return {a: frames.from.a + (frames.to.a - frames.from.a) * progress,
        b: frames.from.b + (frames.to.b - frames.from.b) * progress, offset: 0};
    }
    const owner = (animation.effect as KeyframeEffect | null)?.target ?? layer;
    const matrix = new DOMMatrix(getComputedStyle(owner).transform);
    // A fold moves the HTML surface relative to its final SVG projection.
    // Freezing that composition restores non-scaling strokes before new input.
    return owner === layer ? {...pose.current, a: matrix.a, b: matrix.e}
      : {...pose.current, a: matrix.a * pose.current.a, b: matrix.a * pose.current.b + matrix.e / scale};
  };
  const visualGeometry = (): DrawingGeometry => {
    const base = drawing.current;
    const layer = animations.current.size ? box.current?.querySelector<SVGGElement>('[data-plot-main] .slides') : null;
    const {a, b, offset} = layer ? readPose(layer) : pose.current;
    const span = Math.max(60_000, base.to - base.from);
    const inverse = (px: number) => base.from + (((px - offset) / scale - b) / a - left) / (width - left - right) * span;
    const start = inverse(left * scale), finish = inverse((width - right) * scale);
    const owner = captured.current?.visual ?? finished.current?.visual ?? wanted.current.projection;
    let boundary = finish - Math.max(0, owner.to - owner.end);
    const running = motion.current;
    if (running) {
      // The measurement boundary moves in the same affine plane as the artwork.
      // Fractions avoid interpolating large epoch timestamps or reading a timer.
      const da = running.end.a - running.start.a, db = running.end.b - running.start.b;
      const progress = Math.max(0, Math.min(1, Math.abs(da) > 1e-9 ? (a - running.start.a) / da : Math.abs(db) > 1e-9 ? (b - running.start.b) / db : 1));
      const at = running.boundary.start + (running.boundary.end - running.boundary.start) * progress;
      boundary = start + at * (finish - start);
    }
    return {from: start, to: finish, end: Math.min(boundary, finish)};
  };
  const freezeSlides = () => {
    const layer = box.current?.querySelector<SVGGElement>('[data-plot-main] .slides');
    if (layer) pose.current = readPose(layer);
    cancelSlides();
    for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) layer.style.transform = `translateX(${pose.current.b}px) scaleX(${pose.current.a})`;
    paintTicks.current();
  };
  useLayoutEffect(() => pan.register(source.current, () => {
    const visual = visualGeometry();
    return {end: wanted.current.projection.end, future: Math.max(0, visual.to - visual.end)};
  }), []);
  const paint = () => {
    const element = svg.current;
    if (!element) return;
    const frame = pan.get();
    if (frame && captured.current?.token !== frame.token) {
      if (!finished.current?.stop.canceled) finishPresentation.current?.();
      const visual = visualGeometry();
      finishPresentation.current = null;
      if (finalFrame.current !== null) {cancelAnimationFrame(finalFrame.current); finalFrame.current = null;}
      finished.current = null;
      foldTicket.current++;
      motion.current = null;
      freezeSlides();
      captured.current = {token: frame.token, ...drawing.current, visual, pose: {...pose.current}, pixelsPerMs: (width - left - right) * scale / (visual.to - visual.from), navigation: navigationAt(wanted.current.navigation,frame.origin), innerWidth: width - left - right, cssScale: scale, left};
      element.dataset.panToken = String(frame.token);
      element.dataset.panOrigin = String(frame.originEnd);
      element.dataset.panScale = String((visual.to - visual.from) / ((width - left - right) * scale));
      element.dataset.panBase = String(pose.current.offset);
      element.dataset.panMinEnd = String(pan.oldestEnd);
      element.dataset.panMaxEnd = String(pan.newestEnd);
      setFolding(false);
    }
    const origin = captured.current;
    if (frame && origin) pose.current.offset = origin.pose.offset - (frame.to - frame.originEnd) * origin.pixelsPerMs;
    for (const layer of panLayers.current) layer.style.transform = pose.current.offset ? `translateX(${pose.current.offset}px)` : '';
    paintTicks.current();
    if (frame) {
      paintDrawing.current?.();
      element.dataset.panEnd = String(frame.to);
      if (!element.classList.contains('is-panning')) element.classList.add('is-panning');
      element.classList.toggle('is-grabbing', frame.source === source.current && frame.input === 'pointer');
    } else {
      delete element.dataset.panEnd;
      delete element.dataset.panToken;
      delete element.dataset.panOrigin;
      delete element.dataset.panScale;
      delete element.dataset.panBase;
      delete element.dataset.panMinEnd;
      delete element.dataset.panMaxEnd;
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
    const delta = stop.canceled ? 0 : stop.draft.to - stop.draft.originEnd;
    finished.current = {visual: {from: origin.visual.from + delta, to: origin.visual.to + delta, end: origin.visual.end + delta}, stop, navigation: navigationAt(origin.navigation, stop.range)};
    setFolding(true);
    // A new gesture can consume this final pose before its scheduled RAF.
    const finish = () => {
      if (finished.current?.stop !== stop) return;
      if (finalFrame.current !== null) cancelAnimationFrame(finalFrame.current);
      finalFrame.current = null;
      finishPresentation.current = null;
      const base = drawing.current;
      if (base.from === origin.from && base.to === origin.to) {
        pose.current = {...origin.pose, offset: origin.pose.offset - delta * origin.pixelsPerMs};
      } else {
        const visual = finished.current.visual, span = Math.max(60_000, visual.to - visual.from);
        const a = Math.max(60_000, base.to - base.from) / span;
        pose.current = {a, b: origin.left * (1 - a) + (base.from - visual.from) / span * origin.innerWidth, offset: 0};
      }
      for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) layer.style.transform = `translateX(${pose.current.b}px) scaleX(${pose.current.a})`;
      for (const layer of panLayers.current) layer.style.transform = pose.current.offset ? `translateX(${pose.current.offset}px)` : '';
      paintTicks.current();
      paintDrawing.current?.(stop);
      present(value => value + 1);
    };
    finishPresentation.current = finish;
    finalFrame.current = requestAnimationFrame(() => {
      if (pan.active() || finished.current?.stop !== stop) return;
      finalFrame.current = null;
      finish();
    });
    captured.current = null;
  }), []);
  useEffect(() => () => {
    foldTicket.current++;
    finishPresentation.current = null;
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

  const basis: DrawingGeometry = captured.current ?? (finished.current && navigationKey(finished.current.navigation) === navigationKey(requestedNavigation) && !ready ? drawing.current : {from, to, end});
  const span = Math.max(60_000, basis.to - basis.from);
  const drawX = (at: number) => left + ((at - basis.from) / span) * (width - left - right);
  const x = (at: number) => drawX(Math.min(basis.to, Math.max(basis.from, at)));
  const timeAt = (px: number) => {const visual = visualGeometry(); return visual.from + ((px - left) / (width - left - right)) * (visual.to - visual.from);};
  const readPointer = (px: number) => {const at=timeAt(px);setHover(precise?at:Math.floor(at/cellMs)*cellMs);};
  // After a step the pointer stands over another time: the chart reads that.
  useEffect(() => {
    const px = pointer.current;
    if (!shifting && !panning && !folding && px !== null && px >= left && px <= width - right) readPointer(px);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, cellMs, shifting, panning, folding, precise]);

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
    readPointer(px);
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
  const projectionOf = (base: DrawingGeometry, target: DrawingGeometry) => {
    const span = Math.max(60_000, target.to - target.from), a = Math.max(60_000, base.to - base.from) / span;
    return {a, b: left * (1 - a) + (base.from - target.from) / span * (width - left - right), offset: 0};
  };
  const projectTo = (target: DrawingGeometry) => {
    pose.current = projectionOf(drawing.current, target);
    for (const layer of panLayers.current) layer.style.transform = '';
    for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) layer.style.transform = `translateX(${pose.current.b}px) scaleX(${pose.current.a})`;
    paintTicks.current();
  };
  const retirePresentation = () => {
    foldTicket.current++;
    if (finalFrame.current !== null) {cancelAnimationFrame(finalFrame.current); finalFrame.current = null;}
    finished.current = null;
    motion.current = null;
    cancelSlides();
    setFolding(false);
    svg.current?.classList.toggle('is-panning', pan.active() !== null);
  };
  const animateProjection = (visual: DrawingGeometry, target: DrawingGeometry, duration: number, fold: boolean) => {
    cancelSlides();
    const start = projectionOf(drawing.current, visual);
    projectTo(target);
    const end = {...pose.current};
    const ticket = ++foldTicket.current;
    const key = navigationKey(wanted.current.navigation);
    const moving: Animation[] = [];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced && duration > 0 && (Math.abs(start.a - end.a) > 1e-9 || Math.abs(start.b - end.b) > 1e-9)) {
      const options = {duration, easing: fold ? 'ease-out' : 'cubic-bezier(.2, .7, .3, 1)'};
      const boundary = {start: (visual.end - visual.from) / Math.max(60_000, visual.to - visual.from), end: (target.end - target.from) / Math.max(60_000, target.to - target.from)};
      const running: Motion = {key, until: performance.now() + duration, fold, start, end, boundary, options, started: document.timeline.currentTime};
      for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) {
        // Dates animate independently of the drawing so their glyphs never scale.
        const owner = fold && !layer.parentElement?.querySelector('.time-ticks') ? layer.closest<HTMLElement>('.plot-move') : null;
        const a = start.a / end.a, b = (start.b - a * end.b) * scale;
        const frames = owner ? [{transform: `translateX(${b}px) scaleX(${a})`}, {transform: 'none'}]
          : [{transform: `translateX(${start.b}px) scaleX(${start.a})`}, {transform: `translateX(${end.b}px) scaleX(${end.a})`}];
        const animation = animateSlide(layer, frames, options, owner ?? layer, running.started);
        animationPoses.current.set(animation, {from: start, to: end});
        moving.push(animation);
      }
      if (moving.length) {
        motion.current = running;
        moving.push(...animateTicks.current(running));
        // An inactive document starts all effects when its timeline becomes
        // available. Replacement labels inherit that same original start.
        if (running.started === null) moving[0].ready.then(() => {
          if (motion.current !== running) return;
          running.started = moving[0].startTime;
          if (running.started !== null) for (const animation of animations.current.values()) animation.startTime = running.started;
        }, () => {});
      }
    }
    if (!moving.length) {motion.current = null; setFolding(false); return;}
    setFolding(fold);
    Promise.allSettled(moving.map(animation => animation.finished)).then(() => {
      if (foldTicket.current === ticket && !pan.active() && navigationKey(wanted.current.navigation) === key) {motion.current = null; setFolding(false);}
    });
  };
  const wantedProjection = () => {
    const key = navigationKey(requestedNavigation);
    const previous = wanted.current;
    const changed = navigationKey(previous.navigation) !== key;
    const held = finished.current && navigationKey(finished.current.navigation) === key ? finished.current : null;
    // History arriving after a gesture may have a different numeric extent. The
    // reader's final time-to-pixel mapping outlives that replacement.
    const range = held?.stop.range;
    const positioned = held ? !!range && Math.abs(held.visual.from - range.from) <= 1 && Math.abs(held.visual.end - range.to) <= 1 : !changed && previous.positioned;
    const projection = positioned ? held?.visual ?? previous.projection : {from, to, end};
    return {navigation: requestedNavigation, projection, positioned};
  };
  /** The viewport this commit presents, independently of its paths' numeric basis. */
  const presentation = (ready: boolean): {from: number; to: number} => {
    const key = navigationKey(requestedNavigation), frame = pan.get();
    const origin = captured.current, held = finished.current;
    if (frame && origin?.token === frame.token && navigationKey(origin.navigation) === key ||
      held && navigationKey(held.navigation) === key && (!ready || finalFrame.current !== null)) {
      // These held/native poses have no animation. Cancellation's restored pose
      // becomes visible only on its final RAF, even when data is already ready.
      const {from, to} = visualGeometry();
      return {from, to};
    }
    const {from, to} = wantedProjection().projection;
    return {from, to};
  };
  const publishWanted = () => {
    const key = navigationKey(requestedNavigation);
    const previous = wanted.current;
    const changed = navigationKey(previous.navigation) !== key;
    if (pan.active() && captured.current && navigationKey(captured.current.navigation) !== key) pan.cancel();
    const held = finished.current;
    const next = wantedProjection(), projection = next.projection;
    wanted.current = next;
    const superseded = !!held && navigationKey(held.navigation) !== key || !!motion.current && motion.current.key !== key;
    if (superseded) retirePresentation();
    if (!pan.active() && !finished.current && (changed || superseded || previous.projection.from !== projection.from || previous.projection.to !== projection.to)) {
      // Navigation places the already drawn data in its new frame immediately.
      // Readiness only swaps data/basis and cannot replay a superseded final pose.
      const running = motion.current;
      if (!changed && !superseded && running) animateProjection(visualGeometry(), projection, Math.max(0, running.until - performance.now()), running.fold);
      else {cancelSlides(); motion.current = null; foldTicket.current++; setFolding(false); projectTo(projection);}
    }
  };
  useLayoutEffect(publishWanted);

  const commitDrawing = (next: DrawingGeometry, ready: boolean, afterPose?: (stop?: PanStop) => void) => {
    paintDrawing.current = afterPose;
    const before = drawing.current;
    const movedBasis = before.from !== next.from || before.to !== next.to;
    const visual = movedBasis ? visualGeometry() : null;
    drawing.current = next;
    const element = svg.current;
    if (!element) return;
    element.dataset.drawFrom = String(next.from);
    element.dataset.drawTo = String(next.to);
    element.dataset.drawReady = String(ready);
    if (pan.active()) {
      for (const layer of box.current?.querySelectorAll<SVGGElement>('.slides') ?? []) layer.style.transform = `translateX(${pose.current.b}px) scaleX(${pose.current.a})`;
      paintPan.current();
      return;
    }
    if (finished.current && navigationKey(finished.current.navigation) !== navigationKey(wanted.current.navigation)) retirePresentation();
    const previous = finished.current;
    if (previous) {
      if (!ready || finalFrame.current !== null) {if (visual) projectTo(visual); return;}
      const positioned = wantedProjection().positioned;
      finished.current = null;
      if (previous.stop.range && positioned) {
        wanted.current = {...wanted.current, projection: previous.visual, positioned: true};
        cancelSlides(); motion.current = null; foldTicket.current++;
        projectTo(previous.visual); setFolding(false);
        return;
      }
      animateProjection(previous.visual, wanted.current.projection, 160, true);
      return;
    }
    const running = motion.current;
    if (running && movedBasis && visual) {
      animateProjection(visual, wanted.current.projection, Math.max(0, running.until - performance.now()), running.fold);
      return;
    }
    if (running) return;
    // A borrowed model already shows the wanted frame. Its ready replacement
    // keeps those coordinates rather than animating the same navigation again.
    if (!ready || !visual || !slideOf(visual, wanted.current.projection, width - left - right)) {projectTo(wanted.current.projection); return;}
    animateProjection(visual, wanted.current.projection, SLIDE_MS, false);
  };

  useLayoutEffect(() => {
    // Measure only after DOM commit. Native input reuses these widths without
    // reading layout, and hides a whole edge date instead of clipping its digits.
    const ticks=[...(box.current?.querySelectorAll<SVGTextElement>('.time-ticks text.tick')??[])].map(element=>{
      const text=element.textContent??'';let length=tickWidths.current.get(text);
      if(length===undefined){
        length=element.getComputedTextLength();
        if(tickWidths.current.size>=128)tickWidths.current.delete(tickWidths.current.keys().next().value!);
        tickWidths.current.set(text,length);
      }
      return {element,x:Number(element.getAttribute('x')),length};
    });
    const retained=new Set(ticks.map(tick=>tick.element));
    for(const {element} of tickElements.current)if(!retained.has(element)){
      animations.current.get(element)?.cancel();
      animations.current.delete(element);
    }
    tickElements.current=ticks;
    paintTicks.current=()=>{
      for(const {element,x,length} of ticks){
        const visibility=tickVisible(x,length,pose.current,scale,left,width-right)?'':'hidden';
        if(element.style.visibility!==visibility)element.style.visibility=visibility;
        // CSS rounds fractional transforms; comparing its serialization would
        // parse the same glyph transform again on every translated frame.
        const glyph=tickGlyphs.current.get(element);
        if(glyph?.a!==pose.current.a||glyph.b!==pose.current.b||glyph.x!==x){
          const transform=tickPresentation(x,length,pose.current,scale,left,width-right).transform;
          if(glyph?.transform!==transform)element.style.transform=transform;
          tickGlyphs.current.set(element,{x,a:pose.current.a,b:pose.current.b,transform});
        }
      }
    };
    paintTicks.current();
    animateTicks.current=running=>{
      const moving:Animation[]=[];
      for(const {element,x,length} of ticks){
        const glyph=tickGlyphs.current.get(element)!;
        if(glyph.motion===running&&glyph.length===length)continue;
        moving.push(animateSlide(element,tickKeyframes(x,length,running.start,running.end,left,width-right),running.options,element,running.started));
        tickGlyphs.current.set(element,{...glyph,motion:running,length});
      }
      return moving;
    };
    if(motion.current)animateTicks.current(motion.current);
  });

  return {box, svg, width, scale, commitDrawing, visualGeometry, presentation, screenX: (at: number) => {if (animations.current.size) {const visible = visualGeometry(); return left + (at - visible.from) / (visible.to - visible.from) * (width - left - right);} const base = drawing.current; return pose.current.a * (left + (at - base.from) / Math.max(60_000, base.to - base.from) * (width - left - right)) + pose.current.b + pose.current.offset / scale;}, get held() {return finished.current !== null;}, hover: shifting || panning || folding || finished.current !== null || hover === null ? null : Math.floor(hover / cellMs) * cellMs, hoverAt: hover,rawHover: hover, drag, x, drawX, timeAt, clip, handlers, basis, active: panning !== null, panning: shifting || panning !== null || folding || finished.current !== null};
}
