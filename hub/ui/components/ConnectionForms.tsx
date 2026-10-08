import {widgetVisible} from '../../server/domain/widgets';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import {t} from '../i18n';
import {ApiError, call} from '../lib/http';
import {boardHref, navigate, settingsHref, usePath} from '../lib/router';
import {boardTitle, type Board} from '../lib/session';
import {useBoardId, useConnectionsRevision, useLineup, useServerView} from '../lib/board';
import {cardId, flushView, isHidden} from '../lib/view';
import {PROVIDERS} from '../lib/providers';
import {stamp} from '../lib/format';
import type {Credential} from '../../server/store/credentials';
import {useAddition, type Demo, type Catalogue, type Item, type Operation} from '../lib/addition';
import {Field, ErrorLine} from './Kit';
import {ConnectDevice, type Device} from './Machines';
import {Check, ExternalLink} from 'lucide-react';

export function DemoNotice() {
  return <p className="prototype-note">{t('prototype.notice')}</p>;
}

export function Completion({
  operation,
  board,
  personal,
  onClose,
}: {
  operation: Operation;
  board: Board | null;
  personal: boolean;
  onClose: () => void;
}) {
  const lineup = useLineup(),
    view = useServerView(),
    currentBoard = useBoardId();
  const path = usePath();
  const widgets = operation.item.kind === 'widget' ? operation.widgetIds ?? [operation.item.widgetId] : [];
  const widget = widgets[0] ?? null;
  const visible =
    !personal &&
    currentBoard === board?.id &&
    view &&
    (widget
      ? widgets.every(id => widgetVisible(view, id, lineup.length))
      : operation.result?.sourceIds.every(id => lineup.includes(id) && !isHidden(view, cardId(id))));
  const source = operation.result?.sourceIds[0];
  const changed =
    operation.current?.sources?.some(item => item.placement !== 'visible') ||
    operation.current?.widgets?.some(widget => widget.placement !== 'visible') ||
    (operation.current?.credential && !operation.current.credential.exists);
  const focusId = source ? cardId(source) : widget;
  const focus = () => {
    onClose();
    if (personal || !visible || !['/', '/local'].includes(path)) navigate(boardHref(board?.id ?? ''));
    if (!personal && visible && focusId)
      requestAnimationFrame(() => {
        const element = document.querySelector<HTMLElement>(`[data-widget="${focusId}"]`);
        if (element) {
          element.tabIndex = -1;
          element.scrollIntoView({block: 'center', behavior: 'smooth'});
          element.focus({preventScroll: true});
        }
      });
  };
  return (
    <div className="addition-complete" role="status">
      <span className="completion-symbol" aria-hidden="true">
        <Check size={24} />
      </span>
      <h3>{t(changed ? 'add.changed' : personal ? 'add.connected' : visible ? 'add.complete' : 'add.waiting')}</h3>
      <p>
        {t(changed ? 'add.changedText' : personal ? 'add.personalResult' : 'add.boardResult', {
          board: board ? boardTitle(board) : t('boards.personalName'),
        })}
      </p>
      {operation.result?.connection === 'reused' && (
        <p className="dialog-text">{t(operation.result.replacementRequired ? 'add.replaceNeeded' : 'add.reused')}</p>
      )}
      {operation.result?.replacementRequired && (
        <a
          href={settingsHref('/settings/connections', board?.id ?? '')}
          onClick={event => {
            event.preventDefault();
            onClose();
            navigate(settingsHref('/settings/connections', board?.id ?? ''));
          }}
        >
          {t('settings.connections')}
        </a>
      )}
      {operation.warning && <ErrorLine error={new ApiError(503, operation.warning)} />}
      {operation.result?.expiresAt !== undefined && (
        <p className="dialog-text">
          {operation.result.expiryKind === 'unknown'
            ? t('sources.unknownExpiry')
            : operation.result.expiresAt === null
              ? t('sources.noExpiry')
              : t('connections.expires', {time: stamp(operation.result.expiresAt)})}
        </p>
      )}
      <button className="button primary" disabled={!board || operation.current?.boardAccessible === false} onClick={focus}>
        {t(personal || !visible ? 'add.openBoard' : 'add.viewWidget')}
      </button>
    </div>
  );
}

export function RecoveredAddition({operation, board, onClose}: {operation: Operation; board: Board | null; onClose: () => void}) {
  const addition = useAddition();
  useEffect(() => addition.restore(operation), [operation.id]);
  const current = addition.operation ?? operation;
  if (current.state === 'complete')
    return <Completion operation={current} board={board} personal={current.boardId === null} onClose={onClose} />;
  return (
    <div className="dialog-form">
      <ErrorLine error={addition.error} />
      {current.state === 'verifying' && <p role="status">{t('add.verifying')}</p>}
      <button className="button" disabled={addition.busy} onClick={() => void addition.check()}>
        {t('add.checkResult')}
      </button>
      {board && ['ready', 'needs_input'].includes(current.state) && (
        <button className="button" disabled={addition.busy} onClick={() => void addition.submit(current.boardId, current.item)}>
          {t('add.action')}
        </button>
      )}
      <button className="link-button" onClick={onClose}>
        {t('common.close')}
      </button>
    </div>
  );
}

export function KeyForm({
  board,
  provider: chosenProvider = 'openrouter',
  replace,
  personal,
  demo,
  available,
  storageReason,
  onClose,
  onSaved,
  onAddToBoard,
  initialOperation,
}: {
  board: Board | null;
  provider?: string;
  replace?: Credential;
  personal: boolean;
  demo?: Demo;
  available: boolean;
  storageReason?: string | null;
  onClose: () => void;
  onSaved?: () => void;
  onAddToBoard?: (sourceId: string) => void;
  initialOperation?: Operation;
}) {
  const [secret, setSecret] = useState('');
  const provider =
    replace?.provider ??
    (initialOperation?.item.kind === 'connection' || initialOperation?.item.kind === 'replace'
      ? initialOperation.item.provider
      : undefined) ??
    chosenProvider;
  const namedAccounts = provider === 'deepseek',
    declared = namedAccounts || provider === 'zai';
  const savedTarget = initialOperation?.item.kind === 'connection' ? initialOperation.item.account : undefined;
  const [account, setAccount] = useState(savedTarget?.kind === 'existing' ? savedTarget.id : 'new'),
    [name, setName] = useState('');
  const [consent, setConsent] = useState(false),
    [sameAccount, setSameAccount] = useState(false);
  const [accounts, setAccounts] = useState<{id: string; name: string; connected: boolean}[]>([]),
    [after, setAfter] = useState<string>(),
    [next, setNext] = useState<string | null>(null),
    [back, setBack] = useState<(string | undefined)[]>([]),
    [loadedAfter, setLoadedAfter] = useState<string | undefined | null>(null),
    [accountsError, setAccountsError] = useState<unknown>(null);
  useEffect(() => {
    if (!namedAccounts || replace || initialOperation) return;
    let live = true;
    call<{accounts: {id: string; name: string; connected: boolean}[]; next: string | null}>(
      'GET',
      '/api/source-accounts?provider=deepseek&limit=10' + (after ? '&after=' + encodeURIComponent(after) : ''),
    ).then(
      reply => {
        if (live) {
          setAccounts(reply.accounts);
          setNext(reply.next);
          setLoadedAfter(after);
          setAccountsError(null);
        }
      },
      failure => {
        if (live) setAccountsError(failure);
      },
    );
    return () => {
      live = false;
    };
  }, [namedAccounts, replace?.id, initialOperation?.id, after]);
  const addition = useAddition();
  const replacing = !!replace || initialOperation?.item.kind === 'replace';
  const needsSame = declared && (replacing || (namedAccounts && account !== 'new'));
  const accountReady = !!initialOperation || !namedAccounts || replacing || loadedAfter === after;
  const validAccount = account === 'new' || !!savedTarget || (accountReady && accounts.some(item => item.id === account));
  const blocked =
    !available ||
    addition.busy ||
    (declared && !consent) ||
    (needsSame && !sameAccount) ||
    (namedAccounts && !replacing && (!accountReady || !validAccount || (account === 'new' && !name.trim())));
  const changed = () => {
    if (!initialOperation) addition.reset();
    setSameAccount(false);
  };
  useEffect(() => {
    if (initialOperation) addition.restore(initialOperation);
  }, [initialOperation?.id]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const item: Item =
      initialOperation?.item.kind === 'replace'
        ? {kind: 'replace', credentialId: initialOperation.item.credentialId}
        : replace
          ? {kind: 'replace', credentialId: replace.id}
          : {
              kind: 'connection',
              provider,
              ...(namedAccounts ? {account: savedTarget ?? (account === 'new' ? {kind: 'new'} : {kind: 'existing', id: account})} : {}),
            };
    if (blocked) return;
    void addition.submit(
      personal || replacing ? null : board!.id,
      item,
      secret,
      declared
        ? {
            allowUnknownExpiry: consent,
            ...(needsSame ? {sameAccount} : {}),
            ...(namedAccounts && !replacing && account === 'new' ? {accountName: name} : {}),
          }
        : {},
    );
  };
  useEffect(() => {
    if (addition.operation?.state === 'complete') {
      setSecret('');
      onSaved?.();
    }
  }, [addition.operation?.state]);
  if (addition.operation?.state === 'complete') {
    if (addition.operation.item.kind === 'replace') {
      const current = addition.operation.current?.credential;
      const changed = current && (!current.exists || !current.revisionMatches);
      return (
        <div className="addition-complete" role="status">
          <h3>{t(changed ? 'add.keyChanged' : 'add.replaced')}</h3>
          <p>{t(changed ? 'add.keyChangedText' : 'add.replacePreserved')}</p>
          {addition.operation.warning && <ErrorLine error={new ApiError(503, addition.operation.warning)} />}
          <ErrorLine error={addition.error} />
          {addition.operation.warning && (
            <button className="button" disabled={addition.busy} onClick={() => void addition.submit(null, addition.operation!.item)}>
              {t('add.retryCleanup')}
            </button>
          )}
          <button className="button" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      );
    }
    return (
      <>
        <Completion operation={addition.operation} board={board} personal={personal} onClose={onClose} />
        {personal && onAddToBoard && (
          <div className="button-row">
            <button className="button" onClick={() => onAddToBoard(addition.operation!.result!.sourceIds[0])}>
              {t('add.toBoard')}
            </button>
          </div>
        )}
      </>
    );
  }
  if (addition.operation && ['expired', 'failed'].includes(addition.operation.state))
    return (
      <div className="dialog-form">
        <ErrorLine error={addition.error} />
        <button
          className="button"
          onClick={() => {
            setSecret('');
            addition.reset();
          }}
        >
          {t('add.startAgain')}
        </button>
      </div>
    );
  return (
    <form className="dialog-form" onSubmit={submit}>
      {demo && <DemoNotice />}
      <div className="connect-destination">
        <small>{t('add.destination')}</small>
        <b>{personal ? t('boards.personalName') : boardTitle(board!)}</b>
      </div>
      <p className="dialog-text">
        {t(namedAccounts ? 'sources.deepseekRights' : provider === 'zai' ? 'sources.zaiRights' : 'add.keyRights')}
      </p>
      <a
        className="provider-link"
        href={
          namedAccounts
            ? 'https://platform.deepseek.com/api_keys'
            : provider === 'zai'
              ? 'https://z.ai/manage-apikey/apikey-list'
              : 'https://openrouter.ai/settings/management-keys'
        }
        target="_blank"
        rel="noopener noreferrer"
      >
        {t(namedAccounts ? 'sources.deepseekSettings' : provider === 'zai' ? 'sources.zaiSettings' : 'sources.providerSettings')}
        <ExternalLink size={14} aria-hidden="true" />
      </a>
      {!personal && !board?.personal && <p className="sharing-disclosure">{t('add.disclosure', {board: boardTitle(board!)})}</p>}
      {replacing && <p className="dialog-text">{t('add.replacePreserved')}</p>}
      {demo && (
        <details className="demo-examples">
          <summary>{t('prototype.examples')}</summary>
          <div className="button-row is-start">
            {demo.keys
              .filter(key => (key.provider ?? 'openrouter') === provider)
              .map(key => (
                <button
                  type="button"
                  className="button"
                  key={key.label}
                  disabled={addition.busy}
                  onClick={() => {
                    setSecret(key.secret);
                    changed();
                    setConsent(false);
                  }}
                >
                  {t(`prototype.${key.label}`)}
                </button>
              ))}
          </div>
        </details>
      )}
      {demo && (
        <label className="demo-loss">
          <input
            type="checkbox"
            disabled={addition.busy}
            onChange={event => {
              void call('POST', '/api/prototype/control', {lostReply: event.target.checked});
            }}
          />
          {t('prototype.lostReply')}
        </label>
      )}
      {namedAccounts && (
        <>
          <p className="drawer-note">{t('sources.declaredIdentity')}</p>
          {!replacing && (
            <>
              <label className="field">
                <span>{t('sources.account')}</span>
                <select
                  value={account}
                  disabled={addition.busy || !available || !accountReady || !!initialOperation}
                  onChange={event => {
                    setAccount(event.target.value);
                    changed();
                  }}
                >
                  <option value="new">{t('sources.newAccount')}</option>
                  {savedTarget?.kind === 'existing' && <option value={savedTarget.id}>{t('sources.account')}</option>}
                  {accounts.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.connected ? '' : ` (${t('sources.disconnected')})`}
                    </option>
                  ))}
                </select>
              </label>
              {(back.length > 0 || next) && (
                <div className="button-row">
                  <button
                    type="button"
                    className="button"
                    disabled={addition.busy || !accountReady || !back.length}
                    onClick={() => {
                      setAfter(back.at(-1));
                      setBack(back.slice(0, -1));
                      setAccount('new');
                      changed();
                    }}
                  >
                    {t('sources.backAccounts')}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={addition.busy || !accountReady || !next}
                    onClick={() => {
                      setBack([...back, after]);
                      setAfter(next!);
                      setAccount('new');
                      changed();
                    }}
                  >
                    {t('sources.moreAccounts')}
                  </button>
                </div>
              )}
              {account === 'new' && (
                <Field
                  label={t('sources.accountName')}
                  value={name}
                  maxLength={240}
                  required
                  disabled={addition.busy || !available}
                  onChange={event => {
                    setName(event.target.value);
                    changed();
                  }}
                />
              )}
            </>
          )}
        </>
      )}
      {needsSame && (
        <>
          <p className="drawer-note">{t('sources.declaredAccount')}</p>
          <label className="source-consent">
            <input
              type="checkbox"
              checked={sameAccount}
              disabled={addition.busy || !available}
              onChange={event => setSameAccount(event.target.checked)}
            />
            {namedAccounts
              ? t('sources.sameAccount', {
                  name: replace?.accountName ?? accounts.find(item => item.id === account)?.name ?? t('sources.account'),
                })
              : t('sources.sameAccountConsent')}
          </label>
          <p className="drawer-note">{t('sources.otherAccount')}</p>
        </>
      )}
      <Field
        type="password"
        label={t(declared ? 'sources.apiKey' : 'sources.key')}
        value={secret}
        autoComplete="new-password"
        data-1p-ignore=""
        data-lpignore="true"
        required
        maxLength={4096}
        autoFocus
        disabled={addition.busy}
        onChange={event => {
          setSecret(event.target.value);
          changed();
          setConsent(false);
        }}
      />
      {declared ? (
        <label className="source-consent">
          <input
            type="checkbox"
            checked={consent}
            disabled={addition.busy || !available}
            onChange={event => setConsent(event.target.checked)}
          />
          {t('sources.unknownExpiryConsent')}
        </label>
      ) : (
        <p className="drawer-note">{t('add.expiryInfo')}</p>
      )}
      <ErrorLine error={accountsError} />
      {!available &&
        (storageReason === 'secret_key_mismatch' ? (
          <p className="form-error">{t('trustedKeys.serverMismatch')}</p>
        ) : storageReason ? (
          <ErrorLine error={new ApiError(409, storageReason)} />
        ) : (
          <p className="form-error">{t('trustedKeys.serverMissing')}</p>
        ))}
      <ErrorLine error={addition.error} />
      {addition.busy && (
        <p role="status" className="progress-line">
          <i className="spinner" />
          {t('add.verifying')}
        </p>
      )}
      {addition.operation && !!addition.error && (
        <button className="link-button" type="button" disabled={addition.busy} onClick={() => void addition.check()}>
          {t('add.checkResult')}
        </button>
      )}
      <div className="button-row">
        <button type="button" className="button" onClick={onClose}>
          {t('common.close')}
        </button>
        <button className="button primary" disabled={blocked || !secret}>
          {replacing
            ? t('sources.replace')
            : personal
              ? t('sources.connectProvider', {
                  provider: provider === 'zai' ? t('sources.zaiPersonal') : (PROVIDERS[provider]?.name ?? provider),
                })
              : t('add.connectAndAdd')}
        </button>
      </div>
      {addition.busy && <p className="drawer-note">{t('add.closePending')}</p>}
    </form>
  );
}

export function DeviceAdd({board, demo, onClose}: {board: Board; demo: boolean; onClose: () => void}) {
  const [devices, setDevices] = useState<Device[]>([]),
    [device, setDevice] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState<unknown>(null);
  const [available, setAvailable] = useState<string[]>([]);
  type Intent = {
    id: string;
    boardId: string;
    deviceId: string | null;
    sourceIds: string[];
    additionId: string | null;
    status: string;
    createdAt: number;
  };
  type Pending = {userCode: string; machine: {name: string; os: string; arch: string}};
  const [intent, setIntent] = useState<Intent | null>(null),
    [recent, setRecent] = useState<Intent[]>([]),
    [code, setCode] = useState(''),
    [pending, setPending] = useState<Pending | null>(null),
    [selecting, setSelecting] = useState(false);
  const requestId = useRef(crypto.randomUUID()),
    selectionId = useRef(crypto.randomUUID());
  const mounted = useRef(true),
    revision = useConnectionsRevision();
  const addition = useAddition();
  const read = async () => {
    try {
      const [nextDevices, catalogue] = await Promise.all([
        call<Device[]>('GET', '/api/devices'),
        call<Catalogue>('GET', '/api/boards/' + board.id + '/catalogue'),
      ]);
      if (!mounted.current) return;
      const ids = catalogue.sources.map(source => source.id);
      setDevices(nextDevices);
      setAvailable(ids);
      setSelected(current => current.filter(id => ids.includes(id)));
    } catch (failure) {
      setError(failure);
    }
  };
  const recover = async (id: string) => {
    try {
      const next = await call<Intent>('GET', '/api/device-onboarding/' + id);
      if (!mounted.current) return;
      setIntent(next);
      if (next.deviceId) setDevice(next.deviceId);
      setSelected(next.sourceIds);
      if (next.additionId) {
        const operation = await call<Operation>('GET', '/api/additions/' + next.additionId);
        if (mounted.current) addition.restore(operation);
      }
    } catch (failure) {
      if (mounted.current) setError(failure);
    }
  };
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void call<Intent>('POST', '/api/device-onboarding', {requestId: requestId.current, boardId: board.id}, 12_000, abort.signal).then(
      value => {
        if (!abort.signal.aborted) setIntent(value);
      },
      failure => {
        if (!abort.signal.aborted) setError(failure);
      },
    );
    void call<{intents: Intent[]}>('GET', '/api/device-onboarding?limit=20', undefined, 12_000, abort.signal).then(
      value => {
        if (!abort.signal.aborted) setRecent(value.intents.filter(item => item.boardId === board.id));
      },
      failure => {
        if (!abort.signal.aborted) setError(failure);
      },
    );
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, [board.id]);
  useEffect(() => {
    void read();
    if (intent) void recover(intent.id);
  }, [revision]);
  const finish = async () => {
    if (!intent || selecting) return;
    setSelecting(true);
    setError(null);
    try {
      await flushView(board.id);
      const operation = intent.additionId
        ? await call<Operation>('GET', '/api/additions/' + intent.additionId)
        : await call<Operation>('POST', '/api/device-onboarding/' + intent.id + '/selection', {
            requestId: selectionId.current,
            deviceId: device,
            sourceIds: selected,
          });
      if (!mounted.current) return;
      addition.restore(operation);
      await addition.submit(operation.boardId, operation.item);
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      if (mounted.current) setSelecting(false);
    }
  };
  const chosen = devices.find(item => item.id === device);
  if (addition.operation?.state === 'complete')
    return <Completion operation={addition.operation} board={board} personal={false} onClose={onClose} />;
  return (
    <div className="dialog-form">
      {demo && <DemoNotice />}
      <p className="sharing-disclosure">{t('add.deviceDestination', {board: boardTitle(board)})}</p>
      {recent.length > 0 && (
        <details className="recent-additions">
          <summary>{t('add.recentDevices')}</summary>
          {recent.map(item => (
            <button className="popover-row" key={item.id} onClick={() => void recover(item.id)}>
              <span>{stamp(item.createdAt)}</span>
              <b>{t('add.checkResult')}</b>
            </button>
          ))}
        </details>
      )}
      {intent && <ConnectDevice onboardingId={intent.id} />}
      {intent && !intent.additionId && (
        <form
          className="dialog-form"
          onSubmit={event => {
            event.preventDefault();
            void call<Pending>('GET', '/api/device?code=' + encodeURIComponent(code)).then(setPending, setError);
          }}
        >
          <Field
            label={t('device.code')}
            value={code}
            placeholder="XXXX-XXXX"
            onChange={event => {
              setCode(event.target.value);
              setPending(null);
            }}
          />
          {pending ? (
            <>
              <p className="dialog-text">
                {pending.machine.name}
                <br />
                {pending.machine.os} {pending.machine.arch}
              </p>
              <p className="dialog-text">{t('device.warning')}</p>
              <button
                type="button"
                className="button"
                onClick={() => {
                  void call('POST', '/api/device/approve', {code: pending.userCode, onboardingId: intent.id}).then(() => {
                    setPending(null);
                    setCode('');
                    void recover(intent.id);
                  }, setError);
                }}
              >
                {t('device.connect')}
              </button>
            </>
          ) : (
            <button className="button" disabled={!code.trim()}>
              {t('device.continue')}
            </button>
          )}
        </form>
      )}
      {demo && (
        <button
          className="button"
          onClick={() => {
            void call<{deviceId: string}>('POST', '/api/prototype/device', {}).then(async reply => {
              await read();
              setDevice(reply.deviceId);
              setSelected([]);
            }, setError);
          }}
        >
          {t('prototype.device')}
        </button>
      )}
      <button className="button" onClick={() => void read()}>
        {t('add.refreshDevices')}
      </button>
      <p className="dialog-text">{t('add.selectDevice')}</p>
      <select
        aria-label={t('connections.device')}
        value={device}
        disabled={selecting || addition.busy || !!intent?.additionId}
        onChange={event => {
          setDevice(event.target.value);
          setSelected([]);
        }}
      >
        <option value="">{t('add.chooseDevice')}</option>
        {devices.map(item => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      {chosen && (
        <fieldset className="source-selection" disabled={selecting || addition.busy || !!intent?.additionId}>
          <legend>{t('add.selectSources')}</legend>
          {chosen.sources
            .filter(source => available.includes(source.source) || intent?.sourceIds.includes(source.source))
            .map(source => (
              <label key={source.source}>
                <input
                  type="checkbox"
                  checked={selected.includes(source.source)}
                  onChange={event =>
                    setSelected(ids => (event.target.checked ? [...ids, source.source] : ids.filter(id => id !== source.source)))
                  }
                />
                <span>{PROVIDERS[source.provider]?.name ?? source.provider}</span>
              </label>
            ))}
        </fieldset>
      )}
      <ErrorLine error={error ?? addition.error} />
      <p className="drawer-note">{t('add.futureSources')}</p>
      {intent && (
        <button className="link-button" onClick={() => void recover(intent.id)}>
          {t('add.checkResult')}
        </button>
      )}
      <div className="button-row">
        <button className="button" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="button primary"
          disabled={!intent || !selected.length || addition.busy || selecting || ['expired', 'complete'].includes(intent.status)}
          onClick={() => void finish()}
        >
          {t('add.selection')}
        </button>
      </div>
    </div>
  );
}
