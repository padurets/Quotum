import {defaultFilters,type DataFilters} from '../../server/domain/dataFilters';
const pending=defaultFilters();pending.sources={mode:'include',values:[]};
let active=false,current:DataFilters|null=null;
let quotaKey='null';
const listeners=new Set<()=>void>();
export const effectiveFilters=()=>active?current??pending:undefined;
export const filtersReady=()=>!active||current!==null;
export const quotaPresentationKey=()=>quotaKey;
export const onDataFilters=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export function publishDataFilters(filters:DataFilters|null,enabled=true){if(active===enabled&&current===filters)return;active=enabled;current=filters;const selected=effectiveFilters();quotaKey=JSON.stringify(selected?{sources:selected.sources,windows:selected.windows}:null);for(const listener of listeners)listener();}

let walletUnit:string|undefined;
export const filterWalletUnit=()=>walletUnit;
export const setFilterWalletUnit=(unit:string|undefined)=>{walletUnit=unit;};
