import {DEFAULT_CURRENCY,defaultCurrencyContext,conversionOrigin,conversionId,type CurrencyContext} from '../../server/domain/currency';
import {balanceDescriptor, monetaryOf} from '../../server/domain/providers';
import {isUnit} from '../../server/domain/amount';
import {MAX_METERS,selectionOf,type MeterSelection} from '../../server/domain/meterHistory';
import type {Card} from './types';
import type {MeterHistory} from './moneyView';
import {referenceBalance,budgetVisible} from './money';
import {providerOf, budgetMeter, moneyFamily, type MoneyFamily} from '../../server/domain/providers';

export type MoneyPrefs={version:1;unit:string|null;selected:Record<string,[string,string][]>;legacySelected?:Record<string,[string,string][]>;removed?:number};
export const DEFAULT_MONEY:MoneyPrefs={version:1,unit:DEFAULT_CURRENCY,selected:{}};
const spendingMeter=(meter:string)=>{const native=conversionOrigin(meter)?.meter??meter;return native==='usage'||native==='credits'||/^key:[^:]+:usage$/.test(native);};
const readSelections=(value:unknown):MoneyPrefs['selected']=>{
  const selected:MoneyPrefs['selected']={};
  if(value&&typeof value==='object'&&!Array.isArray(value))for(const [unit,ids] of Object.entries(value)){
    try{if(!unit.startsWith('credits:'))selected[unit]=selectionOf(ids,unit).ids;}catch{/* Invalid saved selections grant no capabilities. */}
  }
  return selected;
};
export function readMoney(value:unknown,family:MoneyFamily='budget'):MoneyPrefs {
  if(!value||typeof value!=='object')return DEFAULT_MONEY;
  const raw=value as Partial<MoneyPrefs>,legacy=family==='funds'&&raw.version!==1;
  const selected=readSelections(raw.selected),legacySelected=legacy?selected:readSelections(raw.legacySelected);
  if(family==='budget')for(const unit of Object.keys(selected))selected[unit]=selected[unit].filter(([,meter])=>!spendingMeter(meter));
  return {version:1,unit:isUnit(raw.unit)&&!raw.unit.startsWith('credits:')?raw.unit==='CNY'?DEFAULT_CURRENCY:raw.unit:DEFAULT_CURRENCY,
    selected:legacy?{}:selected,...(family==='funds'&&(legacy&&raw.selected!==undefined||raw.legacySelected!==undefined)?{legacySelected}:{}),
    ...(Number.isSafeInteger(raw.removed)&&raw.removed!>0&&raw.removed!<=32?{removed:raw.removed}:{})};
}

/** Keep account and limit choices across boards; retired usage is never a balance. */
export function moneyChoices(cards:readonly Card[],ids:readonly [string,string][],unit:string):[string,string][] {
  const normalized=ids.filter(([,meter])=>!spendingMeter(meter)).map(([source,meter]):[string,string]=>{
    const card=cards.find(c=>c.id===source),origin=conversionOrigin(meter),descriptor=card&&balanceDescriptor(card.provider,origin?.meter??meter);
    const total=descriptor&&descriptor.role!=='total'?monetaryOf(card!.provider)?.balances.find(balance=>balance.role==='total'&&balance.unit===descriptor.unit):null;
    const preferred=descriptor&&card&&(unit===DEFAULT_CURRENCY?referenceBalance(card,true)?.total:card.meters?.find(m=>m.kind==='balance'&&m.unit===unit&&balanceDescriptor(card.provider,conversionOrigin(m.id)?.meter??m.id)?.role==='total'));
    if(preferred)return [source,preferred.id];
    return [source,total?(origin?conversionId(total.meterId,origin.unit):total.meterId):meter];
  });
  return [...new Map(normalized.map(pair=>[JSON.stringify(pair),pair])).values()];
}

/** One logical choice commits all available metrics, or leaves the selection intact. */
export function toggleMoneyChoice(selected:readonly [string,string][],source:string,meters:readonly string[],on:boolean):[string,string][] {
  const same=(meter:string)=>conversionOrigin(meter)?.meter??meter;
  const remaining=selected.filter(([id,meter])=>id!==source||!meters.some(candidate=>same(candidate)===same(meter)));
  const next=on?[...remaining,...meters.map(meter=>[source,meter] as [string,string])]:remaining;
  return next.length<=MAX_METERS?next:[...selected];
}
export function moneySelection(cards:readonly Card[],hidden:readonly string[],settings:MoneyPrefs,context:CurrencyContext=defaultCurrencyContext,family:MoneyFamily='budget'):{selection:MeterSelection|undefined;omitted:number;removed:number} {
  const unit=settings.unit??DEFAULT_CURRENCY;
  const shown=cards.filter(c=>moneyFamily(providerOf(c.provider))===family&&budgetVisible(c)&&!hidden.includes('source:'+c.id)),visible=new Set(shown.map(c=>c.id));
  const explicit=settings.selected[unit];
  let ids=explicit??shown.flatMap(card=>{
    const balance=unit===DEFAULT_CURRENCY?(referenceBalance(card,context.target.id!==DEFAULT_CURRENCY||card.provider==='codex')?.total):card.meters?.find(m=>m.kind==='balance'&&m.unit===unit&&balanceDescriptor(card.provider,m.id)?.role==='total');
    return balance?[[card.id,balance.id] as [string,string]]:[];
  });
  if(family==='funds'&&!explicit&&ids.length>MAX_METERS&&settings.legacySelected?.[unit]){
    const identity=([source,meter]:[string,string])=>JSON.stringify([source,conversionOrigin(meter)?.meter??meter]);
    const preferred=new Set(settings.legacySelected[unit].map(identity));
    ids=[...ids.filter(pair=>preferred.has(identity(pair))),...ids.filter(pair=>!preferred.has(identity(pair)))];
  }
  const unique=moneyChoices(shown,ids,unit);
  const admitted=unique.filter(([source,meter])=>visible.has(source)&&budgetMeter(providerOf(shown.find(card=>card.id===source)?.provider??''),meter));
  return {selection:{...selectionOf(admitted.slice(0,MAX_METERS),unit),...(shown.some(c=>c.provider==='codex')?{resourceRevision:JSON.stringify(shown.filter(c=>c.provider==='codex').map(c=>[c.id,c.budget]))}:{}),...(unit===DEFAULT_CURRENCY&&(context.target.id!==DEFAULT_CURRENCY||shown.some(c=>c.provider==='codex'))?{displayCurrency:context.target.id,...(context.revision?{displayRevision:context.revision}:{})}:{})},omitted:Math.max(0,admitted.length-MAX_METERS),removed:unique.length-admitted.length};
}

/** The old global subset is visibility intent, including accounts on other boards. */
export const fundsLegacyMuted=(settings:MoneyPrefs,source:string,meter:string)=>{
  const selected=settings.legacySelected?.[settings.unit??DEFAULT_CURRENCY];
  return !!selected&&!selected.some(([id,key])=>id===source&&(conversionOrigin(key)?.meter??key)===(conversionOrigin(meter)?.meter??meter));
};

/** Membership is checked against the inventory, not against the visible page. */
export const keyMeter=(meter:string)=>/^key:([^:]+):(usage|cap)$/.exec(conversionOrigin(meter)?.meter??meter);

export function archivedKeyGroups(source:string,selected:readonly [string,string][],current:ReadonlySet<string>,history:readonly MeterHistory[]) {
  const groups=new Map<string,{id:string;label:string;cap:string}>();
  for(const [owner,meter] of selected) {
    const key=keyMeter(meter);if(owner!==source||!key||key[2]!=='cap')continue;
    const id=key[1];
    if(current.has(id))continue;
    const saved=history.find(s=>s.sourceId===source&&s.meterId===meter);
    let group=groups.get(id);
    if(!group)groups.set(id,(group={id,label:saved?.semantics?.label??id,cap:meter}));
    group.cap=meter;
  }
  return [...groups.values()];
}
