import {VIEW_VERSION_HEADER} from '../../server/domain/view';
import type {WidgetId} from '../../server/domain/widgets';
export type {WidgetId} from '../../server/domain/widgets';
import {createContext, useContext, useEffect, useRef, useState} from 'react';
import type {Key} from '../i18n';
import type {Board} from './session';
import {ApiError, call} from './http';
import {flushView} from './view';

export type Candidate = {
  id: string;
  provider: string;
  label: string;
  origin: 'own' | 'shared';
  onBoard: boolean;
  visible: boolean;
  action: 'add' | 'show';
};
export const LABELS: Record<WidgetId, Key> = {
  agents: 'agents.title',
  activity: 'activity.title',
  'quota-history': 'history.title',
  'budget-history': 'widgets.budgetHistory',
  'quota-table': 'forecast.title',
  'budget-table': 'money.spending',
};
export type Demo = {
  keys: {
    label: 'noExpiry' | 'partial' | 'expired' | 'temporary' | 'invalid' | 'deepseekBalance' | 'zaiQuotas';
    secret: string;
    provider?: string;
  }[];
};
export type Catalogue = {
  operations?: Operation[];
  board: Board;
  sources: Candidate[];
  widgets: {id: WidgetId; action: Candidate['action']}[];
  connectors: {id: string; name: string}[];
  demo?: Demo;
};
export type Item =
  | {kind: 'sources'; sourceIds: string[]}
  | {kind: 'widget'; widgetId: WidgetId | 'history' | 'forecast'}
  | {kind: 'connection'; provider: string; account?: {kind: 'new'} | {kind: 'existing'; id: string}}
  | {kind: 'replace'; credentialId: string; provider?: string};
export type Operation = {
  id: string;
  boardId: string | null;
  item: Item;
  widgetIds?: WidgetId[];
  createdAt: number;
  state: 'ready' | 'verifying' | 'needs_input' | 'complete' | 'failed' | 'expired';
  current?: {
    boardAccessible: boolean | null;
    sources?: {id: string; placement: string}[];
    widgets?: {id: string; placement: string}[];
    credential?: {exists: boolean; revisionMatches: boolean};
  };
  error?: string;
  warning?: string;
  result?: {
    sourceIds: string[];
    credentialId?: string;
    connection?: 'created' | 'reused';
    expiresAt?: number | null;
    expiryKind?: 'none' | 'unknown' | 'dated';
    replacementRequired?: boolean;
  };
};

/** Form lifetime affects its UI; only the authenticated shell may end its submitted action. */
export const AdditionScope = createContext<() => boolean>(() => false);

/** A submit owns an immutable destination, even if its panel closes while it runs. */
export function useAddition() {
  const currentScope = useContext(AdditionScope);
  const [operation, setOperation] = useState<Operation | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    flight = useRef(false),
    current = useRef<Operation | null>(null);
  const request = useRef(crypto.randomUUID());
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const accept = (next: Operation) => {
    current.current = next;
    setOperation(next);
  };
  const submit = async (
    boardId: string | null,
    item: Item,
    secret?: string,
    options: {allowUnknownExpiry?: boolean; sameAccount?: boolean; accountName?: string} = {},
  ) => {
    if (flight.current) return;
    const binding = (item: Item) =>
      item.kind === 'replace'
        ? {kind: item.kind, credentialId: item.credentialId}
        : item.kind === 'sources'
          ? {...item, sourceIds: [...new Set(item.sourceIds)].sort()}
          : item.kind === 'connection' && item.account?.kind === 'new'
            ? {...item, account: {kind: 'new'}}
            : item;
    if (
      current.current &&
      (current.current.boardId !== boardId || JSON.stringify(binding(current.current.item)) !== JSON.stringify(binding(item)))
    ) {
      current.current = null;
      request.current = crypto.randomUUID();
    }
    flight.current = true;
    setBusy(true);
    setError(null);
    const own = generation.current;
    try {
      if (boardId) await flushView(boardId);
      if (!currentScope()) return;
      let reserved = current.current;
      if (!reserved) reserved = await call<Operation>('POST', '/api/additions', {requestId: request.current, boardId, item}, 12_000, undefined, {[VIEW_VERSION_HEADER]: '2'});
      if (!currentScope()) return;
      if (own === generation.current) accept(reserved);
      const next = await call<Operation>(
        'POST',
        '/api/additions/' + reserved.id + '/run',
        secret === undefined ? {} : {secret, ...options},
        30_000, undefined, {[VIEW_VERSION_HEADER]: '2'},
      );
      if (!currentScope() || own !== generation.current) return;
      accept(next);
      if (next.error) setError(new ApiError(400, next.error));
    } catch (failure) {
      if (own === generation.current) setError(failure);
    } finally {
      flight.current = false;
      if (own === generation.current) setBusy(false);
    }
  };
  const check = async () => {
    if (!current.current || flight.current) return;
    flight.current = true;
    const own = generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await call<Operation>('GET', '/api/additions/' + current.current.id);
      if (currentScope() && own === generation.current) {
        accept(next);
        if (next.error) setError(new ApiError(400, next.error));
      }
    } catch (failure) {
      if (own === generation.current) setError(failure);
    } finally {
      flight.current = false;
      if (own === generation.current) setBusy(false);
    }
  };
  return {
    operation,
    error,
    busy,
    submit,
    check,
    reset: () => {
      if (!flight.current) {
        current.current = null;
        request.current = crypto.randomUUID();
        setOperation(null);
        setError(null);
      }
    },
    restore: (next: Operation) => {
      accept(next);
      if (next.error) setError(new ApiError(400, next.error));
    },
  };
}
