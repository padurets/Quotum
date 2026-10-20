import {defaultFilters,filterRefKey,fundsRule,matchesSelection,matchesSource,matchesWallet,walletRule,type DataFilters,type FamilyRef,type FundingRef,type MoneyRef,type Selection} from '../../server/domain/dataFilters';
import type {WorkFacets} from '../../server/domain/periodRead';
import {moneyFamily,providerOf} from '../../server/domain/providers';
import {quotaPeriods} from './subscription';
import {subscriptionFundsVisible} from './money';
import type {Card} from './types';

export const RESOURCE_FILTERS=['sources','windows','wallet','funds'] as const;
export const selectionRestricted=(rule:Selection<FamilyRef>)=>rule.mode==='include'||rule.values.length>0;
export function excludedCount<T extends FamilyRef>(rule:Selection<T>,choices:readonly T[]=[]){
  return rule.mode==='exclude'?rule.values.length:choices.filter(ref=>!matchesSelection(rule,ref)).length;
}
export function resourcesRestricted(filters:DataFilters){
  const defaults=defaultFilters();
  return !!filters.legacy||RESOURCE_FILTERS.some(family=>JSON.stringify(filters[family])!==JSON.stringify(defaults[family]));
}

/** An excluded parent counts once; its hidden children keep their own selections. */
export function excludedResources(filters:DataFilters,sources:readonly Card[],facets:WorkFacets|null,walletUnit?:string,fundsUnit?:string){
  const choices:FundingRef[]=[...sources.map(source=>({source:source.id})),...(facets?.funding??[]).map(status=>({status}))];
  let count=excludedCount(filters.sources,choices);
  const wallet=walletRule(filters,walletUnit),funds=fundsRule(filters,fundsUnit);
  for(const source of sources){
    if(!matchesSource(filters,source.id))continue;
    count+=quotaPeriods(source).filter(window=>!matchesSelection(filters.windows,[source.id,window.id])).length;
    if(subscriptionFundsVisible(source)&&!matchesSelection(funds,source.id))count++;
    if(moneyFamily(providerOf(source.provider))!=='budget'||source.budget?.enabled===false)continue;
    if(wallet.mode==='auto')count+=wallet.exclude.filter(ref=>ref.source===source.id).length;
    else {
      const preview:MoneyRef[]=[...(source.meters?.some(meter=>meter.kind==='balance')?[{source:source.id,kind:'balance' as const}]:[]),
        ...(source.keys??[]).slice(0,5).filter(key=>source.meters?.some(meter=>meter.id===`key:${key.id}:cap`)).map(key=>({source:source.id,kind:'keyCap' as const,key:key.id}))];
      count+=[...new Map(preview.map(ref=>[filterRefKey(ref),ref])).values()].filter(ref=>!matchesWallet(wallet,ref,true)).length;
    }
  }
  return count;
}
