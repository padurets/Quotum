import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ApiError,call} from '../lib/http';
import {useTitles,page} from '../lib/board';
import type {Session} from '../lib/session';
import type {Credential} from '../../server/store/credentials';
import {stamp} from '../lib/format';
import {t} from '../i18n';
import {PROVIDERS} from '../lib/providers';
import {Modal,ErrorLine} from './Kit';
import {Popover} from './Popover';
import {logoOf} from './logos';


/** Devices and provider accounts have the same row, with their own status and actions. */
export function ConnectionRow({name,icon,detail,status,actions}:{name:string;icon:ReactNode;detail:ReactNode;status:ReactNode;actions:ReactNode}) {
  return <li className="popover-row connection-row">
    <span className="connection-icon">{icon}</span>
    <div className="connection-name"><b title={name}>{name}</b><small>{detail}</small><div className="connection-mobile-status">{status}</div></div>
    <div className="connection-status">{status}</div>
    <Popover label={t('connections.actions',{name})} up width={250} icon={<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="3" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="13" cy="8" r="1"/></svg>}>{actions}</Popover>
  </li>;
}

/** Owner records are fetched only while this panel is open or its own access changes. */
export function ConnectedAccounts({userId,trustedKeys,onReplace}:{userId:string;trustedKeys:Session['trustedKeys'];onReplace:(record:Credential)=>void}) {
  const [list,setList]=useState<Credential[]|null>(null),[error,setError]=useState<unknown>(null),[removing,setRemoving]=useState<Credential|null>(null);
  const generation=useRef(0),titles=useTitles();
  const read=async()=>{const own=++generation.current;try{const reply=await call<{credentials:Credential[]}>('GET','/api/credentials');if(generation.current===own){setList(reply.credentials);setError(null);}}catch(failure){if(generation.current===own)setError(failure);}};
  useEffect(()=>{void read();return()=>{generation.current++;};},[userId]);
  useEffect(()=>page.listen(event=>{if(event.type==='hub'&&event.event.type==='sourceAccess')void read();}),[userId]);
  const available=trustedKeys?.available===true;
  const remove=async()=>{if(!removing)return;try{await call('DELETE','/api/credentials/'+removing.id);setRemoving(null);void read();}catch(failure){setError(failure);}};
  return <>
    {error&&<li><ErrorLine error={error}/></li>}
    {list?.length===0&&<li className="admin-empty">{t('sources.empty')}</li>}
    {list?.map(record=><ConnectionRow key={record.id}
      name={record.sourceId&&titles[record.sourceId]?.title||PROVIDERS[record.provider]?.name||record.provider}
      icon={<img src={logoOf(record.provider)} alt=""/>}
      detail={<>{t('sources.account')}{record.hint&&<span className="connection-detail">…{record.hint}</span>}</>}
      status={record.lastError?<ErrorLine error={new ApiError(400,record.lastError)}/>:<span>{record.expiresAt===null?t('sources.noExpiry'):t('connections.expires',{time:stamp(record.expiresAt)})}</span>}
      actions={<><button type="button" className="popover-row" disabled={!available} onClick={()=>onReplace(record)}><span>{t('sources.replace')}</span></button><button type="button" className="popover-row danger" onClick={()=>setRemoving(record)}><span>{t('sources.remove')}</span></button></>}
    />)}
    {removing&&<Modal title={t('sources.remove')} onClose={()=>setRemoving(null)}><p className="dialog-text">{t('sources.removeText')}</p><div className="button-row"><button className="button" onClick={()=>setRemoving(null)}>{t('common.cancel')}</button><button className="button danger" onClick={()=>void remove()}>{t('sources.remove')}</button></div></Modal>}
  </>;
}
