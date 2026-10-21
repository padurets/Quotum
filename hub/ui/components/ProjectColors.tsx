import {useEffect,useLayoutEffect,useId,useRef,useState,type FormEvent} from 'react';
import {CATEGORY_COLORS,type CategoryColor} from '../../server/domain/categoryColors';
import type {ProjectColorEnvelope} from '../../server/domain/projectColors';
import {projectColorReply} from '../lib/projectColors';
import {page,useProjectColorEnvelope,useProjectColorGeneration,useWorkAuthority} from '../lib/board';
import {ApiError,call} from '../lib/http';
import type {Board} from '../lib/session';
import {t,type Key} from '../i18n';
import {ErrorLine,Field,Modal} from './Kit';
import {Popover} from './Popover';

const COLOR_NAMES:Key[]=['projectColors.red','projectColors.orange','projectColors.yellow','projectColors.green','projectColors.teal','projectColors.cyan','projectColors.blue','projectColors.deepBlue','projectColors.purple'];
const colorName=(color:CategoryColor|null)=>color===null?t('projectColors.auto'):t(COLOR_NAMES[CATEGORY_COLORS.indexOf(color)]);
type Choices={projects:string[];authority:string;nextCursor?:string};

function Picker({project,color,disabled,save}:{project:string;color:CategoryColor|null;disabled:boolean;save:(color:CategoryColor|null)=>Promise<void>}) {
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(color),[error,setError]=useState<unknown>(null),[busy,setBusy]=useState(false);
  const radio=useId();
  const change=(next:boolean)=>{if(next){setDraft(color);setError(null);}setOpen(next);};
  const submit=async(event:FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError(null);
    try{await save(draft);setOpen(false);}catch(failure){setError(failure);}finally{setBusy(false);}
  };
  return <Popover label={t('projectColors.choose',{project,color:colorName(color)})} trigger={<><i className="activity-swatch" style={{background:color??'transparent'}}/>{colorName(color)}</>} triggerClass="button project-color-trigger" buttonProps={{disabled}} width={290} open={open} onOpenChange={change}>
    <form onSubmit={submit}>
      <fieldset className="project-color-options" disabled={busy}>
        <legend className="popover-title">{t('projectColors.chooseFor',{project})}</legend>
        {[null,...CATEGORY_COLORS].map(value=><label className="popover-row" key={value??'auto'}>
          <input type="radio" name={radio} value={value??'auto'} checked={draft===value} onChange={()=>setDraft(value)} aria-label={t('projectColors.choose',{project,color:colorName(value)})}/>
          <i className="activity-swatch" style={{background:value??'transparent'}}/><span>{colorName(value)}</span>
        </label>)}
      </fieldset>
      <div className="popover-pad"><ErrorLine error={error}/><div className="button-row">
        <button type="button" className="button" onClick={()=>change(false)}>{t('common.cancel')}</button>
        <button className="button" disabled={busy||disabled}>{t('account.save')}</button>
      </div></div>
    </form>
  </Popover>;
}

/** Settings reads the admitted catalogue only while open; saved paint remains in the board's metadata slice. */
export function ProjectColors({board}:{board:Board}) {
  const saved=useProjectColorEnvelope(),generation=useProjectColorGeneration(),workAuthority=useWorkAuthority();
  const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[index,setIndex]=useState(0);
  const [listing,setListing]=useState<{choices:Choices;access:string;query:string;index:number;revision:number}|null>(null),[error,setError]=useState<unknown>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
  const [reset,setReset]=useState<{saved:ProjectColorEnvelope;conflict:boolean;access:string}|null>(null);
  const heading=useRef<HTMLHeadingElement>(null),writes=useRef(false),scope=useRef(0),pending=useRef<AbortController|null>(null);
  const pages=useRef<{authority:string|undefined;query:string;cursors:(string|undefined)[]}>({authority:undefined,query:'',cursors:[undefined]});
  const owner=board.role==='owner',url='/api/boards/'+encodeURIComponent(board.id)+'/project-colors';
  const authority=saved?.authority,access=JSON.stringify([board.id,owner,generation,workAuthority]);
  const choices=listing&&listing.access===access&&listing.query===query&&listing.index===index&&
    (listing.choices.authority===authority||listing.revision!==saved?.revision)?listing.choices:null;
  useLayoutEffect(()=>{
    scope.current++;setListing(null);setReset(null);setError(null);setBusy(false);writes.current=false;setIndex(0);
    return()=>{scope.current++;pending.current?.abort();};
  },[access]);
  useEffect(()=>{
    if(!saved)return;
    const current=scope.current,controller=new AbortController();setLoading(true);
    const fetchPage=async()=>{
      const cache=pages.current.authority===authority&&pages.current.query===query?pages.current:{authority,query,cursors:[undefined] as (string|undefined)[]};
      let answer:Choices|undefined;
      for(let at=cache.cursors[index]===undefined?0:index;at<=index;at++){
        const params=new URLSearchParams({query});if(cache.cursors[at])params.set('cursor',cache.cursors[at]!);
        answer=await call<Choices>('GET',url+'/choices?'+params,undefined,12000,controller.signal);
        if(controller.signal.aborted||current!==scope.current||answer.authority!==page.get().board?.projectColors?.authority)return;
        cache.cursors[at+1]=answer.nextCursor;
        if(at<index&&!answer.nextCursor){setIndex(at);break;}
      }
      if(answer&&!controller.signal.aborted&&current===scope.current){pages.current=cache;setListing({choices:answer,access,query,index,revision:saved.revision});}
    };
    void fetchPage().catch(failure=>{
      if(!controller.signal.aborted&&current===scope.current){setError(failure);if(failure instanceof ApiError&&failure.status===409){pages.current={authority:undefined,query:'',cursors:[undefined]};setIndex(0);}}
    }).finally(()=>{if(!controller.signal.aborted&&current===scope.current)setLoading(false);});
    return()=>controller.abort();
  },[url,authority,query,index,access]);

  const adopt=(value:unknown,expected:ProjectColorEnvelope,current:number)=>{
    const colors=projectColorReply(value);
    if(!colors||scope.current!==current)return;
    page.dispatch({type:'project-colors-response',board:board.id,generation,workAuthority,expected,colors});
  };
  const change=async(color:CategoryColor|null,project:string)=>{
    if(!saved||!owner||writes.current)return;
    const current=scope.current,expected=saved,controller=new AbortController();pending.current=controller;writes.current=true;setBusy(true);setError(null);
    try{
      const answer=await call<ProjectColorEnvelope>('PUT',url,{version:1,authority:expected.authority,project,color},12000,controller.signal,{'If-Match':'"'+expected.revision+'"'});
      adopt(answer,expected,current);
    }catch(failure){
      if(current===scope.current){if(failure instanceof ApiError)adopt(failure.data,expected,current);setError(failure);throw failure;}
    }finally{if(current===scope.current){writes.current=false;setBusy(false);}}
  };
  const confirm=async()=>{
    if(!reset||reset.conflict||writes.current)return;
    const current=scope.current,expected=reset.saved,controller=new AbortController();pending.current=controller;writes.current=true;setBusy(true);setError(null);
    try{
      const answer=await call<ProjectColorEnvelope>('POST',url+'/reset',{version:1,authority:expected.authority},12000,controller.signal,{'If-Match':'"'+expected.revision+'"'});
      adopt(answer,expected,current);if(current===scope.current)setReset(null);
    }catch(failure){
      if(current===scope.current){if(failure instanceof ApiError)adopt(failure.data,expected,current);setError(failure);if(failure instanceof ApiError&&failure.status===409)setReset({...reset,conflict:true});}
    }finally{if(current===scope.current){writes.current=false;setBusy(false);}}
  };
  const submit=(event:FormEvent)=>{event.preventDefault();setQuery(search);pages.current={authority:undefined,query:'',cursors:[undefined]};setIndex(0);setError(null);};
  const next=()=>{if(choices?.nextCursor)setIndex(index+1);};
  const pins=new Map(saved?.pins??[]);
  return <section className="settings-section">
    <h2 ref={heading} tabIndex={-1}>{t('projectColors.title')}</h2>
    <p className="dialog-text">{t('projectColors.description')}</p>
    {!owner&&<p className="dialog-text">{t('projectColors.readOnly')}</p>}
    <form className="project-colors-search" onSubmit={submit}>
      <Field label={t('projectColors.search')} value={search} maxLength={240} onChange={event=>setSearch([...event.target.value].slice(0,120).join(''))}/>
      <button className="button" disabled={loading}>{t('projectColors.find')}</button>
    </form>
    <ErrorLine error={error}/>
    {loading&&!choices?<p role="status">{t('projectColors.loading')}</p>:choices?.projects.length===0?<p className="dialog-text">{t('projectColors.empty')}</p>:null}
    <ul className="settings-list project-colors-list">
      {choices?.projects.map(project=><li className="settings-list-row popover-row" key={project}>
        <span className="settings-item-main" title={project}>{project}</span>
        {owner?<Picker project={project} color={pins.get(project)??null} disabled={busy} save={color=>change(color,project)}/>:<span className="project-color-trigger"><i className="activity-swatch" style={{background:pins.get(project)??'transparent'}}/>{colorName(pins.get(project)??null)}</span>}
      </li>)}
    </ul>
    <div className="table-pages project-colors-pages" aria-label={t('projectColors.pages')}>
      <button className="button" disabled={loading||index===0} onClick={()=>setIndex(index-1)}>{t('projectColors.previous')}</button>
      <span>{t('projectColors.page',{page:index+1})}</span>
      <button className="button" disabled={loading||!choices?.nextCursor} onClick={next}>{t('projectColors.next')}</button>
    </div>
    {owner&&<div className="button-row is-start"><button className="button danger" disabled={!saved||busy} onClick={()=>{setError(null);setReset({saved:saved!,conflict:false,access});}}>{t('projectColors.reset')}</button></div>}
    {owner&&reset&&reset.access===access&&<Modal title={t('projectColors.reset')} onClose={()=>setReset(null)} restore={()=>heading.current}>
      <p className="dialog-text">{t('projectColors.resetText')}</p>
      <ErrorLine error={error}/>
      <div className="button-row">
        <button className="button" autoFocus onClick={()=>setReset(null)}>{t('common.cancel')}</button>
        <button className="button danger" disabled={busy||reset.conflict} onClick={()=>void confirm()}>{t('projectColors.reset')}</button>
      </div>
    </Modal>}
  </section>;
}
