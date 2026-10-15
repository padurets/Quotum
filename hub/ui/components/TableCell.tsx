/** @jsxRuntime automatic */
import {Fragment,useMemo,type ReactNode} from 'react';
import {hubNow,useClock} from '../lib/clock';

export type Cell={content:ReactNode;title?:string;className?:string};
export type TimedCell={time:string;changesAt:(now:number)=>number|null;at:(now:number)=>Cell};

/** A data cell or footer value owns its clock; static measurement owns none. */
function Timed({cell,render}:{cell:TimedCell;render:(cell:Cell,time:string)=>ReactNode}){
  const now=useClock(cell.changesAt,[cell]);
  const shown=useMemo(()=>cell.at(now),[cell,now]);
  return render(shown,cell.time);
}
export const tableCell=(key:string,cell:Cell|TimedCell,render:(cell:Cell,time?:string)=>ReactNode,still=false)=>
  'at' in cell&&!still?<Timed key={key} cell={cell} render={render}/>:<Fragment key={key}>{render('at' in cell?cell.at(hubNow()):cell)}</Fragment>;
