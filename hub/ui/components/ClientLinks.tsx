import {ChevronDown} from 'lucide-react';
import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {clientName} from '../../server/domain/clients';
import {catalogue} from '../../server/domain/providers';
import {resolveLink, type Attribution, type ClientLink, type LinkInput} from '../../server/domain/links';
import {t} from '../i18n';
import {useConnectionsRevision, useDevicesRevision} from '../lib/board';
import {ApiError, call} from '../lib/http';
import {stamp} from '../lib/format';
import {useClock} from '../lib/clock';
import {widgetKind} from '../lib/widgetKind';
import {navigate, settingsHref, useLocation} from '../lib/router';
import {ErrorLine, Field, Modal, Segmented, SelectField} from './Kit';
import {Popover, PopoverHeading} from './Popover';
import {ConnectionRow} from './Connections';
import type {LiveSession} from '../lib/types';

type LinkSource = {id: string; provider: string; name: string};
export type LinkInventory = {revision: string; links: (ClientLink & {active: boolean})[]; clients: string[]; devices: {id: string; name: string}[]; sources: LinkSource[]; targets?: LinkSource[]};
export type LinkEvidence = Attribution & {accountSourceId: string | null; host?: string};
type Edit = {operation: 'create' | 'edit' | 'delete'; link: LinkInput & {id?: string}; revision: string};
const localDate = (at: number) => {const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);};
const condition = (link: Pick<LinkInput, 'route'>) => link.route ? t(`links.${link.route.class}`) + (link.route.provider ? '\n' + (catalogue.find(p => p.id === link.route!.provider)?.name ?? link.route.provider) : '') : t('links.anyRoute');
const period = (link: LinkInput) => stamp(link.from) + '\n' + (link.to === null ? t('links.openEnd') : stamp(link.to));
const choiceName = (source?: LinkSource) => source ? `${t(widgetKind(source.id, source.provider))}: ${source.name}` : t('agents.unknownSource');
const targetOf = (inventory: LinkInventory, id: string | null) => inventory.sources.find(source => source.id === id) ?? inventory.targets?.find(source => source.id === id);

/** Contextual entry points edit the same winning rule as the live session. */
function contextualLink(inventory: LinkInventory, deviceId: string | null, clientId: string, route: LinkInput['route']) {
  if (!deviceId || !clientId) return undefined;
  const attribution = resolveLink({deviceId, clientId, source: null, route: route ? {...route, by: 'session', host: null} : null}, {
    links: inventory.links, held: new Map(inventory.sources.map(source => [source.id, source.provider])), routeEnabled: true,
  }, Date.now());
  return inventory.links.find(link => link.id === attribution.linkId);
}

/** Entry points carry a draft context. Opening them never creates a rule. */
export function openClientLinks(context?: {deviceId: string; clientId?: string; route?: LinkEvidence['route']}, sourceId?: string) {
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
  const revision = useConnectionsRevision();
  const [inventory, setInventory] = useState<LinkInventory | null>(null), [history, setHistory] = useState(false);
  const [error, setError] = useState<unknown>(null), [edit, setEdit] = useState<Edit | null>(null);
  const generation = useRef(0), seeded = useRef(false);
  const load = useCallback(async () => {
    const own = ++generation.current;
    try {const data = await call<LinkInventory>('GET', '/api/links'); if (own === generation.current) {setInventory(data); setError(null); return data;}}
    catch (failure) {if (own === generation.current) setError(failure);}
  }, []);
  useEffect(() => {void load();}, [load, revision]);
  useEffect(() => () => {++generation.current;}, []);
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
  if (!inventory) return <section className="settings-section"><h2>{t('links.title')}</h2>{error ? <><ErrorLine error={error}/><button className="button" onClick={() => void load()}>{t('links.reload')}</button></> : <p role="status">{t('links.loading')}</p>}</section>;
  const sourceName = (id: string | null) => targetOf(inventory, id)?.name ?? t('agents.unknownSource');
  const deviceName = (id: string | null) => id === null ? t('links.allDevices') : inventory.devices.find(device => device.id === id)?.name ?? t('devices.title');
  const rows = (links: LinkInventory['links']) => <ul className="settings-list">{links.map(link => <ConnectionRow key={link.id} id={'client-link-' + link.id}
      name={clientName(link.clientId) + ' → ' + sourceName(link.sourceId)}
      onOpen={() => setEdit({operation: 'edit', link, revision: inventory.revision})}
      detail={<><span>{deviceName(link.deviceId)}</span>{link.route && <><br /><span>{condition(link).split('\n').join(' / ')}</span></>}</>}
      status={<><span>{t(link.from > now ? 'links.scheduledFrom' : 'links.startedFrom', {at: stamp(link.from)})}</span>{link.to !== null && <small>{t('links.endsOn', {at: stamp(link.to)})}</small>}{!link.active && <small className="v-warn">{t('sources.disconnected')}</small>}</>}
      actions={<><button className="popover-row" onClick={() => setEdit({operation: 'edit', link, revision: inventory.revision})}>{t('links.edit')}</button><button className="popover-row is-danger" onClick={() => setEdit({operation: 'delete', link, revision: inventory.revision})}>{t('links.delete')}</button></>}
    />)}</ul>;
  const shown = inventory.links.filter(link => history ? link.to !== null && link.to <= now : link.to === null || link.to > now);
  return <section className="settings-section">
    <div className="settings-section-head"><h2>{t('links.title')}</h2><button id="create-client-link" className="button primary" disabled={!inventory.sources.length} onClick={() => setEdit({operation: 'create', revision: inventory.revision, link: draft()})}>{t('links.create')}</button></div>
    <p className="dialog-text">{t('links.description')}</p>
    {!inventory.sources.length && <><p className="dialog-text">{t('links.noSources')}</p><div><button className="button" onClick={() => navigate(settingsHref('/settings/connections'))}>{t('settings.connections')}</button></div></>}
    <div className="settings-section-head"><Segmented options={[['links', t('links.saved')], ['history', t('links.history')]]} value={history ? 'history' : 'links'} onChange={value => setHistory(value === 'history')} label={t('links.list')} /></div>
    <ErrorLine error={error} />
    {!!error && <button className="button" onClick={() => void load()}>{t('links.reload')}</button>}
    {!shown.length && <p className="admin-empty">{t(history ? 'links.emptyHistory' : inventory.links.length ? 'links.noCurrent' : 'links.empty')}</p>}
    {rows(shown)}
    {edit && <LinkForm key={edit.operation + edit.link.id} edit={edit} inventory={inventory} onClose={() => setEdit(null)} onSaved={async () => {await load(); setEdit(null);}} reload={load} />}
  </section>;
}

function LinkForm({edit, inventory, onClose, onSaved, reload}: {edit: Edit; inventory: LinkInventory; onClose: () => void; onSaved: () => Promise<void>; reload: () => Promise<LinkInventory | undefined>}) {
  const [openedAt] = useState(Date.now), existing = edit.operation === 'edit', remove = edit.operation === 'delete';
  const [starts, setStarts] = useState<'now' | 'original' | 'date'>(() => existing && !(edit.link.from <= openedAt && (edit.link.to === null || openedAt < edit.link.to)) ? 'original' : 'now');
  const [link, setLink] = useState(edit.link), [from, setFrom] = useState(localDate(edit.link.from)), [to, setTo] = useState(edit.link.to === null ? '' : localDate(edit.link.to));
  const [revision, setRevision] = useState(edit.revision), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const command = useRef<{fingerprint: string; url: string; body: object} | null>(null);
  const presence = useDevicesRevision(), [suggestions, setSuggestions] = useState<LinkInput[]>([]);
  useEffect(() => {
    if (existing || remove) return;
    let current = true;
    call<{suggestions: LinkInput[]}>('GET', '/api/links/suggestions').then(data => {if (current) setSuggestions(data.suggestions);}, () => {if (current) setSuggestions([]);});
    return () => {current = false;};
  }, [existing, remove, presence, inventory.revision]);
  const candidates = suggestions.filter(candidate => candidate.clientId === link.clientId && candidate.deviceId === link.deviceId && (!link.route || candidate.route?.class === link.route.class && candidate.route.provider === link.route.provider));
  const recommendation = candidates.length === 1 ? candidates[0] : null;
  const chooseSource = (sourceId: string) => {
    if (recommendation?.sourceId === sourceId) {
      setLink({...recommendation}); setStarts('date'); setFrom(localDate(recommendation.from)); setTo(recommendation.to === null ? '' : localDate(recommendation.to));
    } else setLink({...link, sourceId});
  };
  const original = existing ? edit.link : link;
  const source = targetOf(inventory, edit.link.sourceId), start = starts === 'now' ? openedAt : from === localDate(original.from) ? original.from : new Date(from).getTime();
  const end = to ? original.to !== null && to === localDate(original.to) ? original.to : new Date(to).getTime() : null;
  const changed = !existing || link.clientId !== edit.link.clientId || link.sourceId !== edit.link.sourceId || link.deviceId !== edit.link.deviceId || JSON.stringify(link.route) !== JSON.stringify(edit.link.route) || end !== edit.link.to || starts === 'original' && start !== edit.link.from || start < edit.link.from;
  const effect = existing && starts !== 'original' && (starts === 'now' || start > edit.link.from) ? 'links.datedEffect' : 'links.periodEffect';
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || !remove && !changed) return; setError(null);
    // The choice "from saving" is captured once, including after a lost reply.
    const fingerprint = JSON.stringify([link, starts, from, to, revision]);
    if (command.current?.fingerprint !== fingerprint) {
      const at = starts === 'now' ? Date.now() : start;
      if (!remove && (!inventory.clients.includes(link.clientId) || !inventory.sources.some(source => source.id === link.sourceId) || !Number.isSafeInteger(at) || at < 0 || end !== null && (!Number.isSafeInteger(end) || end <= at) || existing && starts !== 'original' && at > edit.link.from && edit.link.to !== null && at >= edit.link.to)) {
        setError(new ApiError(400, 'invalid_link')); return;
      }
      const dated = existing && starts !== 'original' && at > edit.link.from;
      const data = remove ? {} : dated ? {at, newSourceId: link.sourceId, clientId: link.clientId, deviceId: link.deviceId, route: link.route, to: end} : {...link, from: at, to: end};
      command.current = {fingerprint, url: '/api/links' + (edit.link.id ? '/' + edit.link.id : '') + (dated ? '/change' : ''), body: {...data, expectedRevision: revision, requestId: crypto.randomUUID()}};
    }
    setBusy(true);
    try {await call(remove ? 'DELETE' : 'POST', command.current.url, command.current.body); await onSaved();}
    catch (failure) {setError(failure);} finally {setBusy(false);}
  };
  return <Modal title={t(`links.${remove ? 'delete' : edit.operation}`)} restore={() => {
    const button = edit.link.id ? document.querySelector<HTMLElement>('[data-connection-id="client-link-' + CSS.escape(edit.link.id) + '"]') : null;
    return button?.getClientRects().length ? button : document.getElementById('create-client-link');
  }} onClose={busy ? undefined : onClose}><form className="dialog-form client-link-form" onSubmit={event => void submit(event)} onInvalidCapture={event => (event.target as HTMLElement).closest('details')?.setAttribute('open', '')}>
    {remove ? <><p className="dialog-text"><b>{clientName(edit.link.clientId)} → {source?.name ?? t('agents.unknownSource')}</b><br />{period(edit.link).split('\n').join(' — ')}</p><p className="dialog-text">{t('links.deleteEffect')}</p></> : <>
      <fieldset className="form-fields" disabled={busy}>
        <div className="inline-form is-wrap">
          <SelectField label={t('links.client')} required autoFocus value={link.clientId} onChange={event => setLink({...link, clientId: event.target.value})}><option value="" disabled>{t('links.chooseClient')}</option>{inventory.clients.map(client => <option key={client} value={client}>{clientName(client)}</option>)}</SelectField>
          <SelectField label={t('links.deviceScope')} value={link.deviceId ?? ''} onChange={event => setLink({...link, deviceId: event.target.value || null})}><option value="">{t('links.allDevices')}</option>{inventory.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</SelectField>
        </div>
        <SelectField label={t('links.source')} hint={recommendation ? t('links.recommendation', {source: targetOf(inventory, recommendation.sourceId)?.name ?? '', route: condition(recommendation).split('\n').join(' / ')}) : undefined} required value={link.sourceId} onChange={event => chooseSource(event.target.value)}><option value="" disabled>{t('links.chooseSource')}</option>{link.sourceId && !inventory.sources.some(source => source.id === link.sourceId) && <option value={link.sourceId} disabled>{choiceName(targetOf(inventory, link.sourceId))} ({t('sources.disconnected')})</option>}{inventory.sources.map(source => <option key={source.id} value={source.id}>{choiceName(source)}</option>)}</SelectField>
        <SelectField label={t(existing ? 'links.apply' : 'links.from')} value={starts} onChange={event => setStarts(event.target.value as typeof starts)}><option value="now">{t('currencies.fromNow')}</option><option value="date">{t('links.fromDate')}</option>{existing && <option value="original">{t('links.entirePeriod')}</option>}</SelectField>
        {starts !== 'now' && <Field type="datetime-local" required label={t('links.date')} value={from} onChange={event => setFrom(event.target.value)} />}
        {starts !== 'now' && <small>{t('links.timezone', {zone: Intl.DateTimeFormat().resolvedOptions().timeZone})}</small>}
        <details className="disclosure"><summary>{t('links.conditions')}{(link.route || to) && <span className="disclosure-value">{link.route && condition(link).split('\n').join(' / ')}{link.route && to && <br />}{to && t('links.endsOn', {at: Number.isFinite(end) ? stamp(end!) : to})}</span>}</summary><div className="dialog-form">
          <Field type="datetime-local" label={t('links.to')} value={to} onChange={event => setTo(event.target.value)} />
          <SelectField label={t('links.routeType')} value={link.route?.class ?? ''} onChange={event => setLink({...link, route: event.target.value ? {class: event.target.value as 'api' | 'subscription' | 'unknown', provider: null} : null})}><option value="">{t('links.anyRoute')}</option>{(['subscription', 'api', 'unknown'] as const).map(value => <option key={value} value={value}>{t(`links.${value}`)}</option>)}</SelectField>
          {link.route && <SelectField label={t('links.provider')} value={link.route.provider ?? ''} onChange={event => setLink({...link, route: {...link.route!, provider: event.target.value || null}})}><option value="">{t('links.anyProvider')}</option>{catalogue.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</SelectField>}
          {starts === 'now' && <small>{t('links.timezone', {zone: Intl.DateTimeFormat().resolvedOptions().timeZone})}</small>}
          <small>{t('links.conditionAdvice')}</small>
        </div></details>
      </fieldset>
      {existing && <p className="dialog-text">{t(effect)}</p>}
    </>}
    <ErrorLine error={error} />
    {error instanceof ApiError && ['links_changed', 'source_not_held'].includes(error.code) && <button className="button" type="button" onClick={() => void reload().then(data => {if (data) {setRevision(data.revision); command.current = null; setError(null);}})}>{t('links.reload')}</button>}
    <div className="button-row"><button type="button" className="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className={'button ' + (remove ? 'danger' : 'primary')} disabled={busy || !remove && (!changed || !inventory.clients.includes(link.clientId) || !inventory.sources.some(source => source.id === link.sourceId))}>{t(remove ? 'links.delete' : 'account.save')}</button></div>
  </form></Modal>;
}

/** Owner-only evidence stays beside the session whose source it explains. */
export function SessionFunding({session, evidence, inventory, error}: {session: LiveSession & {source: string | null}; evidence?: LinkEvidence; inventory: LinkInventory | null; error: unknown}) {
  const [open, setOpen] = useState(false);
  const name = (id: string | null) => inventory && targetOf(inventory, id)?.name || catalogue.find(provider => provider.id === id?.split(':')[0])?.name || t('agents.unknownSource');
  const link = inventory?.links.find(link => link.id === evidence?.linkId);
  const source = name(evidence ? evidence.source : session.source);
  const inactive = evidence?.by === 'link' && !evidence.active;
  return <Popover label={t('links.whySource')} trigger={<>{source}<ChevronDown size={12} aria-hidden="true" /></>} open={open} onOpenChange={setOpen} width={350}>
    <PopoverHeading onClose={() => setOpen(false)}>{source}</PopoverHeading>
    <ErrorLine error={error} />
    {!inventory && !error ? <p className="dialog-text">{t('links.loading')}</p> : !evidence ? !error && <p className="dialog-text">{t(inventory ? 'links.sessionEnded' : 'links.loading')}</p> : <>
      <p className="dialog-text">{inactive ? t('links.inactiveExplanation', {source: name(link?.sourceId ?? null)}) : t(evidence.by === 'link' ? 'links.manual' : evidence.by === 'account' ? evidence.accountBy === 'inferred' ? 'links.inferred' : 'links.reported' : evidence.route?.class === 'api' ? 'links.apiUnassigned' : 'links.noAccount')}</p>
      <dl className="connection-facts">
        {link && <><dt>{t('links.source')}</dt><dd>{name(link.sourceId)}{inactive && <><br /><small className="v-warn">{t('sources.disconnected')}</small></>}</dd></>}
        {evidence.accountSourceId && <><dt>{t('links.reportedAccount')}</dt><dd>{name(evidence.accountSourceId)}</dd></>}
        {evidence.route && <><dt>{t('links.routeType')}</dt><dd>{condition(evidence).split('\n').join(' / ')}</dd></>}
        {evidence.host && <><dt>{t('links.gateway')}</dt><dd>{evidence.host}</dd></>}
      </dl>
      {evidence.disagreement && !inactive && <p className="dialog-text">{t('links.disagreement')}</p>}
      {evidence.otherGateway && <p className="dialog-text">{t('links.otherGateway')}</p>}
    </>}
    <div className="popover-section"><button className="popover-row" onClick={() => openClientLinks({deviceId: session.device.id, clientId: session.clientId, route: session.route})}>{t('links.manage')}</button></div>
  </Popover>;
}
