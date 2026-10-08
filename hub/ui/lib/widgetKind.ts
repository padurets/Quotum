import type {Key} from '../i18n';
import {providerOf} from '../../server/domain/providers';

export const widgetKind = (id: string, provider?: string): Key => provider
  ? providerOf(provider)?.funding === 'wallet' ? 'resource.budget' : 'resource.subscription'
  : ({agents: 'widgets.kind.list', activity: 'widgets.kind.chart', history: 'widgets.kind.chart', forecast: 'widgets.kind.table'} as const)[id as 'agents' | 'activity' | 'history' | 'forecast'] ?? 'widgets.title';
