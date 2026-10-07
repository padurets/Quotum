import {createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent} from 'react';
import {t, type Key} from '../i18n';
import {ApiError, call} from '../lib/http';
import {navigate, settingsHref} from '../lib/router';
import {boardTitle, type Board, type Session} from '../lib/session';
import {useBoardId, useConnectionsRevision, useLineup, useServerView} from '../lib/board';
import {cardId, flushView, isHidden} from '../lib/view';
import {PROVIDERS} from '../lib/providers';
import {stamp} from '../lib/format';
import {widgetKind} from '../lib/widgetKind';
import {catalogue as providerCatalogue} from '../../server/domain/providers';
import type {Credential} from '../../server/store/credentials';
import {Modal, Field, ErrorLine} from './Kit';
import {logoOf} from './logos';
import {Popover} from './Popover';
import {ConnectDevice, type Device} from './Machines';
import {Activity, ChartNoAxesCombined, List, Monitor, Plug, Plus, Table2, X} from 'lucide-react';

type Candidate = {id: string; provider: string; label: string; origin: 'own' | 'shared'; onBoard: boolean; visible: boolean; action: 'add' | 'show'};
type WidgetId = 'agents' | 'activity' | 'history' | 'forecast';
const LABELS: Record<WidgetId, Key> = {agents: 'agents.title', activity: 'activity.title', history: 'widgets.history', forecast: 'forecast.title'};
const WIDGET_ICONS = {agents: List, activity: Activity, history: ChartNoAxesCombined, forecast: Table2};
type Demo = {keys: {label: 'noExpiry' | 'partial' | 'expired' | 'temporary' | 'invalid' | 'deepseekBalance' | 'zaiQuotas'; secret: string; provider?:string}[]};
type Catalogue = {operations?: Operation[]; board: Board; sources: Candidate[]; widgets: {id: WidgetId; action: Candidate['action']}[]; connectors: {id: string; name: string}[]; demo?: Demo};
type Item = {kind: 'sources'; sourceIds: string[]} | {kind: 'widget'; widgetId: WidgetId} | {kind: 'connection'; provider: string; account?:{kind:'new'}|{kind:'existing';id:string}} | {kind: 'replace'; credentialId: string; provider?:string};
type Operation = {id: string; boardId: string | null; item: Item; createdAt: number; state: 'ready' | 'verifying' | 'needs_input' | 'complete' | 'failed' | 'expired'; current?: {boardAccessible: boolean | null; sources?: {id: string; placement: string}[]; widget?: {id: string; placement: string}; credential?: {exists: boolean; revisionMatches: boolean}}; error?: string; warning?: string; result?: {sourceIds: string[]; credentialId?: string; connection?: 'created' | 'reused'; expiresAt?: number | null; expiryKind?:'none'|'unknown'|'dated'; replacementRequired?: boolean}};

/** Form lifetime affects its UI; only the authenticated shell may end its submitted action. */
export const AdditionScope = createContext<() => boolean>(() => false);

/** A submit owns an immutable destination, even if its panel closes while it runs. */
function useAddition() {
  const currentScope = useContext(AdditionScope);
  const [operation, setOperation] = useState<Operation | null>(null), [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0), flight = useRef(false), current = useRef<Operation | null>(null);
  const request = useRef(crypto.randomUUID());
  useEffect(() => () => {generation.current++;}, []);
  const accept = (next: Operation) => {current.current = next; setOperation(next);};
  const submit = async (boardId: string | null, item: Item, secret?: string, options:{allowUnknownExpiry?:boolean;sameAccount?:boolean;accountName?:string}={}) => {
    if (flight.current) return;
    const binding = (item: Item) => item.kind === 'replace' ? {kind: item.kind, credentialId: item.credentialId} : item.kind === 'sources' ? {...item, sourceIds: [...new Set(item.sourceIds)].sort()} : item.kind==='connection'&&item.account?.kind==='new'?{...item,account:{kind:'new'}}:item;
    if (current.current && (current.current.boardId !== boardId || JSON.stringify(binding(current.current.item)) !== JSON.stringify(binding(item)))) {current.current = null; request.current = crypto.randomUUID();}
    flight.current = true; setBusy(true); setError(null);
    const own = generation.current;
    try {
      if (boardId) await flushView(boardId);
      if (!currentScope()) return;
      let reserved = current.current;
      if (!reserved) reserved = await call<Operation>('POST', '/api/additions', {requestId: request.current, boardId, item});
      if (!currentScope()) return;
      if (own === generation.current) accept(reserved);
      const next = await call<Operation>('POST', '/api/additions/' + reserved.id + '/run', secret === undefined ? {} : {secret,...options}, 30_000);
      if (!currentScope() || own !== generation.current) return;
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
  return {operation, error, busy, submit, check, reset: () => {if (!flight.current) {current.current = null; request.current = crypto.randomUUID(); setOperation(null); setError(null);}}, restore: (next: Operation) => {accept(next); if (next.error) setError(new ApiError(400, next.error));}};
}

function RecentAdditions({boardId, onRestore}: {boardId?: string; onRestore: (operation: Operation) => void}) {
  const [operations, setOperations] = useState<Operation[]>([]), [next, setNext] = useState<string | null>(null), [error, setError] = useState<unknown>(null);
  const revision = useConnectionsRevision();
  const read = async (before?: string, signal?: AbortSignal) => {
    try {
      const reply = await call<{operations: Operation[]; next: string | null}>('GET', '/api/additions?limit=20' + (before ? '&before=' + encodeURIComponent(before) : ''), undefined, 12_000, signal);
      if (!signal?.aborted) {setOperations(current => before ? [...current, ...reply.operations] : reply.operations); setNext(reply.next);}
    } catch (failure) {if (!signal?.aborted) setError(failure);}
  };
  useEffect(() => {const abort = new AbortController(); void read(undefined, abort.signal); return () => abort.abort();}, [revision]);
  const items = operations.filter(operation => boardId === undefined || operation.boardId === boardId);
  return items.length || next || error ? <details className="recent-additions"><summary>{t('add.recent')}</summary><ErrorLine error={error} />
    {items.map(operation => <button type="button" className="popover-row" key={operation.id} onClick={() => {void call<Operation>('GET', '/api/additions/' + operation.id).then(onRestore, setError);}}><span>{operation.item.kind === 'connection' ? PROVIDERS[operation.item.provider]?.name ?? operation.item.provider : operation.item.kind === 'widget' ? t(LABELS[operation.item.widgetId]) : t('add.title')}<small>{stamp(operation.createdAt)}</small></span><b>{t(operation.state === 'complete' ? 'add.complete' : 'add.checkResult')}</b></button>)}
    {next && <button className="link-button" type="button" onClick={() => void read(next)}>{t('common.more')}</button>}
  </details> : null;
}

function DemoNotice() { return <p className="prototype-note">{t('prototype.notice')}</p>; }

function Completion({operation, board, personal, onClose}: {operation: Operation; board: Board | null; personal: boolean; onClose: () => void}) {
  const lineup = useLineup(), view = useServerView(), currentBoard = useBoardId();
  const widget = operation.item.kind === 'widget' ? operation.item.widgetId : null;
  const visible = !personal && currentBoard === board?.id && view && (widget ? !isHidden(view, widget) && (lineup.length > 0 || view.enabledWhenEmpty?.includes(widget)) : operation.result?.sourceIds.every(id => lineup.includes(id) && !isHidden(view, cardId(id))));
  const source = operation.result?.sourceIds[0];
  const changed = operation.current?.sources?.some(item => item.placement !== 'visible') || operation.current?.widget && operation.current.widget.placement !== 'visible' || operation.current?.credential && !operation.current.credential.exists;
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
    {operation.result?.connection === 'reused' && <p className="dialog-text">{t(operation.result.replacementRequired ? 'add.replaceNeeded' : 'add.reused')}</p>}
    {operation.result?.replacementRequired && <a href={settingsHref('/settings/connections', board?.id ?? '')} onClick={event => {event.preventDefault(); onClose(); navigate(settingsHref('/settings/connections', board?.id ?? ''));}}>{t('settings.connections')}</a>}
    {operation.warning && <ErrorLine error={new ApiError(503, operation.warning)} />}
    {operation.result?.expiresAt !== undefined && <p className="dialog-text">{operation.result.expiryKind==='unknown'?t('sources.unknownExpiry'):operation.result.expiresAt === null ? t('sources.noExpiry') : t('connections.expires', {time: stamp(operation.result.expiresAt)})}</p>}
    <button className="button primary" disabled={!board || operation.current?.boardAccessible === false} onClick={focus}>{t(personal || !visible ? 'add.openBoard' : 'add.viewWidget')}</button>
  </div>;
}

function RecoveredAddition({operation, board, onClose}: {operation: Operation; board: Board | null; onClose: () => void}) {
  const addition = useAddition();
  useEffect(() => addition.restore(operation), [operation.id]);
  const current = addition.operation ?? operation;
  if (current.state === 'complete') return <Completion operation={current} board={board} personal={current.boardId === null} onClose={onClose} />;
  return <div className="dialog-form"><ErrorLine error={addition.error} />{current.state === 'verifying' && <p role="status">{t('add.verifying')}</p>}
    <button className="button" disabled={addition.busy} onClick={() => void addition.check()}>{t('add.checkResult')}</button>
    {board && ['ready', 'needs_input'].includes(current.state) && <button className="button" disabled={addition.busy} onClick={() => void addition.submit(current.boardId, current.item)}>{t('add.action')}</button>}
    <button className="link-button" onClick={onClose}>{t('common.close')}</button>
  </div>;
}

function KeyForm({board, provider:chosenProvider='openrouter', replace, personal, demo, available, storageReason, onClose, onSaved, onAddToBoard, initialOperation}: {
  board: Board | null; provider?:string; replace?: Credential; personal: boolean; demo?: Demo; available: boolean; storageReason?:string|null;
  onClose: () => void; onSaved?: () => void; onAddToBoard?: (sourceId: string) => void;
  initialOperation?: Operation;
}) {
  const [secret, setSecret] = useState('');
  const provider=replace?.provider??(initialOperation?.item.kind==='connection'||initialOperation?.item.kind==='replace'?initialOperation.item.provider:undefined)??chosenProvider;
  const namedAccounts=provider==='deepseek',declared=namedAccounts||provider==='zai';
  const savedTarget=initialOperation?.item.kind==='connection'?initialOperation.item.account:undefined;
  const [account,setAccount]=useState(savedTarget?.kind==='existing'?savedTarget.id:'new'),[name,setName]=useState('');
  const [consent,setConsent]=useState(false),[sameAccount,setSameAccount]=useState(false);
  const [accounts,setAccounts]=useState<{id:string;name:string;connected:boolean}[]>([]),[after,setAfter]=useState<string>(),[next,setNext]=useState<string|null>(null),[back,setBack]=useState<(string|undefined)[]>([]),[loadedAfter,setLoadedAfter]=useState<string|undefined|null>(null),[accountsError,setAccountsError]=useState<unknown>(null);
  useEffect(()=>{
    if(!namedAccounts||replace||initialOperation)return;
    let live=true;
    call<{accounts:{id:string;name:string;connected:boolean}[];next:string|null}>('GET','/api/source-accounts?provider=deepseek&limit=10'+(after?'&after='+encodeURIComponent(after):''))
      .then(reply=>{if(live){setAccounts(reply.accounts);setNext(reply.next);setLoadedAfter(after);setAccountsError(null);}},failure=>{if(live)setAccountsError(failure);});
    return()=>{live=false;};
  },[namedAccounts,replace?.id,initialOperation?.id,after]);
  const addition = useAddition();
  const replacing = !!replace || initialOperation?.item.kind === 'replace';
  const needsSame=declared&&(replacing||namedAccounts&&account!=='new');
  const accountReady=!!initialOperation||!namedAccounts||replacing||loadedAfter===after;
  const validAccount=account==='new'||!!savedTarget||accountReady&&accounts.some(item=>item.id===account);
  const blocked=!available||addition.busy||declared&&!consent||needsSame&&!sameAccount||namedAccounts&&!replacing&&(!accountReady||!validAccount||account==='new'&&!name.trim());
  const changed=()=>{if(!initialOperation)addition.reset();setSameAccount(false);};
  useEffect(() => {if (initialOperation) addition.restore(initialOperation);}, [initialOperation?.id]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const item: Item = initialOperation?.item.kind === 'replace' ? {kind: 'replace', credentialId: initialOperation.item.credentialId} : replace ? {kind: 'replace', credentialId: replace.id} : {kind: 'connection', provider,...(namedAccounts?{account:savedTarget??(account==='new'?{kind:'new'}:{kind:'existing',id:account})}:{})};
    if(blocked)return;
    void addition.submit(personal || replacing ? null : board!.id, item, secret,declared?{allowUnknownExpiry:consent,...(needsSame?{sameAccount}:{}),...(namedAccounts&&!replacing&&account==='new'?{accountName:name}:{})}:{});
  };
  useEffect(() => {if (addition.operation?.state === 'complete') {setSecret(''); onSaved?.();}}, [addition.operation?.state]);
  if (addition.operation?.state === 'complete') {
    if (addition.operation.item.kind === 'replace') {
      const current = addition.operation.current?.credential;
      const changed = current && (!current.exists || !current.revisionMatches);
      return <div className="addition-complete" role="status"><h3>{t(changed ? 'add.keyChanged' : 'add.replaced')}</h3><p>{t(changed ? 'add.keyChangedText' : 'add.replacePreserved')}</p>
        {addition.operation.warning && <ErrorLine error={new ApiError(503, addition.operation.warning)} />}
        <ErrorLine error={addition.error} />
        {addition.operation.warning && <button className="button" disabled={addition.busy} onClick={() => void addition.submit(null, addition.operation!.item)}>{t('add.retryCleanup')}</button>}
        <button className="button" onClick={onClose}>{t('common.close')}</button></div>;
    }
    return <><Completion operation={addition.operation} board={board} personal={personal} onClose={onClose} />{personal && onAddToBoard && <div className="button-row"><button className="button" onClick={() => onAddToBoard(addition.operation!.result!.sourceIds[0])}>{t('add.toBoard')}</button></div>}</>;
  }
  if (addition.operation && ['expired', 'failed'].includes(addition.operation.state)) return <div className="dialog-form"><ErrorLine error={addition.error} /><button className="button" onClick={() => {setSecret(''); addition.reset();}}>{t('add.startAgain')}</button></div>;
  return <form className="dialog-form" onSubmit={submit}>
    {demo && <DemoNotice />}
    <div className="connect-destination"><small>{t('add.destination')}</small><b>{personal ? t('boards.personalName') : boardTitle(board!)}</b></div>
    <p className="dialog-text">{t(namedAccounts?'sources.deepseekRights':provider==='zai'?'sources.zaiRights':'add.keyRights')}</p>
    <a href={namedAccounts?'https://platform.deepseek.com/api_keys':provider==='zai'?'https://z.ai/manage-apikey/apikey-list':'https://openrouter.ai/settings/management-keys'} target="_blank" rel="noopener noreferrer">{t(namedAccounts?'sources.deepseekSettings':provider==='zai'?'sources.zaiSettings':'sources.providerSettings')} ↗</a>
    {!personal && !board?.personal && <p className="sharing-disclosure">{t('add.disclosure', {board: boardTitle(board!)})}</p>}
    {replacing && <p className="dialog-text">{t('add.replacePreserved')}</p>}
    {demo && <details className="demo-examples"><summary>{t('prototype.examples')}</summary><div className="button-row is-start">{demo.keys.filter(key=>(key.provider??'openrouter')===provider).map(key => <button type="button" className="button" key={key.label} disabled={addition.busy} onClick={() => {setSecret(key.secret);changed();setConsent(false);}}>{t(`prototype.${key.label}`)}</button>)}</div></details>}
    {demo && <label className="demo-loss"><input type="checkbox" disabled={addition.busy} onChange={event => {void call('POST', '/api/prototype/control', {lostReply: event.target.checked});}} />{t('prototype.lostReply')}</label>}
    {namedAccounts&&<><p className="drawer-note">{t('sources.declaredIdentity')}</p>{!replacing&&<>
      <label className="field"><span>{t('sources.account')}</span><select value={account} disabled={addition.busy||!available||!accountReady||!!initialOperation} onChange={event=>{setAccount(event.target.value);changed();}}><option value="new">{t('sources.newAccount')}</option>{savedTarget?.kind==='existing'&&<option value={savedTarget.id}>{t('sources.account')}</option>}{accounts.map(item=><option key={item.id} value={item.id}>{item.name}{item.connected?'':` (${t('sources.disconnected')})`}</option>)}</select></label>
      {(back.length>0||next)&&<div className="button-row"><button type="button" className="button" disabled={addition.busy||!accountReady||!back.length} onClick={()=>{setAfter(back.at(-1));setBack(back.slice(0,-1));setAccount('new');changed();}}>{t('sources.backAccounts')}</button><button type="button" className="button" disabled={addition.busy||!accountReady||!next} onClick={()=>{setBack([...back,after]);setAfter(next!);setAccount('new');changed();}}>{t('sources.moreAccounts')}</button></div>}
      {account==='new'&&<Field label={t('sources.accountName')} value={name} maxLength={240} required disabled={addition.busy||!available} onChange={event=>{setName(event.target.value);changed();}}/>}
    </>}</>}
    {needsSame&&<><p className="drawer-note">{t('sources.declaredAccount')}</p><label className="source-consent"><input type="checkbox" checked={sameAccount} disabled={addition.busy||!available} onChange={event=>setSameAccount(event.target.checked)}/>{namedAccounts?t('sources.sameAccount',{name:replace?.accountName??accounts.find(item=>item.id===account)?.name??t('sources.account')}):t('sources.sameAccountConsent')}</label><p className="drawer-note">{t('sources.otherAccount')}</p></>}
    <Field type="password" label={t(declared?'sources.apiKey':'sources.key')} value={secret} autoComplete="new-password" data-1p-ignore="" data-lpignore="true" required maxLength={4096} autoFocus disabled={addition.busy} onChange={event => {setSecret(event.target.value);changed();setConsent(false);}} />
    {declared?<label className="source-consent"><input type="checkbox" checked={consent} disabled={addition.busy||!available} onChange={event=>setConsent(event.target.checked)}/>{t('sources.unknownExpiryConsent')}</label>:<p className="drawer-note">{t('add.expiryInfo')}</p>}
    <ErrorLine error={accountsError}/>
    {!available&&(storageReason==='secret_key_mismatch'?<p className="form-error">{t('trustedKeys.serverMismatch')}</p>:storageReason?<ErrorLine error={new ApiError(409,storageReason)}/>:<p className="form-error">{t('trustedKeys.serverMissing')}</p>)}
    <ErrorLine error={addition.error} />
    {addition.busy && <p role="status" className="progress-line"><i className="spinner" />{t('add.verifying')}</p>}
    {addition.operation && !!addition.error && <button className="link-button" type="button" disabled={addition.busy} onClick={() => void addition.check()}>{t('add.checkResult')}</button>}
    <div className="button-row"><button type="button" className="button" onClick={onClose}>{t('common.close')}</button><button className="button primary" disabled={blocked || !secret}>{replacing?t('sources.replace'):personal?t('sources.connectProvider',{provider:provider==='zai'?t('sources.zaiPersonal'):PROVIDERS[provider]?.name??provider}):t('add.connectAndAdd')}</button></div>
    {addition.busy && <p className="drawer-note">{t('add.closePending')}</p>}
  </form>;
}

function DeviceAdd({board, demo, onClose}: {board: Board; demo: boolean; onClose: () => void}) {
  const [devices, setDevices] = useState<Device[]>([]), [device, setDevice] = useState(''), [selected, setSelected] = useState<string[]>([]), [error, setError] = useState<unknown>(null);
  const [available, setAvailable] = useState<string[]>([]);
  type Intent = {id: string; boardId: string; deviceId: string | null; sourceIds: string[]; additionId: string | null; status: string; createdAt: number};
  type Pending = {userCode: string; machine: {name: string; os: string; arch: string}};
  const [intent, setIntent] = useState<Intent | null>(null), [recent, setRecent] = useState<Intent[]>([]), [code, setCode] = useState(''), [pending, setPending] = useState<Pending | null>(null), [selecting, setSelecting] = useState(false);
  const requestId = useRef(crypto.randomUUID()), selectionId = useRef(crypto.randomUUID());
  const mounted = useRef(true), revision = useConnectionsRevision();
  const addition = useAddition();
  const read = async () => {try {
    const [nextDevices, catalogue] = await Promise.all([call<Device[]>('GET', '/api/devices'), call<Catalogue>('GET', '/api/boards/' + board.id + '/catalogue')]);
    if (!mounted.current) return;
    const ids = catalogue.sources.map(source => source.id);
    setDevices(nextDevices); setAvailable(ids); setSelected(current => current.filter(id => ids.includes(id)));
  } catch (failure) {setError(failure);}};
  const recover = async (id: string) => {
    try {
      const next = await call<Intent>('GET', '/api/device-onboarding/' + id);
      if (!mounted.current) return;
      setIntent(next); if (next.deviceId) setDevice(next.deviceId); setSelected(next.sourceIds);
      if (next.additionId) {const operation = await call<Operation>('GET', '/api/additions/' + next.additionId); if (mounted.current) addition.restore(operation);}
    } catch (failure) {if (mounted.current) setError(failure);}
  };
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void call<Intent>('POST', '/api/device-onboarding', {requestId: requestId.current, boardId: board.id}, 12_000, abort.signal).then(value => {if (!abort.signal.aborted) setIntent(value);}, failure => {if (!abort.signal.aborted) setError(failure);});
    void call<{intents: Intent[]}>('GET', '/api/device-onboarding?limit=20', undefined, 12_000, abort.signal).then(value => {if (!abort.signal.aborted) setRecent(value.intents.filter(item => item.boardId === board.id));}, failure => {if (!abort.signal.aborted) setError(failure);});
    return () => {mounted.current = false; abort.abort();};
  }, [board.id]);
  useEffect(() => {void read(); if (intent) void recover(intent.id);}, [revision]);
  const finish = async () => {
    if (!intent || selecting) return;
    setSelecting(true); setError(null);
    try {
      await flushView(board.id);
      const operation = intent.additionId ? await call<Operation>('GET', '/api/additions/' + intent.additionId) : await call<Operation>('POST', '/api/device-onboarding/' + intent.id + '/selection', {requestId: selectionId.current, deviceId: device, sourceIds: selected});
      if (!mounted.current) return;
      addition.restore(operation); await addition.submit(operation.boardId, operation.item);
    } catch (failure) {if (mounted.current) setError(failure);}
    finally {if (mounted.current) setSelecting(false);}
  };
  const chosen = devices.find(item => item.id === device);
  if (addition.operation?.state === 'complete') return <Completion operation={addition.operation} board={board} personal={false} onClose={onClose} />;
  return <div className="dialog-form">{demo && <DemoNotice />}<p className="sharing-disclosure">{t('add.deviceDestination', {board: boardTitle(board)})}</p>
    {recent.length > 0 && <details className="recent-additions"><summary>{t('add.recentDevices')}</summary>{recent.map(item => <button className="popover-row" key={item.id} onClick={() => void recover(item.id)}><span>{stamp(item.createdAt)}</span><b>{t('add.checkResult')}</b></button>)}</details>}
    {intent && <ConnectDevice onboardingId={intent.id} />}
    {intent && !intent.additionId && <form className="dialog-form" onSubmit={event => {event.preventDefault(); void call<Pending>('GET', '/api/device?code=' + encodeURIComponent(code)).then(setPending, setError);}}><Field label={t('device.code')} value={code} placeholder="XXXX-XXXX" onChange={event => {setCode(event.target.value); setPending(null);}} />{pending ? <><p className="dialog-text">{pending.machine.name}<br />{pending.machine.os} {pending.machine.arch}</p><p className="dialog-text">{t('device.warning')}</p><button type="button" className="button" onClick={() => {void call('POST', '/api/device/approve', {code: pending.userCode, onboardingId: intent.id}).then(() => {setPending(null); setCode(''); void recover(intent.id);}, setError);}}>{t('device.connect')}</button></> : <button className="button" disabled={!code.trim()}>{t('device.continue')}</button>}</form>}
    {demo && <button className="button" onClick={() => {void call<{deviceId: string}>('POST', '/api/prototype/device', {}).then(async reply => {await read(); setDevice(reply.deviceId); setSelected([]);}, setError);}}>{t('prototype.device')}</button>}
    <button className="button" onClick={() => void read()}>{t('add.refreshDevices')}</button>
    <p className="dialog-text">{t('add.selectDevice')}</p><select aria-label={t('connections.device')} value={device} disabled={selecting || addition.busy || !!intent?.additionId} onChange={event => {setDevice(event.target.value); setSelected([]);}}><option value="">{t('add.chooseDevice')}</option>{devices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    {chosen && <fieldset className="source-selection" disabled={selecting || addition.busy || !!intent?.additionId}><legend>{t('add.selectSources')}</legend>{chosen.sources.filter(source => available.includes(source.source) || intent?.sourceIds.includes(source.source)).map(source => <label key={source.source}><input type="checkbox" checked={selected.includes(source.source)} onChange={event => setSelected(ids => event.target.checked ? [...ids, source.source] : ids.filter(id => id !== source.source))} /><span>{PROVIDERS[source.provider]?.name ?? source.provider}</span></label>)}</fieldset>}
    <ErrorLine error={error ?? addition.error} /><p className="drawer-note">{t('add.futureSources')}</p>
    {intent && <button className="link-button" onClick={() => void recover(intent.id)}>{t('add.checkResult')}</button>}
    <div className="button-row"><button className="button" onClick={onClose}>{t('common.cancel')}</button><button className="button primary" disabled={!intent || !selected.length || addition.busy || selecting || ['expired', 'complete'].includes(intent.status)} onClick={() => void finish()}>{t('add.selection')}</button></div>
  </div>;
}

function WidgetCatalogue({board, local, trustedKeys, onClose, initialSourceId}: {initialSourceId?: string; board: Board; local: boolean; trustedKeys: Session['trustedKeys']; onClose: () => void}) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null), [error, setError] = useState<unknown>(null), [search, setSearch] = useState('');
  const [page, setPage] = useState<'catalogue' | 'connect' | 'connection' | 'device'>('catalogue');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const addition = useAddition();
  const revision = useConnectionsRevision();
  const [providerSearch, setProviderSearch] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    call<Catalogue>('GET', '/api/boards/' + board.id + '/catalogue', undefined, 12_000, abort.signal).then(setCatalogue, failure => {if (!abort.signal.aborted) setError(failure);});
    return () => abort.abort();
  }, [board.id, revision]);
  useEffect(() => {const initial = catalogue?.sources.find(item => item.id === initialSourceId); if (initial && ['add', 'show'].includes(initial.action)) setCandidate(initial);}, [catalogue, initialSourceId]);
  const matches = (label: string, query = search) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const sources = catalogue?.sources.filter(source => matches(source.label + ' ' + source.provider + ' ' + t(widgetKind('', source.provider)))) ?? [];
  const widgets = catalogue?.widgets.filter(widget => matches(t(LABELS[widget.id]) + ' ' + t(widgetKind(widget.id)))) ?? [];
  const connectors = catalogue?.connectors.filter(connector => matches(connector.id === 'zai' ? t('sources.zaiPersonal') : connector.name, providerSearch)) ?? [];
  const [provider,setProvider]=useState('openrouter');
  const complete = addition.operation?.state === 'complete';
  return <div className="widget-catalogue">
    <div className="catalogue-heading"><h3>{page === 'connection' ? t('sources.connectProvider',{provider:provider==='zai'?t('sources.zaiPersonal'):PROVIDERS[provider]?.name??provider}) : page === 'device' ? t('connections.connectDevice') : page === 'connect' ? t('add.connect') : t('add.title')}</h3><button className="icon-button" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><X size={14} aria-hidden="true" /></button></div>
    {page !== 'catalogue' && <button className="link-button connection-back" onClick={() => setPage('catalogue')}>← {t('add.title')}</button>}
    {page === 'connection' ? <KeyForm key={provider} provider={provider} board={board} personal={false} demo={catalogue?.demo} available={trustedKeys?.available === true} storageReason={trustedKeys?.reason} onClose={onClose} /> :
      page === 'device' ? <DeviceAdd board={board} demo={!!catalogue?.demo} onClose={onClose} /> :
      page === 'connect' ? <div className="dialog-form">
        <Field label={t('add.searchProviders')} type="search" autoFocus value={providerSearch} onChange={event => setProviderSearch(event.target.value)} />
        <div className="catalogue-list popover-scroll">{connectors.map(connector => <button type="button" className="popover-row catalogue-connect" key={connector.id} onClick={() => {setProvider(connector.id);setPage('connection');}}><img src={logoOf(connector.id)} alt="" /><span>{connector.id === 'zai' ? t('sources.zaiPersonal') : connector.name}</span><span aria-hidden="true">→</span></button>)}{!connectors.length && <p className="popover-note dialog-text">{t('add.noProviders')}</p>}</div>
        {!local && <button type="button" className="popover-row catalogue-connect" onClick={() => setPage('device')}><Monitor size={20} aria-hidden="true" /><span>{t('connections.connectDevice')}</span><span aria-hidden="true">→</span></button>}
      </div> :
      complete ? <Completion operation={addition.operation!} board={board} personal={false} onClose={onClose} /> : candidate ? <div className="dialog-form">
        <button className="link-button connection-back" onClick={() => setCandidate(null)}>← {t('add.title')}</button><h3>{candidate.label}</h3><p className="sharing-disclosure">{t(board.personal || candidate.onBoard ? 'add.showDisclosure' : 'add.disclosure', {board: boardTitle(board)})}</p>
        <ErrorLine error={addition.error} /><div className="button-row"><button className="button" onClick={() => setCandidate(null)}>{t('common.cancel')}</button><button className="button primary" disabled={addition.busy} onClick={() => void addition.submit(board.id, {kind: 'sources', sourceIds: [candidate.id]})}>{t(candidate.action === 'show' ? 'add.show' : 'add.action')}</button></div>
      </div> : <div className="dialog-form">
        <Field label={t('add.search')} type="search" value={search} autoFocus onChange={event => setSearch(event.target.value)} />
        <ErrorLine error={error ?? addition.error} />
        {addition.operation && <div className="addition-recovery"><ErrorLine error={addition.error} /><button className="button" disabled={addition.busy} onClick={() => void addition.check()}>{t('add.checkResult')}</button>{['ready', 'needs_input'].includes(addition.operation.state) && <button className="button" disabled={addition.busy} onClick={() => void addition.submit(addition.operation!.boardId, addition.operation!.item)}>{t('add.action')}</button>}{['expired', 'failed'].includes(addition.operation.state) && <button className="button" onClick={addition.reset}>{t('add.startAgain')}</button>}</div>}
        {catalogue && <><div className="catalogue-list popover-scroll">{sources.map(source => <div className="catalogue-row" key={source.id}>
          <img src={logoOf(source.provider)} alt="" /><span className="catalogue-name"><b>{source.label}</b><small>{t(widgetKind('', source.provider))}</small></span>
          <button className="button" disabled={addition.busy} onClick={() => setCandidate(source)}>{t(source.action === 'show' ? 'add.show' : 'add.action')}</button>
        </div>)}
        {widgets.map(widget => {const Icon = WIDGET_ICONS[widget.id];return <div className="catalogue-row" key={widget.id}><Icon size={22} aria-hidden="true" /><span className="catalogue-name"><b>{t(LABELS[widget.id])}</b><small>{t(widgetKind(widget.id))}</small></span><button className="button" disabled={addition.busy} onClick={() => void addition.submit(board.id, {kind: 'widget', widgetId: widget.id})}>{t('add.action')}</button></div>;})}
        {!sources.length && !widgets.length && <p className="popover-note dialog-text">{t(search.trim() ? 'add.noWidgets' : 'add.allVisible')}</p>}
        </div><button type="button" className="popover-row catalogue-connect catalogue-connect-entry" onClick={() => setPage('connect')}><Plug size={20} aria-hidden="true" /><span>{t('add.connect')}</span><span aria-hidden="true">→</span></button></>}
      </div>}
  </div>;
}

export function WidgetAdd({board, local, trustedKeys, open, onOpenChange, initialSourceId, trigger}: {
  board: Board; local: boolean; trustedKeys: Session['trustedKeys']; open: boolean;
  onOpenChange: (open: boolean) => void; initialSourceId?: string; trigger?: string;
}) {
  return <Popover label={t('add.title')}
    trigger={trigger ?? <><Plus size={16} aria-hidden="true" /><span>{t('add.action')}</span></>} triggerClass={trigger ? 'button' : 'button board-action-button'} open={open} onOpenChange={onOpenChange} width={420}>
    {open && <WidgetCatalogue key={board.id} board={board} local={local} trustedKeys={trustedKeys} initialSourceId={initialSourceId} onClose={() => onOpenChange(false)} />}
  </Popover>;
}

type ConnectionDetails = Credential & {label: string; lastSuccessAt: number | null; placements: (Board & {visible: boolean})[]};

export function ConnectionsPage({userId, boards, trustedKeys, local}: {userId: string; boards: Board[]; trustedKeys: Session['trustedKeys']; local: boolean}) {
  const [connections, setConnections] = useState<ConnectionDetails[]>([]), [demo, setDemo] = useState<Demo | undefined>();
  const [provider,setProvider]=useState<string|null>(null);
  const [connecting, setConnecting] = useState(false), [replace, setReplace] = useState<Credential | undefined>(), [error, setError] = useState<unknown>(null), [remove, setRemove] = useState<Credential | null>(null);
  const [adding, setAdding] = useState<Board | null>(null), [choosing, setChoosing] = useState(false), [selectedSource, setSelectedSource] = useState<string | undefined>();
  const [readAt, setReadAt] = useState<number | null>(null);
  const [recovered, setRecovered] = useState<Operation | undefined>();
  const readGeneration = useRef(0), mounted = useRef(true);
  const read = useCallback(async (signal?: AbortSignal) => {
    if (!mounted.current) return;
    const own = ++readGeneration.current;
    try {const reply = await call<{connections: ConnectionDetails[]; demo?: Demo}>('GET', '/api/connections', undefined, 12_000, signal); if (!signal?.aborted && mounted.current && own === readGeneration.current) {setConnections(reply.connections); setDemo(reply.demo); setReadAt(Date.now()); setError(null);}}
    catch (failure) {if (!signal?.aborted && mounted.current && own === readGeneration.current) setError(failure);}
  }, [userId]);
  useEffect(() => {mounted.current = true; const abort = new AbortController(); void read(abort.signal); return () => {mounted.current = false; readGeneration.current++; abort.abort();};}, [read]);
  const disconnect = async () => {
    try {await call('DELETE', '/api/credentials/' + remove!.id); setRemove(null); void read();}
    catch (failure) {setError(failure);}
  };
  const recoveryBoard = recovered?.boardId ? boards.find(board => board.id === recovered.boardId) : boards.find(board => board.personal);
  const restore = (operation: Operation) => {
    const id = operation.item.kind === 'replace' ? operation.item.credentialId : undefined;
    setRecovered(operation); setReplace(connections.find(record => record.id === id));setProvider(operation.item.kind==='connection'||operation.item.kind==='replace'?operation.item.provider??connections.find(record=>record.id===id)?.provider??'openrouter':null);
    setConnecting(operation.item.kind === 'connection' || operation.item.kind === 'replace');
  };
  const groups = [...new Set(connections.map(record => record.sourceId ?? record.id))].map(id => connections.filter(record => (record.sourceId ?? record.id) === id));
  return <div className="dialog-form"><div className="settings-section-head"><h2>{t('settings.connections')}</h2><button className="button primary" onClick={() => {setRecovered(undefined); setReplace(undefined);setProvider(null);setConnecting(true);}}>{t('add.connectNew')}</button></div>
    {demo && <DemoNotice />}<p className="dialog-text">{t('settings.connectionScope')}</p><div className="settings-section-head"><small className="drawer-note">{readAt && t('settings.checkedAt', {time: stamp(readAt)})}</small><button className="link-button" onClick={() => void read()}>{t('refresh.action')}</button></div>
    <ErrorLine error={error} />{!connections.length && <p className="admin-empty">{t('sources.empty')}</p>}
    <RecentAdditions onRestore={restore} />
    {recovered && !connecting && <section className="connection-editor"><RecoveredAddition key={recovered.id} operation={recovered} board={recoveryBoard ?? null} onClose={() => setRecovered(undefined)} /></section>}
    {groups.map(group => <section className="connection-group" key={group[0].sourceId ?? group[0].id}>{group.length > 1 && <h3>{t('connections.savedAccesses', {count: group.length})}</h3>}{group.map(connection => <article key={connection.id} className="connection-record"><div className="connection-record-head"><img src={logoOf(connection.provider)} alt="" /><div><h3>{connection.label}</h3><small>{t('sources.account')}{connection.hint && ' …' + connection.hint}</small></div></div>
      {connection.lastError ? <ErrorLine error={new ApiError(400, connection.lastError)} /> : <p className="connection-health">{t('connections.healthy')}</p>}
      <dl className="connection-facts"><dt>{t('connections.expiry')}</dt><dd>{connection.expiryKind==='unknown'?t('sources.unknownExpiry'):connection.expiresAt === null ? t('sources.noExpiry') : stamp(connection.expiresAt)}</dd><dt>{t('connections.lastSuccess')}</dt><dd>{connection.lastSuccessAt ? stamp(connection.lastSuccessAt) : '—'}</dd><dt>{t('connections.boards')}</dt><dd>{connection.placements.map(placement => <span className="placement-tag" key={placement.id}>{boardTitle(placement)}{!placement.visible && <small>{t('connections.hidden')}</small>}</span>)}</dd></dl>
      <div className="button-row is-start"><button className="button" onClick={() => {setSelectedSource(connection.sourceId ?? undefined); setChoosing(true);}}>{t('add.toBoard')}</button><button className="button" onClick={() => {setRecovered(undefined); setReplace(connection);setProvider(connection.provider);setConnecting(true);}}>{t('sources.replace')}</button><button className="link-button danger" onClick={() => setRemove(connection)}>{t('sources.remove')}</button></div>
    </article>)}</section>)}
    {connecting && <section className="connection-editor"><h3>{replace?t('sources.replace'):provider?t('sources.connectProvider',{provider:provider==='zai'?t('sources.zaiPersonal'):PROVIDERS[provider]?.name??provider}):t('add.connectNew')}</h3>{!provider?<div className="dialog-form">{providerCatalogue.filter(item=>item.measuredBy==='hub').map(item=><button type="button" className="popover-row" key={item.id} onClick={()=>setProvider(item.id)}><img src={logoOf(item.id)} width="22" alt=""/><span>{item.id==='zai'?t('sources.zaiPersonal'):item.name}</span></button>)}</div>:!recoveryBoard && recovered ? <ErrorLine error={new ApiError(403, 'addition_permission')} /> : <KeyForm key={recovered?.id ?? replace?.id ?? provider} provider={provider} board={recoveryBoard ?? boards.find(board => board.personal) ?? null} personal={!recovered?.boardId} initialOperation={recovered} replace={replace} demo={demo} available={trustedKeys?.available === true} storageReason={trustedKeys?.reason} onClose={() => {setConnecting(false); setRecovered(undefined);}} onSaved={() => void read()} onAddToBoard={sourceId => {setConnecting(false); setSelectedSource(sourceId); setChoosing(true);}} />}</section>}
    {choosing && <section className="connection-editor"><h3>{t('add.toBoard')}</h3><p className="dialog-text">{t('add.chooseBoard')}</p>{boards.map(board => <button className="popover-row" key={board.id} onClick={() => {setChoosing(false); setAdding(board);}}><span>{boardTitle(board)}</span></button>)}<button className="link-button" onClick={() => setChoosing(false)}>{t('common.cancel')}</button></section>}
    {adding && <WidgetAdd board={adding} initialSourceId={selectedSource} local={local} trustedKeys={trustedKeys} open onOpenChange={open => {if (!open) {setAdding(null); void read();}}} trigger={boardTitle(adding)} />}
    {remove && <Modal title={t('sources.remove')} onClose={() => setRemove(null)}><p className="dialog-text">{t('sources.removeText')}</p><p className="dialog-text">{t('add.disconnectEffect')}</p><ErrorLine error={error} /><div className="button-row"><button className="button" onClick={() => setRemove(null)}>{t('common.cancel')}</button><button className="button danger" onClick={() => void disconnect()}>{t('sources.remove')}</button></div></Modal>}
  </div>;
}
