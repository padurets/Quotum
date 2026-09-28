import {createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type RefObject} from 'react';

/** What a widget needs, in CSS pixels: at least (`min`), and to show all of itself (`natural`). */
export type Size = {min: number; natural: number};

/**
 * How tall the board makes a widget: whether its owner chose a height (`manual`), and
 * the CSS pixels that gives it (`allocated`, 0 while it follows its content). A widget
 * that fills a chosen height with more of itself rather than with empty room (the charts,
 * the list of agents) reads it at its root and tells the board what it needs (`report`);
 * the rest of the board neither reads it nor renders for it.
 */
export type Sizing = {manual: boolean; allocated: number; report: (size: Size | null) => void};
export const SizingContext = createContext<Sizing | null>(null);
export const useSizing = () => useContext(SizingContext);

/** Pixels as measured, to 1/64: the same layout reads the same, and nothing renders for less. */
export const pixels = (value: number) => Math.round(value * 64) / 64;

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
  const [plot, setPlot] = useState<number | undefined>(undefined);
  const base = useRef<number | null>(null);
  const measure = useRef(() => {});
  measure.current = () => {
    const root = panel.current;
    const chart = root?.querySelector<HTMLElement>(':scope > .chart');
    if (!sizing || !root || !chart) return;
    const own = chart.querySelector(':scope > svg') ? base.current : parseFloat(getComputedStyle(chart).minHeight) || 0;
    if (own === null) return;
    // What is not the plot does not depend on how tall the plot is: the head, totals and legend wrap only with the width.
    const chrome = root.getBoundingClientRect().height - fillOf(root) - chart.getBoundingClientRect().height;
    const min = pixels(chrome + own);
    sizing.report({min, natural: min});
    const next = sizing.manual ? pixels(Math.max(own, sizing.allocated - chrome)) : undefined;
    setPlot(was => (was === next ? was : next));
  };
  useLayoutEffect(() => measure.current());
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measure.current());
    if (panel.current) observer.observe(panel.current);
    return () => observer.disconnect();
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
