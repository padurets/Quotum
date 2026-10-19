import {useEffect,useState,useSyncExternalStore} from 'react';
import {Save,RotateCcw,Unlink} from 'lucide-react';
import {dataFilters,useDataFilters} from '../lib/dataFilters';
import {useBoardId,useNamed,useRole,type Named} from '../lib/board';
import {setPrefs,usePref} from '../lib/prefs';
import {boardPeriod} from '../lib/period';
import {budgetHistory} from '../lib/history';
import type {MeterHistory} from '../lib/moneyView';
import {t,type Key} from '../i18n';
import {quotaPeriods} from '../lib/subscription';
import {windowName} from '../lib/quota';
import {subscriptionFundsVisible} from '../lib/money';
import {RESOURCE_FILTERS,excludedCount,excludedResources,resourcesRestricted,selectionRestricted} from '../lib/filterSummary';
import {clientName} from '../../server/domain/clients';
import {executableWorkFilters,fundsRule,matchesSelection,matchesSource,type DataFilters,type FamilyRef,type Selection} from '../../server/domain/dataFilters';
import {moneyFamily,providerOf} from '../../server/domain/providers';
import {FilterGroup,FilterOptions,FilterPopover,FilterRow,FilterSearch} from './Filters';
import {ErrorLine} from './Kit';
import {KeyMoneySettings} from './MoneySettings';
import {logoOf} from './logos';

let requested=false;
export function openDataFilters(){requested=true;setPrefs({filtersVisible:true});window.dispatchEvent(new Event('quotum:open-filters'));}

function Dimension({family,label}:{family:'projects'|'devices'|'clients';label:Key}){
  const [open,setOpen]=useState(false),state=useDataFilters(),facets=useSyncExternalStore(boardPeriod.subscribeFacets,boardPeriod.getFacets);
  const [search,setSearch]=useState('');
  const rule=state.current?.[family];
  useEffect(()=>open?boardPeriod.demandFacets():undefined,[open]);
  const choices=(value:typeof facets.value):{ref:string|null;name:string}[]=>family==='projects'?(value?.projects??[]).map(ref=>({ref,name:ref??t('activity.noProject')})):
    family==='devices'?(value?.devices??[]).map(device=>({ref:device.id,name:device.name})):
      (value?.clients??[]).map(ref=>({ref,name:ref?clientName(ref):t('filters.unknownClient')}));
  const available=choices(facets.value),retained=choices(facets.value?.retained??null);
  const options=[...available,...retained.filter(option=>rule?.values.some(ref=>ref===option.ref)&&!available.some(present=>present.ref===option.ref))];
  const count=rule?(rule.mode==='include'&&!facets.value?undefined:excludedCount(rule as Selection<FamilyRef>,available.map(option=>option.ref))):0;
  return <FilterPopover label={label} count={count} changed={!!rule&&selectionRestricted(rule)} onReset={()=>{dataFilters.reset(family,'all');setSearch('');}} open={open} onOpenChange={setOpen} width={288}>
    {facets.loading&&<p className="popover-note">{t('desktop.loading')}</p>}
    {facets.error&&<p className="popover-note" role="status">{t('filters.unavailable')}</p>}
    {(options.length>10||!!search)&&<FilterSearch value={search} onChange={setSearch}/>}
    <FilterOptions>{rule&&options.filter(option=>option.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(option=><FilterRow key={JSON.stringify(option.ref)} on={matchesSelection(rule as Selection<FamilyRef>,option.ref)} onChange={on=>dataFilters.toggle(family,option.ref,on)}>{option.name}</FilterRow>)}</FilterOptions>
    {!!state.saved?.unavailable[family]&&<p className="popover-note">{t('filters.unavailableCount',{count:state.saved.unavailable[family]})}</p>}
  </FilterPopover>;
}

function Resource({source,filters,wallets,fundsUnit,visible,series}:{source:Named;filters:DataFilters;wallets:readonly Named[];fundsUnit?:string;visible:boolean;series:readonly MeterHistory[]}){
  const enabled=matchesSource(filters,source.id),windows=quotaPeriods(source),funds=subscriptionFundsVisible(source),wallet=wallets.some(wallet=>wallet.id===source.id);
  const hasChildren=!!windows.length||funds||wallet,title=source.title??source.id;
  return <FilterGroup label={title} icon={<img src={logoOf(source.provider)} alt=""/>} on={enabled} onChange={on=>dataFilters.toggle('sources',{source:source.id},on)} hidden={!visible}>
    {hasChildren?expanded=><>
      {windows.map(window=><FilterRow key={window.id} on={matchesSelection(filters.windows,[source.id,window.id])} onChange={on=>dataFilters.toggle('windows',[source.id,window.id],on)}>{windowName(window)}</FilterRow>)}
      {funds&&<FilterRow on={matchesSelection(fundsRule(filters,fundsUnit),source.id)} onChange={on=>dataFilters.toggle('funds',source.id,on,fundsUnit)}>{t('money.additionalFunds')}</FilterRow>}
      {wallet&&<KeyMoneySettings source={source} sources={wallets} hidden={[]} series={series} active={visible&&expanded}/>}
    </>:undefined}
  </FilterGroup>;
}

function Resources(){
  const [open,setOpen]=useState(()=>{const value=requested;requested=false;return value;}),state=useDataFilters(),sources=useNamed(),board=useBoardId(),funds=usePref('funds'),money=usePref('money');
  const [search,setSearch]=useState('');
  const history=useSyncExternalStore(budgetHistory.subscribe,budgetHistory.get);
  const facets=useSyncExternalStore(boardPeriod.subscribeFacets,boardPeriod.getFacets),filters=state.current;
  useEffect(()=>open?boardPeriod.demandFacets():undefined,[open]);
  useEffect(()=>{const show=()=>{requested=false;setOpen(true);};window.addEventListener('quotum:open-filters',show);return()=>window.removeEventListener('quotum:open-filters',show);},[]);
  const wallets=sources.filter(source=>moneyFamily(providerOf(source.provider))==='budget'&&source.budget?.enabled!==false&&source.meters?.some(meter=>meter.kind==='balance'||meter.kind==='cap'));
  const count=filters?(filters.sources.mode==='include'&&!facets.value?undefined:excludedResources(filters,sources,facets.value,money.unit??undefined,funds.unit??undefined)):0;
  return <FilterPopover label="filters.resources" count={count} changed={!!filters&&resourcesRestricted(filters)} onReset={()=>{dataFilters.reset(RESOURCE_FILTERS,'all');setSearch('');}} open={open} onOpenChange={setOpen} width={320}>
    {(sources.length>10||!!search)&&<FilterSearch value={search} onChange={setSearch}/>}
    <FilterOptions>{filters&&!!board&&sources.map(source=><Resource key={source.id} source={source} filters={filters} wallets={wallets} fundsUnit={funds.unit??undefined} series={history.history?.meterSeries??[]} visible={(source.title??source.id).toLocaleLowerCase().includes(search.toLocaleLowerCase())}/>)}
      {filters&&[...(facets.value?.funding??[]),...(facets.value?.retained?.funding??[]).filter(status=>filters.sources.values.some(ref=>'status' in ref&&ref.status===status))].map(status=><FilterGroup key={status} label={t(status==='unknown'?'agents.unknownSource':'agents.notProvided')} icon={status==='notProvided'?<Unlink size={16}/>:undefined} on={matchesSelection(filters.sources,{status})} onChange={on=>dataFilters.toggle('sources',{status},on)}/>)}
    </FilterOptions>
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
  return <><div className="filter-save-actions">
    <button className="icon-button" title={t('filters.restore')} aria-label={t('filters.restore')} disabled={!state.saved||!state.dirty} onClick={()=>dataFilters.restore()}><RotateCcw size={16}/></button>
    {owner&&<button className="icon-button" title={t(state.saving?'filters.saving':'filters.save')} aria-label={t(state.saving?'filters.saving':'filters.save')} aria-busy={state.saving} disabled={!state.saved||!state.current||!executableWorkFilters(state.current)||state.saving||!state.dirty&&state.saved.revision>0} onClick={()=>void dataFilters.save()}>{state.saving?<span className="spinner" aria-hidden="true"/>:<Save size={16}/>}</button>}
  </div><ErrorLine error={state.error}/></>;
}
