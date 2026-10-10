import {createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {pan} from '../lib/pan';
import {onTimeRange, timeRange, type TimeRange} from '../lib/timeRange';
import {onPrefs, prefs} from '../lib/prefs';
import {useLocale} from '../i18n';
import {page} from '../lib/board';

/** What a widget needs, in CSS pixels: at least (`min`), and to show all of itself (`natural`). */
export type Size = {min: number; natural: number};
/** What a widget tells the board: what it needs, and how tall it shows now (`shown`), under which the board fills its rows. */
export type Report = Size & {shown: number};

/**
 * How tall the board makes a widget: whether its owner chose a height (`manual`), and
 * the CSS pixels that gives it (`allocated`, 0 while it follows its content). A widget
 * that fills a chosen height with more of itself rather than with empty room (the charts,
 * the list of agents) reads it at its root and tells the board what it needs and shows
 * (`report`) as it lays itself out anew, so the board fills the rest before that paints;
 * the rest of the board neither reads it nor renders for it. `width` changes when the board
 * gives it another width (the board's columns, its own, the end of a gesture that moved its
 * side, which it followed until then), so that such a widget lays itself out anew at that
 * width in the frame it takes it, not a frame after it shows.
 */
export type Sizing = {manual: boolean; allocated: number; width: string; report: (report: Report | null) => void};
export const SizingContext = createContext<Sizing | null>(null);
export const useSizing = () => useContext(SizingContext);

/** Pixels as measured, to 1/64: the same layout reads the same, and nothing renders for less. */
export const pixels = (value: number) => Math.round(value * 64) / 64;

/**
 * Whether a widget measured again (`now`) is as tall as it was: within a pixel of the screen.
 * Boxes snap to the screen's pixels, which at a fractional scale (125 %, 150 %) are no whole
 * CSS pixels, so the same content measures a little differently over another fill; taking that
 * for a new height would change the fill again, and so on without end.
 */
export const same = (was: number | undefined, now: number | undefined) =>
  was === now || (was !== undefined && now !== undefined && Math.abs(now - was) < 1 / devicePixelRatio);

/** The widget's `--fill`: the empty room the board adds under a panel's content to fill its rows. */
export const fillOf = (element: Element) => parseFloat(getComputedStyle(element).getPropertyValue('--fill')) || 0;

/**
 * The plot of a chart in a widget (`panel`, whose `.chart` it is): drawn at the height the
 * chart has of its own, or, with a height chosen, as tall as the widget has room for under
 * its head and totals and over its legend, never lower. It tells the board what the widget
 * needs: all of it but the plot, and the plot at its own height. The chart tells that
 * height through `onBase`, in CSS pixels; a placeholder while it loads has its own.
 */
export function usePlot(panel: RefObject<HTMLElement | null>) {
  const sizing = useSizing();
  const locale = useLocale();
  const [plot, setPlot] = useState<number | undefined>(undefined);
  const base = useRef<number | null>(null);
  const held = useRef<{legend: HTMLElement; height: string; overflow: string; alignContent: string; keep: boolean; range: TimeRange | null} | null>(null);
  const legendHeights = useRef(new WeakMap<Element, number>());
  const sizes = useRef<ResizeObserver | null>(null);
  const watchedLegend = useRef<HTMLElement | null>(null);
  const watchLegend = () => {
    const observer = sizes.current;
    if (!observer) return;
    const legend = panel.current?.querySelector<HTMLElement>(':scope > .legend') ?? null;
    if (legend === watchedLegend.current) return;
    if (watchedLegend.current) observer.unobserve(watchedLegend.current);
    watchedLegend.current = legend;
    if (legend) {legendHeights.current.delete(legend); observer.observe(legend);}
  };
  const locked = () => !!pan.active() || pan.shifting() || !!panel.current?.querySelector('.chart > svg.is-panning');
  const measure = useRef(() => {});
  measure.current = () => {
    const root = panel.current;
    const chart = root?.querySelector<HTMLElement>(':scope > .chart');
    if (!sizing || !root || !chart || locked() || held.current) return;
    const own = chart.querySelector(':scope > svg') ? base.current : parseFloat(getComputedStyle(chart).minHeight) || 0;
    if (own === null) return;
    const shown = root.getBoundingClientRect().height - fillOf(root);
    // What is not the plot does not depend on how tall the plot is: the head, totals and legend wrap only with the width.
    const chrome = shown - chart.getBoundingClientRect().height;
    const min = pixels(chrome + own);
    sizing.report({min, natural: min, shown: pixels(shown)});
    const next = sizing.manual ? pixels(Math.max(own, sizing.allocated - chrome)) : undefined;
    setPlot(was => (same(was, next) ? was : next));
  };
  // Plot data can replace thousands of SVG segments without changing the panel's
  // size. Reading its rect after every such render forces their layout during input.
  // Allocation changes are measured here; content changes arrive before paint through
  // the observer below, and a new plot base is measured by onBase.
  useLayoutEffect(() => measure.current(), [sizing?.manual, sizing?.allocated, sizing?.width]);
  useLayoutEffect(() => {
    let alive = true;
    const restore = () => {
      const saved = held.current;
      if (!saved) return;
      Object.assign(saved.legend.style, {height: saved.height, overflow: saved.overflow, alignContent: saved.alignContent});
      held.current = null;
    };
    const changed = () => {
      watchLegend();
      if (locked()) {
        const legend = panel.current?.querySelector<HTMLElement>(':scope > .legend');
        if (held.current || !legend) return;
        // The observer captured the displayed legend before gesture styles changed.
        // A newly mounted legend still needs its first actual size.
        const height = legendHeights.current.get(legend) ?? legend.getBoundingClientRect().height;
        held.current = {legend, height: legend.style.height, overflow: legend.style.overflow, alignContent: legend.style.alignContent, keep: false, range: timeRange()};
        Object.assign(legend.style, {height: `${height}px`, overflow: 'auto', alignContent: 'flex-start'});
      } else if (held.current && !held.current.keep) {
        // Finish renders its fold before this check. Its class change releases the
        // legend only after the animation. A changed pan keeps its viewport for
        // the resulting range too; fewer entries must not enlarge the plot.
        queueMicrotask(() => {if (alive && !locked() && !held.current?.keep) {restore(); measure.current();}});
      }
    };
    const unsubscribe = pan.onPhase(changed);
    const stopped = pan.onStop(stop => {
      if (stop.changed && held.current) {held.current.keep = true; held.current.range = stop.range;}
    });
    const navigated = onTimeRange(() => {
      const saved = held.current, range = timeRange();
      if (saved && !(range === saved.range || range && saved.range && range.from === saved.range.from && range.to === saved.range.to)) {restore(); measure.current();}
    });
    let context = prefs();
    const preferences = onPrefs(() => {
      const next = prefs();
      if (next.range !== context.range || next.kind !== context.kind || next.activityBy !== context.activityBy) {restore(); measure.current();}
      context = next;
    });
    const board = page.listen(event => {
      if (event.type === 'board-open' || event.type === 'board-close') {restore(); measure.current();}
    });
    const observer = new MutationObserver(changed);
    if (panel.current) observer.observe(panel.current, {subtree: true, childList: true, attributes: true, attributeFilter: ['class']});
    changed();
    return () => {alive = false; unsubscribe(); stopped(); navigated(); preferences(); board(); observer.disconnect(); restore();};
  }, [panel, sizing?.manual, sizing?.allocated, sizing?.width, locale]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === watchedLegend.current && !locked() && !held.current) {
          legendHeights.current.set(entry.target, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
        }
      }
      measure.current();
    });
    sizes.current = observer;
    if (panel.current) observer.observe(panel.current);
    watchLegend();
    return () => {observer.disconnect(); sizes.current = null; watchedLegend.current = null;};
  }, [panel]);
  const report = sizing?.report;
  useLayoutEffect(() => () => report?.(null), [report]);
  const onBase = useCallback((height: number) => {
    if (base.current === height) return;
    base.current = height;
    measure.current();
  }, []);
  return {plot, onBase};
}
