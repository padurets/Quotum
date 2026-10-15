import {VIEW_VERSION, VIEW_VERSION_HEADER} from '../../server/domain/view';
import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {stamp} from '../lib/format';
import {PROVIDERS} from '../lib/providers';
import {errorText} from '../lib/quota';
import {call} from '../lib/http';
import {logoOf} from './logos';
import {CopyField, ErrorLine, Field, Modal} from './Kit';
import {rich, t} from '../i18n';
import {Ago} from './Time';
import {ConnectionRow} from './Connections';
import {clientName} from '../../server/domain/clients';
import type {LiveSession} from '../lib/types';
import {useConnectionsRevision, useDevicesRevision, useDeviceContact} from '../lib/board';
import type {MeasurementPolicy} from '../../server/domain/measurementPolicy';
import {ParticipationSettings, PreferenceSettings, VersionInfo, type MeasurementSource} from './MeasurementDevices';
import {useLocation} from '../lib/router';

export type Device = {
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
  clients?: {clientId: string; version: string | null; seenAt: number;observedAt?:number|null}[];
  sessions?: (LiveSession & {source: string | null})[];
  failures: {provider: string; error: string; detail: string | null; at: number}[];
  policy?: MeasurementPolicy;
  control?: {capable:boolean;confirmedRevision:number|null};
};
type Token = {id: string; name: string; hint: string; createdAt: number; lastUsedAt: number | null};

const origin = () => location.origin;
const tokenName = (token: {name: string}) => token.name || t('connect.tokenDefault');

function Contact({device}:{device:Device}) {
  const at=useDeviceContact(device.id,device.lastSeenAt);
  return <span title={at?stamp(at):undefined}>{at?<Ago at={at}/>:t('connect.unused')}</span>;
}

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
export function Devices({local}: {local: boolean}) {
  const [detailsId, setDetails] = useState<string | null>(null);
  const revision = useConnectionsRevision();
  const presence = useDevicesRevision();
  const request = useRef(0);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [hubVersion,setHubVersion]=useState(''),[sources,setSources]=useState<MeasurementSource[]>([]);
  const location=useLocation(),focused=new URLSearchParams(location.split('?')[1]??'').get('source');
  const [sourceId,setSource]=useState<string|null>(focused);
  const selector=useRef<HTMLSelectElement>(null),unavailable=useRef<HTMLLIElement>(null),lastFocus=useRef<string|null>(null);
  useEffect(()=>{setSource(focused);},[focused]);
  useEffect(()=>{
    if(!focused||sourceId!==focused||lastFocus.current===focused||!devices)return;
    const target=sources.some(source=>source.source===focused)?selector.current:unavailable.current;
    if(!target)return;
    target.scrollIntoView({block:'center'});target.focus({preventScroll:true});lastFocus.current=focused;
  },[focused,sourceId,sources,devices]);
  const details = devices?.find(device=>device.id===detailsId) ?? null;
  const [renaming,setRenaming]=useState<Device|null>(null),[name,setName]=useState('');
  const [error, setError] = useState<unknown>(null);
  const newest=useRef<{promise:Promise<void>}|null>(null);
  const load = useCallback(() => {
    const current = ++request.current;
    const result=call<{devices:Device[];hubVersion:string;sources:MeasurementSource[]}>('GET', '/api/devices?measurement=1').then(value => {
      if (current !== request.current) return;
      setDevices(value.devices);setHubVersion(value.hubVersion);setSources(value.sources);setError(null);
    }, failure => {if (current === request.current) setError(failure);throw failure;});
    // Save waits for the authoritative read even when a newer owner hint supersedes it.
    const entry={promise:Promise.resolve()};
    entry.promise=result.then(()=>newest.current!==entry?newest.current?.promise:undefined,failure=>{
      if(newest.current&&newest.current!==entry)return newest.current.promise;
      throw failure;
    });
    newest.current=entry;return entry.promise;
  }, []);
  useEffect(()=>{void load().catch(()=>{});}, [load, revision,presence]);
  useEffect(() => () => {++request.current;}, []);

  const revoke = async (device: Device) => {
    if (!confirm(t('devices.confirmRevoke', {name: device.name}))) return;
    setError(null);
    try {
      await call('DELETE', `/api/devices/${encodeURIComponent(device.id)}`);
      await load();
    } catch (failure) {
      setError(failure);
    }
  };

  const rename = async(event:FormEvent) => {
    event.preventDefault();if(!renaming)return;
    try {await call('POST',`/api/devices/${encodeURIComponent(renaming.id)}`,{name:name.trim()});setRenaming(null);await load();}catch(failure){setError(failure);}
  };
  return <>
    {focused&&devices&&!sources.some(source=>source.source===focused)&&<li className="dialog-text" role="alert" tabIndex={-1} ref={unavailable}>{t('measurements.unavailableSource')}</li>}
    {sources.length>0&&<li className="settings-section"><label className="field"><span>{t('measurements.subscription')}</span><select ref={selector} value={sourceId??''} onChange={event=>setSource(event.target.value||null)}><option value="">{t('measurements.chooseSubscription')}</option>{sources.map((source,index)=><option key={source.source} value={source.source}>{source.label ?? `${PROVIDERS[source.provider]?.name ?? source.provider} ${index+1}`}</option>)}</select></label>
      {sources.find(source=>source.source===sourceId)&&<PreferenceSettings key={sourceId} source={sources.find(source=>source.source===sourceId)!} devices={devices??[]} reload={load} readOnly={local}/>}</li>}
    {error&&<li><ErrorLine error={error}/></li>}
    {devices?.length===0&&<li className="admin-empty">{t(local?'local.devicesEmpty':'devices.empty')}</li>}
    {devices?.map(device=><ConnectionRow key={device.id} name={device.name}
      icon={<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>}
      detail={<><span>{device.os}</span><VersionInfo agent={device.agent} hub={hubVersion}/><span className="connection-detail"><Agents device={device}/></span></>}
      status={<Contact device={device}/>}
      actions={<><button className="popover-row" onClick={()=>setDetails(device.id)}><span>{t('devices.clients')}</span></button><button className="popover-row" onClick={()=>{setError(null);setName(device.name);setRenaming(device);}}><span>{t('connections.rename')}</span></button>{!local&&<button className="popover-row danger" onClick={()=>void revoke(device)}><span>{t('devices.revoke')}</span></button>}</>}
    />)}
    {details&&<Modal title={t('devices.clientsOn',{name:details.name})} onClose={()=>setDetails(null)}>
      <VersionInfo agent={details.agent} hub={hubVersion}/>
      {details.failures.length>0&&<section className="settings-section"><h3>{t('measurements.lastFailure')}</h3><ul className="settings-list">{details.failures.map(failure=><li className="settings-list-row popover-row" key={failure.provider}><span className="settings-item-main"><b>{PROVIDERS[failure.provider]?.name ?? failure.provider}</b><small>{errorText(failure.error)}{failure.detail&&<span>{failure.detail}</span>}</small></span><span className="settings-item-detail">{stamp(failure.at)}</span></li>)}</ul></section>}
      {!local&&details.policy&&<ParticipationSettings device={details} reload={load}/>}
      <div className="settings-section"><h3>{t('devices.clients')}</h3><ul className="settings-list">
        {(details.clients ?? []).map(client=><li className="settings-list-row popover-row" key={client.clientId}><span className="settings-item-main"><b>{clientName(client.clientId)}</b></span><span className="settings-item-detail">{client.version ?? t('devices.versionUnknown')}<small>{client.observedAt ? stamp(client.observedAt) : t('measurements.originUnknown')}</small></span></li>)}
      </ul></div>
      <div className="settings-section"><h3>{t('agents.title')}</h3><ul className="settings-list">
        {(details.sessions ?? []).map((session,i)=><li className="settings-list-row popover-row" key={i}><span className="settings-item-main"><b>{clientName(session.clientId ?? 'unknown')}</b><small>{session.project ?? t('agents.noProject')}</small></span><span className="settings-item-detail">{session.source ? PROVIDERS[session.source.split(':')[0]]?.name ?? session.source : t('agents.unknownSource')}</span></li>)}
      </ul></div>
    </Modal>}
    {renaming&&<Modal title={t('devices.rename',{name:renaming.name})} onClose={()=>setRenaming(null)}>
      <form className="dialog-form" onSubmit={rename}><Field label={t('devices.nameLabel')} value={name} maxLength={80} placeholder={renaming.reported} autoFocus onChange={e=>setName(e.target.value)}/><ErrorLine error={error}/><div className="button-row"><button className="button" type="button" onClick={()=>setRenaming(null)}>{t('common.cancel')}</button><button className="button primary">{t('boards.save')}</button></div></form>
    </Modal>}
  </>;
}

export function DeviceCode() {
  return <>
    <p className="dialog-text">{t('connect.codeText')}</p>
    <CopyField value={`npx quotum connect ${origin()}`} />
  </>;
}

/** Settings show both methods; onboarding keeps automation optional within its current step. */
export function ConnectDevice({onboardingId}: {onboardingId?: string} = {}) {
  return (
    <div className="dialog-form">
      <p className="sharing-disclosure">{t('connect.sessionSharing')}</p>
      <DeviceCode />
      <details className="connection-tokens">
        <summary>{t('connect.tokenTitle')}</summary>
        <DeviceTokens onboardingId={onboardingId} />
      </details>
    </div>
  );
}

export function DeviceTokens({onboardingId}: {onboardingId?: string} = {}) {
  const revision = useConnectionsRevision();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{secret: string; name: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    call<Token[]>('GET', '/api/tokens').then(setTokens, setError);
  }, []);
  useEffect(load, [load, revision]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await call<Token & {secret: string}>('POST', '/api/tokens', {name: name.trim(), ...(onboardingId ? {onboardingId} : {})}, 12_000, undefined, {[VIEW_VERSION_HEADER]:String(VIEW_VERSION)});
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
      <p className="dialog-text">{t('connect.tokenText')}</p>
      {created ? (
        <div className="token-created">
          <CopyField label={t('connect.tokenShownOnce', {name: created.name})} value={created.secret} secret />
          <CopyField label={t('connect.run')} value={`QUOTUM_HUB_URL=${origin()} QUOTUM_HUB_TOKEN=${created.secret} npx quotum run`} />
          <button type="button" className="button" onClick={() => setCreated(null)}>
            {t('connect.done')}
          </button>
        </div>
      ) : (
        <form className="inline-form is-wrap settings-form" onSubmit={create}>
          <Field label={t('connect.name')} placeholder={t('connect.namePlaceholder')} value={name} onChange={e => setName(e.target.value)} maxLength={80} />
          <button type="submit" className="button primary" disabled={busy}>
            {t('connect.create')}
          </button>
        </form>
      )}
      <ErrorLine error={error} />
      {tokens.length > 0 && (
        <ul className="settings-list">
          {tokens.map(token => (
            <li key={token.id} className="popover-row settings-list-row">
              <div className="settings-item-main">
                <b>{tokenName(token)}</b>
                <small className="mono">{token.hint}</small>
              </div>
              <small className="settings-item-detail" title={token.lastUsedAt ? stamp(token.lastUsedAt) : undefined}>
                {token.lastUsedAt ? rich('connect.used', {ago: <Ago at={token.lastUsedAt} />}) : t('connect.unused')}
              </small>
              <div className="settings-item-actions">
                <button type="button" className="button" onClick={() => revoke(token)}>
                  {t('connect.revoke')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
