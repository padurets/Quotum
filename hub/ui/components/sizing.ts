import {createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {useLocale} from '../i18n';
import {pan} from '../lib/pan';

/** What a widget needs, in CSS pixels: at least (`min`), and to show all of itself (`natural`). */
export type Size = {min: number; natural: number};
/** Structural geometry belongs to a layout lifetime; data never creates a new one. */
export type Report = Size & {shown: number;layout: string};

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
  const measure = useRef(() => {});
  measure.current = () => {
    const root = panel.current;
    const chart = root?.querySelector<HTMLElement>(':scope > .chart');
    if (!sizing || !root || !chart || pan.active() || pan.shifting()) return;
    const own = chart.querySelector(':scope > svg') ? base.current : parseFloat(getComputedStyle(chart).minHeight) || 0;
    if (own === null) return;
    const bounds = root.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const shown = bounds.height - fillOf(root);
    // The legend is useful content: its actual wrapping determines the panel's chrome.
    const chrome = pixels(shown - chart.getBoundingClientRect().height);
    const min = pixels(chrome + own);
    const layout = JSON.stringify([root.clientWidth, locale, own, chrome]);
    sizing.report({min, natural: min, shown: pixels(shown), layout});
    const next = sizing.manual ? pixels(Math.max(own, sizing.allocated - chrome)) : undefined;
    setPlot(was => (same(was, next) ? was : next));
  };
  useLayoutEffect(() => measure.current(), [sizing?.manual, sizing?.allocated, sizing?.width, locale]);
  useLayoutEffect(() => {
    let alive = true, legend: HTMLElement | null = null;
    const observer = new ResizeObserver(() => measure.current());
    const follow = () => {
      const next = panel.current?.querySelector<HTMLElement>(':scope > .legend') ?? null;
      if (next === legend) return false;
      if (legend) observer.unobserve(legend);
      legend = next;
      if (legend) observer.observe(legend);
      return true;
    };
    const mutations = new MutationObserver(() => {if (follow()) measure.current();});
    follow();
    if (panel.current) {
      observer.observe(panel.current);
      // SVG data changes are below the chart; only replacing the legend changes this subscription.
      mutations.observe(panel.current, {childList: true});
    }
    const stop = pan.onPhase(() => {
      if (!pan.active() && !pan.shifting()) queueMicrotask(() => {if (alive) measure.current();});
    });
    return () => {alive = false; stop(); mutations.disconnect(); observer.disconnect();};
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
