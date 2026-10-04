import {useEffect,useState} from 'react';
import type {Card} from '../lib/types';
import type {KeyPage} from '../lib/moneyKeys';
import {ApiError,call} from '../lib/http';
import {keyName,money,capLeft} from '../lib/money';
import {keyShown,withKeyShown,type Arrange} from '../lib/view';
import {t} from '../i18n';
import {ErrorLine} from './Kit';
import {SwitchRow} from './Popover';

/** A source's scales are chosen here, like subscription windows, without a key table. */
export function KeyScaleSettings({source,board,arrange}:{source:Card;board:string;arrange:Arrange}) {
  const inCard=source.keysCount===source.keys?.length;
  const [loaded,setPage]=useState<KeyPage|null>(null),[after,setAfter]=useState<string|undefined>(),[back,setBack]=useState<(string|undefined)[]>([]);
  const [error,setError]=useState<unknown>(null),[changed,setChanged]=useState(false);
  const page=inCard?{keys:source.keys??[],meters:source.meters??[],next:null}:loaded;
  useEffect(()=>{
    if(inCard)return;
    let live=true;
    call<KeyPage>('GET',`/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(source.id)}/keys?limit=50${after?'&after='+encodeURIComponent(after):''}`)
      .then(reply=>{if(live){setPage(reply);setError(null);}},failure=>{
        if(!live)return;
        if(failure instanceof ApiError&&failure.code==='keys_changed'){setChanged(true);setBack([]);setAfter(undefined);}
        else setError(failure);
      });
    return()=>{live=false;};
  },[board,source.id,source.successAt,after,inCard]);
  return <>
    <div className="popover-title popover-section">{t('source.show')}</div>
    <ErrorLine error={error}/>
    {changed&&<p className="popover-note">{t('money.changed')}</p>}
    <div className="popover-scroll">{page?.keys.map(part=>{
      const cap=page.meters.find(m=>m.id===`key:${part.id}:cap`);
      return <SwitchRow key={part.id} on={!!cap&&keyShown(arrange.view,source.id,part.id,source.keys??[])} disabled={!cap}
        onChange={on=>arrange.update(view=>withKeyShown(view,source.id,part.id,on))}
        value={cap?money(capLeft(cap)):t('money.noCap')}>{keyName(part)}</SwitchRow>;
    })}</div>
    {(!!page?.next||back.length>0)&&<div className="button-row popover-pad">
      <button className="button" disabled={!back.length} onClick={()=>{setAfter(back.at(-1));setBack(back.slice(0,-1));}}>{t('money.previous')}</button>
      <button className="button" disabled={!page?.next} onClick={()=>{setBack([...back,after]);setAfter(page!.next!);}}>{t('money.next')}</button>
    </div>}
  </>;
}

