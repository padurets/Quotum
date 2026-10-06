import {useCallback, useEffect, useState, type FormEvent} from 'react';
import {stamp} from '../lib/format';
import {PROVIDERS} from '../lib/providers';
import {errorText} from '../lib/quota';
import {call} from '../lib/http';
import {logoOf} from './logos';
import {CopyField, ErrorLine, Field, Modal} from './Kit';
import {Popover} from './Popover';
import {rich, t} from '../i18n';
import {Ago} from './Time';
import {ConnectedAccounts,ConnectSource,ConnectionRow} from './Connections';
import type {Session} from '../lib/session';

import type {Credential} from '../../server/store/credentials';

export type ConnectionsStart = 'list' | 'connect';

type Device = {
  id: string;
  /** The name given on the hub, else the one the machine reports. */
  name: string;
  reported: string;
  os: string;
  arch: string;
  agent: string;
  via: 'code' | 'token';
  lastSeenAt: number | null;
  sources: {provider: string; source: string; seenAt: number}[];
  failures: {provider: string; error: string; detail: string | null; at: number}[];
};
type Token = {id: string; name: string; hint: string; createdAt: number; lastUsedAt: number | null};

const origin = () => location.origin;
const tokenName = (token: {name: string}) => token.name || t('connect.tokenDefault');

/** The agents of a device: the providers it delivers, and the ones whose client failed there. */
function Agents({device}: {device: Device}) {
  const providers = [...new Set([...device.sources.map(s => s.provider), ...device.failures.map(f => f.provider)])];
  if (!providers.length) return <>—</>;
  return (
    <span className="agent-icons">
      {providers.map(provider => {
        const failure = device.failures.find(f => f.provider === provider);
        const title = [PROVIDERS[provider]?.name ?? provider, failure && errorText(failure.error), failure?.detail].filter(Boolean).join(' — ');
        return (
          <span key={provider} className={`agent-icon ${failure ? 'is-failing' : ''}`} title={title}>
            <img src={logoOf(provider)} alt={title} />
          </span>
        );
      })}
    </span>
  );
}

/** The reader's devices; on the desktop app's board, its one machine, which cannot be disconnected (it is the app's own agent). */
function Devices({local}: {local: boolean}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [renaming,setRenaming]=useState<Device|null>(null),[name,setName]=useState('');
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    call<Device[]>('GET', '/api/devices').then(setDevices, setError);
  }, []);
  useEffect(load, [load]);

  const revoke = async (device: Device) => {
    if (!confirm(t('devices.confirmRevoke', {name: device.name}))) return;
    setError(null);
    try {
      await call('DELETE', `/api/devices/${encodeURIComponent(device.id)}`);
      load();
    } catch (failure) {
      setError(failure);
    }
  };

  const rename = async(event:FormEvent) => {
    event.preventDefault();if(!renaming)return;
    try {await call('POST',`/api/devices/${encodeURIComponent(renaming.id)}`,{name:name.trim()});setRenaming(null);load();}catch(failure){setError(failure);}
  };
  return <>
    {error&&<li><ErrorLine error={error}/></li>}
    {devices?.length===0&&<li className="admin-empty">{t(local?'local.devicesEmpty':'devices.empty')}</li>}
    {devices?.map(device=><ConnectionRow key={device.id} name={device.name}
      icon={<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>}
      detail={<><span>{device.os}</span><span className="connection-detail"><Agents device={device}/></span></>}
      status={<span title={device.lastSeenAt?stamp(device.lastSeenAt):undefined}>{device.lastSeenAt?<Ago at={device.lastSeenAt}/>:t('connect.unused')}</span>}
      actions={<><button className="popover-row" onClick={()=>{setError(null);setName(device.name);setRenaming(device);}}><span>{t('connections.rename')}</span></button>{!local&&<button className="popover-row danger" onClick={()=>void revoke(device)}><span>{t('devices.revoke')}</span></button>}</>}
    />)}
    {renaming&&<Modal title={t('devices.rename',{name:renaming.name})} onClose={()=>setRenaming(null)}>
      <form className="dialog-form" onSubmit={rename}><Field label={t('devices.nameLabel')} value={name} maxLength={80} placeholder={renaming.reported} autoFocus onChange={e=>setName(e.target.value)}/><ErrorLine error={error}/><div className="button-row"><button className="button" type="button" onClick={()=>setRenaming(null)}>{t('common.cancel')}</button><button className="button primary">{t('boards.save')}</button></div></form>
    </Modal>}
  </>;
}

function ConnectDevice() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{secret: string; name: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    call<Token[]>('GET', '/api/tokens').then(setTokens, setError);
  }, []);
  useEffect(load, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await call<Token & {secret: string}>('POST', '/api/tokens', {name: name.trim()});
      setCreated({secret: token.secret, name: tokenName(token)});
      setName('');
      load();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: Token) => {
    if (!confirm(t('connect.confirmRevoke', {name: tokenName(token)}))) return;
    setError(null);
    try {
      await call('DELETE', `/api/tokens/${encodeURIComponent(token.id)}`);
      setCreated(null);
      load();
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <div className="dialog-form">
        <p>{t('connect.codeText')}</p>
        <CopyField value={`npx quotum connect ${origin()}`} />
      <details className="connection-tokens"><summary>{t('connect.tokenTitle')}</summary><div className="dialog-form">
        <p>{t('connect.tokenText')}</p>
        {created ? (
          <div className="token-created">
            <CopyField label={t('connect.tokenShownOnce', {name: created.name})} value={created.secret} secret />
            <CopyField label={t('connect.run')} value={`QUOTUM_HUB_URL=${origin()} QUOTUM_HUB_TOKEN=${created.secret} npx quotum run`} />
            <button type="button" className="link-button" onClick={() => setCreated(null)}>
              {t('connect.done')}
            </button>
          </div>
        ) : (
          <form className="inline-form" onSubmit={create}>
            <Field label={t('connect.name')} placeholder={t('connect.namePlaceholder')} value={name} onChange={e => setName(e.target.value)} maxLength={80} />
            <button type="submit" className="button primary" disabled={busy}>
              {t('connect.create')}
            </button>
          </form>
        )}
        <ErrorLine error={error} />
        {tokens.length > 0 && (
          <ul className="token-list">
            {tokens.map(token => (
              <li key={token.id}>
                <span>
                  <b>{tokenName(token)}</b> <span className="mono">{token.hint}</span>
                </span>
                <small title={token.lastUsedAt ? stamp(token.lastUsedAt) : undefined}>{token.lastUsedAt ? rich('connect.used', {ago: <Ago at={token.lastUsedAt} />}) : t('connect.unused')}</small>
                <button type="button" className="link-button danger" onClick={() => revoke(token)}>
                  {t('connect.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div></details>
    </div>
  );
}

export function ConnectionsDialog({start,onClose,local,userId,trustedKeys}:{start:ConnectionsStart;onClose:()=>void;local:boolean;userId:string;trustedKeys:Session['trustedKeys']}) {
  const [kind,setKind]=useState<'device'|'openrouter'|'zai'|null>(null);
  const [open,setOpen]=useState(start==='connect');
  const [replace,setReplace]=useState<Credential|null>(null);
  const back=()=>{setKind(null);setReplace(null);};
  const choose=(next:'device'|'openrouter'|'zai')=>{setOpen(false);setKind(next);};
  const title=kind==='device'?t('connections.connectDevice'):kind==='openrouter'||kind==='zai'?t(replace?'sources.replace':kind==='zai'?'sources.connectZai':'sources.connect'):t('machines.title');
  return <Modal key={kind??'list'} title={title} onClose={onClose} wide={!kind}>
    {kind?<div className="dialog-form">
      <button type="button" className="link-button connection-back" onClick={back}>← {t('connections.back')}</button>
      {kind==='device'?<ConnectDevice/>:<ConnectSource provider={kind} userId={userId} local={local} trustedKeys={trustedKeys} replace={replace} onClose={back}/>}
    </div>:<div className="dialog-body">
      <div className="connections-toolbar">{<Popover label={t('admin.connect')} trigger={t('admin.connect')} triggerClass="button primary" open={open} onOpenChange={setOpen} align="left">
        {!local&&<button className="popover-row" onClick={()=>choose('device')}><span>{t('connections.device')}</span></button>}
        <button className="popover-row" onClick={()=>choose('openrouter')}><span>OpenRouter</span></button>
        <button className="popover-row" onClick={()=>choose('zai')}><span>{t('sources.zaiPersonal')}</span></button>
      </Popover>}</div>
      <ul className="connections-list"><Devices local={local}/><ConnectedAccounts userId={userId} trustedKeys={trustedKeys} onReplace={record=>{setReplace(record);choose(record.provider==='zai'?'zai':'openrouter');}}/></ul>
    </div>}
  </Modal>;
}
