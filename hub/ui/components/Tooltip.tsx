import {useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject} from 'react';

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

/** How far down the window the bars that stick at its top cover the page, in CSS pixels. */
export function coverOf(above = Infinity) {
  const bars = [...document.querySelectorAll<HTMLElement>('.topbar, .analytics-head')].filter(bar => getComputedStyle(bar).position === 'sticky');
  return Math.max(0, ...bars.map(bar => bar.getBoundingClientRect()).filter(rect => rect.top <= above).map(rect => rect.bottom));
}

/** Keep a small anchored tooltip inside the viewport without growing its card. */
export function useBubble(active: boolean) {
  const tip = useRef<HTMLSpanElement>(null);
  const place = () => {
    const element = tip.current;
    if (!active || !element) return;
    element.style.translate = '';
    element.style.maxHeight = '';
    element.style.overflow = '';
    element.style.pointerEvents = '';
    const rect = element.getBoundingClientRect();
    const {by, room} = placeOf(rect.top, rect.height, innerHeight, coverOf(rect.top));
    const edge = document.documentElement.clientWidth - 8;
    const x = rect.left < 8 ? 8 - rect.left : rect.right > edge ? edge - rect.right : 0;
    element.style.translate = `${x}px ${-by}px`;
    if (rect.height > room) {
      element.style.maxHeight = `${room}px`;
      element.style.overflow = 'auto';
      element.style.pointerEvents = 'auto';
    }
  };
  useLayoutEffect(place);
  useEffect(() => {
    if (!active) return;
    addEventListener('resize', place);
    addEventListener('scroll', place, {passive: true, capture: true});
    return () => {
      removeEventListener('resize', place);
      removeEventListener('scroll', place, true);
    };
  }, [active]);
  return tip;
}

/**
 * Where a chart's tooltip stands, for a chart `width` wide (in its own units, which are
 * CSS pixels here) with the pointer `at` across it. Beside the pointer: right of it, or
 * left, or where there is more room when it fits neither side, narrowed to that room (its
 * names wrap) rather than over the pointer. On a `narrow` chart it spans the chart's width
 * under the plot (`bottom`, in CSS pixels), over what comes below. While it `rises`, it
 * stands as `placeOf` says: whole in the window where it can be (a long list, a phone), never
 * under the bars that stick at the top, and never lengthening the page. It is measured after every render while it shows,
 * whatever changed it (its rows, a new answer moving the chart, the pointer), and as the
 * page scrolls under a pointer that stays.
 */
export function useTip(svg: RefObject<SVGSVGElement | null>, {width, at, narrow, rises, bottom}: {width: number; at: number; narrow: boolean; rises: boolean; bottom: number}) {
  const tip = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(200);
  /** How far it rises (below 0, comes down), from where it stands unraised within the chart, and how tall it may be (CSS pixels; 0 for any). */
  const [lift, setLift] = useState({by: 0, from: 0, room: 0});
  const measure = useRef(() => {});
  measure.current = () => {
    const element = tip.current;
    if (!element) return;
    // Its own width, not as narrowed to the side it stands on: where it goes depends on it.
    const cap = element.style.maxWidth;
    element.style.maxWidth = '';
    setTipWidth(element.offsetWidth);
    element.style.maxWidth = cap;
    if (!rises || !svg.current) return setLift(same => (same.by || same.room ? {by: 0, from: 0, room: 0} : same));
    // Where it stands unraised, and how tall it is, are read with nothing of its own rise or
    // cut, never from where and as it is drawn, so what it finds does not depend on what it
    // found before: under the plot on a narrow chart, else where the stylesheet puts it.
    const tall = element.style.maxHeight;
    element.style.maxHeight = '';
    const height = element.getBoundingClientRect().height;
    element.style.maxHeight = tall;
    const chart = svg.current.getBoundingClientRect();
    let top: number;
    if (narrow) top = chart.bottom + parseFloat(getComputedStyle(element).marginTop);
    else {
      const raised = element.style.top;
      element.style.top = '';
      top = element.getBoundingClientRect().top;
      element.style.top = raised;
    }
    const {by, room} = placeOf(top, height, innerHeight, coverOf());
    const from = narrow ? bottom : top - chart.top;
    setLift(same => (same.by === by && same.from === from && same.room === room ? same : {by, from, room}));
  };
  // No dependencies: the same values found again change nothing, so it settles in one pass.
  useLayoutEffect(() => measure.current());
  useEffect(() => {
    if (!rises) return;
    const scrolled = () => measure.current();
    addEventListener('scroll', scrolled, {passive: true});
    return () => removeEventListener('scroll', scrolled);
  }, [rises]);
  const roomRight = width - at - 12;
  const roomLeft = at - 12;
  const onRight = tipWidth <= roomRight || (tipWidth > roomLeft && roomRight >= roomLeft);
  const room = Math.min(360, Math.max(0, onRight ? roomRight : roomLeft));
  const left = onRight ? at + 12 : Math.max(0, at - 12 - Math.min(tipWidth, room));
  const cut = lift.room ? {maxHeight: lift.room} : {};
  const style: CSSProperties = narrow ? {top: bottom - lift.by, ...cut} : {left, maxWidth: room, ...cut, ...(lift.by ? {top: lift.from - lift.by} : {})};
  return {tip, style};
}

/** A chart's own tooltip, glass as the popovers are; it lies over the widgets below, under the sticky bars. */
export function Tooltip({tip, className, style, children}: {tip: RefObject<HTMLDivElement | null>; className: string; style: CSSProperties; children: ReactNode}) {
  return (
    <div className={`tooltip glass ${className}`} ref={tip} style={style}>
      {children}
    </div>
  );
}
