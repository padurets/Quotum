import {isUnit} from './amount.js';
import {PROJECT_NAME_CHARS} from './projects.js';

export type Selection<T> = {mode:'include'|'exclude';values:T[]};
export type FundingRef = {source:string}|{status:'unknown'|'notProvided'};
export type WindowRef = [source:string,window:string];
export type MoneyRef = {source:string;kind:'balance'}|{source:string;kind:'keyCap';key:string};
export type OnlyWallet = {mode:'only';values:MoneyRef[]};
export type Wallet = OnlyWallet|{mode:'auto';include:MoneyRef[];exclude:MoneyRef[]};
export type DataFilters = {
  version:1;
  sources:Selection<FundingRef>;
  windows:Selection<WindowRef>;
  wallet:Wallet;
  funds:Selection<string>;
  projects:Selection<string|null>;
  devices:Selection<string>;
  clients:Selection<string|null>;
  legacy?:{walletByUnit?:Record<string,OnlyWallet>;fundsByUnit?:Record<string,Selection<string>>;fundsPreferredByUnit?:Record<string,string[]>};
};
export const FILTER_FAMILIES = ['sources','windows','wallet','funds','projects','devices','clients'] as const;
export type FilterFamily = typeof FILTER_FAMILIES[number];
export type FamilyRefs = {sources:FundingRef;windows:WindowRef;wallet:MoneyRef;funds:string;projects:string|null;devices:string;clients:string|null};
export type FamilyRef = FamilyRefs[FilterFamily];
export const FILTER_BYTES = 256*1024;
export const FILTER_BODY_LIMIT = 272*1024;
export const jsonBytes = (value:unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const defaultFilters = ():DataFilters => ({version:1,sources:{mode:'exclude',values:[]},windows:{mode:'exclude',values:[]},
  wallet:{mode:'auto',include:[],exclude:[]},funds:{mode:'exclude',values:[]},projects:{mode:'exclude',values:[]},devices:{mode:'exclude',values:[]},clients:{mode:'exclude',values:[]}});

const object = (value:unknown):value is Record<string,unknown> => !!value&&typeof value==='object'&&!Array.isArray(value);
const keys = (value:Record<string,unknown>,allowed:readonly string[]) => Object.keys(value).every(key=>allowed.includes(key));
const id = (value:unknown):value is string => typeof value==='string'&&/^[A-Za-z0-9:_-]{1,120}$/.test(value);
const project = (value:unknown):value is string|null => value===null||typeof value==='string'&&value.length>0&&[...value].length<=PROJECT_NAME_CHARS&&!/[\u0000-\u001f\u007f]/.test(value);
const client = (value:unknown):value is string|null => value===null||typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(value);
const funding = (value:unknown):value is FundingRef => object(value)&&(Object.keys(value).length===1)&&
  (id(value.source)||value.status==='unknown'||value.status==='notProvided');
const windowRef = (value:unknown):value is WindowRef => Array.isArray(value)&&value.length===2&&id(value[0])&&typeof value[1]==='string'&&value[1].length>0&&[...value[1]].length<=120;
const money = (value:unknown):value is MoneyRef => object(value)&&id(value.source)&&
  (value.kind==='balance'&&keys(value,['source','kind'])||value.kind==='keyCap'&&id(value.key)&&keys(value,['source','kind','key']));
const validators:{[F in FilterFamily]:(value:unknown)=>value is FamilyRefs[F]} = {sources:funding,windows:windowRef,wallet:money,funds:id,projects:project,devices:id,clients:client};
export const validFilterRef=(family:FilterFamily,ref:unknown):ref is FamilyRef=>validators[family](ref);

/** Identities never include display currency or an object's incoming key order. */
export function filterRefKey(value:FamilyRef):string {
  if(value===null||typeof value==='string'||Array.isArray(value))return JSON.stringify(value);
  if('status' in value)return JSON.stringify(['status',value.status]);
  if('kind' in value)return JSON.stringify([value.source,value.kind,...(value.kind==='keyCap'?[value.key]:[])]);
  return JSON.stringify(['source',value.source]);
}
export function canonicalRefs<T extends FamilyRef>(values:readonly T[]):T[] {
  return [...new Map(values.map(value=>[filterRefKey(value),value])).entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,value])=>
    value===null||typeof value==='string'||Array.isArray(value)?value:('status' in value?{status:value.status}:'kind' in value?
      {source:value.source,kind:value.kind,...(value.kind==='keyCap'?{key:value.key}:{})}:{source:value.source}) as T);
}
function list<T extends FamilyRef>(value:unknown,valid:(value:unknown)=>value is T):T[]|null {
  return Array.isArray(value)&&value.length<=FILTER_BYTES&&value.every(valid)?canonicalRefs(value):null;
}
function selection<T extends FamilyRef>(value:unknown,valid:(value:unknown)=>value is T):Selection<T>|null {
  if(!object(value)||!keys(value,['mode','values'])||!['include','exclude'].includes(String(value.mode)))return null;
  const values=list(value.values,valid);return values?{mode:value.mode as Selection<T>['mode'],values}:null;
}
function wallet(value:unknown):Wallet|null {
  if(!object(value))return null;
  if(value.mode==='only'&&keys(value,['mode','values'])){const values=list(value.values,money);return values?{mode:'only',values}:null;}
  if(value.mode!=='auto'||!keys(value,['mode','include','exclude']))return null;
  const include=list(value.include,money),exclude=list(value.exclude,money);
  return include&&exclude?{mode:'auto',include:include.filter(ref=>!exclude.some(off=>filterRefKey(ref)===filterRefKey(off))),exclude}:null;
}
function unitMap<T>(value:unknown,parse:(value:unknown)=>T|null):Record<string,T>|null {
  if(!object(value))return null;
  const entries:[string,T][]=[];
  for(const [unit,raw] of Object.entries(value).sort(([a],[b])=>a.localeCompare(b))){const parsed=parse(raw);if(!isUnit(unit)||parsed===null)return null;entries.push([unit,parsed]);}
  return Object.fromEntries(entries);
}

/** This codec is shared by storage, API and browser; unknown fields are errors. */
export function parseDataFilters(value:unknown):DataFilters|null {
  if(!object(value)||value.version!==1||!keys(value,['version',...FILTER_FAMILIES,'legacy']))return null;
  const sources=selection(value.sources,funding),windows=selection(value.windows,windowRef),funds=selection(value.funds,id),
    projects=selection(value.projects,project),devices=selection(value.devices,id),clients=selection(value.clients,client),moneyRule=wallet(value.wallet);
  if(!sources||!windows||!moneyRule||!funds||!projects||!devices||!clients)return null;
  const result:DataFilters={version:1,sources,windows,wallet:moneyRule,funds,projects,devices,clients};
  if(value.legacy!==undefined){
    if(!object(value.legacy)||!keys(value.legacy,['walletByUnit','fundsByUnit','fundsPreferredByUnit']))return null;
    const legacy:NonNullable<DataFilters['legacy']>={};
    if(value.legacy.walletByUnit!==undefined){const map=unitMap(value.legacy.walletByUnit,raw=>{const rule=wallet(raw);return rule?.mode==='only'?rule:null;});if(!map)return null;if(Object.keys(map).length)legacy.walletByUnit=map;}
    if(value.legacy.fundsByUnit!==undefined){const map=unitMap(value.legacy.fundsByUnit,raw=>selection(raw,id));if(!map)return null;if(Object.keys(map).length)legacy.fundsByUnit=map;}
    if(value.legacy.fundsPreferredByUnit!==undefined){const map=unitMap(value.legacy.fundsPreferredByUnit,raw=>Array.isArray(raw)&&raw.every(id)?[...new Set(raw)]:null);if(!map)return null;if(Object.keys(map).length)legacy.fundsPreferredByUnit=map;}
    if(Object.keys(legacy).length)result.legacy=legacy;
  }
  return jsonBytes(result)<=FILTER_BYTES?result:null;
}
export const encodeDataFilters = (filters:DataFilters) => JSON.stringify(parseDataFilters(filters));
export const sameFilters = (a:DataFilters,b:DataFilters) => encodeDataFilters(a)===encodeDataFilters(b);
export const matchesSelection = <T extends FamilyRef>(selection:Selection<T>,value:T) => selection.values.some(ref=>filterRefKey(ref)===filterRefKey(value))===(selection.mode==='include');
export const matchesSource = (filters:Pick<DataFilters,'sources'>,source:string|null,status?:'notProvided') => matchesSelection(filters.sources,source===null?{status:status??'unknown'}:{source});
export const walletRule = (filters:DataFilters,unit?:string):Wallet => unit&&filters.legacy?.walletByUnit?.[unit]||filters.wallet;
export const fundsRule = (filters:DataFilters,unit?:string):Selection<string> => unit&&filters.legacy?.fundsByUnit?.[unit]||filters.funds;
export function matchesWallet(rule:Wallet,ref:MoneyRef,automatic:boolean) {
  if(rule.mode==='only')return rule.values.some(value=>filterRefKey(value)===filterRefKey(ref));
  return !rule.exclude.some(value=>filterRefKey(value)===filterRefKey(ref))&&(automatic||rule.include.some(value=>filterRefKey(value)===filterRefKey(ref)));
}
export type WorkFilter = Pick<DataFilters,'sources'|'projects'|'devices'|'clients'>;
export function parseWorkFilter(value:unknown):WorkFilter|null {
  if(!object(value)||!keys(value,['sources','projects','devices','clients'])||Object.keys(value).length!==4)return null;
  const parsed=parseDataFilters({...defaultFilters(),...value});
  return parsed?workFilter(parsed):null;
}
export const workFilter = ({sources,projects,devices,clients}:WorkFilter):WorkFilter => ({sources,projects,devices,clients});
export type FilterWork = {source:string|null;sourceStatus?:'notProvided';project:string|null;device:string;clientId?:string|null};
export const matchesWork = (filters:WorkFilter,row:FilterWork) => matchesSource(filters,row.source,row.sourceStatus)&&matchesSelection(filters.projects,row.project)&&matchesSelection(filters.devices,row.device)&&matchesSelection(filters.clients,row.clientId==='unknown'?null:row.clientId??null);

export function prepareWorkFilter(filters:WorkFilter,reserve:(bytes:number)=>void=()=>{}) {
  function compile<T extends FamilyRef>(selection:Selection<T>) {
    const included=selection.mode==='include';
    if(!selection.values.length){reserve(64);return ()=>!included;}
    reserve(128+selection.values.reduce((bytes,ref)=>bytes+128+filterRefKey(ref).length*2,0));
    const keys=new Set(selection.values.map(filterRefKey));
    return (value:T)=>keys.has(filterRefKey(value))===included;
  }
  const source=compile(filters.sources),project=compile(filters.projects),device=compile(filters.devices),client=compile(filters.clients);
  return (row:FilterWork)=>source(row.source===null?{status:row.sourceStatus??'unknown'}:{source:row.source})&&project(row.project)&&device(row.device)&&client(row.clientId==='unknown'?null:row.clientId??null);
}

export type FilterAuthority = (family:FilterFamily,ref:FamilyRef,unit?:string)=>boolean;
export type FilterEnvelope = {filters:DataFilters;revision:number;authority:string;unavailable:Record<FilterFamily,number>};
export type FilterDecision = {[F in FilterFamily]:{family:F;ref:FamilyRefs[F];included:boolean}}[FilterFamily];
export type FilterUpdate = {filters:DataFilters;authority:string;replace:FilterFamily[];resets?:Partial<Record<FilterFamily,'all'|'none'>>;decisions?:FilterDecision[];materialize?:{wallet?:string;funds?:string}};
export function parseFilterUpdate(value:unknown):FilterUpdate|null {
  if(!object(value)||!keys(value,['filters','authority','replace','resets','decisions','materialize'])||typeof value.authority!=='string'||!/^[A-Za-z0-9_-]{16,120}$/.test(value.authority))return null;
  const filters=parseDataFilters(value.filters),replace=value.replace;
  if(!filters||!Array.isArray(replace)||new Set(replace).size!==replace.length||!replace.every(f=>FILTER_FAMILIES.includes(f)))return null;
  const result:FilterUpdate={filters,authority:value.authority,replace};
  if(value.resets!==undefined){if(!object(value.resets)||!keys(value.resets,replace)||Object.values(value.resets).some(v=>v!=='all'&&v!=='none'))return null;result.resets=value.resets;}
  if(value.decisions!==undefined){
    if(!Array.isArray(value.decisions))return null;
    const decisions=new Map<string,FilterDecision>();
    for(const raw of value.decisions){if(!object(raw)||!keys(raw,['family','ref','included'])||!replace.includes(raw.family)||typeof raw.included!=='boolean'||!validators[raw.family as FilterFamily]?.(raw.ref))return null;
      const decision=raw as FilterDecision;decisions.set(decision.family+':'+filterRefKey(decision.ref),decision);}
    result.decisions=[...decisions.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,decision])=>decision);
  }
  if(value.materialize!==undefined){if(!object(value.materialize)||!keys(value.materialize,['wallet','funds'])||Object.entries(value.materialize).some(([family,unit])=>!replace.includes(family)||!isUnit(unit)))return null;result.materialize=value.materialize;}
  return jsonBytes(result)<=FILTER_BODY_LIMIT?result:null;
}

/** Reserve the released cursor and detail envelope before accepting an opening default. */
export function workFilterBytes(filters:WorkFilter) {
  const predicate=workFilter(filters);
  return [jsonBytes({version:1,selection:{mode:'live',periodMs:86_400_000},evaluatedAt:Number.MAX_SAFE_INTEGER,sessions:{cursor:'x'.repeat(2048)},workFilter:predicate}),
    jsonBytes({version:1,selection:{mode:'live',periodMs:86_400_000},evaluatedAt:Number.MAX_SAFE_INTEGER,cursor:'x'.repeat(2048),refs:Array.from({length:100},()=> '01234567'),workFilter:predicate})] as const;
}
export function executableWorkFilters(filters:WorkFilter){const [work,details]=workFilterBytes(filters);return work<=76*1024&&details<=80*1024;}
