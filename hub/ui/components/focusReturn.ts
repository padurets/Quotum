import {useCallback} from 'react';

let restoring=0;
export const isFocusReturn=()=>restoring>0;
const available=(element:HTMLElement)=>element.isConnected&&!element.matches(':disabled')&&!element.closest('[hidden],[inert]')&&element.getClientRects().length>0&&getComputedStyle(element).visibility==='visible';

/** A contextual return is not a new reader navigation. */
export function returnFocus(element:HTMLElement|null|undefined){
  if(!element||!available(element))return;
  restoring++;
  try{element.focus({preventScroll:true});}finally{restoring--;}
}

function targetOf(element:HTMLElement){
  const trigger=element.closest('.picker')?.querySelector<HTMLElement>(':scope > button');
  if(trigger&&!element.contains(trigger)&&available(trigger))return trigger;
  const scope=element.closest<HTMLElement>('.panel,.card,.analytics-head-inner');
  const controls=scope?.querySelectorAll<HTMLElement>('.panel-head .panel-controls button,.card-head > .picker > button,.data-filter-controls button')??[];
  // Other transient reader marks and Save/Restore are not stable recovery targets.
  const control=[...controls].find(control=>!element.contains(control)&&!control.closest('.reader-state')&&available(control));
  return control??scope?.querySelector<HTMLElement>('.panel-head h2,.card-head h2');
}

/** The entire boundary, including its trigger, is retiring. */
export function returnFocusOutside(element:HTMLElement){returnFocus(targetOf(element));}

/** Ref detachment runs before removing the node that still owns keyboard focus. */
export function useRemovalFocus<T extends HTMLElement>(){
  return useCallback((element:T|null)=>element?()=>{
    if(element.contains(document.activeElement))returnFocusOutside(element);
  }:undefined,[]);
}
