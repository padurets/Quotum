import {useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {clientName} from '../../server/domain/clients';
import {catalogue} from '../../server/domain/providers';
import type {Attribution, ClientLink, LinkInput} from '../../server/domain/links';
import {t} from '../i18n';
import {useConnectionsRevision, useDevicesRevision} from '../lib/board';
import {ApiError, call} from '../lib/http';
import {stamp} from '../lib/format';
import {navigate, settingsHref, useLocation} from '../lib/router';
import {ErrorLine, Field, Modal} from './Kit';

type Inventory = {revision: string; links: (ClientLink & {active: boolean})[]; clients: string[]; devices: {id: string; name: string}[]; sources: {id: string; provider: string; name: string}[]};
type Evidence = Attribution & {deviceId: string; clientId: string; project: string | null; accountSourceId: string | null; host?: string};
type Edit = {operation: 'create' | 'correct' | 'change' | 'delete'; link: LinkInput & {id?: string}; revision: string};
const localDate = (at: number) => {const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);};
const condition = (link: LinkInput) => link.route ? t(`links.${link.route.class}`) + (link.route.provider ? '\n' + (catalogue.find(p => p.id === link.route!.provider)?.name ?? link.route.provider) : '') : t('links.anyRoute');
const period = (link: LinkInput) => stamp(link.from) + '\n' + (link.to === null ? t('links.openEnd') : stamp(link.to));

/** Entry points carry a draft context. Opening them never creates a rule. */
export function openClientLinks(context?: {deviceId: string; clientId?: string; route?: Evidence['route']}, sourceId?: string) {
  const url = new URL(settingsHref('/settings/connections'), location.origin);
  url.searchParams.set('links', '1');
  if (context) {url.searchParams.set('device', context.deviceId); if (context.clientId) url.searchParams.set('client', context.clientId);
    if (context.route) {url.searchParams.set('route', context.route.class); if (context.route.provider) url.searchParams.set('provider', context.route.provider);}}
  if (sourceId) url.searchParams.set('source', sourceId);
  navigate(url.pathname + url.search + '#client-links');
}

export function ClientLinks({userId}: {userId: string}) {
  const location = useLocation(), params = new URLSearchParams(location.split('?')[1]);
  const [open, setOpen] = useState(params.has('links'));
  useEffect(() => {if (params.has('links')) setOpen(true);}, [location]);
  return <section className="settings-section" id="client-links">
    <div className="settings-section-head"><h2>{t('links.title')}</h2><button className="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>{t(open ? 'links.close' : 'links.manage')}</button></div>
    <p className="dialog-text">{t('links.description')}</p>
    {open && <LinkManager key={JSON.stringify([userId, ...['device', 'client', 'route', 'provider', 'source'].map(key => params.get(key))])} context={params} />}
  </section>;
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
  const draft = (data: Inventory): LinkInput => ({clientId: data.clients[0] ?? 'codex', deviceId: null, sourceId: data.sources[0]?.id ?? '', route: null, from: Date.now(), to: null});
  useEffect(() => {
    if (!inventory || seeded.current) return; seeded.current = true;
    if (context.has('device') || context.has('source')) {
      const deviceId = inventory.devices.find(device => device.id === context.get('device'))?.id ?? null;
      const clientId = inventory.clients.find(client => client === context.get('client')) ?? draft(inventory).clientId;
      const sourceId = inventory.sources.find(source => source.id === context.get('source'))?.id ?? draft(inventory).sourceId;
      const route = ['api', 'subscription', 'unknown'].includes(context.get('route') ?? '') ? {class: context.get('route') as 'api' | 'subscription' | 'unknown', provider: catalogue.some(p => p.id === context.get('provider')) ? context.get('provider') : null} : null;
      setEdit({operation: 'create', revision: inventory.revision, link: {...draft(inventory), clientId, deviceId, sourceId, route}});
    }
  }, [inventory, context]);
  if (!inventory) return <ErrorLine error={error} />;
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
    <div className="button-row is-start"><button className="button" disabled={!inventory.sources.length} onClick={() => setEdit({operation: 'create', revision: inventory.revision, link: draft(inventory)})}>{t('links.create')}</button><button className="button" onClick={() => void reset()}>{t('links.reload')}</button></div>
    <ErrorLine error={error} />
    {!inventory.links.length && <p className="admin-empty">{t('links.empty')}</p>}
    <ul className="settings-list">{inventory.links.map(link => <li className="settings-list-row popover-row" key={link.id}>
      <span className="settings-item-main"><b>{clientName(link.clientId)}</b><small>{deviceName(link.deviceId)}</small><small className="multiline">{condition(link)}</small><small className="multiline">{period(link)}</small><small className={link.active ? '' : 'warn'}>{link.active ? sourceName(link.sourceId) : t('links.inactive')}</small></span>
      <span className="button-row"><button className="button" onClick={() => setEdit({operation: 'correct', link, revision: inventory.revision})}>{t('links.correct')}</button><button className="button" onClick={() => setEdit({operation: 'change', link, revision: inventory.revision})}>{t('links.change')}</button><button className="button danger" onClick={() => setEdit({operation: 'delete', link, revision: inventory.revision})}>{t('sources.remove')}</button></span>
    </li>)}</ul>
    {(suggestions.length > 0 || pending) && <><h3>{t('links.suggestions')}</h3><ul className="settings-list">{(pending ? [pending.link, ...suggestions.filter(link => JSON.stringify(link) !== JSON.stringify(pending.link))] : suggestions).map(link => <li className="settings-list-row popover-row" key={JSON.stringify(link)}><span className="settings-item-main"><b>{clientName(link.clientId)}</b><small>{deviceName(link.deviceId)}</small><small className="multiline">{condition(link)}</small><small>{sourceName(link.sourceId)}</small><small className="multiline">{period(link)}</small></span><button className="button" disabled={busy} onClick={() => void linked(link)}>{t(pending?.link === link ? 'links.retry' : 'links.link')}</button></li>)}</ul></>}
    {evidence.length > 0 && <details><summary>{t('links.attribution')}</summary><ul className="settings-list">{evidence.map((session, i) => <li className="settings-list-row popover-row" key={i}><span className="settings-item-main"><b>{clientName(session.clientId)}</b><small>{deviceName(session.deviceId)}</small><small>{session.project ?? t('agents.noProject')}</small><small>{sourceName(session.source)}</small><small>{t(session.by === 'link' ? 'links.manual' : session.accountBy === 'inferred' ? 'links.inferred' : 'links.reported')}</small>{session.route && <small>{condition({...draft(inventory), route: session.route})}</small>}{session.accountSourceId && <small>{t('links.reportedSource', {source: sourceName(session.accountSourceId)})}</small>}{session.disagreement && <small className="warn">{t('links.disagreement')}</small>}{session.otherGateway && <small>{t('links.otherGateway')}</small>}{session.host && <small>{session.host}</small>}</span><button className="button" onClick={() => setEdit({operation: 'create', revision: inventory.revision, link: {...draft(inventory), deviceId: session.deviceId, clientId: session.clientId, route: session.route}})}>{t('links.create')}</button></li>)}</ul></details>}
    {edit && <LinkForm key={edit.operation + edit.link.id} edit={edit} inventory={inventory} onClose={() => setEdit(null)} onSaved={async () => {setEdit(null); await load(); await readLive();}} reload={load} />}
  </>;
}

function Select({label, value, onChange, disabled, children}: {label: string; value: string; onChange: (value: string) => void; disabled?: boolean; children: ReactNode}) {
  return <label className="field"><span>{label}</span><select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{children}</select></label>;
}

function LinkForm({edit, inventory, onClose, onSaved, reload}: {edit: Edit; inventory: Inventory; onClose: () => void; onSaved: () => Promise<void>; reload: () => Promise<Inventory | undefined>}) {
  const [link, setLink] = useState(edit.link), [from, setFrom] = useState(localDate(edit.operation === 'change' ? Math.max(edit.link.from, Date.now()) : edit.link.from)), [to, setTo] = useState(edit.link.to === null ? '' : localDate(edit.link.to));
  const [revision, setRevision] = useState(edit.revision), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const command = useRef<{fingerprint: string; body: object} | null>(null);
  const change = edit.operation === 'change', remove = edit.operation === 'delete';
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setError(null);
    const fromAt = !change && from === localDate(edit.link.from) ? edit.link.from : new Date(from).getTime();
    const toAt = to ? edit.link.to !== null && to === localDate(edit.link.to) ? edit.link.to : new Date(to).getTime() : null;
    if (!remove && (!Number.isSafeInteger(fromAt) || fromAt < 0 || toAt !== null && (!Number.isSafeInteger(toAt) || toAt <= fromAt))) {setError(new ApiError(400, 'invalid_link')); return;}
    const data = remove ? {} : change ? {at: fromAt, newSourceId: link.sourceId} : {...link, from: fromAt, to: toAt};
    const fingerprint = JSON.stringify([data, revision]);
    if (command.current?.fingerprint !== fingerprint) command.current = {fingerprint, body: {...data, expectedRevision: revision, requestId: crypto.randomUUID()}};
    setBusy(true);
    try {await call(remove ? 'DELETE' : 'POST', '/api/links' + (edit.link.id ? '/' + edit.link.id : '') + (change ? '/change' : ''), command.current.body); await onSaved();}
    catch (failure) {setError(failure);} finally {setBusy(false);}
  };
  return <Modal title={t(`links.${remove ? 'delete' : edit.operation}`)} onClose={onClose}><form className="dialog-form" onSubmit={event => void submit(event)}>
    <p className="dialog-text">{t(remove ? 'links.deleteEffect' : change ? 'links.changeEffect' : edit.operation === 'correct' ? 'links.correctEffect' : 'links.conditionAdvice')}</p>
    {!remove && <>
      {!change && <><Select label={t('links.client')} value={link.clientId} onChange={clientId => setLink({...link, clientId})}>{inventory.clients.map(client => <option key={client} value={client}>{clientName(client)}</option>)}</Select>
        <Select label={t('devices.title')} value={link.deviceId ?? ''} onChange={deviceId => setLink({...link, deviceId: deviceId || null})}><option value="">{t('links.allDevices')}</option>{inventory.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</Select>
        <Select label={t('links.condition')} value={link.route?.class ?? ''} onChange={value => setLink({...link, route: value ? {class: value as 'api' | 'subscription' | 'unknown', provider: null} : null})}><option value="">{t('links.anyRoute')}</option>{(['subscription', 'api', 'unknown'] as const).map(value => <option key={value} value={value}>{t(`links.${value}`)}</option>)}</Select>
        {link.route && <Select label={t('links.provider')} value={link.route.provider ?? ''} onChange={provider => setLink({...link, route: {...link.route!, provider: provider || null}})}><option value="">{t('links.anyProvider')}</option>{catalogue.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select>}</>}
      <Select label={t('links.source')} value={link.sourceId} onChange={sourceId => setLink({...link, sourceId})}>{!inventory.sources.some(source => source.id === link.sourceId) && <option value={link.sourceId} disabled>{t('links.inactive')}</option>}{inventory.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</Select>
      <Field type="datetime-local" required label={t(change ? 'links.changeAt' : 'links.from')} value={from} onChange={event => setFrom(event.target.value)} />
      {!change && <Field type="datetime-local" label={t('links.to')} value={to} onChange={event => setTo(event.target.value)} />}
      <small>{Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
    </>}
    <ErrorLine error={error} />
    {error instanceof ApiError && error.status === 409 && <button className="button" type="button" onClick={() => void reload().then(data => {if (data) {setRevision(data.revision); command.current = null; setError(null);}})}>{t('links.reload')}</button>}
    <div className="button-row"><button type="button" className="button" onClick={onClose}>{t('common.cancel')}</button><button className={'button ' + (remove ? 'danger' : 'primary')} disabled={busy || !remove && !inventory.sources.some(source => source.id === link.sourceId)}>{t(remove ? 'sources.remove' : 'account.save')}</button></div>
  </form></Modal>;
}
