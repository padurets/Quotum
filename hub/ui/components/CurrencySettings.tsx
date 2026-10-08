import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {CurrencyDefinition,CurrencyManagement,CurrencyRateHistory,ManagedCurrency,RateSnapshot} from '../../server/domain/currency';
import {t,useLocale} from '../i18n';
import {ApiError,call} from '../lib/http';
import {useCurrencyRegistryRevision} from '../lib/board';
import {guardNavigation} from '../lib/router';
import {currencyRate,rateText} from '../lib/currencySettings';
import {stamp} from '../lib/format';
import {ErrorLine,Field,Modal} from './Kit';
import {Popover,PopoverHeading} from './Popover';

type Refresh=()=>Promise<CurrencyManagement>;
type Dirty=(key:string,value:boolean,discard?:()=>void)=>void;
const personal=(id:string)=>id.startsWith('personal:');
const label=(definition:CurrencyDefinition,locale:string)=>personal(definition.id)?`${definition.name} (${definition.symbol}, ${definition.id.slice(-6)})`:`${definition.id} — ${new Intl.DisplayNames([locale],{type:'currency'}).of(definition.id)??definition.name}`;

function CurrencyChoice({items,value,onChange,title,disabled=false}:{items:CurrencyDefinition[];value:string;onChange:(id:string)=>void;title:string;disabled?:boolean}) {
  const locale=useLocale(),[open,setOpen]=useState(false),[search,setSearch]=useState(''),chosen=items.find(item=>item.id===value),box=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(open)box.current?.querySelector('input')?.focus({preventScroll:true});},[open]);
  return <div className="field currency-choice" aria-disabled={disabled} ref={box}>
    <span>{title}</span>
    <Popover label={title} trigger={chosen?label(chosen,locale):t('currencies.choose')} triggerClass="button" align="left" width={420} open={!disabled&&open} onOpenChange={next=>{if(!disabled){setOpen(next);if(next)setSearch('');}}}>
      <PopoverHeading onClose={()=>setOpen(false)}>{title}</PopoverHeading>
      <div className="popover-section"><Field label={t('currencies.search')} value={search} onChange={event=>setSearch(event.target.value)} /></div>
      <div className="popover-scroll">
        {items.filter(item=>label(item,locale).toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale))).map(item=><button type="button" className="popover-row" key={item.id} aria-pressed={value===item.id} onClick={()=>{onChange(item.id);setOpen(false);}}>{label(item,locale)}</button>)}
      </div>
    </Popover>
  </div>;
}

function useDirty(dirty:Dirty,value:boolean,discard?:()=>void) {
  const key=useId(),latest=useRef(discard);latest.current=discard;useEffect(()=>{dirty(key,value,()=>latest.current?.());return ()=>dirty(key,false);},[dirty,key,value]);
}

/** A retry keeps the exact receipt, payload and revision after an unconfirmed response. */
function useSave(revision:string,changed:boolean,refresh:Refresh,dirty:Dirty,discard?:()=>void) {
  const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState<unknown>(null),[saved,setSaved]=useState(false);
  const baseline=useRef(revision),alive=useRef(true),sending=useRef(false),request=useRef<{url:string;body:Record<string,unknown>;done:(value:unknown)=>void}|null>(null);
  if(!changed&&!request.current)baseline.current=revision;
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useDirty(dirty,changed||busy||uncertain,discard);
  const submit=async()=>{
    const current=request.current;if(!current||sending.current)return;sending.current=true;setBusy(true);setError(null);setSaved(false);
    try {
      const value=await call<unknown>('POST',current.url,current.body);
      if(!alive.current)return;request.current=null;setUncertain(false);current.done(value);setSaved(true);
      await refresh().then(data=>{baseline.current=data.registryRevision;}).catch(()=>{});
    }catch(failure){
      if(!alive.current)return;
      if(failure instanceof ApiError&&failure.status<500){request.current=null;setUncertain(false);setError(failure);if(failure.status===409)await refresh().then(data=>{baseline.current=data.registryRevision;}).catch(()=>{});}
      else{setUncertain(true);setError(null);}
    }finally{sending.current=false;if(alive.current)setBusy(false);}
  };
  const send=(url:string,body:Record<string,unknown>,done:(value:unknown)=>void=()=>{})=>{
    if(request.current||sending.current)return;request.current={url,body:{...body,expectedRevision:baseline.current,requestId:crypto.randomUUID()},done};void submit();
  };
  return {send,disabled:busy||uncertain,notice:<>
    {busy&&<p role="status">{t('currencies.saving')}</p>}
    {saved&&!busy&&!error&&<p role="status">{t('currencies.saved')}</p>}
    <ErrorLine error={error} />
    {uncertain&&<div role="alert"><p>{t('currencies.unconfirmed')}</p><button type="button" className="button" disabled={busy} onClick={()=>void submit()}>{t('currencies.retry')}</button></div>}
  </>};
}

function DisplayCurrency({data,refresh,dirty}:{data:CurrencyManagement;refresh:Refresh;dirty:Dirty}) {
  const [choice,setChoice]=useState(data.selected),[edited,setEdited]=useState(false),[detail,setDetail]=useState<{definition:CurrencyDefinition;rates:RateSnapshot[]}|null>(null),[error,setError]=useState<unknown>(null);
  const save=useSave(data.registryRevision,edited,refresh,dirty,()=>{setChoice(data.selected);setEdited(false);}),locale=useLocale();
  useEffect(()=>{if(!edited)setChoice(data.selected);},[data.selected,edited]);
  useEffect(()=>{let live=true;setDetail(null);setError(null);if(!personal(choice))void call<{definition:CurrencyDefinition;rates:RateSnapshot[]}>('GET','/api/currencies/'+choice).then(value=>{if(live)setDetail(value);}).catch(error=>{if(live)setError(error);});return ()=>{live=false;};},[choice,data.registryRevision]);
  const items=[...data.standards,...data.personal.filter(item=>item.archivedAt===null).map(item=>item.definition)];
  return <section className="settings-section">
    <h2>{t('currencies.display')}</h2><p className="dialog-text">{t('currencies.scope')}</p>
    <form className="dialog-form settings-form" onSubmit={event=>{event.preventDefault();save.send('/api/currencies/display',{currency:choice},()=>setEdited(false));}}>
      <CurrencyChoice title={t('currencies.display')} items={items} value={choice} disabled={save.disabled} onChange={id=>{setChoice(id);setEdited(id!==data.selected);}} />
      <p className="dialog-text">{t('currencies.current',{currency:label(items.find(item=>item.id===data.selected)!,locale)})}</p>
      <div className="button-row is-start currency-actions"><button className="button" disabled={save.disabled||!edited}>{t('account.save')}</button>{edited&&<button type="button" className="button" disabled={save.disabled} onClick={()=>{setChoice(data.selected);setEdited(false);}}>{t('common.cancel')}</button>}</div>
      {save.notice}
    </form>
    {detail&&<div className="dialog-text"><p>{t('currencies.precisionValue',{digits:detail.definition.fractionDigits})}</p>{detail.rates.length?detail.rates.slice(0,3).map(quote=><p key={quote.id}>{quote.source.toUpperCase()}<br />{stamp(quote.date)}<br />1 {quote.base} = {rateText(quote.rates[choice])} {choice}</p>):<p>{t('currencies.noPublicRate')}</p>}</div>}
    <ErrorLine error={error} />
  </section>;
}

function DefinitionForm({data,item,refresh,dirty,onCreated}:{data:CurrencyManagement;item?:ManagedCurrency;refresh:Refresh;dirty:Dirty;onCreated?:(id:string)=>void}) {
  const locale=useLocale(),original=item?.definition;
  const [name,setName]=useState(original?.name??''),[symbol,setSymbol]=useState(original?.symbol??''),[digits,setDigits]=useState(String(original?.fractionDigits??2));
  const [base,setBase]=useState('USD'),[rate,setRate]=useState(''),[error,setError]=useState<unknown>(null),[edited,setEdited]=useState(false);
  const save=useSave(data.registryRevision,edited,refresh,dirty,()=>reset());
  const reset=()=>{setName(original?.name??'');setSymbol(original?.symbol??'');setDigits(String(original?.fractionDigits??2));setRate('');setBase('USD');setEdited(false);setError(null);};
  useEffect(()=>{if(!edited){setName(original?.name??'');setSymbol(original?.symbol??'');setDigits(String(original?.fractionDigits??2));}},[original?.name,original?.symbol,original?.fractionDigits,edited]);
  const submit=(event:FormEvent)=>{
    event.preventDefault();setError(null);
    try {
      const body={name,symbol,fractionDigits:Number(digits),...(!original?{base,rate:currencyRate(rate,locale)}:{})};
      save.send('/api/currencies'+(original?'/'+original.id:''),body,value=>{setEdited(false);if(!original){reset();onCreated?.((value as CurrencyDefinition).id);}});
    }catch{setError(new ApiError(400,'invalid_currency'));}
  };
  return <form className="dialog-form settings-form" onSubmit={submit} onChange={()=>setEdited(true)}>
    <fieldset disabled={save.disabled||item?.archivedAt!=null} className="currency-fields">
      <Field label={t('currencies.name')} value={name} maxLength={64} required onChange={event=>setName(event.target.value)} />
      <Field label={t('currencies.symbol')} value={symbol} maxLength={12} required onChange={event=>setSymbol(event.target.value)} />
      <Field label={t('currencies.precision')} type="number" min={0} max={6} step={1} required value={digits} onChange={event=>setDigits(event.target.value)} />
      {!original&&<><CurrencyChoice items={data.standards} value={base} title={t('currencies.base')} onChange={id=>{setBase(id);setEdited(true);}} /><Field label={t('currencies.rate')} inputMode="decimal" value={rate} required onChange={event=>setRate(event.target.value)} /><p className="currency-equation">1 {base} = {rate||'…'} {symbol||'…'}</p><p className="dialog-text">{t('currencies.nominalHelp')}</p></>}
      <div className="button-row is-start currency-actions"><button className="button" disabled={!edited}>{t(original?'account.save':'currencies.create')}</button><button type="button" className="button" onClick={reset}>{t('common.cancel')}</button></div>
    </fieldset>
    {edited&&original&&<p className="dialog-text">{t('currencies.serverVersion',{name:original.name,symbol:original.symbol,digits:original.fractionDigits})}</p>}
    <ErrorLine error={error} />{save.notice}
  </form>;
}

function RateForm({data,item,refresh,dirty,seed}:{data:CurrencyManagement;item:ManagedCurrency;refresh:Refresh;dirty:Dirty;seed:{base:string;rate:string}|null}) {
  const locale=useLocale(),[base,setBase]=useState(seed?.base??'USD'),[rate,setRate]=useState(seed?.rate??''),[date,setDate]=useState(''),[error,setError]=useState<unknown>(null);
  const edited=!!rate||!!date,save=useSave(data.registryRevision,edited,refresh,dirty,()=>reset());
  const reset=()=>{setRate('');setDate('');setError(null);};
  return <form className="dialog-form settings-form" onSubmit={event=>{
    event.preventDefault();setError(null);try{const at=date?new Date(date).getTime():undefined;if(at!==undefined&&(!Number.isSafeInteger(at)||at>Date.now()))throw new Error();save.send('/api/currencies/'+item.definition.id+'/rates',{base,rate:currencyRate(rate,locale),...(at===undefined?{}:{date:at})},reset);}catch{setError(new ApiError(400,'invalid_currency'));}
  }}>
    <h3>{t('currencies.setRate')}</h3><p className="dialog-text">{t('currencies.rateHelp')}</p>
    <fieldset className="currency-fields" disabled={save.disabled}>
      <CurrencyChoice items={data.standards} value={base} onChange={setBase} title={t('currencies.base')} disabled={save.disabled} />
      <Field label={t('currencies.rate')} inputMode="decimal" required value={rate} onChange={event=>setRate(event.target.value)} />
      <p className="currency-equation">1 {base} = {rate||'…'} {item.definition.symbol}</p>
      <Field label={t('currencies.effective')} hint={t('currencies.nowHelp')} type="datetime-local" value={date} onChange={event=>setDate(event.target.value)} />
      <div className="button-row is-start currency-actions"><button className="button" disabled={!rate}>{t('account.save')}</button><button type="button" className="button" onClick={reset}>{t('common.cancel')}</button></div>
    </fieldset><ErrorLine error={error} />{save.notice}
  </form>;
}

function ArchiveCurrency({data,item,refresh,dirty,onClose}:{data:CurrencyManagement;item:ManagedCurrency;refresh:Refresh;dirty:Dirty;onClose:()=>void}) {
  const [replacement,setReplacement]=useState(''),save=useSave(data.registryRevision,false,refresh,dirty),selected=data.selected===item.definition.id;
  return <Modal title={t('currencies.archive')} onClose={save.disabled?undefined:onClose}>
    <p className="dialog-text">{t('currencies.archiveHelp',{name:item.definition.name})}</p>
    {selected&&<CurrencyChoice title={t('currencies.replacement')} value={replacement} onChange={setReplacement} disabled={save.disabled} items={[...data.standards,...data.personal.filter(row=>row.archivedAt===null&&row.definition.id!==item.definition.id).map(row=>row.definition)]} />}
    <div className="button-row currency-actions"><button className="button" disabled={save.disabled} onClick={onClose}>{t('common.cancel')}</button><button className="button danger" disabled={save.disabled||selected&&!replacement} onClick={()=>save.send('/api/currencies/'+item.definition.id+'/archive',{...(replacement?{replacement}:{})},onClose)}>{t('currencies.archive')}</button></div>
    {save.notice}
  </Modal>;
}

function CurrencyDetails({data,item,refresh,dirty,leave}:{data:CurrencyManagement;item:ManagedCurrency;refresh:Refresh;dirty:Dirty;leave:(go:()=>void)=>void}) {
  const [history,setHistory]=useState<CurrencyRateHistory|null>(null),[error,setError]=useState<unknown>(null),[loading,setLoading]=useState(false),[archive,setArchive]=useState(false),[stop,setStop]=useState<{base:string;quote:string}|null>(null);
  const [seed,setSeed]=useState<{base:string;rate:string;key:number}|null>(null),save=useSave(data.registryRevision,false,refresh,dirty),generation=useRef(0);
  const read=useCallback(async(before?:string)=>{
    const token=++generation.current;setLoading(true);setError(null);
    try{const answer=await call<CurrencyRateHistory>('GET','/api/currencies/'+item.definition.id+'/history'+(before?'?before='+encodeURIComponent(before):''));if(token===generation.current)setHistory(old=>before&&old?{...answer,changes:[...old.changes,...answer.changes]}:answer);}catch(failure){if(token===generation.current)setError(failure);}finally{if(token===generation.current)setLoading(false);}
  },[item.definition.id]);
  useEffect(()=>{void read();return ()=>{generation.current++;};},[read,data.registryRevision]);
  const archived=item.archivedAt!==null;
  return <section className="settings-section currency-details">
    <h2>{item.definition.name}</h2>
    {archived?<><p className="dialog-text">{t('currencies.archivedHelp')}</p><button type="button" className="button" disabled={save.disabled||data.personal.filter(row=>row.archivedAt===null).length>=data.maxActive} onClick={()=>save.send('/api/currencies/'+item.definition.id+'/restore',{})}>{t('currencies.restore')}</button></>:<>
      <DefinitionForm data={data} item={item} refresh={refresh} dirty={dirty} />
      <div className="button-row is-start currency-actions"><button type="button" className="button" disabled={save.disabled||data.selected===item.definition.id} onClick={()=>save.send('/api/currencies/display',{currency:item.definition.id})}>{t('currencies.use')}</button><button type="button" className="button danger" onClick={()=>setArchive(true)}>{t('currencies.archive')}</button></div>
    </>}
    {save.notice}
    <h3>{t('currencies.pairs')}</h3>
    {loading&&!history&&<p role="status">{t('currencies.loading')}</p>}
    <ErrorLine error={error} />
    {history&&<ul className="settings-list">{history.pairs.map(pair=><li key={pair.base} className="settings-list-row popover-row">
      <div className="settings-item-main"><b>{pair.quote?`1 ${pair.base} = ${rateText(pair.quote.rates[item.definition.id])} ${item.definition.symbol}`:pair.base}</b><small>{t(pair.kind==='stop'?'currencies.stopped':'currencies.active')}</small><small>{pair.nominal?t('currencies.nominal'):stamp(pair.effectiveAt)}</small></div>
      <div className="settings-item-actions">{!archived&&pair.quote&&<button className="button" type="button" disabled={save.disabled} onClick={()=>setStop({base:pair.base,quote:pair.quote!.id})}>{t('currencies.stop')}</button>}</div>
    </li>)}</ul>}
    {!archived&&<RateForm key={seed?.key??0} seed={seed} data={data} item={item} refresh={refresh} dirty={dirty} />}
    <h3>{t('currencies.versions')}</h3><p className="dialog-text">{t('currencies.retentionHelp')}</p>
    {history&&<><ul className="settings-list">{history.changes.map(change=><li key={change.sequence} className="settings-list-row popover-row">
      <div className="settings-item-main"><b>{change.quote?`1 ${change.base} = ${rateText(change.quote.rates[item.definition.id])} ${item.definition.symbol}`:t('currencies.stopped')}</b><small>{change.nominal?t('currencies.nominal'):t('currencies.effectiveAt',{time:stamp(change.effectiveAt)})}</small><small>{t('currencies.recordedAt',{time:stamp(change.recordedAt)})}</small></div>
      <div className="settings-item-actions">{!archived&&change.quote&&<button type="button" className="button" onClick={()=>leave(()=>setSeed({base:change.base,rate:rateText(change.quote!.rates[item.definition.id]),key:(seed?.key??0)+1}))}>{t('currencies.reuse')}</button>}</div>
    </li>)}</ul>{history.nextCursor&&<button type="button" className="button" disabled={loading} onClick={()=>void read(history.nextCursor!)}>{t('currencies.more')}</button>}</>}
    {archive&&<ArchiveCurrency data={data} item={item} refresh={refresh} dirty={dirty} onClose={()=>setArchive(false)} />}
    {stop&&<Modal title={t('currencies.stop')} onClose={save.disabled?undefined:()=>setStop(null)}><p className="dialog-text">{t('currencies.stopHelp')}</p><div className="button-row currency-actions"><button type="button" className="button" disabled={save.disabled} onClick={()=>setStop(null)}>{t('common.cancel')}</button><button type="button" className="button danger" disabled={save.disabled} onClick={()=>save.send('/api/currencies/'+item.definition.id+'/rates/'+stop.quote+'/archive',{base:stop.base},()=>setStop(null))}>{t('currencies.stop')}</button></div>{save.notice}</Modal>}
  </section>;
}

export function CurrencySettings() {
  const [data,setData]=useState<CurrencyManagement|null>(null),[error,setError]=useState<unknown>(null),[selected,setSelected]=useState<string|null>(null),[confirm,setConfirm]=useState<{go:()=>void}|null>(null);
  const revision=useCurrencyRegistryRevision(),generation=useRef(0),alive=useRef(true),drafts=useRef(new Map<string,()=>void>()),[hasDraft,setHasDraft]=useState(false);
  const dirty=useCallback<Dirty>((key,value,discard)=>{if(value)drafts.current.set(key,discard??(()=>{}));else drafts.current.delete(key);setHasDraft(drafts.current.size>0);},[]);
  const leave=useCallback((go:()=>void)=>{if(drafts.current.size)setConfirm({go});else go();},[]);
  const refresh=useCallback(async()=>{const token=++generation.current;try{const answer=await call<CurrencyManagement>('GET','/api/currencies/manage');if(alive.current&&token===generation.current){setData(answer);setError(null);}return answer;}catch(failure){if(alive.current&&token===generation.current)setError(failure);throw failure;}},[]);
  useEffect(()=>{alive.current=true;const read=()=>{if(document.visibilityState!=='hidden')void refresh().catch(()=>{});};read();window.addEventListener('focus',read);document.addEventListener('visibilitychange',read);return ()=>{alive.current=false;generation.current++;window.removeEventListener('focus',read);document.removeEventListener('visibilitychange',read);};},[refresh]);
  useEffect(()=>{if(revision!==undefined&&data&&revision!==data.registryRevision)void refresh().catch(()=>{});},[revision,refresh]);
  useEffect(()=>guardNavigation(leave),[leave]);
  useEffect(()=>{if(!hasDraft)return;const unload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',unload);return ()=>window.removeEventListener('beforeunload',unload);},[hasDraft]);
  const item=data?.personal.find(row=>row.definition.id===selected);
  return <>
    <ErrorLine error={error} />{error&&<button className="button" onClick={()=>void refresh().catch(()=>{})}>{t('currencies.retry')}</button>}
    {!data?<p role="status">{t('currencies.loading')}</p>:<>
      <DisplayCurrency data={data} refresh={refresh} dirty={dirty} />
      <section className="settings-section"><div className="settings-section-head"><h2>{t('currencies.personal')}</h2><button type="button" className="button" disabled={data.personal.filter(row=>row.archivedAt===null).length>=data.maxActive} onClick={()=>leave(()=>setSelected('new'))}>{t('currencies.create')}</button></div>
        {data.personal.filter(row=>row.archivedAt===null).length>=data.maxActive&&<p>{t('api.currency_limit')}</p>}
        <ul className="settings-list">{data.personal.filter(row=>row.archivedAt===null).map(row=><li className="settings-list-row popover-row" key={row.definition.id}><div className="settings-item-main"><b>{row.definition.name}</b><small>{row.definition.symbol}{data.selected===row.definition.id?' — '+t('currencies.selected'):''}</small></div><div className="settings-item-actions"><button className="button" type="button" aria-expanded={selected===row.definition.id} onClick={()=>leave(()=>setSelected(selected===row.definition.id?null:row.definition.id))}>{t('currencies.manage')}</button></div></li>)}</ul>
        {!data.personal.some(row=>row.archivedAt===null)&&<p className="dialog-text">{t('currencies.empty')}</p>}
      </section>
      {selected==='new'&&<section className="settings-section"><h2>{t('currencies.create')}</h2><DefinitionForm data={data} refresh={refresh} dirty={dirty} onCreated={setSelected} /></section>}
      {item&&<CurrencyDetails key={item.definition.id} data={data} item={item} refresh={refresh} dirty={dirty} leave={leave} />}
      <section className="settings-section"><details><summary>{t('currencies.archiveList')}</summary><ul className="settings-list">{data.personal.filter(row=>row.archivedAt!==null).map(row=><li key={row.definition.id} className="settings-list-row popover-row"><div className="settings-item-main"><b>{row.definition.name}</b><small>{stamp(row.archivedAt!)}</small></div><div className="settings-item-actions"><button type="button" className="button" onClick={()=>leave(()=>setSelected(row.definition.id))}>{t('currencies.manage')}</button></div></li>)}</ul></details></section>
    </>}
    {confirm&&<Modal title={t('currencies.unsaved')} onClose={()=>setConfirm(null)}><p className="dialog-text">{t('currencies.unsavedHelp')}</p><div className="button-row currency-actions"><button type="button" className="button" onClick={()=>setConfirm(null)}>{t('currencies.stay')}</button><button type="button" className="button danger" onClick={()=>{const go=confirm.go;setConfirm(null);for(const discard of drafts.current.values())discard();go();}}>{t('currencies.discard')}</button></div></Modal>}
  </>;
}
