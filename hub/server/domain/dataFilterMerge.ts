import {canonicalRefs,defaultFilters,filterRefKey,FILTER_FAMILIES,FILTER_BYTES,jsonBytes,parseDataFilters,walletRule,fundsRule,
  type DataFilters,type FilterAuthority,type FilterFamily,type FamilyRef,type FilterUpdate,type Selection,type Wallet,type MoneyRef,type OnlyWallet} from './dataFilters.js';
import {providerOf,supportsQuota} from './providers.js';

/** A projected document is safe to disclose; dormant intent stays in raw storage. */
export function projectFilters(raw:DataFilters,allowed:FilterAuthority) {
  const unavailable=Object.fromEntries(FILTER_FAMILIES.map(family=>[family,0])) as Record<FilterFamily,number>;
  const missing=new Map<FilterFamily,Set<string>>();
  const keep=<T extends FamilyRef>(family:FilterFamily,values:T[],unit?:string):T[]=>values.filter(ref=>{
    if(allowed(family,ref,unit))return true;
    let set=missing.get(family);if(!set)missing.set(family,set=new Set());set.add(filterRefKey(ref));return false;
  });
  const filters=structuredClone(raw);
  for(const family of FILTER_FAMILIES){
    if(family==='wallet'){
      filters.wallet=raw.wallet.mode==='only'?{mode:'only',values:keep(family,raw.wallet.values)}:
        {mode:'auto',include:keep(family,raw.wallet.include),exclude:keep(family,raw.wallet.exclude)};
    }else filters[family]={...raw[family],values:keep<FamilyRef>(family,raw[family].values)} as never;
  }
  if(filters.legacy){
    if(raw.legacy?.walletByUnit)filters.legacy.walletByUnit=Object.fromEntries(Object.entries(raw.legacy.walletByUnit).map(([unit,rule])=>[unit,{mode:'only',values:keep('wallet',rule.values,unit)}]));
    if(raw.legacy?.fundsByUnit)filters.legacy.fundsByUnit=Object.fromEntries(Object.entries(raw.legacy.fundsByUnit).map(([unit,rule])=>[unit,{...rule,values:keep('funds',rule.values,unit)}]));
    if(raw.legacy?.fundsPreferredByUnit)filters.legacy.fundsPreferredByUnit=Object.fromEntries(Object.entries(raw.legacy.fundsPreferredByUnit).map(([unit,refs])=>[unit,keep('funds',refs,unit)]));
  }
  for(const [family,refs] of missing)unavailable[family]=refs.size;
  return {filters,unavailable};
}

function mergeSelection<T extends FamilyRef>(old:Selection<T>,next:Selection<T>,allowed:(ref:T)=>boolean):Selection<T> {
  // A mode change must preserve each dormant explicit decision's boolean membership.
  const dormant=old.mode===next.mode?old.values.filter(ref=>!allowed(ref)):[];
  return {mode:next.mode,values:canonicalRefs([...next.values,...dormant])};
}
function mergeWallet(old:Wallet,next:Wallet,allowed:(ref:MoneyRef)=>boolean):Wallet {
  const on=(old.mode==='only'?old.values:old.include).filter(ref=>!allowed(ref));
  const off=old.mode==='auto'?old.exclude.filter(ref=>!allowed(ref)):[];
  if(next.mode==='only')return {mode:'only',values:canonicalRefs([...next.values,...on])};
  const exclude=canonicalRefs([...next.exclude,...off]),excluded=new Set(exclude.map(filterRefKey));
  return {mode:'auto',include:canonicalRefs([...next.include,...on]).filter(ref=>!excluded.has(filterRefKey(ref))),exclude};
}
export function setSelection<T extends FamilyRef>(rule:Selection<T>,ref:T,included:boolean):Selection<T> {
  const values=rule.values.filter(value=>filterRefKey(value)!==filterRefKey(ref));
  if(included===(rule.mode==='include'))values.push(ref);
  return {mode:rule.mode,values:canonicalRefs(values)};
}
export function setWallet(rule:Wallet,ref:MoneyRef,included:boolean,automatic=false):Wallet {
  if(rule.mode==='only')return {mode:'only',values:setSelection({mode:'include',values:rule.values},ref,included).values};
  const include=rule.include.filter(value=>filterRefKey(value)!==filterRefKey(ref)),exclude=rule.exclude.filter(value=>filterRefKey(value)!==filterRefKey(ref));
  // A preview can move around a manually pinned key; only an off or reset removes it.
  if(!included)exclude.push(ref);else if(!automatic||rule.include.some(value=>filterRefKey(value)===filterRefKey(ref)))include.push(ref);
  return {mode:'auto',include:canonicalRefs(include),exclude:canonicalRefs(exclude)};
}
export function resetFilter(filters:DataFilters,family:FilterFamily,mode:'all'|'none'):DataFilters {
  const next=structuredClone(filters);
  if(family==='wallet')next.wallet=mode==='all'?{mode:'auto',include:[],exclude:[]}:{mode:'only',values:[]};
  else next[family]={mode:mode==='all'?'exclude':'include',values:[]} as never;
  clearLegacy(next,family);return next;
}
function clearLegacy(filters:DataFilters,family:FilterFamily) {
  if(!filters.legacy)return;
  if(family==='wallet')delete filters.legacy.walletByUnit;
  if(family==='funds'){delete filters.legacy.fundsByUnit;delete filters.legacy.fundsPreferredByUnit;}
  if(!Object.keys(filters.legacy).length)delete filters.legacy;
}

/** Merge under the same authority snapshot as the revision precondition. */
export function mergeFilters(raw:DataFilters,update:FilterUpdate,allowed:FilterAuthority,automatic:(ref:MoneyRef)=>boolean=()=>false):DataFilters|null {
  let result=structuredClone(raw);
  for(const family of update.replace){
    const reset=update.resets?.[family];
    if(reset){result=resetFilter(result,family,reset);continue;}
    const unit=family==='wallet'||family==='funds'?update.materialize?.[family]:undefined;
    if(family==='wallet'){
      const old=walletRule(raw,unit),next=update.filters.wallet;
      if(raw.legacy?.walletByUnit&&!unit&&!update.filters.legacy?.walletByUnit)return null;
      result.wallet=mergeWallet(old,next,ref=>allowed(family,ref,unit));
      if(unit)clearLegacy(result,family);
      else if(update.filters.legacy?.walletByUnit){
        result.legacy??={};
        result.legacy.walletByUnit=Object.fromEntries(Object.entries({...raw.legacy?.walletByUnit,...update.filters.legacy.walletByUnit}).map(([key,rule])=>[key,
          update.filters.legacy?.walletByUnit?.[key]?mergeWallet(raw.legacy?.walletByUnit?.[key]??{mode:'only',values:[]},rule,ref=>allowed(family,ref,key)) as OnlyWallet:rule]));
      }
    }else if(family==='funds'){
      if(raw.legacy?.fundsByUnit&&!unit&&!update.filters.legacy?.fundsByUnit)return null;
      result.funds=mergeSelection(fundsRule(raw,unit),update.filters.funds,ref=>allowed(family,ref,unit));
      if(unit)clearLegacy(result,family);
      else {
        if(update.filters.legacy?.fundsByUnit){result.legacy??={};result.legacy.fundsByUnit=Object.fromEntries(Object.entries({...raw.legacy?.fundsByUnit,...update.filters.legacy.fundsByUnit}).map(([key,rule])=>[key,
          update.filters.legacy?.fundsByUnit?.[key]?mergeSelection(raw.legacy?.fundsByUnit?.[key]??{mode:'include',values:[]},rule,ref=>allowed(family,ref,key)):rule]));}
        if(update.filters.legacy?.fundsPreferredByUnit){
          result.legacy??={};result.legacy.fundsPreferredByUnit={...raw.legacy?.fundsPreferredByUnit};
          for(const [key,refs] of Object.entries(update.filters.legacy.fundsPreferredByUnit))result.legacy.fundsPreferredByUnit[key]=[...new Set([...refs,...(raw.legacy?.fundsPreferredByUnit?.[key]??[]).filter(ref=>!allowed(family,ref,key))])];
        }
      }
    }else result[family]=mergeSelection(raw[family] as Selection<FamilyRef>,update.filters[family] as Selection<FamilyRef>,ref=>allowed(family,ref)) as never;
  }
  for(const decision of update.decisions??[]){
    if(decision.family==='wallet')result.wallet=setWallet(result.wallet,decision.ref,decision.included,automatic(decision.ref));
    else result[decision.family]=setSelection(result[decision.family] as Selection<FamilyRef>,decision.ref,decision.included) as never;
  }
  if(jsonBytes(result)>FILTER_BYTES)throw Object.assign(new Error('filters_limit'),{statusCode:413});
  return parseDataFilters(result);
}

/** Extract the released v4 membership without treating hidden cards as exclusions. */
export function filtersFromView(view:{windows:readonly string[];shown:readonly string[]}):DataFilters {
  const filters=defaultFilters();
  const key=(value:string):MoneyRef|null=>{
    const at=value.indexOf('/'),source=value.slice(0,at);
    // Native window IDs can contain both slashes and a leading key: scope.
    if(at<=0||supportsQuota(providerOf(source.split(':')[0])))return null;
    const match=/^key:([^/]+)$/.exec(value.slice(at+1));
    return match?{source,kind:'keyCap',key:match[1]}:null;
  };
  for(const value of view.windows){const match=key(value);if(match&&filters.wallet.mode==='auto')filters.wallet.exclude.push(match);
    else {const at=value.indexOf('/');if(at>0)filters.windows.values.push([value.slice(0,at),value.slice(at+1)]);}}
  for(const value of view.shown){const match=key(value);if(match&&filters.wallet.mode==='auto')filters.wallet.include.push(match);}
  const parsed=parseDataFilters(filters);if(!parsed)throw new Error('Invalid migrated board filters');return parsed;
}

/** A regrant exposes raw decisions, while a foreign save leaves an open view alone. */
export function rebaseFilterProjection(current:DataFilters,before:DataFilters,after:DataFilters,intents:Pick<FilterUpdate,'resets'|'decisions'|'materialize'>):DataFilters {
  const result=structuredClone(current);
  for(const family of FILTER_FAMILIES){
    if(intents.resets?.[family])continue;
    const touched=new Set(intents.decisions?.filter(d=>d.family===family).map(d=>filterRefKey(d.ref)));
    const selection=<T extends FamilyRef>(rule:Selection<T>,prior:Selection<T>,next:Selection<T>)=>{
      const existing=new Set(prior.values.map(filterRefKey));
      for(const ref of next.values)if(!existing.has(filterRefKey(ref))&&!touched.has(filterRefKey(ref)))rule=setSelection(rule,ref,next.mode==='include');
      return rule;
    };
    const wallet=(rule:Wallet,prior:Wallet,next:Wallet)=>{
      const explicit=(rule:Wallet)=>rule.mode==='only'?rule.values.map(ref=>({ref,included:true})):[...rule.include.map(ref=>({ref,included:true})),...rule.exclude.map(ref=>({ref,included:false}))];
      const existing=new Set(explicit(prior).map(d=>filterRefKey(d.ref)));
      for(const {ref,included} of explicit(next))if(!existing.has(filterRefKey(ref))&&!touched.has(filterRefKey(ref)))rule=setWallet(rule,ref,included);
      return rule;
    };
    if(family==='wallet'){
      const unit=intents.materialize?.wallet;
      result.wallet=wallet(result.wallet,walletRule(before,unit),walletRule(after,unit));
      if(!unit&&after.legacy?.walletByUnit)for(const [unit,rule] of Object.entries(after.legacy.walletByUnit)){
        result.legacy??={};result.legacy.walletByUnit??={};
        result.legacy.walletByUnit[unit]=wallet(result.legacy.walletByUnit[unit]??{mode:'only',values:[]},before.legacy?.walletByUnit?.[unit]??{mode:'only',values:[]},rule) as OnlyWallet;
      }
    }else {
      const unit=family==='funds'?intents.materialize?.funds:undefined;
      result[family]=selection(result[family] as Selection<FamilyRef>,family==='funds'?fundsRule(before,unit):before[family],family==='funds'?fundsRule(after,unit):after[family]) as never;
      if(family==='funds'&&!unit){
        if(after.legacy?.fundsByUnit)for(const [unit,rule] of Object.entries(after.legacy.fundsByUnit)){
          result.legacy??={};result.legacy.fundsByUnit??={};
          result.legacy.fundsByUnit[unit]=selection(result.legacy.fundsByUnit[unit]??{mode:'include',values:[]},before.legacy?.fundsByUnit?.[unit]??{mode:'include',values:[]},rule);
        }
        if(after.legacy?.fundsPreferredByUnit)for(const [unit,refs] of Object.entries(after.legacy.fundsPreferredByUnit)){
          result.legacy??={};result.legacy.fundsPreferredByUnit??={};
          const prior=new Set(before.legacy?.fundsPreferredByUnit?.[unit]??[]);
          result.legacy.fundsPreferredByUnit[unit]=canonicalRefs([...(result.legacy.fundsPreferredByUnit[unit]??[]),...refs.filter(ref=>!prior.has(ref)&&!touched.has(filterRefKey(ref)))]);
        }
      }
    }
  }
  return result;
}
