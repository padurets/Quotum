import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ApiError,call} from '../lib/http';
import {useApp,page} from '../lib/board';
import type {Session} from '../lib/session';
import type {Credential} from '../../server/store/credentials';
import {stamp} from '../lib/format';
import {t} from '../i18n';
import {Modal,Field,ErrorLine} from './Kit';

function Connect({replace,local,storageNote,onClose,onSaved}:{replace:Credential|null;local:boolean;storageNote:string;onClose:()=>void;onSaved:()=>void}) {
  const [secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  const [confirmation,setConfirmation]=useState(false),[consent,setConsent]=useState(false);
  const request=useRef(crypto.randomUUID()),generation=useRef(0);
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const changed=()=>close.current();window.addEventListener('popstate',changed);return()=>{generation.current++;window.removeEventListener('popstate',changed);};},[]);
  const save=async(event:FormEvent)=>{
    event.preventDefault();if(busy||confirmation&&!consent)return;
    const own=generation.current;setBusy(true);setError(null);
    try {
      await call('POST',replace?'/api/credentials/'+replace.id:'/api/credentials',{...(replace?{}:{provider:'openrouter',requestId:request.current}),secret,allowNoExpiry:consent},25_000);
      if(generation.current!==own)return;setSecret('');onSaved();onClose();
    }catch(failure){
      if(generation.current!==own)return;
      if(failure instanceof ApiError&&failure.code==='credential_expiry_confirmation')setConfirmation(true);else setError(failure);
    }finally{if(generation.current===own)setBusy(false);}
  };
  return <Modal title={t(replace?'sources.replace':'sources.connect')} onClose={onClose}>
    <form className="dialog-form" onSubmit={save}>
      <h3>OpenRouter</h3><p className="dialog-text">{t('sources.rights')}</p>
      <p className="dialog-text">{t('sources.expiryAdvice')}</p>
      <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">{t('sources.providerSettings')}</a>
      <p className="drawer-note">{local?storageNote:t('trustedKeys.operator')}</p>
      <Field type="password" label={t('sources.key')} value={secret} autoFocus autoComplete="new-password" spellCheck={false} required data-1p-ignore="" data-lpignore="true" onChange={e=>{setSecret(e.target.value);request.current=crypto.randomUUID();setConfirmation(false);setConsent(false);setError(null);}} />
      {confirmation&&<label className="source-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} />{t('sources.noExpiryConsent')}</label>}
      <ErrorLine error={error} />
      <div className="button-row"><button type="button" className="button" onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={busy||!secret||confirmation&&!consent}>{t(replace?'sources.replace':'sources.connect')}</button></div>
    </form>
  </Modal>;
}

/** Owner records are fetched only while this panel is open or its own access changes. */
export function Connections({userId,local,trustedKeys}:{userId:string;local:boolean;trustedKeys:Session['trustedKeys']}) {
  const [open,setOpen]=useState(false),[edit,setEdit]=useState<Credential|null>(null),[list,setList]=useState<Credential[]>([]),[error,setError]=useState<unknown>(null),[removing,setRemoving]=useState<Credential|null>(null);
  const state=useApp(),generation=useRef(0);
  const storage=state?.secretKey;
  const read=async()=>{const own=++generation.current;try{const reply=await call<{credentials:Credential[]}>('GET','/api/credentials');if(generation.current===own)setList(reply.credentials);}catch(failure){if(generation.current===own)setError(failure);}};
  useEffect(()=>{void read();return()=>{generation.current++;};},[userId]);
  useEffect(()=>page.listen(event=>{if(event.type==='hub'&&event.event.type==='sourceAccess')void read();}),[userId]);
  const available=trustedKeys?.available===true;
  const storageNote=storage?t(storage.outcome==='mismatch'?'trustedKeys.mismatch':`trustedKeys.${storage.state}`):t('trustedKeys.title');
  const remove=async()=>{if(!removing)return;try{await call('DELETE','/api/credentials/'+removing.id);setRemoving(null);void read();}catch(failure){setError(failure);}};
  return <section className="drawer-section">
    <h3>{t('sources.title')}</h3>
    <button className="button" type="button" disabled={!available} onClick={()=>{setEdit(null);setOpen(true);}}>{t('sources.connect')}</button>
    {!available&&<p className="drawer-note">{t(trustedKeys?.reason==='secret_key_mismatch'?'trustedKeys.serverMismatch':'trustedKeys.serverMissing')}</p>}
    <ErrorLine error={error}/>
    {list.map(record=><div className="popover-row connection-row" key={record.id}>
      <div><strong>OpenRouter</strong><span className="drawer-note">{record.hint?`…${record.hint}`:'—'}</span><span className="drawer-note">{record.expiresAt===null?t('sources.noExpiry'):stamp(record.expiresAt)}</span>{record.lastError&&<ErrorLine error={new ApiError(400,record.lastError)}/>}</div>
      <button type="button" className="link-button" disabled={!available} onClick={()=>{setEdit(record);setOpen(true);}}>{t('sources.replace')}</button><button type="button" className="link-button danger" onClick={()=>setRemoving(record)}>{t('sources.remove')}</button>
    </div>)}
    {open&&<Connect key={userId} replace={edit} local={local} storageNote={storageNote} onClose={()=>setOpen(false)} onSaved={()=>void read()}/>}
    {removing&&<Modal title={t('sources.remove')} onClose={()=>setRemoving(null)}><p className="dialog-text">{t('sources.removeText')}</p><div className="button-row"><button className="button" onClick={()=>setRemoving(null)}>{t('common.cancel')}</button><button className="button danger" onClick={()=>void remove()}>{t('sources.remove')}</button></div></Modal>}
  </section>;
}
