import {useEffect,useState} from 'react';
import type {Card} from '../lib/types';
import type {KeyPage} from '../lib/moneyKeys';
import {ApiError,call} from '../lib/http';
import {keyName,money,capLeft} from '../lib/money';
import {keyShown,withKeyShown,type Arrange} from '../lib/view';
import {t} from '../i18n';
import {ErrorLine} from './Kit';
import {SwitchRow} from './Popover';
import {KeyPages} from './KeyPages';

/** A source's scales are chosen here, like subscription windows, without a key table. */
export function KeyScaleSettings({source,board,arrange}:{source:Card;board:string;arrange:Arrange}) {
  const inCard=source.keysCount===source.keys?.length;
  const [loaded,setPage]=useState<KeyPage|null>(null),[after,setAfter]=useState<string|undefined>(),[back,setBack]=useState<(string|undefined)[]>([]);
  const [error,setError]=useState<unknown>(null),[changed,setChanged]=useState(false);
  const page=inCard?{keys:source.keys??[],meters:source.meters??[],total:source.keysCount??0,next:null}:loaded;
  useEffect(()=>{
    if(inCard)return;
    let live=true;
    call<KeyPage>('GET',`/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(source.id)}/keys?limit=50${after?'&after='+encodeURIComponent(after):''}`)
      .then(reply=>{if(live){setPage(reply);setError(null);}},failure=>{
        if(!live)return;
        if(failure instanceof ApiError&&failure.code==='keys_changed'){setPage(null);setChanged(true);setBack([]);setAfter(undefined);}
        else setError(failure);
      });
    return()=>{live=false;};
  },[board,source.id,source.successAt,after,inCard]);
  return <>
    <div className="popover-title popover-section">{t('source.show')}</div>
    <ErrorLine error={error}/>
    {changed&&<p className="popover-note">{t('money.changed')}</p>}
    {loaded?.inventory&&!loaded.inventory.complete&&<p className="popover-note">{t('money.inventoryPartial')}</p>}
    {page?.keys.map(part=>{
      const cap=page.meters.find(m=>m.id===`key:${part.id}:cap`);
      return <SwitchRow key={part.id} on={!!cap&&keyShown(arrange.view,source.id,part.id,source.keys??[])} disabled={!cap}
        onChange={on=>arrange.update(view=>withKeyShown(view,source.id,part.id,on))}
        value={cap?money(capLeft(cap)):t('money.noCap')}>{keyName(part)}</SwitchRow>;
    })}
    {(!!page?.next||back.length>0)&&<KeyPages page={back.length+1} pages={Math.ceil((page?.total??source?.keysCount??0)/50)} previous={!!back.length} next={!!page?.next}
      onPrevious={()=>{setPage(null);setAfter(back.at(-1));setBack(back.slice(0,-1));}}
      onNext={()=>{setPage(null);setBack([...back,after]);setAfter(page!.next!);}}/>}
  </>;
}
