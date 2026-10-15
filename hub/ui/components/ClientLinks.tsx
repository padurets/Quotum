import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {clientName} from '../../server/domain/clients';
import {catalogue} from '../../server/domain/providers';
import {resolveLink, type Attribution, type ClientLink, type LinkInput} from '../../server/domain/links';
import {t} from '../i18n';
import {useConnectionsRevision, useDevicesRevision} from '../lib/board';
import {ApiError, call} from '../lib/http';
import {stamp} from '../lib/format';
import {useClock} from '../lib/clock';
import {navigate, settingsHref, useLocation} from '../lib/router';
import {ErrorLine, Field, Modal, SelectField} from './Kit';
import {ConnectionRow} from './Connections';
import {logoOf} from './logos';

type LinkSource = {id: string; provider: string; name: string};
type Inventory = {revision: string; links: (ClientLink & {active: boolean})[]; clients: string[]; devices: {id: string; name: string}[]; sources: LinkSource[]; targets?: LinkSource[]};
type Evidence = Attribution & {deviceId: string; clientId: string; project: string | null; accountSourceId: string | null; host?: string};
type Edit = {operation: 'create' | 'edit' | 'delete'; link: LinkInput & {id?: string}; revision: string};
const localDate = (at: number) => {const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);};
const condition = (link: LinkInput) => link.route ? t(`links.${link.route.class}`) + (link.route.provider ? '\n' + (catalogue.find(p => p.id === link.route!.provider)?.name ?? link.route.provider) : '') : t('links.anyRoute');
const period = (link: LinkInput) => stamp(link.from) + '\n' + (link.to === null ? t('links.openEnd') : stamp(link.to));
const targetOf = (inventory: Inventory, id: string | null) => inventory.sources.find(source => source.id === id) ?? inventory.targets?.find(source => source.id === id);

/** Contextual entry points edit the same winning rule as the live session. */
function contextualLink(inventory: Inventory, deviceId: string | null, clientId: string, route: LinkInput['route']) {
  if (!deviceId || !clientId) return undefined;
  const attribution = resolveLink({deviceId, clientId, source: null, route: route ? {...route, by: 'session', host: null} : null}, {
    links: inventory.links, held: new Map(inventory.sources.map(source => [source.id, source.provider])), routeEnabled: true,
  }, Date.now());
  return inventory.links.find(link => link.id === attribution.linkId);
}

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
      const existing = contextualLink(inventory, deviceId, clientId, route);
      setEdit({operation: existing ? 'edit' : 'create', revision: inventory.revision, link: existing ?? {...draft(), clientId, deviceId, sourceId, route}});
    }
  }, [inventory, context]);
  const now = useClock(at => {
    let next = Infinity;
    for (const link of inventory?.links ?? []) for (const boundary of [link.from, link.to]) if (boundary !== null && boundary > at) next = Math.min(next, boundary);
    return Number.isFinite(next) ? next : null;
  }, [inventory?.links]);
  if (!inventory) return <section className="settings-section"><h2>{t('links.title')}</h2><p role="status">{t('links.loading')}</p><ErrorLine error={error} /></section>;
  const sourceName = (id: string | null) => targetOf(inventory, id)?.name ?? t('agents.unknownSource');
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
  const rows = (links: Inventory['links']) => <ul className="connections-list client-links-list">{links.map(link => <ConnectionRow key={link.id} id={'client-link-' + link.id}
      name={clientName(link.clientId) + ' → ' + sourceName(link.sourceId)}
      icon={<img src={logoOf(targetOf(inventory, link.sourceId)?.provider ?? 'unknown')} alt="" />}
      detail={<><span>{deviceName(link.deviceId)}</span><span>{condition(link).split('\n').join(' / ')}</span></>}
      status={<><span>{stamp(link.from)}</span><span>{link.to === null ? t('links.openEnd') : stamp(link.to)}</span>{!link.active && <span className="v-warn">{t('sources.disconnected')}</span>}</>}
      actions={<><button className="popover-row" onClick={() => setEdit({operation: 'edit', link, revision: inventory.revision})}>{t('links.edit')}</button><button className="popover-row is-danger" onClick={() => setEdit({operation: 'delete', link, revision: inventory.revision})}>{t('links.delete')}</button></>}
    />)}</ul>;
  const current = inventory.links.filter(link => link.from <= now && (link.to === null || now < link.to)), future = inventory.links.filter(link => link.from > now), past = inventory.links.filter(link => link.to !== null && link.to <= now);
  return <>
    <section className="settings-section">
    <div className="settings-section-head"><h2>{t('links.title')}</h2><button id="create-client-link" className="button primary" disabled={!inventory.sources.length} onClick={() => setEdit({operation: 'create', revision: inventory.revision, link: draft()})}>{t('links.create')}</button></div>
    <p className="dialog-text">{t('links.description')}</p>
    {!inventory.sources.length && <><p className="dialog-text">{t('links.noSources')}</p><div><button className="button" onClick={() => navigate(settingsHref('/settings/connections'))}>{t('settings.connections')}</button></div></>}
    <div className="settings-section-head"><h3>{t('links.saved')}</h3><button className="link-button" onClick={() => void reset()}>{t('links.reload')}</button></div>
    <ErrorLine error={error} />
    {!current.length && <p className="admin-empty">{t(inventory.links.length ? 'links.noCurrent' : 'links.empty')}</p>}
    {rows(current)}
    </section>
    {!!future.length && <section className="settings-section"><h3>{t('links.planned')}</h3>{rows(future)}</section>}
    {!!past.length && <section className="settings-section"><details className="disclosure"><summary>{t('links.history')}</summary>{rows(past)}</details></section>}
    {(suggestions.length > 0 || pending) && <section className="settings-section"><h3>{t('links.suggestions')}</h3><p className="dialog-text">{t('links.suggestionHelp')}</p><ul className="settings-list">{(pending ? [pending.link, ...suggestions.filter(link => JSON.stringify(link) !== JSON.stringify(pending.link))] : suggestions).map(link => <li className="settings-list-row popover-row" key={JSON.stringify(link)}><span className="settings-item-main"><b>{clientName(link.clientId)} → {sourceName(link.sourceId)}</b><small>{deviceName(link.deviceId)}</small><small className="multiline">{condition(link)}</small><small className="multiline">{period(link)}</small></span><button className="button" disabled={busy} onClick={() => void linked(link)}>{t(pending?.link === link ? 'links.retry' : 'links.link')}</button></li>)}</ul></section>}
    {evidence.length > 0 && <section className="settings-section"><details className="disclosure"><summary>{t('links.attribution')}</summary><p className="dialog-text">{t('links.attributionHelp')}</p><ul className="settings-list">{evidence.map((session, i) => <li className="settings-list-row popover-row" key={i}><span className="settings-item-main"><b>{clientName(session.clientId)} → {sourceName(session.source)}</b><small>{deviceName(session.deviceId)}</small><small>{session.project ?? t('agents.noProject')}</small><small>{t(session.by === 'link' ? 'links.manual' : session.accountBy === 'inferred' ? 'links.inferred' : 'links.reported')}</small>{session.route && <small className="multiline">{condition({...draft(), route: session.route})}</small>}{session.accountSourceId && <small>{t('links.reportedSource', {source: sourceName(session.accountSourceId)})}</small>}{session.disagreement && <small className="v-warn">{t('links.disagreement')}</small>}{session.otherGateway && <small>{t('links.otherGateway')}</small>}{session.host && <small>{session.host}</small>}</span><button className="button" onClick={() => {
      const existing = inventory.links.find(link => link.id === session.linkId);
      setEdit({operation: existing ? 'edit' : 'create', revision: inventory.revision, link: existing ?? {...draft(), deviceId: session.deviceId, clientId: session.clientId, sourceId: session.source ?? '', route: session.route}});
    }}>{t('links.manage')}</button></li>)}</ul></details></section>}
    {edit && <LinkForm key={edit.operation + edit.link.id} edit={edit} inventory={inventory} onClose={() => setEdit(null)} onSaved={async () => {await load(); await readLive(); setEdit(null);}} reload={load} />}
  </>;
}

function LinkForm({edit, inventory, onClose, onSaved, reload}: {edit: Edit; inventory: Inventory; onClose: () => void; onSaved: () => Promise<void>; reload: () => Promise<Inventory | undefined>}) {
  const [openedAt] = useState(Date.now), existing = edit.operation === 'edit', remove = edit.operation === 'delete';
  const [starts, setStarts] = useState<'now' | 'original' | 'date'>(() => existing && !(edit.link.from <= openedAt && (edit.link.to === null || openedAt < edit.link.to)) ? 'original' : 'now');
  const [link, setLink] = useState(edit.link), [from, setFrom] = useState(localDate(edit.link.from)), [to, setTo] = useState(edit.link.to === null ? '' : localDate(edit.link.to));
  const [revision, setRevision] = useState(edit.revision), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const command = useRef<{fingerprint: string; url: string; body: object} | null>(null), dates = useRef<HTMLDetailsElement>(null);
  const source = targetOf(inventory, edit.link.sourceId), start = starts === 'original' ? edit.link.from : starts === 'now' ? openedAt : from === localDate(edit.link.from) ? edit.link.from : new Date(from).getTime();
  const end = to ? edit.link.to !== null && to === localDate(edit.link.to) ? edit.link.to : new Date(to).getTime() : null;
  const changed = !existing || link.clientId !== edit.link.clientId || link.sourceId !== edit.link.sourceId || link.deviceId !== edit.link.deviceId || JSON.stringify(link.route) !== JSON.stringify(edit.link.route) || end !== edit.link.to || start < edit.link.from;
  const effect = existing && (starts === 'now' || start > edit.link.from) ? 'links.datedEffect' : 'links.periodEffect';
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || !remove && !changed) return; setError(null);
    // The choice "from saving" is captured once, including after a lost reply.
    const fingerprint = JSON.stringify([link, starts, from, to, revision]);
    if (command.current?.fingerprint !== fingerprint) {
      const at = starts === 'now' ? Date.now() : start;
      if (!remove && (!inventory.clients.includes(link.clientId) || !inventory.sources.some(source => source.id === link.sourceId) || !Number.isSafeInteger(at) || at < 0 || end !== null && (!Number.isSafeInteger(end) || end <= at) || existing && at > edit.link.from && edit.link.to !== null && at >= edit.link.to)) {
        if (dates.current) dates.current.open = true; setError(new ApiError(400, 'invalid_link')); return;
      }
      const dated = existing && at > edit.link.from;
      const data = remove ? {} : dated ? {at, newSourceId: link.sourceId, clientId: link.clientId, deviceId: link.deviceId, route: link.route, to: end} : {...link, from: at, to: end};
      command.current = {fingerprint, url: '/api/links' + (edit.link.id ? '/' + edit.link.id : '') + (dated ? '/change' : ''), body: {...data, expectedRevision: revision, requestId: crypto.randomUUID()}};
    }
    setBusy(true);
    try {await call(remove ? 'DELETE' : 'POST', command.current.url, command.current.body); await onSaved();}
    catch (failure) {if (failure instanceof ApiError && ['invalid_link', 'link_overlap'].includes(failure.code) && dates.current) dates.current.open = true; setError(failure);} finally {setBusy(false);}
  };
  return <Modal title={t(`links.${remove ? 'delete' : edit.operation}`)} restore={() => {
    const button = edit.link.id ? document.getElementById('client-link-' + edit.link.id)?.querySelector<HTMLElement>('.picker > button') : null;
    return button?.getClientRects().length ? button : document.getElementById('create-client-link');
  }} onClose={busy ? undefined : onClose}><form className="dialog-form client-link-form" onSubmit={event => void submit(event)} onInvalidCapture={event => (event.target as HTMLElement).closest('details')?.setAttribute('open', '')}>
    {remove ? <><p className="dialog-text"><b>{clientName(edit.link.clientId)} → {source?.name ?? t('agents.unknownSource')}</b><br />{period(edit.link).split('\n').join(' — ')}</p><p className="dialog-text">{t('links.deleteEffect')}</p></> : <>
      <fieldset className="form-fields" disabled={busy}>
        <div className="inline-form is-wrap">
          <SelectField label={t('links.client')} required autoFocus value={link.clientId} onChange={event => setLink({...link, clientId: event.target.value})}><option value="" disabled>{t('links.chooseClient')}</option>{inventory.clients.map(client => <option key={client} value={client}>{clientName(client)}</option>)}</SelectField>
          <SelectField label={t('links.source')} required value={link.sourceId} onChange={event => setLink({...link, sourceId: event.target.value})}><option value="" disabled>{t('links.chooseSource')}</option>{link.sourceId && !inventory.sources.some(source => source.id === link.sourceId) && <option value={link.sourceId} disabled>{targetOf(inventory, link.sourceId)?.name ?? t('agents.unknownSource')} ({t('sources.disconnected')})</option>}{inventory.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</SelectField>
        </div>
        <details ref={dates} className="disclosure"><summary>{t('links.period')}<span className="disclosure-value">{starts === 'now' ? t('currencies.fromNow') : Number.isFinite(start) ? stamp(start) : t('links.from')}{' — '}{end !== null && Number.isFinite(end) ? stamp(end) : t('links.openEnd')}</span></summary>
          <div className="dialog-form">
            <SelectField label={t('links.from')} value={starts} onChange={event => setStarts(event.target.value as typeof starts)}><option value="now">{t('currencies.fromNow')}</option>{existing && <option value="original">{t('links.fromOriginal', {time: stamp(edit.link.from)})}</option>}<option value="date">{t('links.fromDate')}</option></SelectField>
            {starts === 'date' && <Field type="datetime-local" required label={t('links.date')} value={from} onChange={event => setFrom(event.target.value)} />}
            <Field type="datetime-local" label={t('links.to')} value={to} onChange={event => setTo(event.target.value)} />
            <small>{t('links.timezone', {zone: Intl.DateTimeFormat().resolvedOptions().timeZone})}</small>
          </div>
        </details>
        <details className="disclosure"><summary>{t('links.scope')}<span className="disclosure-value">{link.deviceId === null ? t('links.allDevices') : inventory.devices.find(device => device.id === link.deviceId)?.name ?? t('devices.title')}<br />{condition(link).split('\n').join(' / ')}</span></summary><div className="dialog-form">
          <SelectField label={t('links.deviceScope')} value={link.deviceId ?? ''} onChange={event => setLink({...link, deviceId: event.target.value || null})}><option value="">{t('links.allDevices')}</option>{inventory.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</SelectField>
          <SelectField label={t('links.routeType')} value={link.route?.class ?? ''} onChange={event => setLink({...link, route: event.target.value ? {class: event.target.value as 'api' | 'subscription' | 'unknown', provider: null} : null})}><option value="">{t('links.anyRoute')}</option>{(['subscription', 'api', 'unknown'] as const).map(value => <option key={value} value={value}>{t(`links.${value}`)}</option>)}</SelectField>
          {link.route && <SelectField label={t('links.provider')} value={link.route.provider ?? ''} onChange={event => setLink({...link, route: {...link.route!, provider: event.target.value || null}})}><option value="">{t('links.anyProvider')}</option>{catalogue.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</SelectField>}
          <small>{t('links.conditionAdvice')}</small>
        </div></details>
      </fieldset>
      {existing && <p className="dialog-text">{t(effect, {time: starts === 'now' ? t('currencies.fromNow') : Number.isFinite(start) ? stamp(start) : t('links.from')})}</p>}
    </>}
    <ErrorLine error={error} />
    {error instanceof ApiError && ['links_changed', 'source_not_held'].includes(error.code) && <button className="button" type="button" onClick={() => void reload().then(data => {if (data) {setRevision(data.revision); command.current = null; setError(null);}})}>{t('links.reload')}</button>}
    <div className="button-row"><button type="button" className="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className={'button ' + (remove ? 'danger' : 'primary')} disabled={busy || !remove && (!changed || !inventory.clients.includes(link.clientId) || !inventory.sources.some(source => source.id === link.sourceId))}>{t(remove ? 'links.delete' : 'account.save')}</button></div>
  </form></Modal>;
}
