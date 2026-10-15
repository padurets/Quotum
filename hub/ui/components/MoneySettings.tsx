import {useEffect,useState} from 'react';
import {DEFAULT_CURRENCY,conversionOrigin} from '../../server/domain/currency';
import {useBoardId,useCurrencyContext,type Named} from '../lib/board';
import {ApiError,call} from '../lib/http';
import {archivedKeyGroups,keyMeter,moneySelection,moneyChoices,toggleMoneyChoice} from '../lib/moneySelection';
import {usePref,setPrefs} from '../lib/prefs';
import {referenceBalance,budgetVisible,keyName} from '../lib/money';
import {balanceDescriptor,type MoneyFamily} from '../../server/domain/providers';
import type {MeterHistory} from '../lib/moneyView';
import {MAX_METERS} from '../../server/domain/meterHistory';
import {withHidden,type Arrange} from '../lib/view';
import {t} from '../i18n';
import {ErrorLine} from './Kit';
import {Popover,SwitchRow,SlidersIcon,HideRow} from './Popover';
import {KEYS_PER_PAGE,KeyPages,KeyPageContent} from './KeyPages';
import type {KeyPage} from '../lib/moneyKeys';

/** The chart and table edit the same reader selection beside their own measurements. */
export function KeyMoneySettings({sources,hidden,series}:{sources:readonly Named[];hidden:readonly string[];series:readonly MeterHistory[]}) {
  const context=useCurrencyContext(),board=useBoardId(),moneyPrefs=usePref('money'),unit=moneyPrefs.unit??DEFAULT_CURRENCY;
  const prefs={money:moneyPrefs};
  const accounts=sources.filter(s=>budgetVisible(s)&&!hidden.includes('source:'+s.id)&&(unit===DEFAULT_CURRENCY?!!referenceBalance(s,context.target.id!==DEFAULT_CURRENCY||s.provider==='codex'):s.meters?.some(m=>m.kind==='balance'&&m.unit===unit)));
  const [sourceId,setSource]=useState<string|null>(null);
  const [loaded,setPage]=useState<KeyPage|null>(null),[after,setAfter]=useState<string|undefined>(),[back,setBack]=useState<(string|undefined)[]>([]),[error,setError]=useState<unknown>(null),[changed,setChanged]=useState(false);
  const [loading,setLoading]=useState(true);
  const [archivePage,setArchivePage]=useState(0);
  const [membership,setMembership]=useState<{context:string;keys:string[]}|null>(null);
  const selected=moneyChoices(sources,prefs.money.selected[unit]??moneySelection(sources,hidden,prefs.money,context).selection?.ids??[],unit);
  const source=accounts.find(s=>s.id===sourceId);
  const inCard=source?.keysCount===source?.keys?.length&&!!source?.keys;
  const page:KeyPage|null=inCard?{keys:source!.keys!,meters:source!.meters??[],total:source!.keysCount!,inventory:source!.inventory,next:null}:loaded;
  const selectedKeys=JSON.stringify([...new Set(selected.filter(([id])=>id===sourceId).map(([,m])=>keyMeter(m)?.[1]).filter((id):id is string=>!!id))].sort());
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
  const has=(id:string,meter:string)=>selected.some(([s,m])=>s===id&&(conversionOrigin(m)?.meter??m)===(conversionOrigin(meter)?.meter??meter));
  const toggle=(id:string,meters:string[],on:boolean)=>{
    const ids=toggleMoneyChoice(selected,id,meters,on);
    setPrefs({money:{...prefs.money,removed:0,selected:{...prefs.money.selected,[unit]:ids}}});
  };
  const row=(id:string,meters:string[],label:string,unavailable=false,value?:string,slot=false,key=meters.join(':'))=>{
    const on=meters.some(meter=>has(id,meter)),extra=meters.filter(meter=>!has(id,meter)).length;
    return <SwitchRow key={key} className={slot?'key-slot':undefined} on={on} value={value} disabled={!on&&(unavailable||selected.length+extra>MAX_METERS)} onChange={next=>toggle(id,meters,next)}>{label}</SwitchRow>;
  };
  const membershipReady=inCard||selectedKeys==='[]'||membership?.context===membershipContext;
  const current=new Set(inCard?source?.keys?.map(k=>k.id):membership?.context===membershipContext?membership.keys:[]);
  const archived=source&&membershipReady?archivedKeyGroups(source.id,selected,current,series):[];
  const free=KEYS_PER_PAGE-(page?.keys.length??0),extraPages=Math.ceil(Math.max(0,archived.length-free)/KEYS_PER_PAGE);
  const archivalIndex=Math.min(archivePage,extraPages);
  const archivedStart=archivalIndex?free+(archivalIndex-1)*KEYS_PER_PAGE:0;
  const archivedShown=page&&!page.next?archived.slice(archivedStart,archivedStart+(archivalIndex?KEYS_PER_PAGE:free)):[];
  const total=(page?.total??source?.keysCount??0)+archived.length;
  const busy=!inCard&&loading;
  useEffect(()=>{if(archivePage>extraPages)setArchivePage(extraPages);},[archivePage,extraPages]);
  const balance=(s:Named)=>unit===DEFAULT_CURRENCY?referenceBalance(s,context.target.id!==DEFAULT_CURRENCY||s.provider==='codex')?.total:s.meters?.find(m=>m.kind==='balance'&&m.unit===unit&&balanceDescriptor(s.provider,m.id)?.role==='total');
  const keyRow=(id:string,label:string,meters:string[],archived=false)=>{
    return row(source!.id,meters,label,archived||!meters.length,archived?t('money.archived'):!meters.length?t('money.noCap'):undefined,true,id);
  };
  return <>
    <p className="popover-note">{selected.length} / {MAX_METERS}</p>
    {source?<>
      <button className="popover-row" onClick={()=>setSource(null)}><span>← {t('money.accounts')}</span></button>
      <div className="popover-title">{source.title}</div>
      <ErrorLine error={error}/>
      {changed&&<p className="popover-note">{t('money.changed')}</p>}
      {(page?.inventory??source.inventory)?.complete===false&&<p className="popover-note">{t('money.inventoryPartial')}</p>}
      <KeyPageContent key={source.id} loading={busy} rows={Math.min(KEYS_PER_PAGE,total)}>
        {page&&<>
          {!archivalIndex&&page.keys.map(part=>keyRow(part.id,keyName(part),[`key:${part.id}:cap`].filter(id=>page.meters.some(m=>m.unit===unit&&m.id===id)||has(source.id,id))))}
          {archivedShown.map(group=>keyRow(group.id,group.label,[group.cap],true))}
        </>}
      </KeyPageContent>
      {(total>KEYS_PER_PAGE||!!page?.next||back.length>0||!!archivalIndex)&&<KeyPages page={back.length+archivalIndex+1} pages={Math.ceil(total/KEYS_PER_PAGE)} previous={!!back.length||!!archivalIndex} next={!!page?.next||archivalIndex<extraPages}
        loading={busy}
        onPrevious={()=>{if(archivalIndex){setArchivePage(archivalIndex-1);return;}setLoading(true);setAfter(back.at(-1));setBack(back.slice(0,-1));}}
        onNext={()=>{if(page?.next){setLoading(true);setBack([...back,after]);setAfter(page.next);}else setArchivePage(archivalIndex+1);}}/>}
    </>:<>
      <div>{accounts.map(s=><div key={s.id} className="popover-section">
        {balance(s)&&row(s.id,[balance(s)!.id],s.title??s.id)}
        {!!s.keysCount&&<button className="popover-row" onClick={()=>choose(s.id)}><span>{t('money.keySeries',{count:s.keysCount})}</span><b>›</b></button>}
        {!s.keysCount&&selected.some(([id,m])=>id===s.id&&keyMeter(m))&&<button className="popover-row" onClick={()=>choose(s.id)}><span>{t('money.selectedDetails')}</span><b>›</b></button>}
      </div>)}</div>
    </>}
    <div className="popover-section"><button className="popover-row" onClick={()=>{const next={...prefs.money.selected};delete next[unit];setPrefs({money:{...prefs.money,selected:next}});}}>{t('money.resetSelection')}</button></div>
  </>;
}

export function MoneySettings(props:{sources:readonly Named[];hidden:readonly string[];series:readonly MeterHistory[]}) {
  return <div className="popover-section"><div className="popover-title">{t('money.data')}</div><KeyMoneySettings {...props}/></div>;
}

/** Additional subscription funds have their own balance-only series selection. */
export function FundsSettings({sources,hidden}:{sources:readonly Named[];hidden:readonly string[]}) {
  const context=useCurrencyContext(),settings=usePref('funds'),unit=settings.unit??DEFAULT_CURRENCY;
  const selected=settings.selected[unit]??moneySelection(sources,hidden,settings,context,'funds').selection?.ids??[];
  const available=sources.flatMap(source=>moneySelection([source],hidden,{...settings,selected:{}},context,'funds').selection?.ids??[]);
  const toggle=(source:string,meter:string,on:boolean)=>{
    const ids=on?[...selected,[source,meter] as [string,string]]:selected.filter(([s,m])=>s!==source||m!==meter);
    if(ids.length<=MAX_METERS)setPrefs({funds:{...settings,selected:{...settings.selected,[unit]:ids}}});
  };
  return <>
    <p className="popover-note">{selected.length} / {MAX_METERS}</p>
    {available.map(([source,meter])=>{
      const on=selected.some(([s,m])=>s===source&&m===meter);
      return <SwitchRow key={source+':'+meter} on={on} disabled={!on&&selected.length>=MAX_METERS} onChange={next=>toggle(source,meter,next)}>{sources.find(s=>s.id===source)?.title??source}</SwitchRow>;
    })}
    <div className="popover-section"><button className="popover-row" onClick={()=>{const next={...settings.selected};delete next[unit];setPrefs({funds:{...settings,selected:next}});}}>{t('funds.allSubscriptions')}</button></div>
  </>;
}

/** Reader selection shares the settings surface; ordinary funds visibility lives in the legend. */
export function MoneyChartSettings({arrange,widget,sources,series,family='budget'}:{arrange:Arrange;widget:string;sources:readonly Named[];series:readonly MeterHistory[];family?:MoneyFamily}) {
  const hidden=arrange.view.hidden;
  const context=useCurrencyContext(),settings=usePref(family==='funds'?'funds':'money'),unit=settings.unit??DEFAULT_CURRENCY;
  const available=sources.flatMap(source=>moneySelection([source],hidden,{...settings,selected:{}},context,family).selection?.ids??[]);
  const data=family==='budget'||available.length>MAX_METERS||Object.hasOwn(settings.selected,unit);
  if(!arrange.owner&&!data)return null;
  return <Popover label={t('history.settings')} icon={<SlidersIcon/>}>
    {data&&(family==='funds'?<div className="popover-section"><div className="popover-title">{t('funds.data')}</div><FundsSettings sources={sources} hidden={hidden}/></div>:<MoneySettings sources={sources} hidden={hidden} series={series}/>)}
    {arrange.owner&&<HideRow onHide={()=>arrange.update(view=>withHidden(view,widget,true))}>{t('widget.hide')}</HideRow>}
  </Popover>;
}
