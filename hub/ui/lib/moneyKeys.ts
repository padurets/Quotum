import {useDataFilters} from './dataFilters';
import {usePref} from './prefs';
import {walletRule} from '../../server/domain/dataFilters';
import {useEffect,useState} from 'react';
import type {Card,View} from './types';
import type {KeyPart,Meter} from '../../server/domain/meters';
import {ApiError} from './http';
import {readKeyIds} from './keyReads';
import {MAX_METERS} from '../../server/domain/meterHistory';
import {keyShown} from './view';

export type {KeyPage} from './keyReads';

/** Only explicitly enabled scales beyond the default preview need another read. */
export function useShownKeys(source:Card,view:View|undefined,board:string) {
  const filters=useDataFilters().current,settings=usePref('money');
  const rule=filters&&walletRule(filters,settings.unit??undefined);
  const pinned=rule?(rule.mode==='only'?rule.values:rule.include).flatMap(ref=>ref.source===source.id&&ref.kind==='keyCap'?[ref.key]:[]):[];
  const prefix=source.id+'/key:',preview=new Set(source.keys?.map(k=>k.id));
  const ids=JSON.stringify(filters?pinned.filter(id=>!preview.has(id)&&(!view||keyShown(view,source.id,id,source.keys??[]))).sort():view?.shown.filter(key=>key.startsWith(prefix)).map(key=>key.slice(prefix.length)).filter(id=>!preview.has(id)&&keyShown(view,source.id,id,source.keys??[])).sort()??[]);
  const [extra,setExtra]=useState<{source:string;keys:KeyPart[];meters:Meter[]}>({source:source.id,keys:[],meters:[]});
  const [error,setError]=useState<unknown>(null);
  useEffect(()=>{
    const selected:string[]=JSON.parse(ids);
    if(selected.length>MAX_METERS){setExtra({source:source.id,keys:[],meters:[]});setError(new ApiError(413,'filters_limit'));return;}
    if(!board||!selected.length){setExtra(previous=>previous.source===source.id&&!previous.keys.length&&!previous.meters.length?previous:{source:source.id,keys:[],meters:[]});setError(null);return;}
    let live=true;const controller=new AbortController();
    readKeyIds(board,source.id,selected,controller.signal)
      .then(parts=>{if(live){setExtra({source:source.id,...parts});setError(null);}},failure=>{if(live)setError(failure);});
    return()=>{live=false;controller.abort();};
  },[board,source,ids]);
  const extras=extra.source===source.id?extra:{keys:[],meters:[]};
  const keys=[...(source.keys??[]),...extras.keys.filter(k=>!preview.has(k.id))].filter(k=>!view||keyShown(view,source.id,k.id,source.keys??[]));
  return {keys,meters:[...(source.meters??[]),...extras.meters.filter(m=>!preview.has(m.id.split(':')[1]))],error};
}
