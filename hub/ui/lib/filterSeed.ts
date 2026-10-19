import {conversionOrigin} from '../../server/domain/currency';
import {filterRefKey,parseDataFilters,type DataFilters,type MoneyRef} from '../../server/domain/dataFilters';
import {moneyChoices,keyMeter,type MoneyPrefs} from './moneySelection';
import type {Card} from './types';

/** Global legacy preferences remain read-only so another board can migrate independently. */
export function seedDataFilters(saved:DataFilters,cards:readonly Card[],money:MoneyPrefs,funds:MoneyPrefs):DataFilters {
  const filters=structuredClone(saved),legacy={...filters.legacy};
  const off=saved.wallet.mode==='auto'?saved.wallet.exclude:[];
  const byUnit:NonNullable<DataFilters['legacy']>['walletByUnit']={};
  for(const [unit,pairs] of Object.entries(money.selected)){
    const values=moneyChoices(cards,pairs,unit).flatMap(([source,meter]):MoneyRef[]=>{
      const native=conversionOrigin(meter)?.meter??meter,key=keyMeter(native);
      return key?.[2]==='cap'?[{source,kind:'keyCap',key:key[1]}]:key?[]:[{source,kind:'balance'}];
    }).filter(ref=>!off.some(excluded=>JSON.stringify(excluded)===JSON.stringify(ref)));
    byUnit[unit]={mode:'only',values};
  }
  if(Object.keys(byUnit).length)legacy.walletByUnit=byUnit;
  const fundsByUnit=Object.fromEntries(Object.entries(funds.selected).map(([unit,pairs])=>[unit,{mode:'include' as const,values:[...new Set(pairs.map(([source])=>source))]}]));
  if(Object.keys(fundsByUnit).length)legacy.fundsByUnit=fundsByUnit;
  const preferred=Object.fromEntries(Object.entries(funds.legacySelected??{}).map(([unit,pairs])=>[unit,[...new Set(pairs.map(([source])=>source))]]));
  if(Object.keys(preferred).length)legacy.fundsPreferredByUnit=preferred;
  if(Object.keys(legacy).length)filters.legacy=legacy;
  // An inherited oversized selection remains available for explicit recovery.
  return parseDataFilters(filters)??filters;
}

export function seedConflicts(saved:DataFilters,money:MoneyPrefs):number {
  const on=saved.wallet.mode==='auto'?saved.wallet.include:[],off=saved.wallet.mode==='auto'?saved.wallet.exclude:[],conflicts=new Set<string>();
  for(const pairs of Object.values(money.selected)){
    const selected=new Set(pairs.map(([source,meter])=>{const key=keyMeter(meter);return filterRefKey(key?{source,kind:'keyCap',key:key[1]}:{source,kind:'balance'});}));
    for(const ref of on)if(!selected.has(filterRefKey(ref)))conflicts.add(filterRefKey(ref));
    for(const ref of off)if(selected.has(filterRefKey(ref)))conflicts.add(filterRefKey(ref));
  }
  return conflicts.size;
}
