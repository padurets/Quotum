import {canonicalRefs,defaultFilters,fundsRule,walletRule,type DataFilters,type FamilyRef,type Selection} from '../../server/domain/dataFilters';
import {moneyFamily,providerOf,supportsQuota} from '../../server/domain/providers';
import {quotaPeriods} from './subscription';
import type {Card} from './types';

export type LegendKind='project'|'device'|'source'|'session'|'weekly'|'budget'|'funds';
export type LegendSelection={kind:LegendKind;unit?:string};
const selection=<T extends FamilyRef>(rule:Selection<T>,keep:(ref:T)=>boolean=()=>true)=>({mode:rule.mode,values:canonicalRefs(rule.values.filter(keep))});
export const legendHasSource=(kind:LegendKind,card:Card|undefined)=>!card||
  (kind==='project'||kind==='device'||kind==='source'?true:kind==='session'||kind==='weekly'?supportsQuota(providerOf(card.provider)):moneyFamily(providerOf(card.provider))===kind);

/** Project the applied rule, never the rows returned for a particular history range. */
export function legendSelectionKey(filters:DataFilters|undefined,{kind,unit}:LegendSelection,cards:readonly Card[]) {
  const current=filters??defaultFilters();
  if(kind==='project')return JSON.stringify(selection(current.projects));
  if(kind==='device')return JSON.stringify(selection(current.devices));
  if(kind==='source')return JSON.stringify(selection(current.sources));
  const quota=kind==='session'||kind==='weekly';
  const belongs=(source:string)=>{
    const card=cards.find(card=>card.id===source);
    // Missing metadata cannot grant a narrower invalidation boundary.
    return legendHasSource(kind,card);
  };
  const sources=selection(current.sources,ref=>'source' in ref&&belongs(ref.source));
  if(quota)return JSON.stringify([sources,selection(current.windows,([source,id])=>{
    if(!belongs(source))return false;
    const card=cards.find(card=>card.id===source),period=card&&quotaPeriods(card).find(period=>period.id===id);
    return !period||period.kind==='other'||period.kind===kind;
  })]);
  if(kind==='funds')return JSON.stringify([sources,selection(fundsRule(current,unit))]);
  const rule=walletRule(current,unit);
  return JSON.stringify([sources,rule.mode==='only'?{mode:rule.mode,values:canonicalRefs(rule.values)}:{mode:rule.mode,include:canonicalRefs(rule.include),exclude:canonicalRefs(rule.exclude)}]);
}
