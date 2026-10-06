import {useEffect,useState} from 'react';
import {DEFAULT_CURRENCY} from '../../server/domain/currency';
import {useBoardId,useCurrencyContext,type Named} from '../lib/board';
import {ApiError,call} from '../lib/http';
import {archivedKeyGroups,moneySelection} from '../lib/moneySelection';
import {usePrefs,setPrefs} from '../lib/prefs';
import {balanceDescriptor} from '../../server/domain/providers';
import {referenceBalance,balanceGroups,balanceRoleLabel,keyName} from '../lib/money';
import type {MeterHistory} from '../lib/moneyView';
import {MAX_METERS} from '../../server/domain/meterHistory';
import {t} from '../i18n';
import {ErrorLine} from './Kit';
import {SwitchRow} from './Popover';
import {KEYS_PER_PAGE,KeyPages,KeyPageContent} from './KeyPages';
import type {KeyPage} from '../lib/moneyKeys';

/** Series are chosen in the chart's settings; the key table only reads measurements. */
export function KeyMoneySettings({sources,hidden,series}:{sources:readonly Named[];hidden:readonly string[];series:readonly MeterHistory[]}) {
  const context=useCurrencyContext(),board=useBoardId(),prefs=usePrefs(),unit=prefs.money.unit??DEFAULT_CURRENCY;
  const accounts=sources.filter(s=>!hidden.includes('source:'+s.id)&&(unit===DEFAULT_CURRENCY?!!referenceBalance(s,context.target.id!==DEFAULT_CURRENCY):s.meters?.some(m=>m.kind==='balance'&&m.unit===unit)));
  const [sourceId,setSource]=useState<string|null>(()=>accounts.length===1?accounts[0].id:null);
  const [loaded,setPage]=useState<KeyPage|null>(null),[after,setAfter]=useState<string|undefined>(),[back,setBack]=useState<(string|undefined)[]>([]),[error,setError]=useState<unknown>(null),[changed,setChanged]=useState(false);
  const [loading,setLoading]=useState(true);
  const [archivePage,setArchivePage]=useState(0);
  const [membership,setMembership]=useState<{context:string;keys:string[]}|null>(null);
  const selected=moneySelection(sources,hidden,prefs.money,context).selection?.ids??[];
  const source=sources.find(s=>s.id===sourceId);
  const inCard=source?.keysCount===source?.keys?.length&&!!source?.keys;
  const page:KeyPage|null=inCard?{keys:source!.keys!,meters:source!.meters??[],total:source!.keysCount!,inventory:source!.inventory,next:null}:loaded;
  const selectedKeys=JSON.stringify([...new Set(selected.filter(([id,m])=>id===sourceId&&m!=='balance').map(([,m])=>m.match(/^key:([^:]+):/)?.[1]).filter((id):id is string=>!!id))].sort());
  const membershipContext=JSON.stringify([board,sourceId,source?.successAt,selectedKeys]);
  useEffect(()=>{
    const ids:string[]=JSON.parse(selectedKeys);
    if(!board||!sourceId||inCard||!ids.length)return;
    let live=true;
    call<KeyPage>('GET',`/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(sourceId)}/keys?ids=${encodeURIComponent(selectedKeys)}`)
      .then(reply=>{if(live)setMembership({context:membershipContext,keys:reply.keys.map(k=>k.id)});},failure=>{if(live)setError(failure);});
    return()=>{live=false;};
  },[board,sourceId,inCard,selectedKeys,membershipContext]);
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
  },[board,sourceId,after,inCard,source?.successAt]);
  const choose=(id:string)=>{setSource(id);setPage(null);setLoading(true);setAfter(undefined);setBack([]);setArchivePage(0);setError(null);setChanged(false);};
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
  const membershipReady=inCard||selectedKeys==='[]'||membership?.context===membershipContext;
  const current=new Set(inCard?source?.keys?.map(k=>k.id):membership?.context===membershipContext?membership.keys:[]);
  const archived=source&&membershipReady?archivedKeyGroups(source.id,selected.filter(([,meter])=>!balanceDescriptor(source.provider,meter)),current,series):[];
  const free=KEYS_PER_PAGE-(page?.keys.length??0),extraPages=Math.ceil(Math.max(0,archived.length-free)/KEYS_PER_PAGE);
  const archivalIndex=Math.min(archivePage,extraPages);
  const archivedStart=archivalIndex?free+(archivalIndex-1)*KEYS_PER_PAGE:0;
  const archivedShown=page&&!page.next?archived.slice(archivedStart,archivedStart+(archivalIndex?KEYS_PER_PAGE:free)):[];
  const total=(page?.total??source?.keysCount??0)+archived.length;
  const busy=!inCard&&loading;
  useEffect(()=>{if(archivePage>extraPages)setArchivePage(extraPages);},[archivePage,extraPages]);
  const balances=(s:Named)=>(unit===DEFAULT_CURRENCY?[referenceBalance(s,context.target.id!==DEFAULT_CURRENCY)].filter((g):g is NonNullable<typeof g>=>!!g):balanceGroups(s).filter(g=>g.total.unit===unit)).flatMap(g=>[{meter:g.total,role:'total' as const},...g.components].map(({meter,role})=>row(s.id,meter.id,(meter.conversion?'≈ ':'')+balanceRoleLabel(role),false)));
  return <>
    <div className="popover-title popover-section">{t('source.show')}</div>
    <p className="popover-note">{selected.length} / {MAX_METERS}</p>
    {source?<>
      {accounts.length>1&&<button className="popover-row" onClick={()=>setSource(null)}><span>← {t('money.accounts')}</span></button>}
      <div className="popover-title">{source.title}</div>
      {balances(source)}
      <ErrorLine error={error}/>
      {changed&&<p className="popover-note">{t('money.changed')}</p>}
      {(page?.inventory??source.inventory)?.complete===false&&<p className="popover-note">{t('money.inventoryPartial')}</p>}
      <KeyPageContent key={source.id} loading={busy} rows={Math.min(KEYS_PER_PAGE,total)} series>
        {page&&<>
          {!archivalIndex&&page.keys.map(part=><div key={part.id} className="popover-section key-slot">
            <div className="popover-title" title={keyName(part)}>{keyName(part)}</div>
            {(['usage','cap'] as const).map(kind=>{
              const id=`key:${part.id}:${kind}`,meter=page.meters.find(m=>m.unit===unit&&m.id===id);
              return row(source.id,id,t(kind==='cap'?'money.cap':'money.usage'),!meter,!meter&&kind==='cap'?t('money.noCap'):undefined);
            })}
          </div>)}
          {archivedShown.map(group=><div key={group.id} className="popover-section key-slot">
            <div className="popover-title" title={group.label}>{group.label}</div>
            {(['usage','cap'] as const).map(kind=>row(source.id,group[kind]??`key:${group.id}:${kind}`,t(kind==='cap'?'money.cap':'money.usage'),true))}
          </div>)}
        </>}
      </KeyPageContent>
      {(total>KEYS_PER_PAGE||!!page?.next||back.length>0||!!archivalIndex)&&<KeyPages page={back.length+archivalIndex+1} pages={Math.ceil(total/KEYS_PER_PAGE)} previous={!!back.length||!!archivalIndex} next={!!page?.next||archivalIndex<extraPages}
        loading={busy}
        onPrevious={()=>{if(archivalIndex){setArchivePage(archivalIndex-1);return;}setLoading(true);setAfter(back.at(-1));setBack(back.slice(0,-1));}}
        onNext={()=>{if(page?.next){setLoading(true);setBack([...back,after]);setAfter(page.next);}else setArchivePage(archivalIndex+1);}}/>}
    </>:<>
      <div>{accounts.map(s=><div key={s.id} className="popover-section">
        <div className="popover-title">{s.title}</div>
        {balances(s)}
        {!!s.keysCount&&<button className="popover-row" onClick={()=>choose(s.id)}><span>{t('money.keySeries',{count:s.keysCount})}</span><b>›</b></button>}
        {!s.keysCount&&selected.some(([id,m])=>id===s.id&&!balanceDescriptor(s.provider,m))&&<button className="popover-row" onClick={()=>choose(s.id)}><span>{t('money.selectedDetails')}</span><b>›</b></button>}
      </div>)}</div>
    </>}
    <div className="popover-section"><button className="popover-row" onClick={()=>{const next={...prefs.money.selected};delete next[unit];setPrefs({money:{...prefs.money,selected:next}});}}>{t('money.resetSelection')}</button></div>
  </>;
}

export const MoneySettings=KeyMoneySettings;
