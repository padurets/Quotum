import {useCallback, useEffect, useRef, useState} from 'react';
import {t} from '../i18n';
import {ApiError, call} from '../lib/http';
import {boardTitle, type Board, type Session} from '../lib/session';
import {useConnectionsRevision} from '../lib/board';
import {PROVIDERS} from '../lib/providers';
import {stamp} from '../lib/format';
import {catalogue as providerCatalogue} from '../../server/domain/providers';
import type {Credential} from '../../server/store/credentials';
import {LABELS, type Demo, type Operation} from '../lib/addition';
import {Modal, ErrorLine} from './Kit';
import {logoOf} from './logos';

import {KeyForm, RecoveredAddition, DemoNotice} from './ConnectionForms';
import {WidgetAdd} from './WidgetAdd';

function RecentAdditions({boardId, onRestore}: {boardId?: string; onRestore: (operation: Operation) => void}) {
  const [operations, setOperations] = useState<Operation[]>([]),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null);
  const revision = useConnectionsRevision();
  const read = async (before?: string, signal?: AbortSignal) => {
    try {
      const reply = await call<{operations: Operation[]; next: string | null}>(
        'GET',
        '/api/additions?limit=20' + (before ? '&before=' + encodeURIComponent(before) : ''),
        undefined,
        12_000,
        signal,
      );
      if (!signal?.aborted) {
        setOperations(current => (before ? [...current, ...reply.operations] : reply.operations));
        setNext(reply.next);
      }
    } catch (failure) {
      if (!signal?.aborted) setError(failure);
    }
  };
  useEffect(() => {
    const abort = new AbortController();
    void read(undefined, abort.signal);
    return () => abort.abort();
  }, [revision]);
  const items = operations.filter(operation => boardId === undefined || operation.boardId === boardId);
  return items.length || next || error ? (
    <details className="recent-additions">
      <summary>{t('add.recent')}</summary>
      <ErrorLine error={error} />
      {items.map(operation => (
        <button
          type="button"
          className="popover-row"
          key={operation.id}
          onClick={() => {
            void call<Operation>('GET', '/api/additions/' + operation.id).then(onRestore, setError);
          }}
        >
          <span>
            {operation.item.kind === 'connection'
              ? (PROVIDERS[operation.item.provider]?.name ?? operation.item.provider)
              : operation.item.kind === 'widget'
                ? t(LABELS[operation.item.widgetId])
                : t('add.title')}
            <small>{stamp(operation.createdAt)}</small>
          </span>
          <b>{t(operation.state === 'complete' ? 'add.complete' : 'add.checkResult')}</b>
        </button>
      ))}
      {next && (
        <button className="link-button" type="button" onClick={() => void read(next)}>
          {t('common.more')}
        </button>
      )}
    </details>
  ) : null;
}

type ConnectionDetails = Credential & {label: string; lastSuccessAt: number | null; placements: (Board & {visible: boolean})[]};

export function ConnectionsPage({
  userId,
  boards,
  trustedKeys,
  local,
}: {
  userId: string;
  boards: Board[];
  trustedKeys: Session['trustedKeys'];
  local: boolean;
}) {
  const [connections, setConnections] = useState<ConnectionDetails[]>([]),
    [demo, setDemo] = useState<Demo | undefined>();
  const [provider, setProvider] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false),
    [replace, setReplace] = useState<Credential | undefined>(),
    [error, setError] = useState<unknown>(null),
    [remove, setRemove] = useState<Credential | null>(null);
  const [adding, setAdding] = useState<Board | null>(null),
    [choosing, setChoosing] = useState(false),
    [selectedSource, setSelectedSource] = useState<string | undefined>();
  const [readAt, setReadAt] = useState<number | null>(null);
  const [recovered, setRecovered] = useState<Operation | undefined>();
  const readGeneration = useRef(0),
    mounted = useRef(true);
  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (!mounted.current) return;
      const own = ++readGeneration.current;
      try {
        const reply = await call<{connections: ConnectionDetails[]; demo?: Demo}>('GET', '/api/connections', undefined, 12_000, signal);
        if (!signal?.aborted && mounted.current && own === readGeneration.current) {
          setConnections(reply.connections);
          setDemo(reply.demo);
          setReadAt(Date.now());
          setError(null);
        }
      } catch (failure) {
        if (!signal?.aborted && mounted.current && own === readGeneration.current) setError(failure);
      }
    },
    [userId],
  );
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void read(abort.signal);
    return () => {
      mounted.current = false;
      readGeneration.current++;
      abort.abort();
    };
  }, [read]);
  const disconnect = async () => {
    try {
      await call('DELETE', '/api/credentials/' + remove!.id);
      setRemove(null);
      void read();
    } catch (failure) {
      setError(failure);
    }
  };
  const recoveryBoard = recovered?.boardId ? boards.find(board => board.id === recovered.boardId) : boards.find(board => board.personal);
  const restore = (operation: Operation) => {
    const id = operation.item.kind === 'replace' ? operation.item.credentialId : undefined;
    setRecovered(operation);
    setReplace(connections.find(record => record.id === id));
    setProvider(
      operation.item.kind === 'connection' || operation.item.kind === 'replace'
        ? (operation.item.provider ?? connections.find(record => record.id === id)?.provider ?? 'openrouter')
        : null,
    );
    setConnecting(operation.item.kind === 'connection' || operation.item.kind === 'replace');
  };
  const groups = [...new Set(connections.map(record => record.sourceId ?? record.id))].map(id =>
    connections.filter(record => (record.sourceId ?? record.id) === id),
  );
  return (
    <div className="dialog-form">
      <div className="settings-section-head">
        <h2>{t('settings.connections')}</h2>
        <button
          className="button primary"
          onClick={() => {
            setRecovered(undefined);
            setReplace(undefined);
            setProvider(null);
            setConnecting(true);
          }}
        >
          {t('add.connectNew')}
        </button>
      </div>
      {demo && <DemoNotice />}
      <p className="dialog-text">{t('settings.connectionScope')}</p>
      <div className="settings-section-head">
        <small className="drawer-note">{readAt && t('settings.checkedAt', {time: stamp(readAt)})}</small>
        <button className="link-button" onClick={() => void read()}>
          {t('refresh.action')}
        </button>
      </div>
      <ErrorLine error={error} />
      {!connections.length && <p className="admin-empty">{t('sources.empty')}</p>}
      <RecentAdditions onRestore={restore} />
      {recovered && !connecting && (
        <section className="connection-editor">
          <RecoveredAddition
            key={recovered.id}
            operation={recovered}
            board={recoveryBoard ?? null}
            onClose={() => setRecovered(undefined)}
          />
        </section>
      )}
      {groups.map(group => (
        <section className="connection-group" key={group[0].sourceId ?? group[0].id}>
          {group.length > 1 && <h3>{t('connections.savedAccesses', {count: group.length})}</h3>}
          {group.map(connection => (
            <article key={connection.id} className="connection-record">
              <div className="connection-record-head">
                <img src={logoOf(connection.provider)} alt="" />
                <div>
                  <h3>{connection.label}</h3>
                  <small>
                    {t('sources.account')}
                    {connection.hint && ' …' + connection.hint}
                  </small>
                </div>
              </div>
              {connection.lastError ? (
                <ErrorLine error={new ApiError(400, connection.lastError)} />
              ) : (
                <p className="connection-health">{t('connections.healthy')}</p>
              )}
              <dl className="connection-facts">
                <dt>{t('connections.expiry')}</dt>
                <dd>
                  {connection.expiryKind === 'unknown'
                    ? t('sources.unknownExpiry')
                    : connection.expiresAt === null
                      ? t('sources.noExpiry')
                      : stamp(connection.expiresAt)}
                </dd>
                <dt>{t('connections.lastSuccess')}</dt>
                <dd>{connection.lastSuccessAt ? stamp(connection.lastSuccessAt) : '—'}</dd>
                <dt>{t('connections.boards')}</dt>
                <dd>
                  {connection.placements.map(placement => (
                    <span className="placement-tag" key={placement.id}>
                      {boardTitle(placement)}
                      {!placement.visible && <small>{t('connections.hidden')}</small>}
                    </span>
                  ))}
                </dd>
              </dl>
              <div className="button-row is-start">
                <button
                  className="button"
                  onClick={() => {
                    setSelectedSource(connection.sourceId ?? undefined);
                    setChoosing(true);
                  }}
                >
                  {t('add.toBoard')}
                </button>
                <button
                  className="button"
                  onClick={() => {
                    setRecovered(undefined);
                    setReplace(connection);
                    setProvider(connection.provider);
                    setConnecting(true);
                  }}
                >
                  {t('sources.replace')}
                </button>
                <button className="link-button danger" onClick={() => setRemove(connection)}>
                  {t('sources.remove')}
                </button>
              </div>
            </article>
          ))}
        </section>
      ))}
      {connecting && (
        <section className="connection-editor">
          <h3>
            {replace
              ? t('sources.replace')
              : provider
                ? t('sources.connectProvider', {
                    provider: provider === 'zai' ? t('sources.zaiPersonal') : (PROVIDERS[provider]?.name ?? provider),
                  })
                : t('add.connectNew')}
          </h3>
          {!provider ? (
            <div className="dialog-form">
              {providerCatalogue
                .filter(item => item.measuredBy === 'hub')
                .map(item => (
                  <button type="button" className="popover-row" key={item.id} onClick={() => setProvider(item.id)}>
                    <img src={logoOf(item.id)} width="22" alt="" />
                    <span>{item.id === 'zai' ? t('sources.zaiPersonal') : item.name}</span>
                  </button>
                ))}
            </div>
          ) : !recoveryBoard && recovered ? (
            <ErrorLine error={new ApiError(403, 'addition_permission')} />
          ) : (
            <KeyForm
              key={recovered?.id ?? replace?.id ?? provider}
              provider={provider}
              board={recoveryBoard ?? boards.find(board => board.personal) ?? null}
              personal={!recovered?.boardId}
              initialOperation={recovered}
              replace={replace}
              demo={demo}
              available={trustedKeys?.available === true}
              storageReason={trustedKeys?.reason}
              onClose={() => {
                setConnecting(false);
                setRecovered(undefined);
              }}
              onSaved={() => void read()}
              onAddToBoard={sourceId => {
                setConnecting(false);
                setSelectedSource(sourceId);
                setChoosing(true);
              }}
            />
          )}
        </section>
      )}
      {choosing && (
        <section className="connection-editor">
          <h3>{t('add.toBoard')}</h3>
          <p className="dialog-text">{t('add.chooseBoard')}</p>
          {boards.map(board => (
            <button
              className="popover-row"
              key={board.id}
              onClick={() => {
                setChoosing(false);
                setAdding(board);
              }}
            >
              <span>{boardTitle(board)}</span>
            </button>
          ))}
          <button className="link-button" onClick={() => setChoosing(false)}>
            {t('common.cancel')}
          </button>
        </section>
      )}
      {adding && (
        <WidgetAdd
          board={adding}
          initialSourceId={selectedSource}
          local={local}
          trustedKeys={trustedKeys}
          open
          onOpenChange={open => {
            if (!open) {
              setAdding(null);
              void read();
            }
          }}
          trigger={boardTitle(adding)}
        />
      )}
      {remove && (
        <Modal title={t('sources.remove')} onClose={() => setRemove(null)}>
          <p className="dialog-text">{t('sources.removeText')}</p>
          <p className="dialog-text">{t('add.disconnectEffect')}</p>
          <ErrorLine error={error} />
          <div className="button-row">
            <button className="button" onClick={() => setRemove(null)}>
              {t('common.cancel')}
            </button>
            <button className="button danger" onClick={() => void disconnect()}>
              {t('sources.remove')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
