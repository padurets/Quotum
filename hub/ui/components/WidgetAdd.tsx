import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {t, type Key} from '../i18n';
import {ApiError, call} from '../lib/http';
import {navigate} from '../lib/router';
import {boardTitle, type Board, type Session} from '../lib/session';
import {useBoardId, useLineup, useServerView} from '../lib/board';
import {cardId, isHidden} from '../lib/view';
import {PROVIDERS} from '../lib/providers';
import {stamp} from '../lib/format';
import type {Credential} from '../../server/store/credentials';
import {Modal, Field, ErrorLine} from './Kit';
import {logoOf} from './logos';
import {Popover} from './Popover';
import {ConnectDevice, type Device} from './Machines';

type Candidate = {id: string; provider: string; label: string; origin: 'own' | 'shared'; onBoard: boolean; visible: boolean; action: 'add' | 'show' | 'present' | 'forbidden'};
type WidgetId = 'agents' | 'activity' | 'history' | 'forecast';
const LABELS: Record<WidgetId, Key> = {agents: 'agents.title', activity: 'activity.title', history: 'widgets.history', forecast: 'forecast.title'};
type Demo = {keys: {label: 'noExpiry' | 'partial' | 'expired' | 'temporary' | 'invalid'; secret: string}[]};
type Catalogue = {operations?: Operation[]; board: Board; sources: Candidate[]; widgets: {id: WidgetId; action: Candidate['action']}[]; connectors: {id: string; name: string}[]; demo?: Demo};
type Item = {kind: 'sources'; sourceIds: string[]} | {kind: 'widget'; widgetId: WidgetId} | {kind: 'connection'; provider: string} | {kind: 'replace'; credentialId: string};
type Operation = {id: string; boardId: string | null; item: Item; state: 'ready' | 'verifying' | 'needs_input' | 'complete' | 'failed'; current?: {boardAccessible: boolean; sources?: {id: string; placement: string}[]; widget?: {id: string; placement: string}}; error?: string; result?: {sourceIds: string[]; credentialId?: string; connection?: 'created' | 'reused'; expiresAt?: number | null}};

/** A submit owns an immutable destination, even if its panel closes while it runs. */
function useAddition() {
  const [operation, setOperation] = useState<Operation | null>(null), [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0), flight = useRef(false), current = useRef<Operation | null>(null);
  const request = useRef(crypto.randomUUID());
  useEffect(() => () => {generation.current++;}, []);
  const accept = (next: Operation) => {current.current = next; setOperation(next);};
  const submit = async (boardId: string | null, item: Item, secret?: string) => {
    if (flight.current) return;
    if (current.current && (current.current.boardId !== boardId || JSON.stringify(current.current.item) !== JSON.stringify(item))) {current.current = null; request.current = crypto.randomUUID();}
    flight.current = true; setBusy(true); setError(null);
    const own = generation.current;
    try {
      let reserved = current.current;
      if (!reserved) reserved = await call<Operation>('POST', '/api/additions', {requestId: request.current, boardId, item});
      if (own !== generation.current) return;
      accept(reserved);
      const next = await call<Operation>('POST', '/api/additions/' + reserved.id + '/run', secret === undefined ? {} : {secret}, 30_000);
      if (own !== generation.current) return;
      accept(next);
      if (next.error) setError(new ApiError(400, next.error));
    } catch (failure) { if (own === generation.current) setError(failure); }
    finally {flight.current = false; if (own === generation.current) setBusy(false);}
  };
  const check = async () => {
    if (!current.current || flight.current) return;
    const own = generation.current; setBusy(true); setError(null);
    try { const next = await call<Operation>('GET', '/api/additions/' + current.current.id); if (own === generation.current) {accept(next); if (next.error) setError(new ApiError(400, next.error));} }
    catch (failure) {if (own === generation.current) setError(failure);}
    finally {if (own === generation.current) setBusy(false);}
  };
  return {operation, error, busy, submit, check, restore: accept};
}

function DemoNotice() { return <p className="prototype-note">{t('prototype.notice')}</p>; }

function Completion({operation, board, personal, onClose}: {operation: Operation; board: Board | null; personal: boolean; onClose: () => void}) {
  const lineup = useLineup(), view = useServerView(), currentBoard = useBoardId();
  const widget = operation.item.kind === 'widget' ? operation.item.widgetId : null;
  const visible = !personal && currentBoard === board?.id && view && (widget ? !isHidden(view, widget) && (lineup.length > 0 || view.shown.includes('empty:' + widget)) : operation.result?.sourceIds.every(id => lineup.includes(id) && !isHidden(view, cardId(id))));
  const source = operation.result?.sourceIds[0];
  const changed = operation.current?.sources?.some(item => item.placement !== 'visible') || operation.current?.widget && operation.current.widget.placement !== 'visible';
  const focusId = source ? cardId(source) : widget;
  const focus = () => {
    onClose();
    if (personal || !visible) navigate('/?board=' + encodeURIComponent(board?.id ?? ''));
    else if (focusId) requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(`[data-widget="${focusId}"]`);
      if (element) {element.tabIndex = -1; element.scrollIntoView({block: 'center', behavior: 'smooth'}); element.focus({preventScroll: true});}
    });
  };
  return <div className="addition-complete" role="status"><span className="completion-symbol" aria-hidden="true">✓</span>
    <h3>{t(changed ? 'add.changed' : personal ? 'add.connected' : visible ? 'add.complete' : 'add.waiting')}</h3>
    <p>{t(changed ? 'add.changedText' : personal ? 'add.personalResult' : 'add.boardResult', {board: board ? boardTitle(board) : t('boards.personalName')})}</p>
    {operation.result?.connection === 'reused' && <p className="dialog-text">{t('add.reused')}</p>}
    {operation.result?.expiresAt !== undefined && <p className="dialog-text">{operation.result.expiresAt === null ? t('sources.noExpiry') : t('connections.expires', {time: stamp(operation.result.expiresAt)})}</p>}
    <button className="button primary" onClick={focus}>{t(personal || !visible ? 'add.openBoard' : 'add.viewWidget')}</button>
  </div>;
}

function KeyForm({board, replace, personal, demo, available, onClose, onSaved, onAddToBoard}: {
  board: Board | null; replace?: Credential; personal: boolean; demo?: Demo; available: boolean;
  onClose: () => void; onSaved?: () => void; onAddToBoard?: (sourceId: string) => void;
}) {
  const [secret, setSecret] = useState('');
  const addition = useAddition();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void addition.submit(personal || replace ? null : board!.id, replace ? {kind: 'replace', credentialId: replace.id} : {kind: 'connection', provider: 'openrouter'}, secret);
  };
  useEffect(() => {if (addition.operation?.state === 'complete') {setSecret(''); onSaved?.();}}, [addition.operation?.state]);
  if (addition.operation?.state === 'complete') return replace ? <div className="addition-complete" role="status"><h3>{t('add.replaced')}</h3><p>{t('add.replacePreserved')}</p><button className="button" onClick={onClose}>{t('common.close')}</button></div> : <><Completion operation={addition.operation} board={board} personal={personal} onClose={onClose} />{personal && onAddToBoard && <div className="button-row"><button className="button" onClick={() => onAddToBoard(addition.operation!.result!.sourceIds[0])}>{t('add.toBoard')}</button></div>}</>;
  return <form className="dialog-form" onSubmit={submit}>
    {demo && <DemoNotice />}
    <div className="connect-destination"><small>{t('add.destination')}</small><b>{personal ? t('boards.personalName') : boardTitle(board!)}</b></div>
    <p className="dialog-text">{t('add.keyRights')}</p>
    <a href="https://openrouter.ai/settings/management-keys" target="_blank" rel="noopener noreferrer">{t('sources.providerSettings')} ↗</a>
    {!personal && !board?.personal && <p className="sharing-disclosure">{t('add.disclosure', {board: boardTitle(board!)})}</p>}
    {replace && <p className="dialog-text">{t('add.replacePreserved')}</p>}
    {demo && <details className="demo-examples"><summary>{t('prototype.examples')}</summary><div className="button-row is-start">{demo.keys.map(key => <button type="button" className="button" key={key.label} disabled={addition.busy} onClick={() => setSecret(key.secret)}>{t(`prototype.${key.label}`)}</button>)}</div></details>}
    {demo && <label className="demo-loss"><input type="checkbox" disabled={addition.busy} onChange={event => {void call('POST', '/api/prototype/control', {lostReply: event.target.checked});}} />{t('prototype.lostReply')}</label>}
    <Field type="password" label={t('sources.key')} value={secret} autoComplete="new-password" data-1p-ignore="" data-lpignore="true" required maxLength={4096} autoFocus disabled={addition.busy} onChange={event => setSecret(event.target.value)} />
    <p className="drawer-note">{t('add.expiryInfo')}</p>
    {!available && <p className="form-error">{t('trustedKeys.serverMissing')}</p>}
    <ErrorLine error={addition.error} />
    {addition.busy && <p role="status" className="progress-line"><i className="spinner" />{t('add.verifying')}</p>}
    {addition.operation && !!addition.error && <button className="link-button" type="button" disabled={addition.busy} onClick={() => void addition.check()}>{t('add.checkResult')}</button>}
    <div className="button-row"><button type="button" className="button" onClick={onClose}>{t('common.close')}</button><button className="button primary" disabled={!available || !secret || addition.busy}>{t(replace ? 'sources.replace' : personal ? 'sources.connect' : 'add.connectAndAdd')}</button></div>
    {addition.busy && <p className="drawer-note">{t('add.closePending')}</p>}
  </form>;
}

function DeviceAdd({board, demo, onClose}: {board: Board; demo: boolean; onClose: () => void}) {
  const [devices, setDevices] = useState<Device[]>([]), [device, setDevice] = useState(''), [selected, setSelected] = useState<string[]>([]), [error, setError] = useState<unknown>(null);
  const addition = useAddition();
  const read = async () => {try {setDevices(await call<Device[]>('GET', '/api/devices'));} catch (failure) {setError(failure);}};
  useEffect(() => {void read();}, []);
  const chosen = devices.find(item => item.id === device);
  if (addition.operation?.state === 'complete') return <Completion operation={addition.operation} board={board} personal={false} onClose={onClose} />;
  return <div className="dialog-form">{demo && <DemoNotice />}<p className="sharing-disclosure">{t('add.deviceDestination', {board: boardTitle(board)})}</p>
    <ConnectDevice />
    {demo && <button className="button" onClick={() => {void call<{deviceId: string}>('POST', '/api/prototype/device', {}).then(async reply => {await read(); setDevice(reply.deviceId); setSelected([]);}, setError);}}>{t('prototype.device')}</button>}
    <button className="button" onClick={() => void read()}>{t('add.refreshDevices')}</button>
    <p className="dialog-text">{t('add.selectDevice')}</p><select aria-label={t('connections.device')} value={device} onChange={event => {setDevice(event.target.value); setSelected([]);}}><option value="">{t('add.chooseDevice')}</option>{devices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    {chosen && <fieldset className="source-selection"><legend>{t('add.selectSources')}</legend>{chosen.sources.map(source => <label key={source.source}><input type="checkbox" checked={selected.includes(source.source)} onChange={event => setSelected(ids => event.target.checked ? [...ids, source.source] : ids.filter(id => id !== source.source))} /><span>{PROVIDERS[source.provider]?.name ?? source.provider}</span></label>)}</fieldset>}
    <ErrorLine error={error ?? addition.error} /><p className="drawer-note">{t('add.futureSources')}</p>
    <div className="button-row"><button className="button" onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!selected.length || addition.busy} onClick={() => void addition.submit(board.id, {kind: 'sources', sourceIds: selected})}>{t('add.selection')}</button></div>
  </div>;
}

function WidgetCatalogue({board, local, trustedKeys, onClose, initialSourceId}: {initialSourceId?: string; board: Board; local: boolean; trustedKeys: Session['trustedKeys']; onClose: () => void}) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null), [error, setError] = useState<unknown>(null), [search, setSearch] = useState('');
  const [page, setPage] = useState<'catalogue' | 'openrouter' | 'device'>('catalogue');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const addition = useAddition();
  useEffect(() => {
    const abort = new AbortController();
    call<Catalogue>('GET', '/api/boards/' + board.id + '/catalogue', undefined, 12_000, abort.signal).then(setCatalogue, failure => {if (!abort.signal.aborted) setError(failure);});
    return () => abort.abort();
  }, [board.id]);
  useEffect(() => {const initial = catalogue?.sources.find(item => item.id === initialSourceId); if (initial && ['add', 'show'].includes(initial.action)) setCandidate(initial);}, [catalogue, initialSourceId]);
  const sources = catalogue?.sources.filter(source => (source.label + ' ' + source.provider).toLowerCase().includes(search.toLowerCase())) ?? [];
  const complete = addition.operation?.state === 'complete';
  return <div className="widget-catalogue">
    <div className="catalogue-heading"><h3>{page === 'openrouter' ? t('sources.connect') : page === 'device' ? t('connections.connectDevice') : t('add.title')}</h3><button className="icon-button" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button></div>
    {page !== 'catalogue' && <button className="link-button connection-back" onClick={() => setPage('catalogue')}>← {t('add.title')}</button>}
    {page === 'openrouter' ? <KeyForm board={board} personal={false} demo={catalogue?.demo} available={trustedKeys?.available === true} onClose={onClose} /> :
      page === 'device' ? <DeviceAdd board={board} demo={!!catalogue?.demo} onClose={onClose} /> :
      complete ? <Completion operation={addition.operation!} board={board} personal={false} onClose={onClose} /> : candidate ? <div className="dialog-form">
        <button className="link-button connection-back" onClick={() => setCandidate(null)}>← {t('add.title')}</button><h3>{candidate.label}</h3><p className="sharing-disclosure">{t(board.personal || candidate.onBoard ? 'add.showDisclosure' : 'add.disclosure', {board: boardTitle(board)})}</p>
        <ErrorLine error={addition.error} /><div className="button-row"><button className="button" onClick={() => setCandidate(null)}>{t('common.cancel')}</button><button className="button primary" disabled={addition.busy} onClick={() => void addition.submit(board.id, {kind: 'sources', sourceIds: [candidate.id]})}>{t(candidate.action === 'show' ? 'add.show' : 'add.action')}</button></div>
      </div> : <div className="dialog-form">
        {catalogue?.demo && <DemoNotice />}<p className="dialog-text">{t('add.catalogueFor', {board: boardTitle(board)})}</p>
        <Field label={t('add.search')} type="search" value={search} autoFocus onChange={event => setSearch(event.target.value)} />
        <ErrorLine error={error ?? addition.error} />
        {catalogue?.operations?.length ? <details className="demo-examples"><summary>{t('add.recent')}</summary>{catalogue.operations.map(operation => <button type="button" className="popover-row" key={operation.id} onClick={() => addition.restore(operation)}><span>{operation.item.kind === 'connection' ? 'OpenRouter' : t('add.title')}</span><span>{t(operation.state === 'complete' ? 'add.complete' : 'add.checkResult')}</span></button>)}</details> : null}
        {catalogue && <><div className="catalogue-group"><h3>{t('add.sources')}</h3>{sources.length ? sources.map(source => <div className="catalogue-row" key={source.id}>
          <img src={logoOf(source.provider)} alt="" /><span className="catalogue-name"><b>{source.label}</b><small>{t(source.origin === 'own' ? 'add.ownSource' : 'add.sharedSource')}</small></span>
          <button className="button" disabled={addition.busy || source.action === 'present' || source.action === 'forbidden'} onClick={() => setCandidate(source)}>{t(source.action === 'present' ? 'add.present' : source.action === 'forbidden' ? 'add.ownerOnly' : source.action === 'show' ? 'add.show' : 'add.action')}</button>
        </div>) : <p className="admin-empty">{t('add.noSources')}</p>}</div>
        <div className="catalogue-group"><h3>{t('analytics.title')}</h3>{catalogue.widgets.map(widget => <div className="catalogue-row" key={widget.id}><span className="catalogue-symbol" aria-hidden="true">▥</span><span className="catalogue-name"><b>{t(LABELS[widget.id])}</b></span><button className="button" disabled={addition.busy || widget.action === 'present' || widget.action === 'forbidden'} onClick={() => void addition.submit(board.id, {kind: 'widget', widgetId: widget.id})}>{t(widget.action === 'present' ? 'add.present' : widget.action === 'forbidden' ? 'add.ownerOnly' : 'add.action')}</button></div>)}</div>
        <div className="catalogue-group"><h3>{t('add.connectNew')}</h3>{catalogue.connectors.map(connector => <button className="popover-row catalogue-connect" key={connector.id} onClick={() => setPage('openrouter')}><img src={logoOf(connector.id)} alt="" /><span>{connector.name}</span><span aria-hidden="true">→</span></button>)}{!local && <button className="popover-row catalogue-connect" onClick={() => setPage('device')}><span>{t('connections.connectDevice')}</span><span aria-hidden="true">→</span></button>}</div></>}
      </div>}
  </div>;
}

export function WidgetAdd({board, local, trustedKeys, open, onOpenChange, initialSourceId, trigger}: {
  board: Board; local: boolean; trustedKeys: Session['trustedKeys']; open: boolean;
  onOpenChange: (open: boolean) => void; initialSourceId?: string; trigger?: string;
}) {
  return <Popover label={t('add.title')} icon={<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>}
    trigger={trigger} triggerClass={trigger ? 'button' : undefined} open={open} onOpenChange={onOpenChange} width={420}>
    {open && <WidgetCatalogue key={board.id} board={board} local={local} trustedKeys={trustedKeys} initialSourceId={initialSourceId} onClose={() => onOpenChange(false)} />}
  </Popover>;
}

type ConnectionDetails = Credential & {label: string; lastSuccessAt: number | null; placements: (Board & {visible: boolean})[]};

export function ConnectionsPage({userId, boards, trustedKeys}: {userId: string; boards: Board[]; trustedKeys: Session['trustedKeys']}) {
  const [connections, setConnections] = useState<ConnectionDetails[]>([]), [demo, setDemo] = useState<Demo | undefined>();
  const [connecting, setConnecting] = useState(false), [replace, setReplace] = useState<Credential | undefined>(), [error, setError] = useState<unknown>(null), [remove, setRemove] = useState<Credential | null>(null);
  const [adding, setAdding] = useState<Board | null>(null), [choosing, setChoosing] = useState(false), [selectedSource, setSelectedSource] = useState<string | undefined>();
  const [readAt, setReadAt] = useState<number | null>(null);
  const read = useCallback(async (signal?: AbortSignal) => {
    try {const reply = await call<{connections: ConnectionDetails[]; demo?: Demo}>('GET', '/api/connections', undefined, 12_000, signal); if (!signal?.aborted) {setConnections(reply.connections); setDemo(reply.demo); setReadAt(Date.now()); setError(null);}}
    catch (failure) {if (!signal?.aborted) setError(failure);}
  }, [userId]);
  useEffect(() => {const abort = new AbortController(); void read(abort.signal); return () => abort.abort();}, [read]);
  const disconnect = async () => {
    try {await call('DELETE', '/api/credentials/' + remove!.id); setRemove(null); void read();}
    catch (failure) {setError(failure);}
  };
  return <div className="dialog-form"><div className="settings-section-head"><h2>{t('settings.connections')}</h2><button className="button primary" onClick={() => {setReplace(undefined); setConnecting(true);}}>{t('add.connectNew')}</button></div>
    {demo && <DemoNotice />}<p className="dialog-text">{t('settings.connectionScope')}</p><div className="settings-section-head"><small className="drawer-note">{readAt && t('settings.checkedAt', {time: stamp(readAt)})}</small><button className="link-button" onClick={() => void read()}>{t('refresh.action')}</button></div>
    <ErrorLine error={error} />{!connections.length && <p className="admin-empty">{t('sources.empty')}</p>}
    {connections.map(connection => <article key={connection.id} className="connection-record"><div className="connection-record-head"><img src={logoOf(connection.provider)} alt="" /><div><h3>{connection.label}</h3><small>{t('sources.account')}{connection.hint && ' …' + connection.hint}</small></div></div>
      {connection.lastError ? <ErrorLine error={new ApiError(400, connection.lastError)} /> : <p className="connection-health">{t('connections.healthy')}</p>}
      <dl className="connection-facts"><dt>{t('connections.expiry')}</dt><dd>{connection.expiresAt === null ? t('sources.noExpiry') : stamp(connection.expiresAt)}</dd><dt>{t('connections.lastSuccess')}</dt><dd>{connection.lastSuccessAt ? stamp(connection.lastSuccessAt) : '—'}</dd><dt>{t('connections.boards')}</dt><dd>{connection.placements.map(placement => <span className="placement-tag" key={placement.id}>{boardTitle(placement)}{!placement.visible && <small>{t('connections.hidden')}</small>}</span>)}</dd></dl>
      <div className="button-row is-start"><button className="button" onClick={() => {setSelectedSource(connection.sourceId ?? undefined); setChoosing(true);}}>{t('add.toBoard')}</button><button className="button" onClick={() => {setReplace(connection); setConnecting(true);}}>{t('sources.replace')}</button><button className="link-button danger" onClick={() => setRemove(connection)}>{t('sources.remove')}</button></div>
    </article>)}
    {connecting && <section className="connection-editor"><h3>{t(replace ? 'sources.replace' : 'sources.connect')}</h3><KeyForm board={boards.find(board => board.personal) ?? null} personal replace={replace} demo={demo} available={trustedKeys?.available === true} onClose={() => setConnecting(false)} onSaved={() => void read()} onAddToBoard={sourceId => {setConnecting(false); setSelectedSource(sourceId); setChoosing(true);}} /></section>}
    {choosing && <section className="connection-editor"><h3>{t('add.toBoard')}</h3><p className="dialog-text">{t('add.chooseBoard')}</p>{boards.map(board => <button className="popover-row" key={board.id} onClick={() => {setChoosing(false); setAdding(board);}}><span>{boardTitle(board)}</span></button>)}<button className="link-button" onClick={() => setChoosing(false)}>{t('common.cancel')}</button></section>}
    {adding && <WidgetAdd board={adding} initialSourceId={selectedSource} local={false} trustedKeys={trustedKeys} open onOpenChange={open => {if (!open) {setAdding(null); void read();}}} trigger={boardTitle(adding)} />}
    {remove && <Modal title={t('sources.remove')} onClose={() => setRemove(null)}><p className="dialog-text">{t('sources.removeText')}</p><p className="dialog-text">{t('add.disconnectEffect')}</p><ErrorLine error={error} /><div className="button-row"><button className="button" onClick={() => setRemove(null)}>{t('common.cancel')}</button><button className="button danger" onClick={() => void disconnect()}>{t('sources.remove')}</button></div></Modal>}
  </div>;
}
