import {useEffect,useState,useSyncExternalStore} from 'react';
import {Save,RotateCcw} from 'lucide-react';
import {dataFilters,useDataFilters} from '../lib/dataFilters';
import {useBoardId,useNamed,useRole} from '../lib/board';
import {setPrefs,usePref} from '../lib/prefs';
import {boardPeriod} from '../lib/period';
import {t,type Key} from '../i18n';
import {quotaPeriods} from '../lib/subscription';
import {windowName} from '../lib/quota';
import {clientName} from '../../server/domain/clients';
import {fundsRule,matchesSelection,matchesSource,type FilterFamily,type FamilyRef,type Selection} from '../../server/domain/dataFilters';
import {moneyFamily,providerOf} from '../../server/domain/providers';
import {Popover,SwitchRow} from './Popover';
import {ErrorLine,Field} from './Kit';
import {KeyMoneySettings} from './MoneySettings';

let requested=false;
export function openDataFilters(){requested=true;setPrefs({filtersVisible:true});window.dispatchEvent(new Event('quotum:open-filters'));}

function FamilyActions({family}:{family:FilterFamily}){
  return <div className="filter-family-actions">
    <button className="popover-row" onClick={()=>dataFilters.reset(family,'all')}>{t(family==='wallet'?'money.resetSelection':family==='funds'?'funds.allSubscriptions':'filters.all')}</button>
    <button className="popover-row" onClick={()=>dataFilters.reset(family,'none')}>{t('filters.clear')}</button>
  </div>;
}
function Dimension({family,label}:{family:'projects'|'devices'|'clients';label:Key}){
  const [open,setOpen]=useState(false),state=useDataFilters(),facets=useSyncExternalStore(boardPeriod.subscribeFacets,boardPeriod.getFacets);
  const [search,setSearch]=useState('');
  useEffect(()=>open?boardPeriod.demandFacets():undefined,[open]);
  const rule=state.current?.[family];
  const options:{ref:string|null;name:string}[]=family==='projects'?(facets.value?.projects??[]).map(ref=>({ref,name:ref??t('activity.noProject')})):
    family==='devices'?(facets.value?.devices??[]).map(device=>({ref:device.id,name:device.name})):
      (facets.value?.clients??[]).map(ref=>({ref,name:ref?clientName(ref):t('filters.unknownClient')}));
  if(family!=='devices')for(const ref of state.saved?.filters[family].values??[])if(!options.some(option=>option.ref===ref))options.push({ref,name:ref===null?t(family==='projects'?'activity.noProject':'filters.unknownClient'):family==='clients'?clientName(ref):ref});
  return <Popover label={t(label)} trigger={<span>{t(label)}</span>} open={open} onOpenChange={setOpen} width={288}>
    <FamilyActions family={family}/>
    {rule&&<div className="filter-family-actions">
      {(['include','exclude'] as const).map(mode=><button key={mode} className="popover-row" aria-pressed={rule.mode===mode} onClick={()=>dataFilters.mode(family,mode)}>{t(mode==='include'?'filters.include':'filters.exclude')}</button>)}
    </div>}
    {facets.loading&&<p className="popover-note">{t('desktop.loading')}</p>}
    {facets.error&&<p className="popover-note" role="status">{t('filters.unavailable')}</p>}
    {(options.length>10||!!search)&&<div className="popover-body"><Field label={t('filters.search')} type="search" value={search} onChange={event=>setSearch(event.target.value)}/></div>}
    <div className="filter-options">{rule&&options.filter(option=>option.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(option=><SwitchRow key={JSON.stringify(option.ref)} on={matchesSelection(rule as Selection<FamilyRef>,option.ref)} onChange={on=>dataFilters.toggle(family,option.ref,on)}>{option.name}</SwitchRow>)}</div>
    {!!state.saved?.unavailable[family]&&<p className="popover-note">{t('filters.unavailableCount',{count:state.saved.unavailable[family]})}</p>}
  </Popover>;
}

function Resources(){
  const [open,setOpen]=useState(()=>{const value=requested;requested=false;return value;}),state=useDataFilters(),sources=useNamed(),board=useBoardId(),funds=usePref('funds');
  const [search,setSearch]=useState('');
  const filters=state.current;
  useEffect(()=>{const show=()=>{requested=false;setOpen(true);};window.addEventListener('quotum:open-filters',show);return()=>window.removeEventListener('quotum:open-filters',show);},[]);
  const wallets=sources.filter(source=>moneyFamily(providerOf(source.provider))==='budget'&&source.budget?.enabled!==false);
  return <Popover label={t('filters.resources')} trigger={<span>{t('filters.resources')}</span>} open={open} onOpenChange={setOpen} width={320}>
    <FamilyActions family="sources"/>
    {(sources.length>10||!!search)&&<div className="popover-body"><Field label={t('filters.search')} type="search" value={search} onChange={event=>setSearch(event.target.value)}/></div>}
    <div className="filter-options">{filters&&sources.filter(source=>(source.title??source.id).toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(source=><div className="popover-section" key={source.id}>
      <SwitchRow on={matchesSource(filters,source.id)} onChange={on=>dataFilters.toggle('sources',{source:source.id},on)}>{source.title}</SwitchRow>
      {quotaPeriods(source).map(window=><SwitchRow key={window.id} on={matchesSelection(filters.windows,[source.id,window.id])} onChange={on=>dataFilters.toggle('windows',[source.id,window.id],on)}>{windowName(window)}</SwitchRow>)}
      {source.budget?.enabled!==false&&moneyFamily(providerOf(source.provider))==='funds'&&<SwitchRow on={matchesSelection(fundsRule(filters,funds.unit??undefined),source.id)} onChange={on=>dataFilters.toggle('funds',source.id,on,funds.unit??undefined)}>{t('money.additionalFunds')}</SwitchRow>}
    </div>)}
    {filters&&(['unknown','notProvided'] as const).map(status=><SwitchRow key={status} on={matchesSelection(filters.sources,{status})} onChange={on=>dataFilters.toggle('sources',{status},on)}>{t(status==='unknown'?'agents.unknownSource':'agents.notProvided')}</SwitchRow>)}
    </div>
    <div className="popover-section"><div className="popover-title">{t('money.data')}</div><FamilyActions family="wallet"/>
      {open&&!!board&&<KeyMoneySettings sources={wallets} hidden={[]} series={[]}/>}</div>
    <div className="popover-section"><div className="popover-title">{t('funds.data')}</div><FamilyActions family="funds"/></div>
    <div className="popover-section"><div className="popover-title">{t('filters.windows')}</div><FamilyActions family="windows"/></div>
    {!!state.conflicts&&<p className="popover-note">{t('filters.conflictCount',{count:state.conflicts})}</p>}
    {!!state.saved&&Object.values(state.saved.unavailable).some(Boolean)&&<p className="popover-note">{t('filters.unavailableCount',{count:Object.values(state.saved.unavailable).reduce((sum,n)=>sum+n,0)})}</p>}
  </Popover>;
}
export function DataFilterControls(){
  const state=useDataFilters(),owner=useRole()==='owner';
  return <div className="data-filter-controls">
    <Resources/>
    <Dimension family="projects" label="filters.projects"/><Dimension family="devices" label="filters.devices"/><Dimension family="clients" label="filters.clients"/>
    <span className="filter-save-actions">
      {owner&&<button className="icon-button" title={t('filters.save')} aria-label={t('filters.save')} aria-busy={state.saving} disabled={!state.saved||state.saving||!state.dirty&&state.saved.revision>0} onClick={()=>void dataFilters.save()}><Save size={16}/></button>}
      <button className="icon-button" title={t('filters.restore')} aria-label={t('filters.restore')} disabled={!state.saved||!state.dirty} onClick={()=>dataFilters.restore()}><RotateCcw size={16}/></button>
    </span>
    <ErrorLine error={state.error}/>
  </div>;
}
