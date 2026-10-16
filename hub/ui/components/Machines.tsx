import {VIEW_VERSION, VIEW_VERSION_HEADER} from '../../server/domain/view';
import {useCallback, useEffect, useLayoutEffect, useId, useRef, useState, type FormEvent} from 'react';
import {stamp} from '../lib/format';
import {PROVIDERS} from '../lib/providers';
import {errorText} from '../lib/quota';
import {call} from '../lib/http';
import {CopyField, ErrorLine, Field, Modal, Segmented} from './Kit';
import {rich, t} from '../i18n';
import {Ago} from './Time';
import {ConnectionRow} from './Connections';
import {clientName} from '../../server/domain/clients';
import type {LiveSession} from '../lib/types';
import {useConnectionsRevision, useDevicesRevision, useDeviceContact} from '../lib/board';
import type {MeasurementPolicy} from '../../server/domain/measurementPolicy';
import {ParticipationSettings, PreferenceSettings, VersionInfo, versionSummary, type MeasurementFormState, type MeasurementSource} from './MeasurementDevices';
import {guardNavigation, useLocation} from '../lib/router';
import {openClientLinks, SessionFunding, type LinkEvidence, type LinkInventory} from './ClientLinks';

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
  sessions?: (LiveSession & {source: string | null; attribution?: LinkEvidence})[];
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

function participationSummary(device:Device) {
  if(!device.policy)return t('measurements.unsupportedControl');
  if(!device.policy.enabled)return t('measurements.disabled');
  if(!Object.values(device.policy.collectors).some(collector=>collector.enabled))return t('measurements.collectorsDisabled');
  if(!device.control?.capable)return t('measurements.limitedControl');
  return t(device.control.confirmedRevision===device.policy.revision?'measurements.allowed':'measurements.awaitingConfirmation');
}

const sourceName=(source:MeasurementSource,index:number)=>source.label ?? `${PROVIDERS[source.provider]?.name ?? source.provider} ${index+1}`;
const restoreConnection=(id:string)=>document.querySelector<HTMLButtonElement>(`[data-connection-id="${CSS.escape(id)}"]`)??document.querySelector<HTMLButtonElement>('#devices button');
const effectiveDevice=(source:MeasurementSource,devices:Device[])=>devices.find(device=>source.candidates.some(candidate=>candidate.device===device.id&&candidate.onDuty))?.name ?? t(source.duty==='none'?'measurements.none':'measurements.otherDevice');

/** The reader's devices; on the desktop app's board, its one machine, which cannot be disconnected (it is the app's own agent). */
export function Devices({local,onBusyChange}: {local: boolean;onBusyChange?:(busy:boolean)=>void}) {
  const [detailsId, setDetails] = useState<string | null>(null);
  const [tab,setTab]=useState<'measurements'|'diagnostics'>('measurements'),tabs=useId();
  const [connecting,setConnecting]=useState(false),[revoking,setRevoking]=useState<Device|null>(null);
  const [formState,setFormState]=useState<MeasurementFormState>({dirty:false,busy:false}),[actionBusy,setActionBusy]=useState(false);
  const [discard,setDiscard]=useState<{go:()=>void}|null>(null);
  const revision = useConnectionsRevision();
  const presence = useDevicesRevision();
  const request = useRef(0), requestedDetails = useRef<string | null>(null);
  const evidenceId = tab === 'diagnostics' ? detailsId : null;
  requestedDetails.current = evidenceId;
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [hubVersion,setHubVersion]=useState(''),[sources,setSources]=useState<MeasurementSource[]>([]);
  const location=useLocation(),focused=new URLSearchParams(location.split('?')[1]??'').get('source');
  const [sourceId,setSource]=useState<string|null>(focused);
  const unavailable=useRef<HTMLParagraphElement>(null),lastFocus=useRef<string|null>(null);
  useEffect(()=>{setSource(focused);},[focused]);
  useEffect(()=>{
    if(!focused||sourceId!==focused||lastFocus.current===focused||!devices)return;
    const target=sources.some(source=>source.source===focused)?null:unavailable.current;
    if(!target)return;
    target.scrollIntoView({block:'center'});target.focus({preventScroll:true});lastFocus.current=focused;
  },[focused,sourceId,sources,devices]);
  const details = devices?.find(device=>device.id===detailsId) ?? null;
  const [renaming,setRenaming]=useState<Device|null>(null),[name,setName]=useState('');
  // The menu item disappears when its dialog opens; return to the menu's trigger.
  const actionFocus=useRef<HTMLElement|null>(null);
  const rememberAction=(button:HTMLButtonElement)=>{actionFocus.current=button.closest('.picker')?.querySelector<HTMLButtonElement>('button')??null;};
  const restoreAction=()=>actionFocus.current?.isConnected?actionFocus.current:document.querySelector<HTMLElement>('#devices button');
  const restoreDetails=()=>sourceId?restoreConnection(sourceId):detailsId?restoreConnection(`device:${detailsId}`):restoreAction();
  const busy=formState.busy||actionBusy,dirty=formState.dirty||!!renaming&&name!==renaming.name;
  const leave=useCallback((go:()=>void)=>{if(busy)return;if(dirty)setDiscard({go});else go();},[busy,dirty]);
  useLayoutEffect(()=>guardNavigation(leave,true),[leave]);
  useLayoutEffect(()=>{onBusyChange?.(busy);return ()=>onBusyChange?.(false);},[busy,onBusyChange]);
  useLayoutEffect(()=>{if(!dirty&&!busy)return;const unload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',unload);return ()=>window.removeEventListener('beforeunload',unload);},[dirty,busy]);
  const [error, setError] = useState<unknown>(null);
  const newest=useRef<{promise:Promise<void>}|null>(null);
  const load = useCallback(() => {
    const current = ++request.current, detail = requestedDetails.current;
    const result=call<{devices:Device[];hubVersion:string;sources:MeasurementSource[]}>('GET', '/api/devices?measurement=1' + (detail === null ? '' : '&details=' + encodeURIComponent(detail))).then(value => {
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
  useEffect(() => {if (evidenceId !== null) void load().catch(() => {});}, [load, evidenceId]);
  useEffect(() => () => {++request.current;}, []);

  const [funding, setFunding] = useState<LinkInventory | null>(null), [fundingError, setFundingError] = useState<unknown>(null);
  useEffect(() => {
    setFunding(null); setFundingError(null);
    if (evidenceId === null) return;
    let current = true;
    call<LinkInventory>('GET', '/api/links').then(inventory => {if (current) setFunding(inventory);}, failure => {if (current) setFundingError(failure);});
    return () => {current = false;};
  }, [evidenceId, revision]);

  const revoke = async (device: Device) => {
    if(actionBusy)return;setActionBusy(true);setError(null);
    try {
      await call('DELETE', `/api/devices/${encodeURIComponent(device.id)}`);
      await load();
      setRevoking(null);
    } catch (failure) {
      setError(failure);
    }finally{setActionBusy(false);}
  };

  const rename = async(event:FormEvent) => {
    event.preventDefault();if(!renaming||actionBusy)return;setActionBusy(true);
    try {await call('POST',`/api/devices/${encodeURIComponent(renaming.id)}`,{name:name.trim()});await load();setRenaming(null);}catch(failure){setError(failure);}finally{setActionBusy(false);}
  };
  const selected=sources.find(source=>source.source===sourceId);
  return <>
    {focused&&devices&&!selected&&sourceId===focused&&<p className="dialog-text" role="alert" tabIndex={-1} ref={unavailable}>{t('measurements.unavailableSource')}</p>}
    <ErrorLine error={error}/>
    {error&&<div><button type="button" className="button" onClick={()=>void load().catch(()=>{})}>{t('refresh.action')}</button></div>}
    <section className="settings-section connection-overview" id="devices">
      <div className="settings-section-head"><h2>{t('devices.machines')}</h2>{!local&&<button type="button" className="button primary" aria-haspopup="dialog" onClick={()=>setConnecting(true)}>{t('connections.connectDevice')}</button>}</div>
      <p className="dialog-text">{t('connections.devicesHelp')}</p>
      {!devices&&!error&&<p role="status">{t('connections.loading')}</p>}
      {devices?.length===0&&<p className="admin-empty">{t(local?'local.devicesEmpty':'devices.empty')}</p>}
      <ul className="settings-list">{devices?.slice().sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)).map(device=><ConnectionRow key={device.id} id={`device:${device.id}`} name={device.name}
        detail={<><span>{device.os}</span><span>{versionSummary(device.agent,hubVersion)}</span></>}
        status={<>{!local&&<span>{participationSummary(device)}</span>}<small><Contact device={device}/></small></>}
        onOpen={()=>{setDetails(device.id);setTab(local||!device.policy?'diagnostics':'measurements');}}
        actions={<><button className="popover-row" onClick={event=>{rememberAction(event.currentTarget);setError(null);setName(device.name);setRenaming(device);}}>{t('connections.rename')}</button>{!local&&<button className="popover-row danger" onClick={event=>{rememberAction(event.currentTarget);setError(null);setRevoking(device);}}>{t('devices.revoke')}</button>}</>}
      />)}</ul>
    </section>
    {!!sources.length&&<section className="settings-section connection-overview"><h2>{t('measurements.subscriptions')}</h2><p className="dialog-text">{t(local?'measurements.localSourcesHelp':'measurements.sourcesHelp')}</p>
      <ul className="settings-list">{sources.map((source,index)=><ConnectionRow key={source.source} id={source.source} name={sourceName(source,index)} detail={PROVIDERS[source.provider]?.name ?? source.provider}
        status={<>{!local&&<span>{t('measurements.preferredSummary',{device:source.preference.kind==='auto'?t('measurements.auto'):source.preference.device?devices?.find(device=>device.id===source.preference.device)?.name??t('measurements.unavailablePreference'):t('measurements.externalPreference')})}</span>}<small>{t('measurements.effective',{device:effectiveDevice(source,devices??[])})}</small></>}
        onOpen={()=>setSource(source.source)}/>)}</ul>
    </section>}
    {selected&&<Modal title={sourceName(selected,sources.indexOf(selected))} restore={restoreDetails} onClose={busy?undefined:()=>leave(()=>setSource(null))}>
      <PreferenceSettings key={selected.source} source={selected} devices={devices??[]} reload={load} readOnly={local} onStateChange={setFormState}/>
    </Modal>}
    {details&&<Modal title={details.name} restore={restoreDetails} onClose={busy?undefined:()=>leave(()=>setDetails(null))}>
      {!local&&details.policy&&<Segmented label={t('connections.deviceSections')} radioName={tabs} value={tab} disabled={busy} options={[["measurements",t('measurements.participation')],["diagnostics",t('connections.diagnostics')]]} onChange={next=>leave(()=>setTab(next))}/>}
      {!local&&details.policy&&tab==='measurements'?<ParticipationSettings key={details.id} device={details} reload={load} onStateChange={setFormState}/>:<>
        <VersionInfo agent={details.agent} hub={hubVersion}/>
        {!!details.failures.length&&<section className="settings-section"><h3>{t('measurements.lastFailure')}</h3><ul className="settings-list">{details.failures.map(failure=><li className="settings-list-row popover-row" key={failure.provider}><div className="settings-item-main"><b>{PROVIDERS[failure.provider]?.name ?? failure.provider}</b><small>{errorText(failure.error)}</small>{failure.detail&&<small>{failure.detail}</small>}</div><div className="settings-item-detail">{stamp(failure.at)}</div></li>)}</ul></section>}
        <div className="settings-section"><h3>{t('devices.clients')}</h3><ul className="settings-list">
          {(details.clients ?? []).map(client=><li className="settings-list-row popover-row" key={client.clientId}><div className="settings-item-main"><b>{clientName(client.clientId)}</b><small>{client.version ?? t('devices.versionUnknown')}</small></div><div className="settings-item-detail">{client.observedAt ? stamp(client.observedAt) : t('measurements.originUnknown')}</div><div className="settings-item-actions"><button className="button" onClick={()=>openClientLinks({deviceId:details.id,clientId:client.clientId})}>{t('links.manage')}</button></div></li>)}
        </ul>{!details.clients?.length&&<p className="dialog-text">{t('devices.noClientData')}</p>}</div>
        <div className="settings-section"><h3>{t('agents.title')}</h3><ul className="settings-list">
          {(details.sessions ?? []).map((session,i)=><li className="settings-list-row popover-row" key={i}><div className="settings-item-main"><b>{clientName(session.clientId ?? 'unknown')}</b><small>{session.project ?? t('agents.noProject')}</small></div><div className="settings-item-actions"><SessionFunding session={session} inventory={funding} evidence={session.attribution} error={fundingError}/></div></li>)}
        </ul>{!details.sessions?.length&&<p className="dialog-text">{t('devices.noSessions')}</p>}</div>
      </>}
    </Modal>}
    {connecting&&<Modal title={t('connections.connectDevice')} onClose={()=>setConnecting(false)}><DeviceCode/></Modal>}
    {renaming&&<Modal title={t('devices.rename',{name:renaming.name})} restore={restoreAction} onClose={busy?undefined:()=>leave(()=>setRenaming(null))}>
      <form className="dialog-form" onSubmit={rename}><fieldset className="form-fields" disabled={busy}><Field label={t('devices.nameLabel')} value={name} maxLength={80} placeholder={renaming.reported} autoFocus onChange={e=>setName(e.target.value)}/></fieldset><ErrorLine error={error}/><div className="button-row"><button className="button" type="button" disabled={busy} onClick={()=>leave(()=>setRenaming(null))}>{t('common.cancel')}</button><button className="button primary" disabled={busy}>{t('boards.save')}</button></div></form>
    </Modal>}
    {revoking&&<Modal title={t('devices.revoke')} restore={restoreAction} onClose={busy?undefined:()=>setRevoking(null)}><p className="dialog-text">{t('devices.confirmRevoke',{name:revoking.name})}</p><ErrorLine error={error}/><div className="button-row"><button className="button" disabled={busy} onClick={()=>setRevoking(null)}>{t('common.cancel')}</button><button className="button danger" disabled={busy} onClick={()=>void revoke(revoking)}>{t('devices.revoke')}</button></div></Modal>}
    {discard&&<Modal title={t('connections.unsaved')} restore={restoreDetails} onClose={()=>setDiscard(null)}><p className="dialog-text">{t('connections.discardHelp')}</p><div className="button-row"><button className="button" onClick={()=>setDiscard(null)}>{t('connections.stay')}</button><button className="button danger" onClick={()=>{const go=discard.go;setDiscard(null);setFormState({dirty:false,busy:false});go();}}>{t('connections.discard')}</button></div></Modal>}
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
