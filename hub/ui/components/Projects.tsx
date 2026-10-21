import {useCallback,useEffect,useLayoutEffect,useId,useRef,useState,type FormEvent} from 'react';
import {merging,renaming,restoring,shown,timeless,type ProjectGroup,type Projects as ProjectList} from '../lib/projects';
import {ApiError,call} from '../lib/http';
import {page,useProjectColorEnvelope,useProjectColorGeneration,useWorkAuthority} from '../lib/board';
import {projectColorReply} from '../lib/projectColors';
import {CATEGORY_COLORS,type CategoryColor} from '../../server/domain/categoryColors';
import type {ProjectColorEnvelope} from '../../server/domain/projectColors';
import {boardTitle,type Board} from '../lib/session';
import {Pencil} from 'lucide-react';
import {stamp} from '../lib/format';
import {t,type Key} from '../i18n';
import {Modal,ErrorLine,Field} from './Kit';
import {Popover} from './Popover';
import {Ago} from './Time';

/**
 * The projects of the reader's machines, with the machines and when they last worked, which
 * the reader renames, merges and gives back their own names; every change applies to all
 * the time kept. The rules are in ui/lib/projects.ts.
 */
export function Projects({board=null}:{board?:Board|null}) {
  const saved=useProjectColorEnvelope(),generation=useProjectColorGeneration(),workAuthority=useWorkAuthority();
  const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[index,setIndex]=useState(0);
  const access=JSON.stringify([board?.id,board?.role,generation,workAuthority]);
  const currentAccess=useRef(access);currentAccess.current=access;
  const cursors=useRef<(string|undefined)[]>([undefined]),pending=useRef<AbortController|null>(null);
  const cursorAuthority=useRef<string|undefined>(undefined);
  const writes=useRef(false);
  const chosenRows=useRef(new Map<string,ProjectGroup>()),focusAfterSave=useRef<{board:string|undefined;name:string}|null>(null);
  const [loadedAccess,setLoadedAccess]=useState(access),[busy,setBusy]=useState(false);
  const [list, setList] = useState<ProjectList | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [merge, setMerge] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The row a rename led to, chosen in the list that came after it: the keyboard goes there,
  // each time anew (a new number), though it was the same row the time before.
  const [landing, setLanding] = useState<{name: string; n: number} | null>(null);
  const load=useCallback(async()=>{
    const controller=new AbortController();pending.current?.abort();pending.current=controller;
    try{
      if(cursorAuthority.current!==saved?.authority){cursors.current=[undefined];cursorAuthority.current=saved?.authority;}
      let answer:ProjectList|undefined;
      for(let at=board&&index>0&&!cursors.current[index]?0:index;at<=index;at++){
        const params=new URLSearchParams();if(board){params.set('board',board.id);params.set('query',query);if(cursors.current[at])params.set('cursor',cursors.current[at]!);}
        answer=await call<ProjectList>('GET','/api/projects'+(params.size?'?'+params:''),undefined,12000,controller.signal);
        if(controller.signal.aborted||currentAccess.current!==access)return null;
        if(board&&answer.authority!==page.get().board?.projectColors?.authority)return null;
        cursors.current[at+1]=answer.nextCursor;
        if(at<index&&!answer.nextCursor){setIndex(at);return null;}
      }
      setLoadedAccess(access);setList(answer!);return answer!;
    }catch(failure){if(!controller.signal.aborted&&currentAccess.current===access){setError(failure);if(failure instanceof ApiError&&failure.status===409){cursors.current=[undefined];setIndex(0);}}return null;}
  },[board?.id,query,index,access,saved?.authority]);
  useEffect(()=>{setList(null);setSelected([]);chosenRows.current.clear();setError(null);cursors.current=[undefined];setIndex(0);},[access,query]);
  useEffect(()=>{void load();return()=>pending.current?.abort();},[load]);
  useEffect(()=>{
    const target=focusAfterSave.current;
    if(!busy&&target&&target.board===board?.id&&loadedAccess===access&&list?.projects.some(row=>row.name===target.name)){
      focusAfterSave.current=null;setLanding(before=>({name:target.name,n:(before?.n??0)+1}));
    }
  },[list,busy,access,loadedAccess,board?.id]);

  /** A change, then the list anew (another tab may have changed it too), which it gives back. */
  const change = async (url: string, body: object) => {
    setError(null);
    setLanding(null);
    let answer: ProjectList | null = null;
    try {
      await call('POST', url, body);
    } finally {
      setMerge(false);
      setSelected([]);chosenRows.current.clear();
      answer = await load();
    }
    return answer;
  };
  const edit=async(group:ProjectGroup,name:string,color:CategoryColor|null)=>{
    if(writes.current)return;writes.current=true;setBusy(true);setError(null);setLanding(null);
    const expected=saved,where=access;
    const target=name===group.name?name:name.trim(),rename=target!==group.name,changedColor=color!==(new Map(saved?.pins??[]).get(group.name!)??null);
    try{
      if(board&&board.role==='owner'&&group.colorAllowed&&expected&&(rename||changedColor)){
        const answer=await call('PUT','/api/boards/'+board.id+'/project-colors',{version:1,authority:expected.authority,project:group.name,...(rename?{name:target}:{}),...(changedColor?{color}:{})},12000,undefined,{'If-Match':'"'+expected.revision+'"'});
        const colors=projectColorReply(answer);if(colors&&currentAccess.current===where)page.dispatch({type:'project-colors-response',board:board.id,generation,workAuthority,expected,colors});
      }else if(rename)await call('POST','/api/projects',renaming(group,target));
      if(page.get().board?.id===board?.id)focusAfterSave.current={board:board?.id,name:target};
      const answer=await load();
      if(answer?.projects.some(row=>row.name===target))setLanding(before=>({name:target,n:(before?.n??0)+1}));
    }catch(failure){
      if(currentAccess.current===where&&failure instanceof ApiError&&board&&expected){const colors=projectColorReply(failure.data);if(colors)page.dispatch({type:'project-colors-response',board:board.id,generation,workAuthority,expected,colors});}
      throw failure;
    }finally{writes.current=false;setBusy(false);}
  };
  const failing = (url: string, body: object) => change(url, body).catch(setError);

  const visible=list&&loadedAccess===access?list:null;
  if (!visible) return <ErrorLine error={error} />;

  const chosen = selected.flatMap(name=>chosenRows.current.get(name)??[]);
  const pins=new Map(saved?.pins??[]);
  const submit=(event:FormEvent)=>{event.preventDefault();cursors.current=[undefined];setIndex(0);setQuery(search);};
  const toggle = (group: ProjectGroup, on: boolean) => {
    if(on)chosenRows.current.set(group.name!,group);else chosenRows.current.delete(group.name!);
    const next = on ? [...selected, group.name!] : selected.filter(name => name !== group.name);
    setSelected(next);
    // The menu goes with its button; chosen again later, it waits to be opened.
    if (next.length < 2) setMerge(false);
  };
  return (
    <>
      <p className="dialog-text">{t('projects.caption', {days: visible.keptDays})}</p>
      <ErrorLine error={error} />
      {board&&<form className="project-search" onSubmit={submit}><input aria-label={t('projectColors.search')} placeholder={t('projectColors.search')} value={search} maxLength={240} onChange={event=>setSearch([...event.target.value].slice(0,120).join(''))}/><button className="button">{t('projectColors.find')}</button></form>}
      {!visible.projects.length&&<p className="admin-empty">{t('projects.empty')}</p>}
      <div className="table-wrap">
        <table className="admin-table projects-table">
          <thead>
            <tr>
              <th />
              <th>{t('projects.project')}</th>
              <th>{t('projects.machines')}</th>
              <th>{t('projects.last')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.projects.map(group => {
              const from = shown(group);
              const unknown = timeless(group);
              return (
                <tr key={group.name ?? ''}>
                  <td>
                    {group.name !== null && group.canRename!==false && (
                      <input
                        type="checkbox"
                        aria-label={t('projects.select', {name: group.name})}
                        checked={selected.includes(group.name)}
                        onChange={event => toggle(group, event.target.checked)}
                      />
                    )}
                  </td>
                  <td>
                    {group.name === null ? (
                      <span className="project-none">{t('projects.none')}</span>
                    ) : (
                      <ProjectEditor
                        project={group}
                        board={board}
                        color={pins.get(group.name)??null}
                        canColor={board?.role==='owner'&&!!group.colorAllowed}
                        disabled={busy}
                        focus={landing?.name === group.name ? landing.n : 0}
                        save={(name,color) => edit(group,name,color)}
                      />
                    )}
                    {from.length > 0 && (
                      <small className="project-froms">
                        <span>{t('projects.from')}</span>
                        {from.map(name => (
                          <span key={name} className="project-from">
                            <span title={name}>{name}</span>
                            <button
                              type="button"
                              className="link-button"
                              aria-label={t('projects.restore', {name})}
                              title={t('projects.restore', {name})}
                              onClick={() => failing('/api/projects/restore', restoring(name))}
                            >
                              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                                <path d="M4 4l8 8M12 4l-8 8" />
                              </svg>
                            </button>
                          </span>
                        ))}
                      </small>
                    )}
                  </td>
                  <td>{group.machines.map(machine => machine.name).join(', ') || '—'}</td>
                  <td title={unknown || !group.lastAt ? undefined : stamp(group.lastAt)}>{unknown ? '—' : <Ago at={group.lastAt} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {board&&<div className="table-pages project-pages" aria-label={t('projectColors.pages')}>
        <button className="button" disabled={index===0||busy} onClick={()=>setIndex(index-1)}>{t('projectColors.previous')}</button><span>{t('projectColors.page',{page:index+1})}</span><button className="button" disabled={!visible.nextCursor||busy} onClick={()=>setIndex(index+1)}>{t('projectColors.next')}</button>
      </div>}
      {board&&<ResetProjectColors board={board}/>}
      {chosen.length >= 2 && (
        <div className="projects-bar">
          <Popover label={t('projects.merge')} trigger={t('projects.merge')} triggerClass="button" align="left" up open={merge} onOpenChange={setMerge}>
            <div className="popover-title">{t('projects.mergeInto')}</div>
            {chosen.map(target => (
              <button key={target.name} type="button" className="popover-row" title={target.name!} onClick={() => failing('/api/projects', merging(chosen, target))}>
                <span>{target.name}</span>
              </button>
            ))}
          </Popover>
        </div>
      )}
    </>
  );
}

export function ProjectsDialog({onClose}:{onClose:()=>void}) {
  return <Modal title={t('admin.projects')} onClose={onClose} wide><div className="dialog-body"><Projects/></div></Modal>;
}

const COLOR_NAMES:Key[]=['projectColors.red','projectColors.orange','projectColors.yellow','projectColors.green','projectColors.teal','projectColors.cyan','projectColors.blue','projectColors.deepBlue','projectColors.purple'];
const colorName=(color:CategoryColor|null)=>color===null?t('projectColors.auto'):t(COLOR_NAMES[CATEGORY_COLORS.indexOf(color)]);

export function ProjectEditor({project,color,board,canColor,disabled,focus=0,save}:{project:ProjectGroup;color:CategoryColor|null;board:Board|null;canColor:boolean;disabled:boolean;focus?:number;save:(name:string,color:CategoryColor|null)=>Promise<void>}) {
  const [open,setOpen]=useState(false),[name,setName]=useState(project.name!),[draft,setDraft]=useState(color),[error,setError]=useState<unknown>(null),[busy,setBusy]=useState(false);
  const root=useRef<HTMLSpanElement>(null),landing=useRef(false),visible=useRef(open);visible.current=open;
  const radio=useId();
  useLayoutEffect(()=>{if(!open&&!busy&&!disabled&&landing.current){landing.current=false;root.current?.querySelector('button')?.focus({preventScroll:true});}},[open,busy,disabled]);
  useEffect(()=>{if(focus)root.current?.querySelector('button')?.focus({preventScroll:true});},[focus]);
  const change=(next:boolean)=>{if(next){setName(project.name!);setDraft(color);setError(null);}setOpen(next);};
  const submit=async(event:FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError(null);
    try{await save(name,draft);landing.current=visible.current;setOpen(false);}catch(failure){setError(failure);}finally{setBusy(false);}
  };
  return <span ref={root} className="project-editor"><Popover label={t('projects.edit',{name:project.name!})} trigger={<>{color&&<i className="activity-swatch" style={{background:color}}/>}<b>{project.name}</b><Pencil size={13} aria-hidden="true"/></>} triggerClass="text-button project-edit-trigger" buttonProps={{disabled}} width={320} align="left" portal={root.current?.closest<HTMLElement>('.dialog,.settings-content')} open={open} onOpenChange={change}>
    <form onSubmit={submit}>
      <div className="popover-pad"><Field label={t('projects.nameLabel')} value={name} maxLength={240} required disabled={busy} readOnly={project.canRename===false} onChange={event=>setName([...event.target.value].slice(0,120).join(''))}/>
        {project.canRename===false&&<p className="dialog-text">{t('projects.nameReadOnly')}</p>}
      </div>
      {board&&<fieldset className="project-color-options" disabled={busy||!canColor}>
        <legend className="popover-title">{t('projects.colourOn',{board:boardTitle(board)})}</legend>
        {[null,...CATEGORY_COLORS].map(value=><label className="popover-row project-color-option" key={value??'auto'} title={colorName(value)}>
          <input type="radio" name={radio} value={value??'auto'} checked={draft===value} onChange={()=>setDraft(value)} aria-label={colorName(value)}/>
          {value===null?<span>{colorName(value)}</span>:<i className="activity-swatch" style={{background:value}}/>}
        </label>)}
      </fieldset>}
      {board&&!canColor&&<p className="popover-pad dialog-text">{t(board.role==='owner'?'projects.colourUnavailable':'projectColors.readOnly')}</p>}
      <div className="popover-pad"><ErrorLine error={error}/><div className="button-row">
        <button type="button" className="button" onClick={()=>change(false)}>{t('common.cancel')}</button>
        <button className="button" disabled={busy||disabled||!name.trim()||project.canRename===false&&!canColor}>{t('account.save')}</button>
      </div></div>
    </form>
  </Popover></span>;
}

export function ResetProjectColors({board}:{board:Board}) {
  const saved=useProjectColorEnvelope(),generation=useProjectColorGeneration(),workAuthority=useWorkAuthority();
  const [reset,setReset]=useState<{saved:ProjectColorEnvelope;conflict:boolean}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  const trigger=useRef<HTMLButtonElement>(null),scope=useRef(0);
  useEffect(()=>{scope.current++;setReset(null);setError(null);setBusy(false);return()=>{scope.current++;};},[board.id,board.role,generation,workAuthority]);
  const confirm=async()=>{
    if(!reset||reset.conflict||busy)return;
    const current=scope.current,expected=reset.saved;setBusy(true);setError(null);
    const adopt=(value:unknown)=>{const colors=projectColorReply(value);if(colors&&scope.current===current)page.dispatch({type:'project-colors-response',board:board.id,generation,workAuthority,expected,colors});};
    try{
      const answer=await call<ProjectColorEnvelope>('POST','/api/boards/'+board.id+'/project-colors/reset',{version:1,authority:expected.authority},12000,undefined,{'If-Match':'"'+expected.revision+'"'});
      adopt(answer);if(scope.current===current)setReset(null);
    }catch(failure){if(scope.current===current){if(failure instanceof ApiError)adopt(failure.data);setError(failure);if(failure instanceof ApiError&&failure.status===409)setReset({...reset,conflict:true});}}
    finally{if(scope.current===current)setBusy(false);}
  };
  return board.role==='owner'?<>
    <div className="button-row is-start"><button ref={trigger} className="button danger" disabled={!saved||busy} onClick={()=>{setError(null);setReset({saved:saved!,conflict:false});}}>{t('projectColors.reset')}</button></div>
    {reset&&<Modal title={t('projectColors.reset')} onClose={()=>setReset(null)} restore={()=>trigger.current}>
      <p className="dialog-text">{t('projectColors.resetText')}</p><ErrorLine error={error}/>
      <div className="button-row"><button className="button" autoFocus onClick={()=>setReset(null)}>{t('common.cancel')}</button><button className="button danger" disabled={busy||reset.conflict} onClick={()=>void confirm()}>{t('projectColors.reset')}</button></div>
    </Modal>}
  </>:null;
}
