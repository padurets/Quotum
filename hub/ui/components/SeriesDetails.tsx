/** @jsxRuntime automatic */
import {useLayoutEffect,useRef,useSyncExternalStore,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import type {SeriesFocus} from './seriesFocus';
import {useBubble} from './Tooltip';

type Entry={key:string;name:string;detail:string};
/** Transient monetary details occupy no space in the ordinary chart. */
export function SeriesDetails({focus,entries,panel}:{focus:SeriesFocus;entries:Entry[];panel:RefObject<HTMLElement|null>}) {
  const key=useSyncExternalStore(focus.subscribe,focus.get),entry=entries.find(entry=>entry.key===key&&entry.detail);
  const anchor=useRef<HTMLElement>(null);
  useLayoutEffect(()=>{anchor.current=[...(panel.current?.querySelectorAll<HTMLElement>('button.legend-item')??[])].find(button=>button.dataset.seriesKey===entry?.key)??null;});
  const tip=useBubble(!!entry,anchor,panel.current);
  return entry&&panel.current?createPortal(<span key={entry.key} ref={tip} role="tooltip" className="tooltip glass series-tip" data-series-details data-series-context={entry.key}><strong>{entry.name}</strong><span>{entry.detail}</span></span>,panel.current):null;
}
