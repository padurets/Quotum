import {BUDGET_TABLE,widgetVisible} from '../../server/domain/widgets';
import type {View} from '../../server/domain/view';
import {columnShown} from './view';
import {sourceWorkEligible} from '../../server/domain/moneyWork';
import {DEFAULT_CURRENCY,defaultCurrencyContext,conversionOrigin,conversionId,type CurrencyContext} from '../../server/domain/currency';
import {balanceDescriptor, monetaryOf} from '../../server/domain/providers';
import {isUnit} from '../../server/domain/amount';
import {MAX_METERS,selectionOf,type MeterSelection} from '../../server/domain/meterHistory';
import type {Card} from './types';
import type {MeterHistory} from './moneyView';
import {referenceBalance,budgetVisible} from './money';
import {providerOf, budgetMeter, moneyFamily, type MoneyFamily} from '../../server/domain/providers';
import {fundsRule,matchesSelection,matchesSource,matchesWallet,walletRule,type MoneyRef} from '../../server/domain/dataFilters';
import {effectiveFilters} from './filterSelection';

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
export function moneySelection(cards:readonly Card[],_hidden:readonly string[],settings:MoneyPrefs,context:CurrencyContext=defaultCurrencyContext,family:MoneyFamily='budget'):{selection:MeterSelection|undefined;omitted:number;removed:number;limited?:boolean} {
  const unit=settings.unit??DEFAULT_CURRENCY;
  const filters=effectiveFilters();
  const shown=cards.filter(c=>moneyFamily(providerOf(c.provider))===family&&budgetVisible(c)&&(!filters||matchesSource(filters,c.id)&&
    (family!=='funds'||matchesSelection(fundsRule(filters,unit),c.id)))),visible=new Set(shown.map(c=>c.id));
  const rule=filters&&walletRule(filters,unit);
  const balance=(card:Card)=>unit===DEFAULT_CURRENCY?referenceBalance(card,context.target.id!==DEFAULT_CURRENCY||card.provider==='codex')?.total:card.meters?.find(m=>m.kind==='balance'&&m.unit===unit&&balanceDescriptor(card.provider,m.id)?.role==='total');
  const resolve=(ref:MoneyRef):[string,string][]=>{
    const card=shown.find(card=>card.id===ref.source);if(!card)return [];
    if(ref.kind==='balance'){const total=balance(card);return total?[[ref.source,total.id]]:[];}
    return [[ref.source,`key:${ref.key}:cap`]];
  };
  const preview=shown.flatMap(card=>(card.keys??[]).slice(0,5).filter(key=>card.meters?.some(m=>m.id===`key:${key.id}:cap`&&m.kind==='cap')).map(key=>({source:card.id,kind:'keyCap' as const,key:key.id})));
  const automatic:MoneyRef[]=[...shown.filter(card=>balance(card)).map(card=>({source:card.id,kind:'balance' as const})),...preview];
  const candidates=rule?.mode==='only'?rule.values:rule?.mode==='auto'?[...rule.include,...automatic]:[];
  const filtered=rule&&candidates.filter(ref=>matchesWallet(rule,ref,automatic.some(other=>JSON.stringify(ref)===JSON.stringify(other)))).flatMap(resolve);
  const explicit=filters?family==='budget'?filtered:undefined:settings.selected[unit];
  let ids=explicit??shown.flatMap(card=>{
    const balance=unit===DEFAULT_CURRENCY?(referenceBalance(card,context.target.id!==DEFAULT_CURRENCY||card.provider==='codex')?.total):card.meters?.find(m=>m.kind==='balance'&&m.unit===unit&&balanceDescriptor(card.provider,m.id)?.role==='total');
    return balance?[[card.id,balance.id] as [string,string]]:[];
  });
  const preferredSources=filters?.legacy?.fundsPreferredByUnit?.[unit];
  const legacyPriority=!filters?settings.legacySelected?.[unit]:undefined;
  if(family==='funds'&&!explicit&&ids.length>MAX_METERS&&(preferredSources||legacyPriority)){
    const identity=([source,meter]:[string,string])=>JSON.stringify([source,conversionOrigin(meter)?.meter??meter]);
    const preferred=new Set(preferredSources?ids.filter(([source])=>preferredSources.includes(source)).map(identity):(legacyPriority??[]).map(identity));
    ids=[...ids.filter(pair=>preferred.has(identity(pair))),...ids.filter(pair=>!preferred.has(identity(pair)))];
  }
  const unique=moneyChoices(shown,ids,unit);
  const admitted=unique.filter(([source,meter])=>visible.has(source)&&budgetMeter(providerOf(shown.find(card=>card.id===source)?.provider??''),meter));
  const limited=admitted.length>MAX_METERS&&!!filters&&(family==='budget'?rule?.mode==='only':fundsRule(filters,unit).mode==='include');
  return {selection:{...selectionOf(limited?[]:admitted.slice(0,MAX_METERS),unit),...(shown.some(c=>c.provider==='codex')?{resourceRevision:JSON.stringify(shown.filter(c=>c.provider==='codex').map(c=>[c.id,c.budget]))}:{}),...(unit===DEFAULT_CURRENCY&&(context.target.id!==DEFAULT_CURRENCY||shown.some(c=>c.provider==='codex'))?{displayCurrency:context.target.id,...(context.revision?{displayRevision:context.revision}:{})}:{})},omitted:Math.max(0,admitted.length-MAX_METERS),removed:unique.length-admitted.length,...(limited?{limited:true}:{})};
}

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

/** Chart and table requests share one selection; source work is an explicit table need. */
export function moneyReadSelection(cards:readonly Card[],view:View,settings:MoneyPrefs,context:CurrencyContext=defaultCurrencyContext,family:MoneyFamily='budget'):MeterSelection|undefined {
  const selected=moneySelection(cards,view.hidden,settings,context,family).selection;
  const work=family==='budget'&&widgetVisible(view,BUDGET_TABLE,cards.length)&&['active','rate','remaining'].some(id=>columnShown(view,BUDGET_TABLE,id))&&selected?.ids.some(([id,meter])=>sourceWorkEligible(cards.find(card=>card.id===id)?.provider??'',meter));
  return work&&selected?{...selected,work:true}:selected;
}
