import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {clientName} from '../../server/domain/clients';
import {catalogue} from '../../server/domain/providers';
import type {Attribution, ClientLink, LinkInput} from '../../server/domain/links';
import {t} from '../i18n';
import {useConnectionsRevision, useDevicesRevision} from '../lib/board';
import {ApiError, call} from '../lib/http';
import {stamp} from '../lib/format';
import {navigate, settingsHref, useLocation} from '../lib/router';
import {ErrorLine, Field, Modal, SelectField} from './Kit';
import {ConnectionRow} from './Connections';
import {logoOf} from './logos';

type Inventory = {revision: string; links: (ClientLink & {active: boolean})[]; clients: string[]; devices: {id: string; name: string}[]; sources: {id: string; provider: string; name: string}[]};
type Evidence = Attribution & {deviceId: string; clientId: string; project: string | null; accountSourceId: string | null; host?: string};
type Edit = {operation: 'create' | 'correct' | 'change' | 'delete'; link: LinkInput & {id?: string}; revision: string};
const localDate = (at: number) => {const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);};
const condition = (link: LinkInput) => link.route ? t(`links.${link.route.class}`) + (link.route.provider ? '\n' + (catalogue.find(p => p.id === link.route!.provider)?.name ?? link.route.provider) : '') : t('links.anyRoute');
const period = (link: LinkInput) => stamp(link.from) + '\n' + (link.to === null ? t('links.openEnd') : stamp(link.to));

/** Entry points carry a draft context. Opening them never creates a rule. */
export function openClientLinks(context?: {deviceId: string; clientId?: string; route?: Evidence['route']}, sourceId?: string) {
  const url = new URL(settingsHref('/settings/links'), location.origin);
  if (context) {url.searchParams.set('device', context.deviceId); if (context.clientId) url.searchParams.set('client', context.clientId);
    if (context.route) {url.searchParams.set('route', context.route.class); if (context.route.provider) url.searchParams.set('provider', context.route.provider);}}
  if (sourceId) url.searchParams.set('source', sourceId);
  navigate(url.pathname + url.search);
}

export function ClientLinks({userId}: {userId: string}) {
  const location = useLocation(), params = new URLSearchParams(location.split('?')[1]);
  return <LinkManager key={JSON.stringify([userId, ...['device', 'client', 'route', 'provider', 'source'].map(key => params.get(key))])} context={params} />;
}

function LinkManager({context}: {context: URLSearchParams}) {
  const revision = useConnectionsRevision(), presence = useDevicesRevision();
  const [inventory, setInventory] = useState<Inventory | null>(null), [suggestions, setSuggestions] = useState<LinkInput[]>([]), [evidence, setEvidence] = useState<Evidence[]>([]);
  const [error, setError] = useState<unknown>(null), [edit, setEdit] = useState<Edit | null>(null), [pending, setPending] = useState<{link: LinkInput; body: object} | null>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0), liveGeneration = useRef(0), seeded = useRef(false);
  const load = useCallback(async () => {
    const own = ++generation.current;
    try {const data = await call<Inventory>('GET', '/api/links'); if (own === generation.current) {setInventory(data); setError(null); return data;}}
    catch (failure) {if (own === generation.current) setError(failure);}
  }, []);
  const readLive = useCallback(async () => {
    const own = ++liveGeneration.current;
    try {const [data, attribution] = await Promise.all([call<{suggestions: LinkInput[]}>('GET', '/api/links/suggestions'), call<{sessions: Evidence[]}>('GET', '/api/links/attribution')]);
      if (own === liveGeneration.current) {setSuggestions(data.suggestions); setEvidence(attribution.sessions);}}
    catch (failure) {if (own === liveGeneration.current) setError(failure);}
  }, []);
  useEffect(() => {void load();}, [load, revision]);
  useEffect(() => {void readLive();}, [readLive, revision, presence]);
  useEffect(() => () => {++generation.current; ++liveGeneration.current;}, []);
  const draft = (): LinkInput => ({clientId: '', deviceId: null, sourceId: '', route: null, from: Date.now(), to: null});
  useEffect(() => {
    if (!inventory || seeded.current) return; seeded.current = true;
    if (context.has('device') || context.has('source')) {
      const deviceId = inventory.devices.find(device => device.id === context.get('device'))?.id ?? null;
      const clientId = inventory.clients.find(client => client === context.get('client')) ?? '';
      const sourceId = inventory.sources.find(source => source.id === context.get('source'))?.id ?? '';
      const route = ['api', 'subscription', 'unknown'].includes(context.get('route') ?? '') ? {class: context.get('route') as 'api' | 'subscription' | 'unknown', provider: catalogue.some(p => p.id === context.get('provider')) ? context.get('provider') : null} : null;
      setEdit({operation: 'create', revision: inventory.revision, link: {...draft(), clientId, deviceId, sourceId, route}});
    }
  }, [inventory, context]);
  if (!inventory) return <section className="settings-section"><h2>{t('links.title')}</h2><p role="status">{t('links.loading')}</p><ErrorLine error={error} /></section>;
  const sourceName = (id: string | null) => inventory.sources.find(source => source.id === id)?.name ?? t('agents.unknownSource');
  const deviceName = (id: string | null) => id === null ? t('links.allDevices') : inventory.devices.find(device => device.id === id)?.name ?? t('devices.title');
  const linked = async (link: LinkInput) => {
    if (busy) return;
    // Keep the exact successful command across a lost reply, even if the hint vanished.
    const command = pending?.link === link ? pending.body : {...link, suggestion: link, expectedRevision: inventory.revision, requestId: crypto.randomUUID()};
    setPending({link, body: command}); setBusy(true); setError(null);
    try {await call('POST', '/api/links', command); setPending(null); await load(); await readLive();}
    catch (failure) {setError(failure);} finally {setBusy(false);}
  };
  const reset = async () => {setPending(null); await load(); await readLive();};
  return <>
    <section className="settings-section">
    <div className="settings-section-head"><h2>{t('links.title')}</h2><button id="create-client-link" className="button primary" disabled={!inventory.sources.length} onClick={() => setEdit({operation: 'create', revision: inventory.revision, link: draft()})}>{t('links.create')}</button></div>
    <p className="dialog-text">{t('links.description')}</p>
    {!inventory.sources.length && <><p className="dialog-text">{t('links.noSources')}</p><div><button className="button" onClick={() => navigate(settingsHref('/settings/connections'))}>{t('settings.connections')}</button></div></>}
    <div className="settings-section-head"><h3>{t('links.saved')}</h3><button className="link-button" onClick={() => void reset()}>{t('links.reload')}</button></div>
    <ErrorLine error={error} />
    {!inventory.links.length && <p className="admin-empty">{t('links.empty')}</p>}
    <ul className="connections-list client-links-list">{inventory.links.map(link => <ConnectionRow key={link.id} id={'client-link-' + link.id}
      name={clientName(link.clientId) + ' → ' + (link.active ? sourceName(link.sourceId) : t('links.unavailableSource'))}
      icon={<img src={logoOf(inventory.sources.find(source => source.id === link.sourceId)?.provider ?? 'unknown')} alt="" />}
      detail={<><span>{deviceName(link.deviceId)}</span><span>{condition(link).split('\n').join(' / ')}</span></>}
      status={<><span>{stamp(link.from)}</span><span>{link.to === null ? t('links.openEnd') : stamp(link.to)}</span>{!link.active && <span className="v-warn">{t('links.inactive')}</span>}</>}
      actions={<><button className="popover-row" onClick={() => setEdit({operation: 'correct', link, revision: inventory.revision})}>{t('links.correct')}</button><button className="popover-row" onClick={() => setEdit({operation: 'change', link, revision: inventory.revision})}>{t('links.change')}</button><button className="popover-row is-danger" onClick={() => setEdit({operation: 'delete', link, revision: inventory.revision})}>{t('links.delete')}</button></>}
    />)}</ul>
    </section>
    {(suggestions.length > 0 || pending) && <section className="settings-section"><h3>{t('links.suggestions')}</h3><p className="dialog-text">{t('links.suggestionHelp')}</p><ul className="settings-list">{(pending ? [pending.link, ...suggestions.filter(link => JSON.stringify(link) !== JSON.stringify(pending.link))] : suggestions).map(link => <li className="settings-list-row popover-row" key={JSON.stringify(link)}><span className="settings-item-main"><b>{clientName(link.clientId)} → {sourceName(link.sourceId)}</b><small>{deviceName(link.deviceId)}</small><small className="multiline">{condition(link)}</small><small className="multiline">{period(link)}</small></span><button className="button" disabled={busy} onClick={() => void linked(link)}>{t(pending?.link === link ? 'links.retry' : 'links.link')}</button></li>)}</ul></section>}
    {evidence.length > 0 && <section className="settings-section"><details className="disclosure"><summary>{t('links.attribution')}</summary><p className="dialog-text">{t('links.attributionHelp')}</p><ul className="settings-list">{evidence.map((session, i) => <li className="settings-list-row popover-row" key={i}><span className="settings-item-main"><b>{clientName(session.clientId)} → {sourceName(session.source)}</b><small>{deviceName(session.deviceId)}</small><small>{session.project ?? t('agents.noProject')}</small><small>{t(session.by === 'link' ? 'links.manual' : session.accountBy === 'inferred' ? 'links.inferred' : 'links.reported')}</small>{session.route && <small className="multiline">{condition({...draft(), route: session.route})}</small>}{session.accountSourceId && <small>{t('links.reportedSource', {source: sourceName(session.accountSourceId)})}</small>}{session.disagreement && <small className="v-warn">{t('links.disagreement')}</small>}{session.otherGateway && <small>{t('links.otherGateway')}</small>}{session.host && <small>{session.host}</small>}</span><button className="button" onClick={() => setEdit({operation: 'create', revision: inventory.revision, link: {...draft(), deviceId: session.deviceId, clientId: session.clientId, sourceId: session.source ?? '', route: session.route}})}>{t('links.create')}</button></li>)}</ul></details></section>}
    {edit && <LinkForm key={edit.operation + edit.link.id} edit={edit} inventory={inventory} onClose={() => setEdit(null)} onSaved={async () => {await load(); await readLive(); setEdit(null);}} reload={load} />}
  </>;
}

function LinkForm({edit, inventory, onClose, onSaved, reload}: {edit: Edit; inventory: Inventory; onClose: () => void; onSaved: () => Promise<void>; reload: () => Promise<Inventory | undefined>}) {
  const [initialFrom] = useState(() => {
    const now = Date.now();
    // A dated change starts inside the original period, including past and future rules.
    return edit.operation === 'change' && now >= edit.link.from && (edit.link.to === null || now < edit.link.to) ? now : edit.link.from;
  });
  const [link, setLink] = useState(edit.link), [from, setFrom] = useState(localDate(initialFrom)), [to, setTo] = useState(edit.link.to === null ? '' : localDate(edit.link.to));
  const [revision, setRevision] = useState(edit.revision), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const command = useRef<{fingerprint: string; body: object} | null>(null);
  const dates = useRef<HTMLDetailsElement>(null);
  const change = edit.operation === 'change', remove = edit.operation === 'delete';
  const source = inventory.sources.find(source => source.id === edit.link.sourceId)?.name ?? t('links.unavailableSource');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setError(null);
    const fromAt = from === localDate(initialFrom) ? initialFrom : new Date(from).getTime();
    const toAt = to ? edit.link.to !== null && to === localDate(edit.link.to) ? edit.link.to : new Date(to).getTime() : null;
    if (!remove && (!inventory.clients.includes(link.clientId) || !inventory.sources.some(source => source.id === link.sourceId) || !Number.isSafeInteger(fromAt) || fromAt < 0 || toAt !== null && (!Number.isSafeInteger(toAt) || toAt <= fromAt))) {if (dates.current) dates.current.open = true; setError(new ApiError(400, 'invalid_link')); return;}
    const data = remove ? {} : change ? {at: fromAt, newSourceId: link.sourceId} : {...link, from: fromAt, to: toAt};
    const fingerprint = JSON.stringify([data, revision]);
    if (command.current?.fingerprint !== fingerprint) command.current = {fingerprint, body: {...data, expectedRevision: revision, requestId: crypto.randomUUID()}};
    setBusy(true);
    try {await call(remove ? 'DELETE' : 'POST', '/api/links' + (edit.link.id ? '/' + edit.link.id : '') + (change ? '/change' : ''), command.current.body); await onSaved();}
    catch (failure) {if (failure instanceof ApiError && ['invalid_link', 'link_overlap'].includes(failure.code) && dates.current) dates.current.open = true; setError(failure);} finally {setBusy(false);}
  };
  return <Modal title={t(`links.${remove ? 'delete' : edit.operation}`)} restore={() => (edit.link.id ? document.getElementById('client-link-' + edit.link.id)?.querySelector<HTMLElement>('.picker > button') : null) ?? document.getElementById('create-client-link')} onClose={busy ? undefined : onClose}><form className="dialog-form client-link-form" onSubmit={event => void submit(event)} onInvalidCapture={event => (event.target as HTMLElement).closest('details')?.setAttribute('open', '')}>
    {edit.operation !== 'create' && <p className="dialog-text"><b>{clientName(edit.link.clientId)} → {source}</b><br />{period(edit.link).split('\n').join(' — ')}</p>}
    {edit.operation !== 'create' && <p className="dialog-text">{t(remove ? 'links.deleteEffect' : change ? 'links.changeEffect' : 'links.correctEffect')}</p>}
    {!remove && <>
      <fieldset className="form-fields" disabled={busy}>
        <div className="inline-form is-wrap">
          {!change && <SelectField label={t('links.client')} required autoFocus value={link.clientId} onChange={event => setLink({...link, clientId: event.target.value})}><option value="" disabled>{t('links.chooseClient')}</option>{inventory.clients.map(client => <option key={client} value={client}>{clientName(client)}</option>)}</SelectField>}
          <SelectField label={t('links.source')} required autoFocus={change} value={link.sourceId} onChange={event => setLink({...link, sourceId: event.target.value})}><option value="" disabled>{t('links.chooseSource')}</option>{link.sourceId && !inventory.sources.some(source => source.id === link.sourceId) && <option value={link.sourceId} disabled>{t('links.unavailableSource')}</option>}{inventory.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</SelectField>
        </div>
        {!change && <SelectField label={t('links.deviceScope')} value={link.deviceId ?? ''} onChange={event => setLink({...link, deviceId: event.target.value || null})}><option value="">{t('links.allDevices')}</option>{inventory.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</SelectField>}
        {change ? <><Field type="datetime-local" required label={t('links.changeAt')} value={from} onChange={event => setFrom(event.target.value)} /><small>{t('links.timezone', {zone: Intl.DateTimeFormat().resolvedOptions().timeZone})}</small></> : <>
          <details ref={dates} className="disclosure" open={edit.operation === 'correct'}><summary>{t('links.period')}<span className="disclosure-value">{from ? stamp(new Date(from).getTime()) : t('links.from')}{' — '}{to ? stamp(new Date(to).getTime()) : t('links.openEnd')}</span></summary>
            <div className="dialog-form"><div className="inline-form is-wrap"><Field type="datetime-local" required label={t('links.from')} value={from} onChange={event => setFrom(event.target.value)} /><Field type="datetime-local" label={t('links.to')} value={to} onChange={event => setTo(event.target.value)} /></div><small>{t('links.timezone', {zone: Intl.DateTimeFormat().resolvedOptions().timeZone})}</small></div>
          </details>
          <details className="disclosure" open={edit.link.route !== null}><summary>{t('links.condition')}<span className="disclosure-value multiline">{condition(link)}</span></summary><div className="dialog-form">
            <p className="dialog-text">{t('links.conditionAdvice')}</p>
            <div className="inline-form is-wrap"><SelectField label={t('links.routeType')} value={link.route?.class ?? ''} onChange={event => setLink({...link, route: event.target.value ? {class: event.target.value as 'api' | 'subscription' | 'unknown', provider: null} : null})}><option value="">{t('links.anyRoute')}</option>{(['subscription', 'api', 'unknown'] as const).map(value => <option key={value} value={value}>{t(`links.${value}`)}</option>)}</SelectField>
            {link.route && <SelectField label={t('links.provider')} value={link.route.provider ?? ''} onChange={event => setLink({...link, route: {...link.route!, provider: event.target.value || null}})}><option value="">{t('links.anyProvider')}</option>{catalogue.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</SelectField>}</div>
          </div></details>
        </>}
      </fieldset>
    </>}
    <ErrorLine error={error} />
    {error instanceof ApiError && ['links_changed', 'source_not_held'].includes(error.code) && <button className="button" type="button" onClick={() => void reload().then(data => {if (data) {setRevision(data.revision); command.current = null; setError(null);}})}>{t('links.reload')}</button>}
    <div className="button-row"><button type="button" className="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className={'button ' + (remove ? 'danger' : 'primary')} disabled={busy || !remove && (!inventory.clients.includes(link.clientId) || !inventory.sources.some(source => source.id === link.sourceId))}>{t(remove ? 'links.delete' : 'account.save')}</button></div>
  </form></Modal>;
}
