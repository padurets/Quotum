import type {Key} from '../i18n';
import {providerOf} from '../../server/domain/providers';

export const widgetKind = (id: string, provider?: string): Key => provider
  ? providerOf(provider)?.funding === 'wallet' ? 'resource.budget' : 'resource.subscription'
  : ({'agent-hours-heatmap':'widgets.kind.chart',agents: 'widgets.kind.table', activity: 'widgets.kind.chart', 'quota-history': 'widgets.kind.chart', 'quota-session-history': 'widgets.kind.chart', 'subscription-funds': 'widgets.kind.chart', 'budget-history': 'widgets.kind.chart', 'quota-table': 'widgets.kind.table', 'quota-session-table': 'widgets.kind.table', 'budget-table': 'widgets.kind.table'} as const)[id as import('../../server/domain/widgets').WidgetId] ?? 'widgets.title';
