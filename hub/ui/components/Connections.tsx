import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {ApiError,call} from '../lib/http';
import {useApp,useTitles,page} from '../lib/board';
import type {Session} from '../lib/session';
import type {Credential} from '../../server/store/credentials';
import {stamp} from '../lib/format';
import {t} from '../i18n';
import {PROVIDERS} from '../lib/providers';
import {Modal,Field,ErrorLine} from './Kit';
import {Popover} from './Popover';
import {logoOf} from './logos';

function SourceKeyForm({provider,replace,local,trustedKeys,onClose,onSaved}:{provider:string;replace:Credential|null;local:boolean;trustedKeys:Session['trustedKeys'];onClose:()=>void;onSaved:()=>void}) {
  const [secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  const [confirmation,setConfirmation]=useState(false),[consent,setConsent]=useState(false);
  const [sameAccount,setSameAccount]=useState(false);
  const declared=provider==='zai';
  const request=useRef(crypto.randomUUID()),generation=useRef(0);
  const close=useRef(onClose);close.current=onClose;
  const storage=useApp()?.secretKey,available=trustedKeys?.available===true;
  const storageNote=storage?t(storage.outcome==='mismatch'?'trustedKeys.mismatch':`trustedKeys.${storage.state}`):t('trustedKeys.title');
  useEffect(()=>{const changed=()=>close.current();window.addEventListener('popstate',changed);return()=>{generation.current++;window.removeEventListener('popstate',changed);};},[]);
  const save=async(event:FormEvent)=>{
    event.preventDefault();if(!available||busy||confirmation&&!consent||declared&&replace&&!sameAccount)return;
    const own=generation.current;setBusy(true);setError(null);
    try {
      await call('POST',replace?'/api/credentials/'+replace.id:'/api/credentials',{...(replace?{}:{provider,requestId:request.current}),secret,...(declared?{allowUnknownExpiry:consent,...(replace?{sameAccount}:{})}:{allowNoExpiry:consent})},25_000);
      if(generation.current!==own)return;setSecret('');onSaved();
    }catch(failure){
      if(generation.current!==own)return;
      if(failure instanceof ApiError&&failure.code==='credential_expiry_confirmation')setConfirmation(true);else setError(failure);
    }finally{if(generation.current===own)setBusy(false);}
  };
  return <form className="dialog-form" onSubmit={save}>
      <p className="dialog-text">{t(declared?'sources.zaiRights':'sources.rights')}</p>
      <p className="dialog-text">{t(declared?'sources.zaiAdvice':'sources.expiryAdvice')}</p>
      <a href={declared?"https://z.ai/manage-apikey/apikey-list":"https://openrouter.ai/settings/keys"} target="_blank" rel="noreferrer">{t(declared?'sources.zaiSettings':'sources.providerSettings')}</a>
      <p className="drawer-note">{local?storageNote:t('trustedKeys.operator')}</p>
      {!available&&<p className="drawer-note">{t(trustedKeys?.reason==='secret_key_mismatch'?'trustedKeys.serverMismatch':'trustedKeys.serverMissing')}</p>}
      <Field type="password" label={t(declared?'sources.apiKey':'sources.key')} value={secret} autoFocus autoComplete="new-password" spellCheck={false} required disabled={!available} data-1p-ignore="" data-lpignore="true" onChange={e=>{setSecret(e.target.value);request.current=crypto.randomUUID();setConfirmation(false);setConsent(false);setError(null);}} />
      {declared&&replace&&<><p className="drawer-note">{t('sources.declaredAccount')}</p><label className="source-consent"><input type="checkbox" checked={sameAccount} onChange={e=>setSameAccount(e.target.checked)}/>{t('sources.sameAccountConsent')}</label><p className="drawer-note">{t('sources.otherAccount')}</p></>}
      {confirmation&&<label className="source-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} />{t(declared?'sources.unknownExpiryConsent':'sources.noExpiryConsent')}</label>}
      <ErrorLine error={error} />
      <div className="button-row"><button type="button" className="button" onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!available||busy||!secret||confirmation&&!consent||declared&&!!replace&&!sameAccount}>{t(replace?'sources.replace':declared?'sources.connectZai':'sources.connect')}</button></div>
    </form>;
}

/** New accounts use the same connection surface as devices; the secret lives in its form. */
export function ConnectSource({provider='openrouter',userId,local,trustedKeys,onClose,replace=null}:{provider?:string;userId:string;local:boolean;trustedKeys:Session['trustedKeys'];onClose:()=>void;replace?:Credential|null}) {
  return <SourceKeyForm key={userId+provider} provider={provider} replace={replace} local={local} trustedKeys={trustedKeys} onClose={onClose} onSaved={onClose}/>;
}

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
      status={record.lastError?<ErrorLine error={new ApiError(400,record.lastError)}/>:<span>{record.expiryKind==='unknown'?t('sources.unknownExpiry'):record.expiresAt===null?t('sources.noExpiry'):t('connections.expires',{time:stamp(record.expiresAt)})}</span>}
      actions={<><button type="button" className="popover-row" disabled={!available} onClick={()=>onReplace(record)}><span>{t('sources.replace')}</span></button><button type="button" className="popover-row danger" onClick={()=>setRemoving(record)}><span>{t('sources.remove')}</span></button></>}
    />)}
    {removing&&<Modal title={t('sources.remove')} onClose={()=>setRemoving(null)}><p className="dialog-text">{t('sources.removeTextGeneric')}</p><div className="button-row"><button className="button" onClick={()=>setRemoving(null)}>{t('common.cancel')}</button><button className="button danger" onClick={()=>void remove()}>{t('sources.remove')}</button></div></Modal>}
  </>;
}
