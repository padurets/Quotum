import {useCallback,useRef} from 'react';

let restoring=0;
export const isFocusReturn=()=>restoring>0;
const available=(element:HTMLElement)=>element.isConnected&&!element.matches(':disabled')&&!element.closest('[hidden],[inert]')&&element.getClientRects().length>0;

/** A contextual return is not a new reader navigation. */
export function returnFocus(element:HTMLElement|null|undefined){
  if(!element||!available(element))return;
  restoring++;
  try{element.focus({preventScroll:true});}finally{restoring--;}
}

function targetOf(element:HTMLElement){
  const trigger=element.closest('.picker')?.querySelector<HTMLElement>(':scope > button');
  if(trigger&&!element.contains(trigger)&&available(trigger))return trigger;
  const scope=element.closest<HTMLElement>('.panel,.analytics-head-inner');
  const controls=scope?.querySelectorAll<HTMLElement>('.panel-head .panel-controls button,.data-filter-controls button')??[];
  // Other transient reader marks and Save/Restore are not stable recovery targets.
  const control=[...controls].find(control=>!element.contains(control)&&!control.closest('.reader-state')&&available(control));
  return control??scope?.querySelector<HTMLElement>('.panel-head h2');
}

/** Ref detachment runs before removing the node that still owns keyboard focus. */
export function useRemovalFocus<T extends HTMLElement>(){
  const current=useRef<T|null>(null);
  return useCallback((element:T|null)=>{
    const previous=current.current;current.current=element;
    if(!element&&previous?.contains(document.activeElement))returnFocus(targetOf(previous));
  },[]);
}
