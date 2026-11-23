import {createContext, useContext} from 'react';
import {useClock} from './clock';

/** Compact and live values use the page clock; historical measurements have a fixed right edge. */
export const MeasurementClock = createContext<number | null>(null);
export const useMeasurementTime = () => useContext(MeasurementClock);
export const measurementTimeAt = (fixed: number | null, now: number) =>
  fixed === null ? now : Math.min(fixed, now);
export function useMeasurementClock(changesAt: (now: number) => number | null) {
  const fixed = useMeasurementTime();
  const live = useClock(now => (fixed === null || now < fixed ? changesAt(now) : null));
  return measurementTimeAt(fixed, live);
}
