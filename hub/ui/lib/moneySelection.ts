import {isUnit} from '../../server/domain/amount';
import {MAX_METERS,selectionOf,type MeterSelection} from '../../server/domain/meterHistory';
import type {Card} from './types';

export type MoneyPrefs={unit:string|null;view:'balance'|'spending';selected:Record<string,[string,string][]>;removed?:number};
export const DEFAULT_MONEY:MoneyPrefs={unit:null,view:'balance',selected:{}};
export function readMoney(value:unknown):MoneyPrefs {
  if(!value||typeof value!=='object')return DEFAULT_MONEY;
  const raw=value as Partial<MoneyPrefs>,selected:MoneyPrefs['selected']={};
  if(raw.selected&&typeof raw.selected==='object')for(const [unit,ids] of Object.entries(raw.selected)){
    try{selected[unit]=selectionOf(ids,unit).ids;}catch{/* Invalid saved selections grant no capabilities. */}
  }
  return {unit:isUnit(raw.unit)?raw.unit:null,view:raw.view==='spending'?'spending':'balance',selected,...(Number.isSafeInteger(raw.removed)&&raw.removed!>0&&raw.removed!<=32?{removed:raw.removed}:{})};
}
export function moneySelection(cards:readonly Card[],hidden:readonly string[],settings:MoneyPrefs):{selection:MeterSelection|undefined;omitted:number;removed:number} {
  if(!settings.unit)return {selection:undefined,omitted:0,removed:0};
  const shown=cards.filter(c=>!hidden.includes('source:'+c.id)),visible=new Set(shown.map(c=>c.id));
  const explicit=settings.selected[settings.unit];
  const ids=explicit??shown.flatMap(card=>{
    const balance=card.meters?.find(m=>m.kind==='balance'&&m.unit===settings.unit);
    return balance?[[card.id,balance.id] as [string,string]]:[];
  });
  const admitted=ids.filter(([source])=>visible.has(source));
  return {selection:selectionOf(admitted.slice(0,MAX_METERS),settings.unit),omitted:Math.max(0,admitted.length-MAX_METERS),removed:ids.length-admitted.length};
}
