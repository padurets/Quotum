/** @jsxRuntime automatic */
import {Fragment,useMemo,useRef,type ReactNode} from 'react';
import {hubNow,useClock} from '../lib/clock';

export type Cell={content:ReactNode;title?:string;className?:string};
export type TimedCell={time:string;changesAt:(now:number,shown?:Cell)=>number|null;at:(now:number)=>Cell};

/** A data cell or footer value owns its clock; static measurement owns none. */
function Timed({cell,render}:{cell:TimedCell;render:(cell:Cell,time:string)=>ReactNode}){
  const shown=useRef<Cell|undefined>(undefined);
  const plan=useMemo(()=>(at:number)=>cell.changesAt(at,shown.current),[cell]);
  const now=useClock(plan,[cell]);
  shown.current=useMemo(()=>cell.at(now),[cell,now]);
  return render(shown.current,cell.time);
}
export const tableCell=(key:string,cell:Cell|TimedCell,render:(cell:Cell,time?:string)=>ReactNode,still=false)=>
  'at' in cell&&!still?<Timed key={key} cell={cell} render={render}/>:<Fragment key={key}>{render('at' in cell?cell.at(hubNow()):cell)}</Fragment>;
