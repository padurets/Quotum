import type {Directory} from '../server/store/directory.js';
import type {Stand} from './setup.js';

export const SHOWCASE_OPENROUTER_KEY = 'sk-or-v1-' + '185'.padStart(64, '0');

const workspace = '550e8400-e29b-41d4-a716-446655440185';
const caps = [
  {
    name: 'dev-workstation',
    limit: 50,
    limit_remaining: 18.4,
    limit_reset: 'monthly',
    usage: 31.6,
    usage_daily: 1.3,
    usage_weekly: 8.2,
    usage_monthly: 31.6,
  },
  {
    name: 'coding-agent',
    limit: 15,
    limit_remaining: 6.5,
    limit_reset: 'daily',
    usage: 29.8,
    usage_daily: 8.5,
    usage_weekly: 18,
    usage_monthly: 29.8,
  },
  {
    name: 'ci-review',
    limit: 20,
    limit_remaining: 4.2,
    limit_reset: 'weekly',
    usage: 15.8,
    usage_daily: 2.1,
    usage_weekly: 15.8,
    usage_monthly: 15.8,
  },
];

/** Raw replies go through the same exact-decimal decoder as a live connector. */
export function showcaseOpenRouterReply(
  operation: string,
  expiresAt: string,
  query: Readonly<Record<string, string>>,
) {
  switch (operation) {
    case 'key':
      return {
        data: {
          is_management_key: true,
          expires_at: expiresAt,
          organization_id: null,
          creator_user_id: 'showcase-openrouter',
        },
      };
    case 'credits':
      return {data: {total_credits: 120, total_usage: 77.2}};
    case 'workspaces':
      return {data: [{id: workspace}], total_count: 1};
    case 'keys':
      return {
        data:
          query.workspace_id === workspace && query.offset === '0'
            ? caps.map((cap, i) => ({
                ...cap,
                hash: (i + 1).toString(16).padStart(64, '0'),
                workspace_id: workspace,
                disabled: false,
                expires_at: null,
                include_byok_in_limit: false,
              }))
            : [],
      };
    default:
      throw new Error('Unknown showcase connector operation');
  }
}

/** Connecting the fixture lets the ordinary hub measure its balance and key inventory. */
export async function seedShowcaseOpenRouter(directory: Directory, stand: Stand) {
  const owner = stand.people.get('alex')!;
  const {sourceId} = await owner.post<{sourceId: string}>('/api/credentials', {
    provider: 'openrouter',
    secret: SHOWCASE_OPENROUTER_KEY,
  });
  const view = directory.view(owner.personalBoard);
  view.names[sourceId] = 'OpenRouter';
  view.layout.places['source:' + sourceId] = {x: 3, y: 1, w: 3};
  directory.saveView(owner.personalBoard, view, owner.id, stand.start);
}
