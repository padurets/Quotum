import {useEffect,useState} from 'react';
import type {Card,View} from './types';
import type {KeyPart,Meter} from '../../server/domain/meters';
import {call} from './http';
import {keyShown} from './view';

export type KeyPage={keys:KeyPart[];meters:Meter[];total:number;inventory:Card['inventory']|null;next:string|null};

/** Only explicitly enabled scales beyond the default preview need another read. */
export function useShownKeys(source:Card,view:View|undefined,board:string) {
  const prefix=source.id+'/key:',preview=new Set(source.keys?.map(k=>k.id));
  const ids=JSON.stringify(view?.shown.filter(key=>key.startsWith(prefix)).map(key=>key.slice(prefix.length)).filter(id=>!preview.has(id)&&keyShown(view,source.id,id,source.keys??[])).sort()??[]);
  const [extra,setExtra]=useState<{source:string;keys:KeyPart[];meters:Meter[]}>({source:source.id,keys:[],meters:[]});
  const [error,setError]=useState<unknown>(null);
  useEffect(()=>{
    const selected:string[]=JSON.parse(ids);
    if(!board||!selected.length){setExtra(previous=>previous.source===source.id&&!previous.keys.length&&!previous.meters.length?previous:{source:source.id,keys:[],meters:[]});setError(null);return;}
    let live=true;
    const groups=Array.from({length:Math.ceil(selected.length/50)},(_,i)=>selected.slice(i*50,i*50+50));
    Promise.all(groups.map(group=>call<KeyPage>('GET',`/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(source.id)}/keys?ids=${encodeURIComponent(JSON.stringify(group))}`)))
      .then(pages=>{if(live){setExtra({source:source.id,keys:pages.flatMap(p=>p.keys),meters:pages.flatMap(p=>p.meters)});setError(null);}},failure=>{if(live)setError(failure);});
    return()=>{live=false;};
  },[board,source,ids]);
  const extras=extra.source===source.id?extra:{keys:[],meters:[]};
  const keys=[...(source.keys??[]),...extras.keys.filter(k=>!preview.has(k.id))].filter(k=>!view||keyShown(view,source.id,k.id,source.keys??[]));
  return {keys,meters:[...(source.meters??[]),...extras.meters.filter(m=>!preview.has(m.id.split(':')[1]))],error};
}
