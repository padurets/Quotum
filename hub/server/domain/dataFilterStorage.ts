import {isUnit} from './amount.js';
import {FILTER_BYTES,FILTER_FAMILIES,canonicalRefs,filterRefKey,jsonBytes,matchesSelection,matchesWallet,parseDataFilters,validFilterRef,
  type DataFilters,type FilterAuthority,type FilterDecision,type FilterFamily,type FilterUpdate,type FamilyRef,type MoneyRef,type Selection} from './dataFilters.js';
import {mergeFilters,projectFilters,setSelection,setWallet} from './dataFilterMerge.js';

type ScopedDecision=FilterDecision&{unit?:string};
export type StoredFilters={filters:DataFilters;retained:ScopedDecision[]};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const key=(d:ScopedDecision)=>JSON.stringify([d.family,d.unit??null,filterRefKey(d.ref)]);

/** Only raw storage carries decisions that coincide with a rule's current default. */
export function parseStoredFilters(value:unknown):StoredFilters|null {
  const plain=parseDataFilters(value);if(plain)return {filters:plain,retained:[]};
  if(!object(value)||Object.keys(value).some(k=>k!=='filters'&&k!=='retained')||!Array.isArray(value.retained)||jsonBytes(value)>FILTER_BYTES)return null;
  const filters=parseDataFilters(value.filters);if(!filters)return null;
  const retained=new Map<string,ScopedDecision>();
  for(const raw of value.retained){
    if(!object(raw)||Object.keys(raw).some(k=>!['family','ref','included','unit'].includes(k))||!FILTER_FAMILIES.includes(raw.family as FilterFamily)||typeof raw.included!=='boolean'||!validFilterRef(raw.family as FilterFamily,raw.ref))return null;
    if(raw.unit!==undefined){
      if(!isUnit(raw.unit)||raw.family!=='wallet'&&raw.family!=='funds')return null;
      if(raw.family==='wallet'?!filters.legacy?.walletByUnit?.[raw.unit]:!filters.legacy?.fundsByUnit?.[raw.unit])return null;
    }
    const decision={family:raw.family,ref:canonicalRefs([raw.ref])[0],included:raw.included,...(raw.unit===undefined?{}:{unit:raw.unit})} as ScopedDecision;retained.set(key(decision),decision);
  }
  const result={filters,retained:[...retained].sort(([a],[b])=>a.localeCompare(b)).map(([,d])=>d)};
  return jsonBytes(result)<=FILTER_BYTES?result:null;
}

function decisionsOf(filters:DataFilters):ScopedDecision[] {
  const decisions:ScopedDecision[]=[];
  const selection=(family:FilterFamily,rule:Selection<FamilyRef>,unit?:string)=>{for(const ref of rule.values)decisions.push({family,ref,included:rule.mode==='include',...(unit?{unit}:{})} as ScopedDecision);};
  for(const family of FILTER_FAMILIES){
    if(family==='wallet'){
      if(filters.wallet.mode==='only')for(const ref of filters.wallet.values)decisions.push({family,ref,included:true});
      else{for(const ref of filters.wallet.include)decisions.push({family,ref,included:true});for(const ref of filters.wallet.exclude)decisions.push({family,ref,included:false});}
    }else selection(family,filters[family]);
  }
  for(const [unit,rule] of Object.entries(filters.legacy?.walletByUnit??{}))for(const ref of rule.values)decisions.push({family:'wallet',unit,ref,included:true});
  for(const [unit,rule] of Object.entries(filters.legacy?.fundsByUnit??{}))selection('funds',rule,unit);
  return decisions;
}

function membership(filters:DataFilters,d:ScopedDecision,automatic:(ref:MoneyRef)=>boolean) {
  if(d.family==='wallet')return matchesWallet(d.unit?filters.legacy!.walletByUnit![d.unit]:filters.wallet,d.ref,automatic(d.ref));
  const rule=d.family==='funds'&&d.unit?filters.legacy!.fundsByUnit![d.unit]:filters[d.family];
  return matchesSelection(rule as Selection<FamilyRef>,d.ref);
}

/** Fold representable decisions into the ordinary rule, retaining the others. */
function apply(filters:DataFilters,d:ScopedDecision,automatic:(ref:MoneyRef)=>boolean=()=>false):boolean {
  if(d.family==='wallet'){
    const rule=d.unit?filters.legacy!.walletByUnit![d.unit]:filters.wallet,next=setWallet(rule,d.ref,d.included,automatic(d.ref));
    if(d.unit)filters.legacy!.walletByUnit![d.unit]=next as typeof rule&{mode:'only'};else filters.wallet=next;
    return next.mode==='only'&&!d.included;
  }
  const rule=d.family==='funds'&&d.unit?filters.legacy!.fundsByUnit![d.unit]:filters[d.family];
  const next=setSelection(rule as Selection<FamilyRef>,d.ref,d.included);
  if(d.family==='funds'&&d.unit)filters.legacy!.fundsByUnit![d.unit]=next as Selection<string>;else filters[d.family]=next as never;
  return d.included!==(next.mode==='include');
}

export function projectStoredFilters(raw:StoredFilters,allowed:FilterAuthority) {
  const effective=structuredClone(raw.filters);
  for(const d of raw.retained)apply(effective,d);
  const projected=projectFilters(effective,allowed),missing=new Map<FilterFamily,Set<string>>();
  const count=(d:ScopedDecision)=>{if(!allowed(d.family,d.ref,d.unit)){let refs=missing.get(d.family);if(!refs)missing.set(d.family,refs=new Set());refs.add(filterRefKey(d.ref));}};
  for(const d of [...decisionsOf(effective),...raw.retained])count(d);
  for(const [unit,refs] of Object.entries(effective.legacy?.fundsPreferredByUnit??{}))for(const ref of refs)count({family:'funds',unit,ref,included:true});
  for(const family of FILTER_FAMILIES)projected.unavailable[family]=missing.get(family)?.size??0;
  return projected;
}

/** The ledger is private to storage; PUT and period predicates remain public codecs. */
export function mergeStoredFilters(raw:StoredFilters,update:FilterUpdate,allowed:FilterAuthority,automatic:(ref:MoneyRef)=>boolean=()=>false):StoredFilters|null {
  const filters=mergeFilters(raw.filters,update,allowed,automatic);if(!filters)return null;
  const retained=new Map<string,ScopedDecision>();
  const retainedKeys=new Set(raw.retained.map(key));
  const old=new Map([...decisionsOf(raw.filters),...raw.retained].map(d=>[key(d),d]));
  for(const decision of old.values()){
    let d=decision;
    if(!update.replace.includes(d.family)){if(retainedKeys.has(key(d)))retained.set(key(d),d);continue;}
    if(update.resets?.[d.family])continue;
    const unit=d.family==='wallet'||d.family==='funds'?update.materialize?.[d.family]:undefined;
    if(unit){
      const branch=d.family==='wallet'?raw.filters.legacy?.walletByUnit?.[unit]:raw.filters.legacy?.fundsByUnit?.[unit];
      if(d.unit!==(branch?unit:undefined))continue;
      const {unit:_unit,...ordinary}=d;d=ordinary as ScopedDecision;
    }
    if(!allowed(decision.family,decision.ref,decision.unit)||membership(filters,d,automatic)===d.included){if(apply(filters,d,automatic))retained.set(key(d),d);}
  }
  for(const d of update.decisions??[]){retained.delete(key(d));if(apply(filters,d,automatic))retained.set(key(d),d);}
  return parseStoredFilters({filters,retained:[...retained.values()]})??limit();
}

function limit():never{throw Object.assign(new Error('filters_limit'),{statusCode:413});}
export const sameStoredFilters=(a:StoredFilters,b:StoredFilters)=>JSON.stringify(a)===JSON.stringify(b);
export const storedProjectRefs=(raw:StoredFilters)=>[...new Set([...raw.filters.projects.values,...raw.retained.filter(d=>d.family==='projects').map(d=>d.ref as string|null)])];
