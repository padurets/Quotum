import type {Key} from '../i18n';
import {providerOf} from '../../server/domain/providers';

export const widgetKind = (id: string, provider?: string): Key => provider
  ? providerOf(provider)?.funding === 'wallet' ? 'resource.budget' : 'resource.subscription'
  : ({agents: 'widgets.kind.list', activity: 'widgets.kind.chart', 'quota-history': 'widgets.kind.chart', 'budget-history': 'widgets.kind.chart', 'quota-table': 'widgets.kind.table', 'budget-table': 'widgets.kind.table'} as const)[id as import('../../server/domain/widgets').WidgetId] ?? 'widgets.title';
