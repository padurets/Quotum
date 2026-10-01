import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ApiError,call} from '../lib/http';
import {useApp,useTitles,page} from '../lib/board';
import type {Session} from '../lib/session';
import type {Credential} from '../../server/store/credentials';
import {stamp} from '../lib/format';
import {t} from '../i18n';
import {PROVIDERS} from '../lib/providers';
import {Modal,Field,ErrorLine} from './Kit';

function SourceKeyForm({replace,local,trustedKeys,onClose,onSaved}:{replace:Credential|null;local:boolean;trustedKeys:Session['trustedKeys'];onClose:()=>void;onSaved:()=>void}) {
  const [secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  const [confirmation,setConfirmation]=useState(false),[consent,setConsent]=useState(false);
  const request=useRef(crypto.randomUUID()),generation=useRef(0);
  const close=useRef(onClose);close.current=onClose;
  const storage=useApp()?.secretKey,available=trustedKeys?.available===true;
  const storageNote=storage?t(storage.outcome==='mismatch'?'trustedKeys.mismatch':`trustedKeys.${storage.state}`):t('trustedKeys.title');
  useEffect(()=>{const changed=()=>close.current();window.addEventListener('popstate',changed);return()=>{generation.current++;window.removeEventListener('popstate',changed);};},[]);
  const save=async(event:FormEvent)=>{
    event.preventDefault();if(!available||busy||confirmation&&!consent)return;
    const own=generation.current;setBusy(true);setError(null);
    try {
      await call('POST',replace?'/api/credentials/'+replace.id:'/api/credentials',{...(replace?{}:{provider:'openrouter',requestId:request.current}),secret,allowNoExpiry:consent},25_000);
      if(generation.current!==own)return;setSecret('');onSaved();
    }catch(failure){
      if(generation.current!==own)return;
      if(failure instanceof ApiError&&failure.code==='credential_expiry_confirmation')setConfirmation(true);else setError(failure);
    }finally{if(generation.current===own)setBusy(false);}
  };
  return <form className="dialog-form" onSubmit={save}>
      <h3>OpenRouter</h3><p className="dialog-text">{t('sources.rights')}</p>
      <p className="dialog-text">{t('sources.expiryAdvice')}</p>
      <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">{t('sources.providerSettings')}</a>
      <p className="drawer-note">{local?storageNote:t('trustedKeys.operator')}</p>
      {!available&&<p className="drawer-note">{t(trustedKeys?.reason==='secret_key_mismatch'?'trustedKeys.serverMismatch':'trustedKeys.serverMissing')}</p>}
      <Field type="password" label={t('sources.key')} value={secret} autoFocus autoComplete="new-password" spellCheck={false} required disabled={!available} data-1p-ignore="" data-lpignore="true" onChange={e=>{setSecret(e.target.value);request.current=crypto.randomUUID();setConfirmation(false);setConsent(false);setError(null);}} />
      {confirmation&&<label className="source-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} />{t('sources.noExpiryConsent')}</label>}
      <ErrorLine error={error} />
      <div className="button-row"><button type="button" className="button" onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!available||busy||!secret||confirmation&&!consent}>{t(replace?'sources.replace':'sources.connect')}</button></div>
    </form>;
}

/** New accounts use the same connection surface as devices; the secret lives in its form. */
export function ConnectSource({userId,local,trustedKeys,onClose}:{userId:string;local:boolean;trustedKeys:Session['trustedKeys'];onClose:()=>void}) {
  return <SourceKeyForm key={userId} replace={null} local={local} trustedKeys={trustedKeys} onClose={onClose} onSaved={onClose}/>;
}

/** Owner records are fetched only while this panel is open or its own access changes. */
export function ConnectedAccounts({userId,local,trustedKeys}:{userId:string;local:boolean;trustedKeys:Session['trustedKeys']}) {
  const [edit,setEdit]=useState<Credential|null>(null),[list,setList]=useState<Credential[]|null>(null),[error,setError]=useState<unknown>(null),[removing,setRemoving]=useState<Credential|null>(null);
  const generation=useRef(0),titles=useTitles();
  const read=async()=>{const own=++generation.current;try{const reply=await call<{credentials:Credential[]}>('GET','/api/credentials');if(generation.current===own)setList(reply.credentials);}catch(failure){if(generation.current===own)setError(failure);}};
  useEffect(()=>{void read();return()=>{generation.current++;};},[userId]);
  useEffect(()=>page.listen(event=>{if(event.type==='hub'&&event.event.type==='sourceAccess')void read();}),[userId]);
  const available=trustedKeys?.available===true;
  const remove=async()=>{if(!removing)return;try{await call('DELETE','/api/credentials/'+removing.id);setRemoving(null);void read();}catch(failure){setError(failure);}};
  return <section className="connect-way">
    <h3>{t('sources.title')}</h3>
    <ErrorLine error={error}/>
    {list?.length===0&&<p className="admin-empty">{t('sources.empty')}</p>}
    {!!list?.length&&<div className="table-wrap"><table className="admin-table"><thead><tr><th>{t('sources.account')}</th><th>{t('sources.expires')}</th><th/></tr></thead><tbody>{list.map(record=><tr key={record.id}>
      <td><b>{record.sourceId&&titles[record.sourceId]?.title||PROVIDERS[record.provider]?.name||record.provider}</b><small>{record.hint?`…${record.hint}`:'—'}</small>{record.lastError&&<ErrorLine error={new ApiError(400,record.lastError)}/>}</td>
      <td>{record.expiresAt===null?t('sources.noExpiry'):stamp(record.expiresAt)}</td>
      <td><div className="button-row"><button type="button" className="link-button" disabled={!available} onClick={()=>setEdit(record)}>{t('sources.replace')}</button><button type="button" className="link-button danger" onClick={()=>setRemoving(record)}>{t('sources.remove')}</button></div></td>
    </tr>)}</tbody></table></div>}
    {edit&&<Modal title={t('sources.replace')} onClose={()=>setEdit(null)}><SourceKeyForm key={userId} replace={edit} local={local} trustedKeys={trustedKeys} onClose={()=>setEdit(null)} onSaved={()=>{setEdit(null);void read();}}/></Modal>}
    {removing&&<Modal title={t('sources.remove')} onClose={()=>setRemoving(null)}><p className="dialog-text">{t('sources.removeText')}</p><div className="button-row"><button className="button" onClick={()=>setRemoving(null)}>{t('common.cancel')}</button><button className="button danger" onClick={()=>void remove()}>{t('sources.remove')}</button></div></Modal>}
  </section>;
}
