import {useEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {Save,RotateCcw,X,ChevronDown} from 'lucide-react';
import {dataFilters,useDataFilters} from '../lib/dataFilters';
import {useBoardId,useNamed,useRole,type Named} from '../lib/board';
import {setPrefs,usePref} from '../lib/prefs';
import {boardPeriod} from '../lib/period';
import {t,type Key} from '../i18n';
import {quotaPeriods} from '../lib/subscription';
import {windowName} from '../lib/quota';
import {subscriptionFundsVisible} from '../lib/money';
import {RESOURCE_FILTERS,excludedCount,excludedResources,resourcesRestricted,selectionRestricted} from '../lib/filterSummary';
import {clientName} from '../../server/domain/clients';
import {fundsRule,matchesSelection,matchesSource,type DataFilters,type FamilyRef,type Selection} from '../../server/domain/dataFilters';
import {moneyFamily,providerOf} from '../../server/domain/providers';
import {Popover,SwitchRow} from './Popover';
import {ErrorLine,Field} from './Kit';
import {KeyMoneySettings} from './MoneySettings';
import {logoOf} from './logos';

let requested=false;
export function openDataFilters(){requested=true;setPrefs({filtersVisible:true});window.dispatchEvent(new Event('quotum:open-filters'));}

/** Reset stays beside its filter, outside the button that opens the menu. */
export function FilterPopover({label,count,changed,onReset,children,open,onOpenChange,width}:{label:Key;count?:number;changed:boolean;onReset:()=>void;children:ReactNode;open?:boolean;onOpenChange?:(open:boolean)=>void;width?:number}){
  const root=useRef<HTMLDivElement>(null);
  return <div className="filter-control" ref={root}>
    <Popover label={t(label)} trigger={<span className="filter-trigger"><span>{t(label)}</span>
      {!!count&&<span className="filter-count" aria-label={t('filters.excludedCount',{count})}>−{count}</span>}
      {changed&&count===undefined&&<i className="filter-changed" aria-hidden="true"/>}
    </span>} open={open} onOpenChange={onOpenChange} width={width}>{children}</Popover>
    {changed&&<button type="button" className="icon-button filter-reset" title={t('filters.showAll',{filter:t(label)})} aria-label={t('filters.showAll',{filter:t(label)})} onClick={()=>{root.current?.querySelector('button')?.focus();onReset();}}><X size={13}/></button>}
  </div>;
}

function Dimension({family,label}:{family:'projects'|'devices'|'clients';label:Key}){
  const [open,setOpen]=useState(false),state=useDataFilters(),facets=useSyncExternalStore(boardPeriod.subscribeFacets,boardPeriod.getFacets);
  const [search,setSearch]=useState('');
  const rule=state.current?.[family];
  const countNeedsChoices=rule?.mode==='include'&&!facets.value&&!facets.error;
  useEffect(()=>open||countNeedsChoices?boardPeriod.demandFacets():undefined,[open,countNeedsChoices]);
  const options:{ref:string|null;name:string}[]=family==='projects'?(facets.value?.projects??[]).map(ref=>({ref,name:ref??t('activity.noProject')})):
    family==='devices'?(facets.value?.devices??[]).map(device=>({ref:device.id,name:device.name})):
      (facets.value?.clients??[]).map(ref=>({ref,name:ref?clientName(ref):t('filters.unknownClient')}));
  const count=rule?excludedCount(rule as Selection<FamilyRef>,options.map(option=>option.ref)):0;
  return <FilterPopover label={label} count={count} changed={!!rule&&selectionRestricted(rule)} onReset={()=>{dataFilters.reset(family,'all');setSearch('');}} open={open} onOpenChange={setOpen} width={288}>
    {facets.loading&&<p className="popover-note">{t('desktop.loading')}</p>}
    {facets.error&&<p className="popover-note" role="status">{t('filters.unavailable')}</p>}
    {(options.length>10||!!search)&&<div className="popover-body"><Field label={t('filters.search')} type="search" value={search} onChange={event=>setSearch(event.target.value)}/></div>}
    <div className="filter-options">{rule&&options.filter(option=>option.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(option=><SwitchRow key={JSON.stringify(option.ref)} on={matchesSelection(rule as Selection<FamilyRef>,option.ref)} onChange={on=>dataFilters.toggle(family,option.ref,on)}>{option.name}</SwitchRow>)}</div>
    {!!state.saved?.unavailable[family]&&<p className="popover-note">{t('filters.unavailableCount',{count:state.saved.unavailable[family]})}</p>}
  </FilterPopover>;
}

function Resource({source,filters,wallets,fundsUnit,visible}:{source:Named;filters:DataFilters;wallets:readonly Named[];fundsUnit?:string;visible:boolean}){
  const [expanded,setExpanded]=useState(false),[visited,setVisited]=useState(false);
  const enabled=matchesSource(filters,source.id),windows=quotaPeriods(source),funds=subscriptionFundsVisible(source),wallet=wallets.some(wallet=>wallet.id===source.id);
  const hasChildren=!!windows.length||funds||wallet,title=source.title??source.id;
  const heading=<><img src={logoOf(source.provider)} alt=""/><span>{title}</span></>;
  return <div className={`filter-resource${!enabled?' is-off':''}`} hidden={!visible}>
    <SwitchRow className="filter-resource-toggle" on={enabled} onChange={on=>dataFilters.toggle('sources',{source:source.id},on)}><span className="sr-only">{title}</span></SwitchRow>
    {hasChildren?<details open={enabled&&expanded} onToggle={event=>{const open=event.currentTarget.open;setExpanded(open);if(open)setVisited(true);}}>
      <summary className="popover-row filter-resource-heading" aria-disabled={!enabled} onClick={event=>{if(!enabled)event.preventDefault();}}>{heading}{enabled&&<ChevronDown size={14}/>}</summary>
      {visited&&<div className="filter-resource-items">
        {windows.map(window=><SwitchRow key={window.id} on={matchesSelection(filters.windows,[source.id,window.id])} onChange={on=>dataFilters.toggle('windows',[source.id,window.id],on)}>{windowName(window)}</SwitchRow>)}
        {funds&&<SwitchRow on={matchesSelection(fundsRule(filters,fundsUnit),source.id)} onChange={on=>dataFilters.toggle('funds',source.id,on,fundsUnit)}>{t('money.additionalFunds')}</SwitchRow>}
        {wallet&&<KeyMoneySettings source={source} sources={wallets} hidden={[]} series={[]} active={visible&&enabled&&expanded}/>}
      </div>}
    </details>:<div className="popover-row filter-resource-heading">{heading}</div>}
  </div>;
}

function Resources(){
  const [open,setOpen]=useState(()=>{const value=requested;requested=false;return value;}),state=useDataFilters(),sources=useNamed(),board=useBoardId(),funds=usePref('funds'),money=usePref('money');
  const [search,setSearch]=useState('');
  const facets=useSyncExternalStore(boardPeriod.subscribeFacets,boardPeriod.getFacets),filters=state.current;
  const countNeedsChoices=filters?.sources.mode==='include'&&!facets.value&&!facets.error;
  useEffect(()=>open||countNeedsChoices?boardPeriod.demandFacets():undefined,[open,countNeedsChoices]);
  useEffect(()=>{const show=()=>{requested=false;setOpen(true);};window.addEventListener('quotum:open-filters',show);return()=>window.removeEventListener('quotum:open-filters',show);},[]);
  const wallets=sources.filter(source=>moneyFamily(providerOf(source.provider))==='budget'&&source.budget?.enabled!==false&&source.meters?.some(meter=>meter.kind==='balance'||meter.kind==='cap'));
  const count=filters?excludedResources(filters,sources,facets.value,money.unit??undefined,funds.unit??undefined):0;
  return <FilterPopover label="filters.resources" count={count} changed={!!filters&&resourcesRestricted(filters)} onReset={()=>{dataFilters.reset(RESOURCE_FILTERS,'all');setSearch('');}} open={open} onOpenChange={setOpen} width={320}>
    {(sources.length>10||!!search)&&<div className="popover-body"><Field label={t('filters.search')} type="search" value={search} onChange={event=>setSearch(event.target.value)}/></div>}
    <div className="filter-options">{filters&&!!board&&sources.map(source=><Resource key={source.id} source={source} filters={filters} wallets={wallets} fundsUnit={funds.unit??undefined} visible={(source.title??source.id).toLocaleLowerCase().includes(search.toLocaleLowerCase())}/>)}
      {filters&&facets.value?.funding.map(status=><SwitchRow key={status} on={matchesSelection(filters.sources,{status})} onChange={on=>dataFilters.toggle('sources',{status},on)}>{t(status==='unknown'?'agents.unknownSource':'agents.notProvided')}</SwitchRow>)}
    </div>
    {facets.error&&<p className="popover-note" role="status">{t('filters.unavailable')}</p>}
    {!!state.conflicts&&<p className="popover-note">{t('filters.conflictCount',{count:state.conflicts})}</p>}
    {!!state.saved&&Object.values(state.saved.unavailable).some(Boolean)&&<p className="popover-note">{t('filters.unavailableCount',{count:Object.values(state.saved.unavailable).reduce((sum,n)=>sum+n,0)})}</p>}
  </FilterPopover>;
}
export function DataFilterControls(){
  return <div className="data-filter-controls"><Resources/><Dimension family="projects" label="filters.projects"/><Dimension family="devices" label="filters.devices"/><Dimension family="clients" label="filters.clients"/></div>;
}
export function FilterSaveActions(){
  const state=useDataFilters(),owner=useRole()==='owner';
  return <div className="filter-save-actions">
    {owner&&<button className="icon-button" title={t('filters.save')} aria-label={t('filters.save')} aria-busy={state.saving} disabled={!state.saved||state.saving||!state.dirty&&state.saved.revision>0} onClick={()=>void dataFilters.save()}><Save size={16}/></button>}
    <button className="icon-button" title={t('filters.restore')} aria-label={t('filters.restore')} disabled={!state.saved||!state.dirty} onClick={()=>dataFilters.restore()}><RotateCcw size={16}/></button>
    <ErrorLine error={state.error}/>
  </div>;
}
