import {useDataFilters} from './dataFilters';
import {usePref} from './prefs';
import {selectedAllowanceIds} from './moneySelection';
import {useEffect,useState} from 'react';
import type {Card,View} from './types';
import type {KeyPart,Meter} from '../../server/domain/meters';
import {ApiError} from './http';
import {readKeyIds} from './keyReads';
import {MAX_METERS} from '../../server/domain/meterHistory';

export type {KeyPage} from './keyReads';

/** Only explicitly enabled scales beyond the default preview need another read. */
export function useShownKeys(source:Card,view:View|undefined,board:string) {
  const filters=useDataFilters().current,settings=usePref('money');
  const allowances=selectedAllowanceIds(source,view,settings.unit??undefined,filters);
  const preview=new Set(source.keys?.map(k=>k.id));
  const ids=JSON.stringify(allowances.filter(id=>!preview.has(id)).sort());
  const query=JSON.stringify([board,source.id,ids]);
  const [extra,setExtra]=useState<{query:string;keys:KeyPart[];meters:Meter[];loading:boolean;error:unknown}>({query:'',keys:[],meters:[],loading:false,error:null});
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const selected:string[]=JSON.parse(ids);
    if(selected.length>MAX_METERS){setExtra({query,keys:[],meters:[],loading:false,error:new ApiError(413,'filters_limit')});return;}
    if(!board||!selected.length){setExtra(previous=>previous.query===query&&!previous.keys.length&&!previous.meters.length?previous:{query,keys:[],meters:[],loading:false,error:null});return;}
    let live=true;const controller=new AbortController();
    setExtra(previous=>({...previous,...(previous.query===query?{}:{keys:[],meters:[]}),query,loading:true,error:null}));
    readKeyIds(board,source.id,selected,controller.signal)
      .then(parts=>{if(live)setExtra({query,...parts,loading:false,error:null});},error=>{if(live)setExtra(previous=>({...previous,...(error instanceof ApiError&&[401,403,404].includes(error.status)?{keys:[],meters:[]}:{}),loading:false,error}));});
    return()=>{live=false;controller.abort();};
  },[board,source,ids,query,attempt]);
  const extras=extra.query===query?extra:{keys:[],meters:[],loading:!!board&&JSON.parse(ids).length>0,error:null};
  const keys=[...(source.keys??[]),...extras.keys.filter(k=>!preview.has(k.id))].filter(k=>allowances.includes(k.id));
  return {keys,allowances,meters:[...(source.meters??[]),...extras.meters.filter(m=>!preview.has(m.id.split(':')[1]))],error:extras.error,loading:extras.loading,selected:allowances.length>0,selectedCount:allowances.length,retry:()=>setAttempt(value=>value+1)};
}
