import {useEffect, useLayoutEffect, useRef, useState, type FormEvent} from 'react';
import type {MeasurementPolicy, Participation} from '../../server/domain/measurementPolicy';
import type {Ingest} from '../../server/ingest';
import {agentVersion, compareVersions} from '../../server/domain/versions';
import {clientProviders} from '../../server/domain/providers';
import {clientName} from '../../server/domain/clients';
import {call} from '../lib/http';
import {stamp} from '../lib/format';
import {useClock} from '../lib/clock';
import {t} from '../i18n';
import {ErrorLine} from './Kit';
import {Popover} from './Popover';
import {Info} from 'lucide-react';
import type {Device} from './Machines';

export type MeasurementSource = ReturnType<Ingest['measurementSources']>[number];
type ResourceOrigin = MeasurementSource['origins'][number];
export type MeasurementFormState={dirty:boolean;busy:boolean};
type FormStateChanged=(state:MeasurementFormState)=>void;

function useFormState(dirty:boolean,busy:boolean,onChange?:FormStateChanged) {
  // Escape and navigation can follow the edit before passive effects have run.
  useLayoutEffect(()=>{onChange?.({dirty,busy});},[dirty,busy,onChange]);
  useLayoutEffect(()=>()=>onChange?.({dirty:false,busy:false}),[onChange]);
}

function OriginDetails({origin}:{origin:ResourceOrigin['valueOrigin']}) {
  return <><small>{origin?.name ?? t(origin?'measurements.otherDevice':'measurements.originUnknown')}</small>
    {origin&&<small>{stamp(origin.at)}</small>}
    {origin?.client&&<small>{t('measurements.clientVersion',{version:origin.client})}</small>}
    {origin?.evidence&&<small>{t(origin.evidence==='nativeHandshake'?'measurements.nativeEvidence':'measurements.preLaunchEvidence')}</small>}
  </>;
}

function ResourceOrigins({origin}:{origin:ResourceOrigin}) {
  const now=useClock(now=>origin.staleAt!==null && now<=origin.staleAt ? origin.staleAt+1 : null);
  const stale=origin.staleAt===null || now>origin.staleAt;
  const name=t(origin.resource==='funds'?'money.additionalFunds':origin.resource==='resets'?'measurements.resets':'measurements.quotas');
  return <li className="settings-list-row popover-row"><div className="settings-item-main">
    <b>{name}</b>
    <small data-time>{t(`measurements.status.${stale&&['observed','finite','unlimited'].includes(origin.status)?'stale':origin.status}`)}</small>
  </div><div className="settings-item-detail">
    {origin.valueOrigin?.name ?? t(origin.valueOrigin?'measurements.otherDevice':'measurements.originUnknown')}
    {origin.valueOrigin&&<small>{stamp(origin.valueOrigin.at)}</small>}
  </div><div className="settings-item-actions"><Popover label={t('measurements.resourceDetails',{resource:name})} width={440} icon={<Info size={16} aria-hidden="true"/>}>
    <div className="popover-section"><h3 className="popover-title">{name}</h3><dl className="connection-facts">
      <dt>{t('measurements.valueOrigin')}</dt><dd><OriginDetails origin={origin.valueOrigin}/></dd>
      <dt>{t('measurements.observationOrigin')}</dt><dd><OriginDetails origin={origin.observationOrigin}/></dd>
    </dl></div>
  </Popover></div></li>;
}

export function versionSummary(agent:string,hub:string) {
  const version=agentVersion(agent),comparison=version ? compareVersions(version,hub) : null;
  return version ? t(comparison===-1?'measurements.behind':comparison===1?'measurements.ahead':comparison===0?'measurements.same':'devices.versionUnknown',{version}) : t('devices.versionUnknown');
}

export function VersionInfo({agent,hub}:{agent:string;hub:string}) {
  return <section className="settings-section"><h3>Quotum</h3>
    <dl className="connection-facts"><dt>{t('measurements.agentVersion')}</dt><dd>{agentVersion(agent) ?? t('devices.versionUnknown')}</dd><dt>{t('measurements.hubVersion')}</dt><dd>{hub}</dd></dl>
    <p className="dialog-text">{versionSummary(agent,hub)}</p>
    <p className="dialog-text">{t('measurements.compatibility')}</p>
    <p className="dialog-text">{t('measurements.upgrade')}</p>
  </section>;
}

/** A retry retains the exact operation and CAS revision until the person reviews a conflict. */
function useMutation(path:string,revision:number,desired:unknown,reload:()=>Promise<unknown>) {
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  const operation=useRef<{payload:string;id:string}|null>(null);
  const save=async(event:FormEvent)=>{
    event.preventDefault();if(busy)return false;
    const payload=JSON.stringify({expectedRevision:revision,desired});
    if(operation.current?.payload!==payload)operation.current={payload,id:crypto.randomUUID()};
    setBusy(true);setError(null);
    let acknowledged=false;
    try {
      await call('POST',path,{operationId:operation.current.id,expectedRevision:revision,desired});
      acknowledged=true;await reload();operation.current=null;return true;
    }catch(failure){setError(failure);if(!acknowledged)await reload().catch(()=>{});return false;}
    finally{setBusy(false);}
  };
  return {busy,error,save,clear:()=>{operation.current=null;setError(null);}};
}

export function ParticipationSettings({device,reload,onStateChange}:{device:Device;reload:()=>Promise<unknown>;onStateChange?:FormStateChanged}) {
  const policy=device.policy!;
  const initial=(policy:MeasurementPolicy):Participation=>({enabled:policy.enabled,collectors:Object.fromEntries(clientProviders.map(id=>[id,policy.collectors[id].enabled])) as Participation['collectors']});
  const [draft,setDraft]=useState(()=>initial(policy)),[revision,setRevision]=useState(policy.revision),[dirty,setDirty]=useState(false);
  useEffect(()=>{if(!dirty){setDraft(initial(policy));setRevision(policy.revision);}},[policy.revision,dirty]);
  const mutation=useMutation(`/api/devices/${encodeURIComponent(device.id)}/measurement-policy`,revision,draft,reload);
  const change=(next:Participation)=>{setDraft(next);setDirty(true);mutation.clear();};
  const changed=dirty&&revision!==policy.revision;
  useFormState(dirty,mutation.busy,onStateChange);
  return <form className="settings-section" onSubmit={async event=>{if(await mutation.save(event))setDirty(false);}}>
    <h3>{t('measurements.participation')}</h3>
    <p className="dialog-text">{t('measurements.participationHelp')}</p>
    <fieldset className="form-fields" disabled={mutation.busy}><div className="settings-list measurement-participation">
      <label className="settings-list-row popover-row"><span className="settings-item-main"><b>{t('measurements.deviceEnabled')}</b></span><span className="settings-item-actions"><input type="checkbox" checked={draft.enabled} onChange={event=>change({...draft,enabled:event.target.checked})}/></span></label>
      {clientProviders.map(id=><label className="settings-list-row popover-row" key={id}><span className="settings-item-main">{clientName(id)}</span><span className="settings-item-actions"><input type="checkbox" checked={draft.collectors[id]} onChange={event=>change({...draft,collectors:{...draft.collectors,[id]:event.target.checked}})}/></span></label>)}
    </div></fieldset>
    <p className="dialog-text">{t(!device.control?.capable?'measurements.unsupportedControl':device.control.confirmedRevision===policy.revision?'measurements.confirmed':'measurements.awaitingPolicy')}</p>
    {clientProviders.some(id=>policy.collectors[id].requiresEpoch)&&!device.control?.capable&&<p className="dialog-text warning">{t('measurements.epochRequired')}</p>}
    {changed&&<p className="dialog-text">{t('measurements.changed')}</p>}
    <ErrorLine error={mutation.error}/>
    <div className="button-row is-start"><button className="button" disabled={mutation.busy||!dirty||changed}>{t('boards.save')}</button>
      {changed&&<button className="button" type="button" disabled={mutation.busy} onClick={()=>{setDraft(initial(policy));setDirty(false);setRevision(policy.revision);mutation.clear();}}>{t('measurements.review')}</button>}
    </div>
  </form>;
}

export function PreferenceSettings({source,devices,reload,readOnly=false,onStateChange}:{source:MeasurementSource;devices:Device[];reload:()=>Promise<unknown>;readOnly?:boolean;onStateChange?:FormStateChanged}) {
  const value=source.preference.kind==='auto'?'auto':source.preference.device ?? 'external';
  const [draft,setDraft]=useState(value),[revision,setRevision]=useState(source.preference.revision),[dirty,setDirty]=useState(false);
  useEffect(()=>{if(!dirty){setDraft(value);setRevision(source.preference.revision);}},[source.preference.revision,value,dirty]);
  const mutation=useMutation(`/api/sources/${encodeURIComponent(source.source)}/measurement-preference`,revision,draft==='auto'?null:draft,reload);
  const changed=dirty&&revision!==source.preference.revision;
  useFormState(dirty,mutation.busy,onStateChange);
  return <>
    {!readOnly&&<form className="settings-section" onSubmit={async event=>{if(await mutation.save(event))setDirty(false);}}>
      <h3>{t('measurements.preference')}</h3>
      <p className="dialog-text">{t('measurements.globalPreference')}</p>
      <fieldset className="form-fields" disabled={mutation.busy}><label className="field"><span>{t('measurements.collector')}</span><select value={draft} onChange={event=>{setDraft(event.target.value);setDirty(true);mutation.clear();}}>
        <option value="auto">{t('measurements.auto')}</option>
        {value==='external'&&<option value="external" disabled>{t('measurements.externalPreference')}</option>}
        {draft!=='auto'&&draft!=='external'&&!source.candidates.some(candidate=>candidate.device===draft)&&<option value={draft} disabled>{t('measurements.unavailablePreference')}</option>}
        {source.candidates.map(candidate=><option key={candidate.device} value={candidate.device} disabled={candidate.reason!=='eligible'}>{devices.find(device=>device.id===candidate.device)?.name ?? t('devices.device')}{candidate.reason==='eligible'?'':` (${t(`measurements.${candidate.reason}`)})`}</option>)}
      </select></label></fieldset>
      {source.pending&&<p className="dialog-text">{t('measurements.handover')}</p>}
      <p className="dialog-text">{t('measurements.effective',{device:devices.find(device=>source.candidates.some(candidate=>candidate.device===device.id&&candidate.onDuty))?.name ?? t(source.duty==='none'?'measurements.none':'measurements.otherDevice')})}</p>
      <ErrorLine error={mutation.error}/>
      <div className="button-row is-start"><button className="button" disabled={mutation.busy||!dirty||changed||draft==='external'}>{t('boards.save')}</button>
        {changed&&<button className="button" type="button" disabled={mutation.busy} onClick={()=>{setDraft(value);setDirty(false);setRevision(source.preference.revision);mutation.clear();}}>{t('measurements.review')}</button>}
      </div>
    </form>}
    <section className="settings-section"><h3>{t('measurements.origins')}</h3><ul className="settings-list">
      {source.origins.map(origin=><ResourceOrigins key={origin.resource} origin={origin}/>)}
      {!source.origins.length&&<li>{t('measurements.originUnknown')}</li>}
    </ul></section>
  </>;
}
