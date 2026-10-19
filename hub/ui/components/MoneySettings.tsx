import {useDataFilters,dataFilters} from '../lib/dataFilters';
import {filterRefKey,walletRule,matchesWallet,matchesSource,type MoneyRef} from '../../server/domain/dataFilters';
import {useEffect,useRef,useState} from 'react';
import {DEFAULT_CURRENCY,conversionOrigin} from '../../server/domain/currency';
import {useBoardId,useCurrencyContext,type Named} from '../lib/board';
import {ApiError,call} from '../lib/http';
import {archivedKeyGroups,keyMeter} from '../lib/moneySelection';
import {usePref} from '../lib/prefs';
import {referenceBalance,budgetVisible,keyName} from '../lib/money';
import {balanceDescriptor,type MoneyFamily} from '../../server/domain/providers';
import type {MeterHistory} from '../lib/moneyView';
import {MAX_METERS} from '../../server/domain/meterHistory';
import {withHidden,type Arrange} from '../lib/view';
import {t} from '../i18n';
import {ErrorLine} from './Kit';
import {Popover,SlidersIcon,HideRow} from './Popover';
import {FilterRow} from './Filters';
import {KEYS_PER_PAGE} from './KeyPages';
import {readKeyIds,type KeyPage} from '../lib/keyReads';

/** Keys expand in place; additional batches preserve the rows already on screen. */
export function KeyMoneySettings({sources,source:focused,hidden:_hidden,series,active=true}:{sources:readonly Named[];source?:Named;hidden:readonly string[];series:readonly MeterHistory[];active?:boolean}) {
  const context=useCurrencyContext(),board=useBoardId(),unit=usePref('money').unit??DEFAULT_CURRENCY,filters=useDataFilters().current;
  const balance=(s:Named)=>unit===DEFAULT_CURRENCY?referenceBalance(s,context.target.id!==DEFAULT_CURRENCY||s.provider==='codex')?.total:s.meters?.find(m=>m.kind==='balance'&&m.unit===unit&&balanceDescriptor(s.provider,m.id)?.role==='total');
  const accounts=sources.filter(s=>budgetVisible(s)&&!!balance(s));
  const rule=filters&&walletRule(filters,unit);
  const preview:MoneyRef[]=accounts.filter(source=>!filters||matchesSource(filters,source.id)).flatMap(source=>[{source:source.id,kind:'balance' as const},...(source.keys??[]).slice(0,5).filter(key=>source.meters?.some(m=>m.id===`key:${key.id}:cap`)).map(key=>({source:source.id,kind:'keyCap' as const,key:key.id}))]);
  const logical=rule?[...new Map((rule.mode==='only'?rule.values:[...rule.include,...preview]).filter(ref=>(!filters||matchesSource(filters,ref.source))&&matchesWallet(rule,ref,preview.some(other=>filterRefKey(other)===filterRefKey(ref)))).map(ref=>[filterRefKey(ref),ref])).values()]:[];
  const selected:[string,string][]=logical.map(ref=>[ref.source,ref.kind==='balance'?'balance':`key:${ref.key}:cap`]);
  const source=focused??accounts.find(source=>source.keysCount||selected.some(([id,meter])=>id===source.id&&keyMeter(meter))),sourceId=source?.id;
  const [keysOpen,setKeysOpen]=useState(false),[batches,setBatches]=useState(1),[error,setError]=useState<unknown>(null),[changed,setChanged]=useState(false),[loading,setLoading]=useState(false);
  const identity=JSON.stringify([board,sourceId,source?.successAt]);
  const scope=JSON.stringify([board,sourceId]);
  const cache=useRef<{identity:string;pages:KeyPage[]}>({identity:'',pages:[]});
  const [loaded,setLoaded]=useState<{identity:string;scope:string;page:KeyPage}|null>(null);
  const inCard=source?.keysCount===source?.keys?.length&&!!source?.keys;
  const page:KeyPage|null=inCard?{keys:source!.keys!,meters:source!.meters??[],total:source!.keysCount!,inventory:source!.inventory,next:null}:loaded?.scope===scope?loaded.page:null;
  const stale=!inCard&&!!page&&loaded?.identity!==identity;
  const selectedKeys=JSON.stringify([...new Set(selected.filter(([id])=>id===sourceId).flatMap(([,meter])=>keyMeter(meter)?.[1]??[]))].sort());
  const requestedKeys:string[]=JSON.parse(selectedKeys);
  const [membership,setMembership]=useState<{identity:string;requested:Set<string>;keys:string[]}|null>(null);
  const membershipReady=inCard||!requestedKeys.length||membership?.identity===identity&&requestedKeys.every(id=>membership.requested.has(id));
  useEffect(()=>{
    if(!active||!keysOpen||!board||!sourceId||membershipReady)return;
    let live=true;const controller=new AbortController();
    readKeyIds(board,sourceId,requestedKeys,controller.signal)
      .then(reply=>{if(live)setMembership({identity,requested:new Set(requestedKeys),keys:reply.keys.map(key=>key.id)});},failure=>{if(live)setError(failure);});
    return()=>{live=false;controller.abort();};
  },[active,keysOpen,board,sourceId,selectedKeys,identity,membershipReady]);
  useEffect(()=>{
    if(!active||!keysOpen||!sourceId||!board||inCard)return;
    let live=true;setLoading(true);
    const read=async(retry=false):Promise<void>=>{
      const pages=cache.current.identity===identity?[...cache.current.pages]:[];
      try{
        for(let index=pages.length;index<batches&&(index===0||pages[index-1].next);index++){
          const after=pages[index-1]?.next;
          const reply=await call<KeyPage>('GET',`/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(sourceId)}/keys?limit=${KEYS_PER_PAGE}${after?'&after='+encodeURIComponent(after):''}`);
          if(!live)return;pages.push(reply);
        }
        if(!live)return;
        cache.current={identity,pages};
        const last=pages.at(-1)!;setLoaded({identity,scope,page:{...last,keys:pages.flatMap(page=>page.keys),meters:pages.flatMap(page=>page.meters)}});setError(null);setLoading(false);
      }catch(failure){
        if(!live)return;
        if(!retry&&failure instanceof ApiError&&failure.code==='keys_changed'){cache.current={identity:'',pages:[]};setChanged(true);await read(true);}
        else{setError(failure);setLoading(false);}
      }
    };
    void read();return()=>{live=false;};
  },[active,keysOpen,board,sourceId,inCard,identity,scope,batches]);
  const has=(id:string,meter:string)=>selected.some(([s,m])=>s===id&&(!keyMeter(meter)&&!keyMeter(m)||(conversionOrigin(m)?.meter??m)===(conversionOrigin(meter)?.meter??meter)));
  const toggle=(id:string,meters:string[],on:boolean)=>{
    for(const meter of meters){const key=keyMeter(meter),ref:MoneyRef=key?{source:id,kind:'keyCap',key:key[1]}:{source:id,kind:'balance'};
      dataFilters.toggle('wallet',ref,on,unit,preview.some(other=>filterRefKey(other)===filterRefKey(ref)));}
  };
  const row=(id:string,meters:string[],label:string,unavailable=false,value?:string,key=meters.join(':'),slot=false)=>{
    const on=meters.some(meter=>has(id,meter)),extra=meters.filter(meter=>!has(id,meter)).length;
    return <FilterRow key={key} className={slot?'key-slot':undefined} on={on} value={value} disabled={loading||stale||!on&&(unavailable||selected.length+extra>MAX_METERS)} onChange={next=>toggle(id,meters,next)}>{label}</FilterRow>;
  };
  const current=new Set(inCard?source?.keys?.map(key=>key.id):membership?.identity===identity?membership.keys:[]);
  const archived=source&&membershipReady?archivedKeyGroups(source.id,selected,current,series):[];
  const keyRow=(id:string,label:string,meters:string[],archived=false)=>row(source!.id,meters,label,archived||!meters.length,archived?t('money.archived'):!meters.length?t('money.noCap'):undefined,id,true);
  return <>
    {(focused?[focused]:accounts).map(source=>balance(source)&&row(source.id,[balance(source)!.id],focused?t('money.balance'):source.title??source.id))}
    {source&&(!!source.keysCount||selectedKeys!=='[]'||!!archived.length)&&<details className="filter-key-details" open={keysOpen} onToggle={event=>setKeysOpen(event.currentTarget.open)}>
      <summary className="link-button">{t('money.keySeries',{count:source.keysCount??0})}</summary>
      <ErrorLine error={error}/>
      {changed&&<p className="popover-note">{t('money.changed')}</p>}
      {(page?.inventory??source.inventory)?.complete===false&&<p className="popover-note">{t('money.inventoryPartial')}</p>}
      {page?.keys.map(part=>keyRow(part.id,keyName(part),[`key:${part.id}:cap`].filter(id=>page.meters.some(meter=>meter.unit===unit&&meter.id===id)||has(source.id,id))))}
      {archived.map(group=>keyRow(group.id,group.label,[group.cap],true))}
      {loading&&!page&&<p className="popover-note">{t('desktop.loading')}</p>}
      {page?.next&&<button type="button" className="popover-row filter-load-more" disabled={loading} aria-busy={loading} onClick={()=>setBatches(batches+1)}>{t('common.more')}</button>}
    </details>}
  </>;
}

/** Chart settings retain presentation and placement only. */
export function MoneyChartSettings({arrange,widget}:{arrange:Arrange;widget:string;sources:readonly Named[];series:readonly MeterHistory[];family?:MoneyFamily}) {
  if(!arrange.owner)return null;
  return <Popover label={t('history.settings')} icon={<SlidersIcon/>}>
    <HideRow onHide={()=>arrange.update(view=>withHidden(view,widget,true))}>{t('widget.hide')}</HideRow>
  </Popover>;
}
