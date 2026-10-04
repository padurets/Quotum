import {useEffect,useState} from 'react';
import {useBoardId,type Named} from '../lib/board';
import {ApiError,call} from '../lib/http';
import {moneySelection} from '../lib/moneySelection';
import {usePrefs,setPrefs} from '../lib/prefs';
import {keyName} from '../lib/money';
import type {MeterHistory} from '../lib/moneyView';
import {MAX_METERS} from '../../server/domain/meterHistory';
import {t} from '../i18n';
import {ErrorLine} from './Kit';
import {SwitchRow} from './Popover';
import {KEYS_PER_PAGE,KeyPages,KeyPageContent} from './KeyPages';
import type {KeyPage} from '../lib/moneyKeys';

/** Series are chosen in the chart's settings; the key table only reads measurements. */
export function MoneySettings({sources,hidden,series}:{sources:readonly Named[];hidden:readonly string[];series:readonly MeterHistory[]}) {
  const board=useBoardId(),prefs=usePrefs(),unit=prefs.money.unit??'USD';
  const accounts=sources.filter(s=>!hidden.includes('source:'+s.id)&&s.meters?.some(m=>m.kind==='balance'&&m.unit===unit));
  const [sourceId,setSource]=useState<string|null>(()=>accounts.length===1?accounts[0].id:null);
  const [loaded,setPage]=useState<KeyPage|null>(null),[after,setAfter]=useState<string|undefined>(),[back,setBack]=useState<(string|undefined)[]>([]),[error,setError]=useState<unknown>(null),[changed,setChanged]=useState(false);
  const [loading,setLoading]=useState(true);
  const selected=moneySelection(sources,hidden,prefs.money).selection?.ids??[];
  const source=sources.find(s=>s.id===sourceId);
  const inCard=source?.keysCount===source?.keys?.length&&!!source?.keys;
  const page:KeyPage|null=inCard?{keys:source!.keys!,meters:source!.meters??[],total:source!.keysCount!,inventory:source!.inventory,next:null}:loaded;
  useEffect(()=>{
    if(!sourceId||!board||inCard)return;
    setLoading(true);
    let live=true;
    call<KeyPage>('GET',`/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(sourceId)}/keys?limit=${KEYS_PER_PAGE}${after?'&after='+encodeURIComponent(after):''}`)
      .then(reply=>{if(live){setPage(reply);setError(null);setLoading(false);}},failure=>{
        if(!live)return;
        setLoading(false);setPage(null);
        if(failure instanceof ApiError&&failure.code==='keys_changed'){setChanged(true);setBack([]);setAfter(undefined);}else setError(failure);
      });
    return()=>{live=false;};
  },[board,sourceId,after,inCard]);
  const choose=(id:string)=>{setSource(id);setPage(null);setLoading(true);setAfter(undefined);setBack([]);setError(null);setChanged(false);};
  const has=(id:string,meter:string)=>selected.some(([s,m])=>s===id&&m===meter);
  const toggle=(id:string,meter:string,on:boolean)=>{
    const ids=on?[...selected,[id,meter] as [string,string]]:selected.filter(([s,m])=>s!==id||m!==meter);
    if(ids.length>MAX_METERS)return;
    setPrefs({money:{...prefs.money,removed:0,selected:{...prefs.money.selected,[unit]:ids}}});
  };
  const row=(id:string,meter:string,label:string,unavailable=false,value?:string)=>{
    const on=has(id,meter);
    return <SwitchRow key={meter} on={on} value={value} disabled={!on&&(unavailable||selected.length>=MAX_METERS)} onChange={next=>toggle(id,meter,next)}>{label}</SwitchRow>;
  };
  const listed=new Set(page?.meters.map(m=>m.id)??[]);
  return <>
    <div className="popover-title popover-section">{t('source.show')}</div>
    <p className="popover-note">{selected.length} / {MAX_METERS}</p>
    {source?<>
      {accounts.length>1&&<button className="popover-row" onClick={()=>setSource(null)}><span>← {t('money.accounts')}</span></button>}
      <div className="popover-title">{source.title}</div>
      {row(source.id,'balance',t('money.balance'))}
      <ErrorLine error={error}/>
      {changed&&<p className="popover-note">{t('money.changed')}</p>}
      {(page?.inventory??source.inventory)?.complete===false&&<p className="popover-note">{t('money.inventoryPartial')}</p>}
      <KeyPageContent key={source.id} loading={!inCard&&loading} rows={Math.min(KEYS_PER_PAGE,source.keysCount??0)} series>
        {page?.keys.map(part=><div key={part.id} className="popover-section key-slot">
          <div className="popover-title" title={keyName(part)}>{keyName(part)}</div>
          {(['usage','cap'] as const).map(kind=>{
            const id=`key:${part.id}:${kind}`,meter=page.meters.find(m=>m.unit===unit&&m.id===id);
            return row(source.id,id,t(kind==='cap'?'money.cap':'money.usage'),!meter,!meter&&kind==='cap'?t('money.noCap'):undefined);
          })}
        </div>)}
      </KeyPageContent>
      <div>
        {selected.filter(([id,meter])=>id===source.id&&meter!=='balance'&&!listed.has(meter)).map(([id,meter])=>{
          const history=series.find(s=>s.sourceId===id&&s.meterId===meter);
          return row(id,meter,[history?.semantics?.label??meter,t(history?.kind==='cap'?'money.cap':'money.usage')].join(' — '));
        })}
      </div>
      {((source.keysCount??0)>KEYS_PER_PAGE||!!page?.next||back.length>0)&&<KeyPages page={back.length+1} pages={Math.ceil((page?.total??source?.keysCount??0)/KEYS_PER_PAGE)} previous={!!back.length} next={!!page?.next}
        loading={loading}
        onPrevious={()=>{setLoading(true);setAfter(back.at(-1));setBack(back.slice(0,-1));}}
        onNext={()=>{setLoading(true);setBack([...back,after]);setAfter(page!.next!);}}/>}
    </>:<>
      <div>{accounts.map(s=><div key={s.id} className="popover-section">
        <div className="popover-title">{s.title}</div>
        {row(s.id,'balance',t('money.balance'))}
        {!!s.keysCount&&<button className="popover-row" onClick={()=>choose(s.id)}><span>{t('money.keySeries',{count:s.keysCount})}</span><b>›</b></button>}
        {!s.keysCount&&selected.some(([id,m])=>id===s.id&&m!=='balance')&&<button className="popover-row" onClick={()=>choose(s.id)}><span>{t('money.selectedDetails')}</span><b>›</b></button>}
      </div>)}</div>
    </>}
    <div className="popover-section"><button className="popover-row" onClick={()=>{const next={...prefs.money.selected};delete next[unit];setPrefs({money:{...prefs.money,selected:next}});}}>{t('money.resetSelection')}</button></div>
  </>;
}
