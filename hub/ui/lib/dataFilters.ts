import {useSyncExternalStore} from 'react';
import type {FilterEnvelope,FilterUpdate} from '../../server/domain/dataFilters';
import {DataFilterState} from './filterState';
import {call} from './http';
import {publishDataFilters,setFilterWalletUnit,onDataFilters,quotaPresentationKey} from './filterSelection';
import {seedDataFilters,seedConflicts} from './filterSeed';
import {onPrefs,prefs} from './prefs';
import type {Card} from './types';

let cards:readonly Card[]=[];
const storage={getItem:(key:string)=>sessionStorage.getItem(key),setItem:(key:string,value:string)=>sessionStorage.setItem(key,value),removeItem:(key:string)=>sessionStorage.removeItem(key)};
export const dataFilters=new DataFilterState({storage,migrationStorage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},refresh:board=>call<FilterEnvelope>('GET','/api/boards/'+encodeURIComponent(board)+'/filters'),save:(board,revision,update:FilterUpdate)=>call<FilterEnvelope>('PUT','/api/boards/'+encodeURIComponent(board)+'/filters',update,12000,undefined,{'If-Match':'"'+revision+'"'}),
  conflicts:saved=>seedConflicts(saved,prefs().money),seed:saved=>seedDataFilters(saved,cards,prefs().money,prefs().funds)});
dataFilters.subscribe(()=>publishDataFilters(dataFilters.get().current));
export const setFilterCards=(values:readonly Card[])=>{cards=values;};
export const useDataFilters=()=>useSyncExternalStore(dataFilters.subscribe,dataFilters.get);
export const useQuotaPresentation=()=>useSyncExternalStore(onDataFilters,quotaPresentationKey);
export function retireDataFilters(){cards=[];dataFilters.retire();publishDataFilters(null,false);}

setFilterWalletUnit(prefs().money.unit??undefined);
onPrefs(()=>setFilterWalletUnit(prefs().money.unit??undefined));
