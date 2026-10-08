import {useCallback,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {Archive,MoreHorizontal,Pencil} from 'lucide-react';
import type {CurrencyDefinition,CurrencyManagement,CurrencyRateHistory,ManagedCurrency,RateSnapshot} from '../../server/domain/currency';
import {t,useLocale} from '../i18n';
import {call} from '../lib/http';
import {useCurrencyRegistryRevision} from '../lib/board';
import {guardNavigation} from '../lib/router';
import {rateText} from '../lib/currencySettings';
import {stamp} from '../lib/format';
import {ErrorLine,Modal,Segmented} from './Kit';
import {Popover} from './Popover';
import {CurrencyChoice,CurrencySelect,DefinitionForm,RateForm,currencyLabel,personal,useSave,type Dirty,type Refresh,type RateSeed} from './CurrencyForms';

type Leave=(go:()=>void)=>void;
const restoreCurrency=(id:string)=>{
  const row=document.querySelector<HTMLElement>(`[data-currency-id="${id}"]`);
  return row?.getClientRects().length?row:document.querySelector<HTMLElement>('.currency-overview button');
};
function CurrencyMenu({label,disabled,children}:{label:string;disabled?:boolean;children:(close:()=>void)=>ReactNode}) {
  const [open,setOpen]=useState(false);
  return <Popover label={label} icon={<MoreHorizontal size={16} />} open={!disabled&&open} onOpenChange={next=>{if(!disabled)setOpen(next);}} width={240}>
    {children(()=>setOpen(false))}
  </Popover>;
}

function DisplayCurrency({data,refresh,dirty}:{data:CurrencyManagement;refresh:Refresh;dirty:Dirty}) {
  const [choice,setChoice]=useState(data.selected),[edited,setEdited]=useState(false),[details,setDetails]=useState(false),[detail,setDetail]=useState<{definition:CurrencyDefinition;rates:RateSnapshot[]}|null>(null),[error,setError]=useState<unknown>(null);
  const reset=()=>{setChoice(data.selected);setEdited(false);},save=useSave(data.registryRevision,edited,refresh,dirty,reset),locale=useLocale();
  useEffect(()=>{if(!edited)setChoice(data.selected);},[data.selected,edited]);
  useEffect(()=>{let live=true;setDetail(null);setError(null);if(details&&!personal(choice))void call<{definition:CurrencyDefinition;rates:RateSnapshot[]}>('GET','/api/currencies/'+choice).then(value=>{if(live)setDetail(value);}).catch(error=>{if(live)setError(error);});return ()=>{live=false;};},[choice,data.registryRevision,details]);
  const items=[...data.standards,...data.personal.filter(item=>item.archivedAt===null).map(item=>item.definition)];
  return <section className="settings-section currency-overview">
    <h2>{t('currencies.display')}</h2><p className="dialog-text">{t('currencies.scope')}</p>
    <form className="currency-display-form" onSubmit={event=>{event.preventDefault();save.send('/api/currencies/display',{currency:choice},()=>setEdited(false));}}>
      <fieldset className="currency-fields" disabled={save.disabled}><CurrencyChoice title={t('currencies.display')} items={items} value={choice} disabled={save.disabled} compact onChange={id=>{setChoice(id);setEdited(id!==data.selected);}} /></fieldset>
      {edited&&<div className="button-row currency-actions"><button className="button primary" disabled={save.disabled}>{t('account.save')}</button><button type="button" className="button" disabled={save.disabled} onClick={reset}>{t('common.cancel')}</button></div>}
      {save.conflict&&<p className="dialog-text">{t('currencies.current',{currency:currencyLabel(items.find(item=>item.id===data.selected)!,locale,items)})}</p>}
      <div className="currency-notice">{save.notice}</div>
    </form>
    {!personal(choice)&&<details className="currency-disclosure" open={details} onToggle={event=>setDetails(event.currentTarget.open)}><summary>{t('currencies.referenceRates')}</summary>
      {!detail&&!error&&<p role="status">{t('currencies.loading')}</p>}
      {detail&&detail.definition.id===choice&&<div className="currency-reference"><p className="dialog-text">{t('currencies.precisionValue',{digits:detail.definition.fractionDigits})}</p>{detail.rates.length?<ul className="settings-list currency-list">{detail.rates.slice(0,3).map(quote=><li className="settings-list-row popover-row" key={quote.id}><div className="settings-item-main"><b className="currency-equation">1 {quote.base} = {rateText(quote.rates[detail.definition.id])} {detail.definition.id}</b><small>{quote.source.toUpperCase()}</small></div><span className="settings-item-detail">{stamp(quote.date)}</span></li>)}</ul>:<p className="dialog-text">{t('currencies.noPublicRate')}</p>}</div>}
      <ErrorLine error={error} />
    </details>}
  </section>;
}

function ArchiveCurrency({data,item,refresh,dirty,onClose}:{data:CurrencyManagement;item:ManagedCurrency;refresh:Refresh;dirty:Dirty;onClose:()=>void}) {
  const [replacement,setReplacement]=useState(''),save=useSave(data.registryRevision,false,refresh,dirty),selected=data.selected===item.definition.id;
  return <Modal title={t('currencies.archive')} restore={()=>restoreCurrency(item.definition.id)} onClose={save.disabled?undefined:onClose}>
    <p className="dialog-text">{t('currencies.archiveHelp',{name:item.definition.name})}</p>
    {selected&&<fieldset className="currency-fields" disabled={save.disabled}><CurrencySelect title={t('currencies.replacement')} value={replacement} onChange={setReplacement} items={[...data.standards,...data.personal.filter(row=>row.archivedAt===null&&row.definition.id!==item.definition.id).map(row=>row.definition)]} /></fieldset>}
    <div className="button-row currency-actions"><button className="button" disabled={save.disabled} onClick={onClose}>{t('common.cancel')}</button><button className="button danger" disabled={save.disabled||selected&&!replacement} onClick={()=>save.send('/api/currencies/'+item.definition.id+'/archive',{...(replacement?{replacement}:{})},onClose)}>{t('currencies.archive')}</button></div>
    {save.notice}
  </Modal>;
}

function CurrencyDetails({data,item,refresh,dirty,leave}:{data:CurrencyManagement;item:ManagedCurrency;refresh:Refresh;dirty:Dirty;leave:Leave}) {
  const [history,setHistory]=useState<CurrencyRateHistory|null>(null),[error,setError]=useState<unknown>(null),[loading,setLoading]=useState(false),[stop,setStop]=useState<{base:string;quote:string}|null>(null);
  const [editor,setEditor]=useState<{kind:'definition'}|{kind:'rate';seed:RateSeed|null;key:number}|null>(null),[notice,setNotice]=useState(false),[tab,setTab]=useState<'settings'|'history'>('settings'),tabs=useId();
  const save=useSave(data.registryRevision,false,refresh,dirty),generation=useRef(0),focus=useRef<HTMLElement|null>(null),body=useRef<HTMLDivElement>(null),serial=useRef(0);
  const read=useCallback(async(before?:string)=>{
    const token=++generation.current;setLoading(true);setError(null);
    try{const answer=await call<CurrencyRateHistory>('GET','/api/currencies/'+item.definition.id+'/history'+(before?'?before='+encodeURIComponent(before):''));if(token===generation.current)setHistory(old=>before&&old?{...answer,changes:[...old.changes,...answer.changes]}:answer);}catch(failure){if(token===generation.current)setError(failure);}finally{if(token===generation.current)setLoading(false);}
  },[item.definition.id]);
  useEffect(()=>{void read();return ()=>{generation.current++;};},[read,data.registryRevision]);
  useEffect(()=>{if(!editor&&focus.current){if(focus.current.isConnected)focus.current.focus({preventScroll:true});else body.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});focus.current=null;}},[editor]);
  const open=(next:NonNullable<typeof editor>)=>leave(()=>{focus.current=document.activeElement as HTMLElement;setNotice(false);setTab('settings');setEditor(next);});
  const close=()=>setEditor(null),done=()=>{close();setNotice(true);},archived=item.archivedAt!==null;
  const rate=(seed:RateSeed|null)=>open({kind:'rate',seed,key:++serial.current});
  return <div className="currency-details" ref={body}>
    <Segmented options={[['settings',t('currencies.settings')],['history',t('currencies.versions')]]} value={tab} radioName={tabs} label={t('currencies.sections')} onChange={next=>{if(next!==tab)leave(()=>{close();setTab(next);});}} />
    {loading&&!history&&<p role="status">{t('currencies.loading')}</p>}<ErrorLine error={error} />
    {!!error&&<div><button type="button" className="button" onClick={()=>void read()}>{t('currencies.retry')}</button></div>}
    {tab==='settings'&&!editor&&<div className="currency-page">
      {archived&&<section className="settings-section"><span className="currency-state">{t('currencies.archived')}</span><p className="dialog-text">{t('currencies.archivedHelp')}</p><div><button type="button" className="button" disabled={save.disabled||data.personal.filter(row=>row.archivedAt===null).length>=data.maxActive} onClick={()=>save.send('/api/currencies/'+item.definition.id+'/restore',{})}>{t('currencies.restore')}</button></div>{data.personal.filter(row=>row.archivedAt===null).length>=data.maxActive&&<p className="dialog-text">{t('api.currency_limit')}</p>}</section>}
      <div className="currency-notice">{save.notice}{notice&&<p className="dialog-text" role="status">{t('currencies.saved')}</p>}</div>
    <section className="settings-section">
      <div className="settings-section-head"><h3>{t('currencies.definition')}</h3>{!archived&&<button type="button" className="icon-button" aria-label={t('currencies.editDefinition')} title={t('currencies.editDefinition')} onClick={()=>open({kind:'definition'})}><Pencil size={15} /></button>}</div>
      <dl className="currency-facts"><div><dt>{t('currencies.symbol')}</dt><dd>{item.definition.symbol}</dd></div><div><dt>{t('currencies.decimals')}</dt><dd>{item.definition.fractionDigits}</dd></div></dl>
    </section>
    <section className="settings-section">
      <div className="settings-section-head"><h3>{t('currencies.pairs')}</h3>{!archived&&<button type="button" className="button" onClick={()=>rate(null)}>{t('currencies.add')}</button>}</div>
      {history&&<ul className="settings-list currency-list">{history.pairs.map(pair=><li key={pair.base} className="settings-list-row popover-row">
        <div className="settings-item-main"><b className="currency-equation">{pair.quote?`1 ${pair.base} = ${rateText(pair.quote.rates[item.definition.id])} ${item.definition.symbol}`:pair.base}</b><small>{pair.kind==='stop'?t('currencies.stopped'):pair.nominal?t('currencies.nominal'):t('currencies.effectiveAt',{time:stamp(pair.effectiveAt)})}</small></div>
        {!archived&&<div className="settings-item-actions currency-row-actions"><button className="icon-button" type="button" disabled={save.disabled} aria-label={t('currencies.editRate',{base:pair.base})} title={t('currencies.editRate',{base:pair.base})} onClick={()=>rate({base:pair.base,rate:pair.quote?rateText(pair.quote.rates[item.definition.id]):''})}><Pencil size={15} /></button>{pair.quote&&<button className="icon-button" type="button" disabled={save.disabled} aria-label={t('currencies.stop')} title={t('currencies.stop')} onClick={()=>setStop({base:pair.base,quote:pair.quote!.id})}><Archive size={15} /></button>}</div>}
      </li>)}</ul>}
    </section>
    </div>}
    {tab==='settings'&&editor?.kind==='definition'&&<section className="settings-section"><h3>{t('currencies.definition')}</h3><DefinitionForm data={data} item={item} refresh={refresh} dirty={dirty} onDone={done} onCancel={()=>leave(close)} /></section>}
    {tab==='settings'&&editor?.kind==='rate'&&<section className="settings-section"><h3>{t('currencies.setRate')}</h3><RateForm key={editor.key} seed={editor.seed} data={data} item={item} refresh={refresh} dirty={dirty} onDone={done} onCancel={()=>leave(close)} /></section>}
    {tab==='history'&&<section className="settings-section"><p className="dialog-text">{t('currencies.retentionHelp')}</p>
      {history&&<><ul className="settings-list currency-list currency-history">{history.changes.map(change=><li key={change.sequence} className="settings-list-row popover-row">
        <div className="settings-item-main"><b className="currency-equation">{change.quote?`1 ${change.base} = ${rateText(change.quote.rates[item.definition.id])} ${item.definition.symbol}`:`${change.base} — ${t('currencies.stopped')}`}</b><small>{change.nominal?t('currencies.nominal'):t('currencies.effectiveAt',{time:stamp(change.effectiveAt)})}</small><small>{t('currencies.recordedAt',{time:stamp(change.recordedAt)})}</small></div>
        {!archived&&change.quote&&<div className="settings-item-actions"><button type="button" className="button" onClick={()=>rate({base:change.base,rate:rateText(change.quote!.rates[item.definition.id])})}>{t('currencies.reuse')}</button></div>}
      </li>)}</ul>{history.nextCursor&&<button type="button" className="button" disabled={loading} onClick={()=>void read(history.nextCursor!)}>{t('currencies.more')}</button>}</>}
    </section>}
    {stop&&<Modal title={t('currencies.stop')} onClose={save.disabled?undefined:()=>setStop(null)}><p className="dialog-text">{t('currencies.stopHelp')}</p><div className="button-row currency-actions"><button type="button" className="button" disabled={save.disabled} onClick={()=>setStop(null)}>{t('common.cancel')}</button><button type="button" className="button danger" disabled={save.disabled} onClick={()=>save.send('/api/currencies/'+item.definition.id+'/rates/'+stop.quote+'/archive',{base:stop.base},()=>setStop(null))}>{t('currencies.stop')}</button></div>{save.notice}</Modal>}
  </div>;
}

function CurrencyRow({data,item,refresh,dirty,leave,onOpen}:{data:CurrencyManagement;item:CurrencyManagement['personal'][number];refresh:Refresh;dirty:Dirty;leave:Leave;onOpen:()=>void}) {
  const [archive,setArchive]=useState(false),save=useSave(data.registryRevision,false,refresh,dirty),archived=item.archivedAt!==null;
  const definition=item.definition,selected=data.selected===definition.id;
  const duplicate=data.personal.some(row=>row.definition.id!==definition.id&&row.definition.name===definition.name&&row.definition.symbol===definition.symbol);
  return <li className="settings-list-row popover-row">
    <button className="currency-open" data-currency-id={definition.id} type="button" aria-label={definition.name} aria-haspopup="dialog" onClick={()=>leave(onOpen)}>
      <span className="settings-item-main"><span className="currency-identity"><span className="currency-name">{definition.name}</span>{selected&&<span className="currency-state is-selected">{t('currencies.selected')}</span>}</span><small>{definition.symbol}{duplicate?' — '+definition.id.slice(-6):''}</small></span>
      <span className="settings-item-detail currency-overview-rates">{archived?<span>{stamp(item.archivedAt!)}</span>:item.pairs.map(pair=><span key={pair.base} className="currency-equation">{pair.rate?`1 ${pair.base} = ${rateText(pair.rate)} ${definition.symbol}`:`${pair.base} — ${t('currencies.stopped')}`}</span>)}</span>
    </button>
    <div className="settings-item-actions"><CurrencyMenu label={t('currencies.namedActions',{name:definition.name})} disabled={save.disabled}>{dismiss=><>
      <button type="button" className="popover-row" onClick={()=>{dismiss();leave(onOpen);}}>{t('currencies.configure')}</button>
      {!archived&&!selected&&<button type="button" className="popover-row" onClick={()=>{dismiss();leave(()=>save.send('/api/currencies/display',{currency:definition.id}));}}>{t('currencies.use')}</button>}
      {archived?<button type="button" className="popover-row" disabled={data.personal.filter(row=>row.archivedAt===null).length>=data.maxActive} onClick={()=>{dismiss();leave(()=>save.send('/api/currencies/'+definition.id+'/restore',{}));}}>{t('currencies.restore')}</button>:<button type="button" className="popover-row" onClick={()=>{dismiss();leave(()=>setArchive(true));}}>{t('currencies.archive')}</button>}
    </>}</CurrencyMenu></div>
    <div className="currency-notice currency-row-notice">{save.notice}</div>
    {archive&&<ArchiveCurrency data={data} item={item} refresh={refresh} dirty={dirty} onClose={()=>setArchive(false)} />}
  </li>;
}

export function CurrencySettings() {
  const [tab,setTab]=useState<'display'|'personal'|'archive'>('display'),tabs=useId();
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
  const rows=(archived:boolean)=><ul className="settings-list currency-list currency-registry-list">{data!.personal.filter(row=>(row.archivedAt!==null)===archived).map(row=><CurrencyRow key={row.definition.id} data={data!} item={row} refresh={refresh} dirty={dirty} leave={leave} onOpen={()=>setSelected(row.definition.id)} />)}</ul>;
  return <>
    <ErrorLine error={error} />{error&&<button className="button" onClick={()=>void refresh().catch(()=>{})}>{t('currencies.retry')}</button>}
    {!data?<p role="status">{t('currencies.loading')}</p>:<>
      <div className="currency-tabs"><Segmented options={[['display',t('currencies.displayTab')],['personal',t('currencies.personalTab')],['archive',t('currencies.archiveTab')]]} value={tab} radioName={tabs} label={t('currencies.title')} onChange={next=>{if(next!==tab)leave(()=>setTab(next));}} /></div>
      {tab==='display'&&<DisplayCurrency data={data} refresh={refresh} dirty={dirty} />}
      {tab==='personal'&&<section className="settings-section currency-overview"><div className="settings-section-head"><h2>{t('currencies.personal')}</h2><button type="button" className="button" disabled={data.personal.filter(row=>row.archivedAt===null).length>=data.maxActive} onClick={()=>leave(()=>setSelected('new'))}>{t('currencies.create')}</button></div>
        {data.personal.filter(row=>row.archivedAt===null).length>=data.maxActive&&<p className="dialog-text">{t('api.currency_limit')}</p>}
        {data.personal.some(row=>row.archivedAt===null)?rows(false):<p className="dialog-text">{t('currencies.empty')}</p>}
      </section>}
      {tab==='archive'&&<section className="settings-section currency-overview"><h2>{t('currencies.archiveList')}</h2>{data.personal.filter(row=>row.archivedAt===null).length>=data.maxActive&&<p className="dialog-text">{t('api.currency_limit')}</p>}{data.personal.some(row=>row.archivedAt!==null)?rows(true):<p className="dialog-text">{t('currencies.archiveEmpty')}</p>}</section>}
      {selected==='new'&&<Modal title={t('currencies.create')} onClose={()=>leave(()=>setSelected(null))}><DefinitionForm data={data} refresh={refresh} dirty={dirty} onDone={setSelected} onCancel={()=>leave(()=>setSelected(null))} /></Modal>}
      {item&&<Modal title={item.definition.name} restore={()=>restoreCurrency(item.definition.id)} onClose={()=>leave(()=>setSelected(null))}><CurrencyDetails key={item.definition.id} data={data} item={item} refresh={refresh} dirty={dirty} leave={leave} /></Modal>}
    </>}
    {confirm&&<Modal title={t('currencies.unsaved')} onClose={()=>setConfirm(null)}><p className="dialog-text">{t('currencies.unsavedHelp')}</p><div className="button-row currency-actions"><button type="button" className="button" onClick={()=>setConfirm(null)}>{t('currencies.stay')}</button><button type="button" className="button danger" onClick={()=>{const go=confirm.go;setConfirm(null);for(const discard of drafts.current.values())discard();go();}}>{t('currencies.discard')}</button></div></Modal>}
  </>;
}
