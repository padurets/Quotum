import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {CurrencyDefinition,CurrencyManagement,ManagedCurrency} from '../../server/domain/currency';
import {ChevronDown} from 'lucide-react';
import {t,useLocale} from '../i18n';
import {ApiError,call} from '../lib/http';
import {currencyRate} from '../lib/currencySettings';
import {ErrorLine,Field} from './Kit';
import {Popover} from './Popover';

export type Refresh=()=>Promise<CurrencyManagement>;
export type Dirty=(key:string,value:boolean,discard?:()=>void)=>void;
export const personal=(id:string)=>id.startsWith('personal:');
export const currencyLabel=(definition:CurrencyDefinition,locale:string,items:CurrencyDefinition[]=[])=>{
  if(!personal(definition.id))return `${definition.id} — ${new Intl.DisplayNames([locale],{type:'currency'}).of(definition.id)??definition.name}`;
  const duplicate=items.some(item=>item.id!==definition.id&&item.name===definition.name&&item.symbol===definition.symbol);
  return `${definition.name} (${definition.symbol})${duplicate?' — '+definition.id.slice(-6):''}`;
};

export function CurrencyChoice({items,value,onChange,title,disabled=false,compact=false}:{items:CurrencyDefinition[];value:string;onChange:(id:string)=>void;title:string;disabled?:boolean;compact?:boolean}) {
  const locale=useLocale(),[open,setOpen]=useState(false),[search,setSearch]=useState(''),chosen=items.find(item=>item.id===value),box=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(open)box.current?.querySelector('input')?.focus({preventScroll:true});},[open]);
  return <div className="field currency-choice" aria-disabled={disabled} ref={box}>
    {!compact&&<span>{title}</span>}
    <Popover label={title} trigger={<><span>{chosen?currencyLabel(chosen,locale,items):t('currencies.choose')}</span><ChevronDown size={12} aria-hidden="true" /></>} triggerClass="button" align="left" width={420} open={!disabled&&open} onOpenChange={next=>{if(!disabled){setOpen(next);if(next)setSearch('');}}}>
      <div className="popover-section"><Field label={t('currencies.search')} value={search} onChange={event=>setSearch(event.target.value)} /></div>
      <div className="popover-scroll">
        {items.filter(item=>currencyLabel(item,locale,items).toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale))).map(item=><button type="button" className="popover-row" key={item.id} aria-pressed={value===item.id} onClick={()=>{onChange(item.id);setOpen(false);}}>{currencyLabel(item,locale,items)}</button>)}
      </div>
    </Popover>
  </div>;
}

function useDirty(dirty:Dirty,value:boolean,discard?:()=>void) {
  const key=useId(),latest=useRef(discard);latest.current=discard;useEffect(()=>{dirty(key,value,()=>latest.current?.());return ()=>dirty(key,false);},[dirty,key,value]);
}

/** A retry keeps the exact receipt, payload and revision after an unconfirmed response. */
export function useSave(revision:string,changed:boolean,refresh:Refresh,dirty:Dirty,discard?:()=>void) {
  const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState<unknown>(null),[saved,setSaved]=useState(false);
  const baseline=useRef(revision),alive=useRef(true),sending=useRef(false),generation=useRef(0),request=useRef<{url:string;body:Record<string,unknown>;done:(value:unknown)=>void}|null>(null);
  if(!changed&&!request.current)baseline.current=revision;
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useDirty(dirty,changed||busy||uncertain,()=>{
    // Discard abandons this form's response, not a command already received by the server.
    generation.current++;request.current=null;sending.current=false;setBusy(false);setUncertain(false);setError(null);setSaved(false);discard?.();
  });
  const submit=async()=>{
    const current=request.current;if(!current||sending.current)return;const token=++generation.current;sending.current=true;setBusy(true);setError(null);setSaved(false);
    try {
      const value=await call<unknown>('POST',current.url,current.body);
      if(!alive.current||token!==generation.current)return;
      await refresh().then(data=>{if(token===generation.current)baseline.current=data.registryRevision;}).catch(()=>{});
      if(!alive.current||token!==generation.current)return;request.current=null;setUncertain(false);current.done(value);setSaved(true);
    }catch(failure){
      if(!alive.current||token!==generation.current)return;
      if(failure instanceof ApiError&&failure.status<500){request.current=null;setUncertain(false);setError(failure);if(failure.status===409)await refresh().then(data=>{if(token===generation.current)baseline.current=data.registryRevision;}).catch(()=>{});}
      else{setUncertain(true);setError(null);}
    }finally{if(token===generation.current){sending.current=false;if(alive.current)setBusy(false);}}
  };
  const send=(url:string,body:Record<string,unknown>,done:(value:unknown)=>void=()=>{})=>{
    if(request.current||sending.current)return;request.current={url,body:{...body,expectedRevision:baseline.current,requestId:crypto.randomUUID()},done};void submit();
  };
  return {send,conflict:error instanceof ApiError&&error.status===409,disabled:busy||uncertain,notice:<>
    {busy&&<p role="status">{t('currencies.saving')}</p>}
    {saved&&!changed&&!busy&&!error&&<p role="status">{t('currencies.saved')}</p>}
    <ErrorLine error={error} />
    {uncertain&&<div role="alert"><p>{t('currencies.unconfirmed')}</p><button type="button" className="button" disabled={busy} onClick={()=>void submit()}>{t('currencies.retry')}</button></div>}
  </>};
}

/** Native choices inside dialogs never compete with their scroll area. */
export function CurrencySelect({items,value,onChange,title,compact=false}:{items:CurrencyDefinition[];value:string;onChange:(id:string)=>void;title:string;compact?:boolean}) {
  const id=useId(),locale=useLocale();
  return <div className="field"><label className={compact?'sr-only':undefined} htmlFor={id}>{title}</label><select id={id} value={value} onChange={event=>onChange(event.target.value)}>
    {!value&&<option value="" disabled>{t('currencies.choose')}</option>}
    {items.map(item=><option key={item.id} value={item.id}>{compact?item.id:currencyLabel(item,locale,items)}</option>)}
  </select></div>;
}

/** The same direction for both the initial ratio and every later price. */
function RateFields({standards,base,rate,symbol,onBase,onRate}:{standards:CurrencyDefinition[];base:string;rate:string;symbol:string;onBase:(id:string)=>void;onRate:(value:string)=>void}) {
  return <div className="currency-ratio" role="group" aria-label={t('currencies.rate')}>
    <span>1</span><CurrencySelect items={standards} value={base} title={t('currencies.base')} onChange={onBase} compact />
    <span>=</span><div className="field"><input aria-label={t('currencies.rate')} inputMode="decimal" value={rate} required placeholder="0" onChange={event=>onRate(event.target.value)} /></div><span className="currency-unit">{symbol||'…'}</span>
  </div>;
}

export function DefinitionForm({data,item,refresh,dirty,onDone,onCancel}:{data:CurrencyManagement;item?:ManagedCurrency;refresh:Refresh;dirty:Dirty;onDone:(id:string)=>void;onCancel:()=>void}) {
  const locale=useLocale(),original=item?.definition,form=useRef<HTMLFormElement>(null);
  const [name,setName]=useState(original?.name??''),[symbol,setSymbol]=useState(original?.symbol??''),[digits,setDigits]=useState(String(original?.fractionDigits??2));
  const [base,setBase]=useState('USD'),[rate,setRate]=useState(''),[error,setError]=useState<unknown>(null),[edited,setEdited]=useState(false);
  const reset=()=>{setName(original?.name??'');setSymbol(original?.symbol??'');setDigits(String(original?.fractionDigits??2));setRate('');setBase('USD');setEdited(false);setError(null);};
  const save=useSave(data.registryRevision,edited,refresh,dirty,reset);
  useEffect(()=>{form.current?.querySelector('input')?.focus({preventScroll:true});},[]);
  useEffect(()=>{if(!edited){setName(original?.name??'');setSymbol(original?.symbol??'');setDigits(String(original?.fractionDigits??2));}},[original?.name,original?.symbol,original?.fractionDigits,edited]);
  const submit=(event:FormEvent)=>{
    event.preventDefault();setError(null);
    try {
      const body={name,symbol,fractionDigits:Number(digits),...(!original?{base,rate:currencyRate(rate,locale)}:{})};
      save.send('/api/currencies'+(original?'/'+original.id:''),body,value=>{setEdited(false);onDone((value as CurrencyDefinition).id);});
    }catch{setError(new ApiError(400,'invalid_currency'));}
  };
  return <form className="dialog-form currency-form" ref={form} onSubmit={submit} onChange={()=>setEdited(true)}>
    <fieldset disabled={save.disabled||item?.archivedAt!=null} className="currency-fields">
      <Field label={t('currencies.name')} value={name} maxLength={64} required onChange={event=>setName(event.target.value)} />
      <div className="currency-metadata-fields"><Field label={t('currencies.symbol')} value={symbol} maxLength={12} required onChange={event=>setSymbol(event.target.value)} />
      <Field label={t('currencies.precision')} type="number" min={0} max={6} step={1} required value={digits} onChange={event=>setDigits(event.target.value)} /></div>
      {!original&&<><h3>{t('currencies.initialRate')}</h3><RateFields standards={data.standards} base={base} rate={rate} symbol={symbol} onBase={id=>{setBase(id);setEdited(true);}} onRate={setRate} /><p className="dialog-text">{t('currencies.nominalBrief')}</p><details className="currency-disclosure"><summary>{t('currencies.details')}</summary><p className="dialog-text">{t('currencies.nominalHelp')}</p></details></>}
      <div className="button-row currency-actions"><button type="button" className="button" onClick={onCancel}>{t('common.cancel')}</button><button className="button primary" disabled={!edited}>{t(original?'account.save':'currencies.create')}</button></div>
    </fieldset>
    {save.conflict&&original&&<p className="dialog-text">{t('currencies.serverVersion',{name:original.name,symbol:original.symbol,digits:original.fractionDigits})}</p>}
    <ErrorLine error={error} />{save.notice}
  </form>;
}

export type RateSeed={base:string;rate:string};
export function RateForm({data,item,refresh,dirty,seed,onDone,onCancel}:{data:CurrencyManagement;item:ManagedCurrency;refresh:Refresh;dirty:Dirty;seed:RateSeed|null;onDone:()=>void;onCancel:()=>void}) {
  const locale=useLocale(),form=useRef<HTMLFormElement>(null),when=useId();
  const [base,setBase]=useState(seed?.base??'USD'),[rate,setRate]=useState(seed?.rate??''),[date,setDate]=useState(''),[past,setPast]=useState(false),[error,setError]=useState<unknown>(null);
  const edited=!!rate||past||base!==(seed?.base??'USD'),save=useSave(data.registryRevision,edited,refresh,dirty,()=>{setRate('');setDate('');setPast(false);setBase(seed?.base??'USD');setError(null);});
  useEffect(()=>{form.current?.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.focus({preventScroll:true});},[]);
  return <form className="dialog-form currency-form" ref={form} onSubmit={event=>{
    event.preventDefault();setError(null);try{const at=past?new Date(date).getTime():undefined;if(at!==undefined&&(!Number.isSafeInteger(at)||at>Date.now()))throw new Error();save.send('/api/currencies/'+item.definition.id+'/rates',{base,rate:currencyRate(rate,locale),...(at===undefined?{}:{date:at})},onDone);}catch{setError(new ApiError(400,'invalid_currency'));}
  }}>
    <fieldset className="currency-fields" disabled={save.disabled||item.archivedAt!==null}>
      <RateFields standards={data.standards} base={base} rate={rate} symbol={item.definition.symbol} onBase={setBase} onRate={setRate} />
      <div className="field"><label htmlFor={when}>{t('currencies.effective')}</label><select id={when} value={past?'past':'now'} onChange={event=>setPast(event.target.value==='past')}><option value="now">{t('currencies.fromNow')}</option><option value="past">{t('currencies.fromPast')}</option></select></div>
      {past&&<Field label={t('currencies.localDate')} type="datetime-local" required value={date} onChange={event=>setDate(event.target.value)} />}
      <p className="dialog-text">{t('currencies.rateBrief')}</p><details className="currency-disclosure"><summary>{t('currencies.details')}</summary><p className="dialog-text">{t('currencies.rateHelp')}</p></details>
      <div className="button-row currency-actions"><button type="button" className="button" onClick={onCancel}>{t('common.cancel')}</button><button className="button primary" disabled={!rate}>{t('account.save')}</button></div>
    </fieldset><ErrorLine error={error} />{save.notice}
  </form>;
}
