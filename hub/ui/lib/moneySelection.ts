import {DEFAULT_CURRENCY,defaultCurrencyContext,type CurrencyContext} from '../../server/domain/currency';
import {balanceDescriptor} from '../../server/domain/providers';
import {isUnit} from '../../server/domain/amount';
import {MAX_METERS,selectionOf,type MeterSelection} from '../../server/domain/meterHistory';
import type {Card} from './types';
import type {MeterHistory} from './moneyView';
import {referenceBalance,budgetVisible} from './money';
import {providerOf, budgetMeter} from '../../server/domain/providers';

export type MoneyPrefs={unit:string|null;view:'balance'|'spending';selected:Record<string,[string,string][]>;removed?:number};
export const DEFAULT_MONEY:MoneyPrefs={unit:DEFAULT_CURRENCY,view:'balance',selected:{}};
export function readMoney(value:unknown):MoneyPrefs {
  if(!value||typeof value!=='object')return DEFAULT_MONEY;
  const raw=value as Partial<MoneyPrefs>,selected:MoneyPrefs['selected']={};
  if(raw.selected&&typeof raw.selected==='object')for(const [unit,ids] of Object.entries(raw.selected)){
    try{if(!unit.startsWith('credits:'))selected[unit]=selectionOf(ids,unit).ids;}catch{/* Invalid saved selections grant no capabilities. */}
  }
  return {unit:isUnit(raw.unit)&&!raw.unit.startsWith('credits:')?raw.unit==='CNY'?DEFAULT_CURRENCY:raw.unit:DEFAULT_CURRENCY,view:raw.view==='spending'?'spending':'balance',selected,...(Number.isSafeInteger(raw.removed)&&raw.removed!>0&&raw.removed!<=32?{removed:raw.removed}:{})};
}
export function moneySelection(cards:readonly Card[],hidden:readonly string[],settings:MoneyPrefs,context:CurrencyContext=defaultCurrencyContext):{selection:MeterSelection|undefined;omitted:number;removed:number} {
  const unit=settings.unit??DEFAULT_CURRENCY;
  const shown=cards.filter(c=>budgetVisible(c)&&!hidden.includes('source:'+c.id)),visible=new Set(shown.map(c=>c.id));
  const explicit=settings.selected[unit];
  const ids=explicit??shown.flatMap(card=>{
    const balance=unit===DEFAULT_CURRENCY?(referenceBalance(card,context.target.id!==DEFAULT_CURRENCY||card.provider==='codex')?.total):card.meters?.find(m=>m.kind==='balance'&&m.unit===unit&&balanceDescriptor(card.provider,m.id)?.role==='total');
    return balance?[[card.id,balance.id] as [string,string]]:[];
  });
  const admitted=ids.filter(([source,meter])=>visible.has(source)&&budgetMeter(providerOf(shown.find(card=>card.id===source)?.provider??''),meter));
  return {selection:{...selectionOf(admitted.slice(0,MAX_METERS),unit),...(shown.some(c=>c.provider==='codex')?{resourceRevision:JSON.stringify(shown.filter(c=>c.provider==='codex').map(c=>[c.id,c.budget]))}:{}),...(unit===DEFAULT_CURRENCY&&(context.target.id!==DEFAULT_CURRENCY||shown.some(c=>c.provider==='codex'))?{displayCurrency:context.target.id,...(context.revision?{displayRevision:context.revision}:{})}:{})},omitted:Math.max(0,admitted.length-MAX_METERS),removed:ids.length-admitted.length};
}

/** Membership is checked against the inventory, not against the visible page. */
export const keyMeter=(meter:string)=>/^key:([^:]+):(usage|cap)$/.exec(meter);

export function archivedKeyGroups(source:string,selected:readonly [string,string][],current:ReadonlySet<string>,history:readonly MeterHistory[]) {
  const groups=new Map<string,{id:string;label:string;usage:string|null;cap:string|null}>();
  for(const [owner,meter] of selected) {
    const key=keyMeter(meter);if(owner!==source||!key)continue;
    const id=key[1];
    if(current.has(id))continue;
    const saved=history.find(s=>s.sourceId===source&&s.meterId===meter);
    const kind=key[2]==='cap'?'cap':'usage';
    let group=groups.get(id);
    if(!group)groups.set(id,(group={id,label:saved?.semantics?.label??id,usage:null,cap:null}));
    group[kind]=meter;
  }
  return [...groups.values()];
}
