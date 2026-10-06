import {balanceDescriptor} from '../../server/domain/providers';
import {isUnit} from '../../server/domain/amount';
import {MAX_METERS,selectionOf,type MeterSelection} from '../../server/domain/meterHistory';
import type {Card} from './types';
import type {MeterHistory} from './moneyView';
import {usdBalance} from './money';

export type MoneyPrefs={unit:string|null;view:'balance'|'spending';selected:Record<string,[string,string][]>;removed?:number};
export const DEFAULT_MONEY:MoneyPrefs={unit:null,view:'balance',selected:{}};
export function readMoney(value:unknown):MoneyPrefs {
  if(!value||typeof value!=='object')return DEFAULT_MONEY;
  const raw=value as Partial<MoneyPrefs>,selected:MoneyPrefs['selected']={};
  if(raw.selected&&typeof raw.selected==='object')for(const [unit,ids] of Object.entries(raw.selected)){
    try{selected[unit]=selectionOf(ids,unit).ids;}catch{/* Invalid saved selections grant no capabilities. */}
  }
  return {unit:isUnit(raw.unit)?raw.unit==='CNY'?'USD':raw.unit:null,view:raw.view==='spending'?'spending':'balance',selected,...(Number.isSafeInteger(raw.removed)&&raw.removed!>0&&raw.removed!<=32?{removed:raw.removed}:{})};
}
export function moneySelection(cards:readonly Card[],hidden:readonly string[],settings:MoneyPrefs):{selection:MeterSelection|undefined;omitted:number;removed:number} {
  if(!settings.unit)return {selection:undefined,omitted:0,removed:0};
  const shown=cards.filter(c=>!hidden.includes('source:'+c.id)),visible=new Set(shown.map(c=>c.id));
  const explicit=settings.selected[settings.unit];
  const ids=explicit??shown.flatMap(card=>{
    const balance=settings.unit==='USD'?usdBalance(card)?.total:card.meters?.find(m=>m.kind==='balance'&&m.unit===settings.unit&&balanceDescriptor(card.provider,m.id)?.role==='total');
    return balance?[[card.id,balance.id] as [string,string]]:[];
  });
  const admitted=ids.filter(([source])=>visible.has(source));
  return {selection:selectionOf(admitted.slice(0,MAX_METERS),settings.unit),omitted:Math.max(0,admitted.length-MAX_METERS),removed:ids.length-admitted.length};
}

/** Membership is checked against the inventory, not against the visible page. */
export function archivedKeyGroups(source:string,selected:readonly [string,string][],current:ReadonlySet<string>,history:readonly MeterHistory[]) {
  const groups=new Map<string,{id:string;label:string;usage:string|null;cap:string|null}>();
  for(const [owner,meter] of selected) {
    if(owner!==source||meter==='balance')continue;
    const key=meter.match(/^key:([^:]+):(usage|cap)$/),id=key?.[1]??meter;
    if(current.has(id))continue;
    const saved=history.find(s=>s.sourceId===source&&s.meterId===meter);
    const kind=key?.[2]==='cap'||saved?.kind==='cap'?'cap':'usage';
    let group=groups.get(id);
    if(!group)groups.set(id,(group={id,label:saved?.semantics?.label??id,usage:null,cap:null}));
    group[kind]=meter;
  }
  return [...groups.values()];
}
