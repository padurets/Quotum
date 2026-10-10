import {createContext,useContext} from 'react';
import {useClock} from './clock';

/** Compact and live values use the page clock; historical measurements have a fixed right edge. */
export const MeasurementClock=createContext<number|null>(null);
export const useMeasurementTime=()=>useContext(MeasurementClock);
export function useMeasurementClock(changesAt:(now:number)=>number|null) {
  const fixed=useMeasurementTime();
  const live=useClock(now=>fixed===null?changesAt(now):null);
  return fixed??live;
}
