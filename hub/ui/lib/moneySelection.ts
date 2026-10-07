import {DEFAULT_CURRENCY,defaultCurrencyContext,type CurrencyContext} from '../../server/domain/currency';
import {balanceDescriptor} from '../../server/domain/providers';
import {isUnit} from '../../server/domain/amount';
import {MAX_METERS,selectionOf,type MeterSelection} from '../../server/domain/meterHistory';
import type {Card} from './types';
import type {MeterHistory} from './moneyView';
import {referenceBalance} from './money';
import {providerOf} from '../../server/domain/providers';

export type MoneyPrefs={unit:string|null;view:'balance'|'spending';selected:Record<string,[string,string][]>;modes?:Partial<Record<'balance'|'spending',Record<string,[string,string][]>>>;removed?:number};
export const DEFAULT_MONEY:MoneyPrefs={unit:null,view:'balance',selected:{}};
export function readMoney(value:unknown):MoneyPrefs {
  if(!value||typeof value!=='object')return DEFAULT_MONEY;
  const raw=value as Partial<MoneyPrefs>,selected:MoneyPrefs['selected']={};
  if(raw.selected&&typeof raw.selected==='object')for(const [unit,ids] of Object.entries(raw.selected)){
    try{if(!unit.startsWith('credits:'))selected[unit]=selectionOf(ids,unit).ids;}catch{/* Invalid saved selections grant no capabilities. */}
  }
  const modes:MoneyPrefs['modes']={};
  for(const view of ['balance','spending'] as const)if(raw.modes?.[view]&&typeof raw.modes[view]==='object'){
    modes[view]={};for(const [unit,ids] of Object.entries(raw.modes[view]!))try{if(!unit.startsWith('credits:'))modes[view]![unit]=selectionOf(ids,unit).ids;}catch{/* Reject malformed saved choices. */}
  }
  return {unit:isUnit(raw.unit)&&!raw.unit.startsWith('credits:')?raw.unit==='CNY'?DEFAULT_CURRENCY:raw.unit:null,view:raw.view==='spending'?'spending':'balance',selected,modes,...(Number.isSafeInteger(raw.removed)&&raw.removed!>0&&raw.removed!<=32?{removed:raw.removed}:{})};
}
export function moneySelection(cards:readonly Card[],hidden:readonly string[],settings:MoneyPrefs,context:CurrencyContext=defaultCurrencyContext):{selection:MeterSelection|undefined;omitted:number;removed:number} {
  if(!settings.unit)return {selection:undefined,omitted:0,removed:0};
  const shown=cards.filter(c=>providerOf(c.provider)?.funding==='wallet'&&!hidden.includes('source:'+c.id)),visible=new Set(shown.map(c=>c.id));
  const explicit=moneyChoices(settings)[settings.unit];
  const ids=explicit??shown.flatMap(card=>{
    const balance=settings.unit===DEFAULT_CURRENCY?(referenceBalance(card,context.target.id!==DEFAULT_CURRENCY)?.total):card.meters?.find(m=>m.kind==='balance'&&m.unit===settings.unit&&balanceDescriptor(card.provider,m.id)?.role==='total');
    if(balance)return [[card.id,balance.id] as [string,string]];
    if(settings.view==='spending'&&card.reportQuality&&(settings.unit===DEFAULT_CURRENCY||card.reportQuality.some(q=>q.unit===settings.unit)))return [[card.id,'costs'] as [string,string]];
    return [];
  });
  const admitted=ids.filter(([source])=>visible.has(source));
  return {selection:{...selectionOf(admitted.slice(0,MAX_METERS),settings.unit),...(settings.unit===DEFAULT_CURRENCY&&context.target.id!==DEFAULT_CURRENCY?{displayCurrency:context.target.id,...(context.revision?{displayRevision:context.revision}:{})}:{})},omitted:Math.max(0,admitted.length-MAX_METERS),removed:ids.length-admitted.length};
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

export const moneyChoices=(settings:MoneyPrefs)=>settings.modes?.[settings.view]??settings.selected;
export function chooseMoney(settings:MoneyPrefs,unit:string,ids:[string,string][]|null):MoneyPrefs {
  const choices={...moneyChoices(settings)};if(ids===null)delete choices[unit];else choices[unit]=ids;
  return {...settings,removed:0,modes:{balance:{...settings.selected},spending:{...settings.selected},...settings.modes,[settings.view]:choices}};
}
