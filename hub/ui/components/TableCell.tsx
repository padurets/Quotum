/** @jsxRuntime automatic */
import {Fragment,useMemo,useRef,type ReactNode} from 'react';
import {hubNow,useClock} from '../lib/clock';

export type Cell={content:ReactNode;title?:string;className?:string};
export type TimedCell={time:string;changesAt:(now:number,shown?:Cell)=>number|null;at:(now:number)=>Cell};

/** A retained cell owns its optional clock; static measurement owns none. */
function Timed({cell,render}:{cell:Cell|TimedCell;render:(cell:Cell,time?:string)=>ReactNode}){
  const shown=useRef<Cell|undefined>(undefined);
  const ticking='at' in cell;
  const plan=useMemo(()=>(at:number)=>'at' in cell?cell.changesAt(at,shown.current):null,[cell]);
  const now=useClock(plan,[cell],ticking);
  shown.current=useMemo(()=>'at' in cell?cell.at(now):cell,[cell,now]);
  return render(shown.current,ticking?cell.time:undefined);
}
export const tableCell=(key:string,cell:Cell|TimedCell,render:(cell:Cell,time?:string)=>ReactNode,still=false)=>
  !still?<Timed key={key} cell={cell} render={render}/>:<Fragment key={key}>{render('at' in cell?cell.at(hubNow()):cell)}</Fragment>;
