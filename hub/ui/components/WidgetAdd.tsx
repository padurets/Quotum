import {useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {Activity, ArrowLeft, ArrowRight, ChartNoAxesCombined, Check, List, Monitor, Plug, Plus, Table2} from 'lucide-react';
import {t} from '../i18n';
import {call} from '../lib/http';
import {boardTitle, type Board, type Session} from '../lib/session';
import {useBoardId, useConnectionsRevision, useLineup, useServerView} from '../lib/board';
import {cardId, isHidden} from '../lib/view';
import {widgetVisible} from '../../server/domain/widgets';
import {PROVIDERS} from '../lib/providers';
import {widgetKind} from '../lib/widgetKind';
import {useAddition, LABELS, type Candidate, type Catalogue, type Item, type WidgetId} from '../lib/addition';
import {Field, ErrorLine} from './Kit';
import {logoOf} from './logos';
import {Popover, PopoverHeading} from './Popover';
import {KeyForm, DeviceAdd} from './ConnectionForms';

const WIDGET_ICONS = {agents: List, activity: Activity, 'quota-history': ChartNoAxesCombined, 'budget-history': ChartNoAxesCombined, 'quota-table': Table2, 'budget-table': Table2};

/** Keep attempted rows in place until this menu closes, including while the board catches up. */
function retainRows<T extends {id: string}>(previous: T[], next: T[], kept: Set<string>, key: (item: T) => string): T[] {
  const fresh = new Map(next.map(item => [item.id, item]));
  const rows = previous.flatMap(item => {
    const current = fresh.get(item.id);
    fresh.delete(item.id);
    return current ? [current] : kept.has(key(item)) ? [item] : [];
  });
  return [...rows, ...fresh.values()];
}

function AdditionRow({
  board,
  id,
  item,
  label,
  kind,
  icon,
  publish,
  hidden,
  visible,
  onStart,
}: {
  board: Board;
  id: string;
  item: Item;
  label: string;
  kind: string;
  icon: ReactNode;
  publish: boolean;
  hidden: boolean;
  visible: boolean;
  onStart: () => void;
}) {
  const addition = useAddition();
  const seenVisible = useRef(false);
  if (visible) seenVisible.current = true;
  const operation = addition.operation;
  const complete = operation?.state === 'complete';
  const changed =
    complete &&
    (operation.current?.boardAccessible === false ||
      operation.current?.sources?.some(source => source.placement !== 'visible') ||
      operation.current?.widgets?.some(widget => widget.placement !== 'visible') ||
      (seenVisible.current && !visible));
  const done = complete && !changed;
  const pending = addition.busy || operation?.state === 'verifying';
  const retry = operation && ['failed', 'expired'].includes(operation.state);
  const add = () => {
    if (done || pending) return;
    onStart();
    if (changed || retry) {
      addition.reset();
      seenVisible.current = false;
    }
    void addition.submit(board.id, item);
  };
  return (
    <div className="catalogue-entry" hidden={hidden} data-addition={id}>
      <div className="popover-row catalogue-row">
        {icon}
        <span className="catalogue-name">
          <b title={label}>{label}</b>
          <small>{kind}</small>
          {publish && <small className="catalogue-disclosure">{t('add.shareInline')}</small>}
        </span>
        <button
          type="button"
          className="button"
          aria-label={t(done ? 'add.addedLabel' : 'add.actionLabel', {widget: label})}
          aria-disabled={done || pending}
          aria-busy={pending}
          onClick={add}
        >
          {pending ? <i className="spinner" aria-hidden="true" /> : done ? <Check size={14} aria-hidden="true" /> : null}
          {t(done ? 'add.added' : 'add.action')}
        </button>
      </div>
      <div className="catalogue-feedback" aria-live="polite">
        {changed && <p className="dialog-text">{t('add.changedInline')}</p>}
        <ErrorLine error={addition.error} />
        {operation && !complete && !addition.busy && (
          <div className="button-row is-start">
            <button type="button" className="link-button" onClick={() => void addition.check()}>
              {t('add.checkResult')}
            </button>
          </div>
        )}
        <span className="sr-only">{done ? t('add.addedLabel', {widget: label}) : pending ? t('add.adding') : ''}</span>
      </div>
    </div>
  );
}

export function WidgetCatalogue({
  board,
  local,
  trustedKeys,
  onClose,
  initialSourceId,
}: {
  initialSourceId?: string;
  board: Board;
  local: boolean;
  trustedKeys: Session['trustedKeys'];
  onClose: () => void;
}) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<'catalogue' | 'connect' | 'connection' | 'device'>('catalogue');
  const [providerSearch, setProviderSearch] = useState('');
  const [provider, setProvider] = useState('openrouter');
  const retained = useRef(new Set<string>());
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const focusedPage = useRef<string | null>(null);
  const revision = useConnectionsRevision();
  const currentBoard = useBoardId(),
    view = useServerView(),
    lineup = useLineup();
  useEffect(() => {
    const abort = new AbortController();
    call<Catalogue>('GET', '/api/boards/' + board.id + '/catalogue', undefined, 12_000, abort.signal).then(
      reply => {
        if (abort.signal.aborted) return;
        setCatalogue(previous =>
          previous
            ? {
                ...reply,
                sources: retainRows(previous.sources, reply.sources, retained.current, source => cardId(source.id)),
                widgets: retainRows(previous.widgets, reply.widgets, retained.current, widget => widget.id),
              }
            : reply,
        );
        setError(null);
      },
      failure => {
        if (!abort.signal.aborted) setError(failure);
      },
    );
    return () => abort.abort();
  }, [board.id, revision, view, lineup]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!catalogue || !element) return;
    const entering = focusedPage.current !== page;
    const first = focusedPage.current === null;
    focusedPage.current = page;
    if (page !== 'catalogue' && page !== 'connect') return;
    // Refreshing the list never steals focus. If its focused search disappears,
    // continue from the first available row instead of the start of the document.
    const removed = focused.current && !focused.current.isConnected && document.activeElement === document.body;
    if (!entering && !removed) return;
    const initial = first && initialSourceId ? element.querySelector<HTMLElement>(`[data-addition="${cardId(initialSourceId)}"] button`) : null;
    const target = initial ?? (entering ? element.querySelector<HTMLElement>('input[type="search"]') : null)
      ?? element.querySelector<HTMLElement>('.catalogue-entry:not([hidden]) button, .catalogue-connect');
    target?.focus({preventScroll: true});
  }, [catalogue, page, initialSourceId]);
  const searchable = !!catalogue && catalogue.sources.length + catalogue.widgets.length > 10;
  const providersSearchable = !!catalogue && catalogue.connectors.length > 10;
  const matches = (label: string, query = searchable ? search : '') => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const sourceMatches = (source: Candidate) => matches(source.label + ' ' + source.provider + ' ' + t(widgetKind('', source.provider)));
  const widgetMatches = (widget: {id: WidgetId}) => matches(t(LABELS[widget.id]) + ' ' + t(widgetKind(widget.id)));
  const connectors =
    catalogue?.connectors.filter(connector =>
      matches(connector.id === 'zai' ? t('sources.zaiPersonal') : connector.name, providersSearchable ? providerSearch : ''),
    ) ?? [];
  const any = catalogue?.sources.some(sourceMatches) || catalogue?.widgets.some(widgetMatches);
  const visible = (id: string) =>
    currentBoard === board.id &&
    !!view &&
    (id.startsWith('source:') ? !isHidden(view, id) && lineup.includes(id.slice(7)) : widgetVisible(view, id, lineup.length));
  const title =
    page === 'connection'
      ? t('sources.connectProvider', {provider: provider === 'zai' ? t('sources.zaiPersonal') : (PROVIDERS[provider]?.name ?? provider)})
      : page === 'device'
        ? t('connections.connectDevice')
        : page === 'connect'
          ? t('add.connect')
          : t('add.onBoard', {board: boardTitle(board)});
  return (
    <div className="widget-catalogue" ref={root} onFocusCapture={event => {focused.current = event.target as HTMLElement;}}>
      <PopoverHeading onClose={onClose}>{title}</PopoverHeading>
      {page !== 'catalogue' && (
        <div className="popover-body">
          <button className="link-button connection-back" onClick={() => setPage('catalogue')}>
            <ArrowLeft size={14} aria-hidden="true" />
            {t('add.title')}
          </button>
        </div>
      )}
      {page === 'connection' ? (
        <div className="popover-body">
          <KeyForm
            key={provider}
            provider={provider}
            board={board}
            personal={false}
            demo={catalogue?.demo}
            available={trustedKeys?.available === true}
            storageReason={trustedKeys?.reason}
            onClose={onClose}
          />
        </div>
      ) : page === 'device' ? (
        <div className="popover-body">
          <DeviceAdd board={board} demo={!!catalogue?.demo} onClose={onClose} />
        </div>
      ) : page === 'connect' ? (
        <>
          {providersSearchable && <div className="popover-body">
            <Field
              label={t('add.searchProviders')}
              type="search"
              value={providerSearch}
              onChange={event => setProviderSearch(event.target.value)}
            />
          </div>}
          <div className="catalogue-list popover-scroll">
            {connectors.map(connector => (
              <button
                type="button"
                className="popover-row catalogue-connect"
                key={connector.id}
                onClick={() => {
                  setProvider(connector.id);
                  setPage('connection');
                }}
              >
                <img src={logoOf(connector.id)} alt="" />
                <span>{connector.id === 'zai' ? t('sources.zaiPersonal') : connector.name}</span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            ))}
            {!connectors.length && <p className="popover-note dialog-text">{t('add.noProviders')}</p>}
          </div>
          {!local && (
            <div className="popover-section">
              <button type="button" className="popover-row catalogue-connect" onClick={() => setPage('device')}>
                <Monitor size={20} aria-hidden="true" />
                <span>{t('connections.connectDevice')}</span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {(searchable || !!error) && <div className="popover-body">
            {searchable && <Field label={t('add.search')} type="search" value={search} onChange={event => setSearch(event.target.value)} />}
            <ErrorLine error={error} />
          </div>}
          {!catalogue && !error && (
            <p className="popover-note" role="status">
              {t('add.loading')}
            </p>
          )}
          {catalogue && (
            <>
              <div className="catalogue-list popover-scroll">
                {catalogue.sources.map(source => (
                  <AdditionRow
                    key={source.id}
                    id={cardId(source.id)}
                    board={board}
                    item={{kind: 'sources', sourceIds: [source.id]}}
                    label={source.label}
                    kind={t(widgetKind('', source.provider))}
                    icon={<img src={logoOf(source.provider)} alt="" />}
                    publish={!board.personal && !source.onBoard}
                    hidden={!sourceMatches(source)}
                    visible={visible(cardId(source.id))}
                    onStart={() => retained.current.add(cardId(source.id))}
                  />
                ))}
                {catalogue.widgets.map(widget => {
                  const Icon = WIDGET_ICONS[widget.id];
                  return (
                    <AdditionRow
                      key={widget.id}
                      id={widget.id}
                      board={board}
                      item={{kind: 'widget', widgetId: widget.id}}
                      label={t(LABELS[widget.id])}
                      kind={t(widgetKind(widget.id))}
                      icon={<Icon size={22} aria-hidden="true" />}
                      publish={false}
                      hidden={!widgetMatches(widget)}
                      visible={visible(widget.id)}
                      onStart={() => retained.current.add(widget.id)}
                    />
                  );
                })}
                {!any && <p className="popover-note dialog-text">{t(searchable && search.trim() ? 'add.noWidgets' : 'add.allVisible')}</p>}
              </div>
              <div className="popover-section">
                <button type="button" className="popover-row catalogue-connect" onClick={() => setPage('connect')}>
                  <Plug size={20} aria-hidden="true" />
                  <span>{t('add.connect')}</span>
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function WidgetAdd({
  board,
  local,
  trustedKeys,
  open,
  onOpenChange,
  initialSourceId,
  trigger,
}: {
  board: Board;
  local: boolean;
  trustedKeys: Session['trustedKeys'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSourceId?: string;
  trigger?: string;
}) {
  return (
    <Popover
      label={t('add.title')}
      icon={<Plus size={16} aria-hidden="true" />}
      trigger={trigger}
      triggerClass={trigger ? 'button' : undefined}
      open={open}
      onOpenChange={onOpenChange}
      width={420}
    >
      {open && (
        <WidgetCatalogue
          key={board.id}
          board={board}
          local={local}
          trustedKeys={trustedKeys}
          initialSourceId={initialSourceId}
          onClose={() => onOpenChange(false)}
        />
      )}
    </Popover>
  );
}
