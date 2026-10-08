import {DAY, HOUR, steady, weekly, type DemoSet} from './model.js';
import {MONEY_KEY} from './money.js';

/**
 * No OpenRouter credential, holding, share or card exists before the user's submit.
 * Existing-source Add shows its publication disclosure in the row and retains Added
 * until the menu closes. Exercise repeated adds, search, EN/RU and keyboard focus;
 * Board controls lists only measured sources. Pending and lost-reply transitions are
 * held by ui/test/widgetAdd.test.ts and server/test/additions.test.ts.
 */
export const ONBOARDING: DemoSet = {
  id: 'onboarding', about: 'Board and account onboarding, with unconnected OpenRouter and two people', scene: 'quiet',
  entries: [
    {kind: 'person', id: 'ana', name: 'Ana', expect: [{state: 'widgets'}]},
    {kind: 'person', id: 'boris', name: 'Boris', expect: [{state: 'widgets'}]},
    {kind: 'board', id: 'studio', name: 'Studio', owner: 'ana', members: ['boris'], expect: [{state: 'widgets'}], look: ['Own and other hidden cards, one visible card, Add on a shared board']},
    {kind: 'board', id: 'empty', name: 'New board', owner: 'ana', members: ['boris'], expect: [{state: 'onboarding'}], look: ['Add an empty analytic widget or an unshared source']},
    {kind: 'machine', id: 'boris-laptop', person: 'boris', expect: [{via: 'token'}]},
    {kind: 'card', id: 'personal-codex', provider: 'codex', plan: 'plus', machines: ['laptop'], history: DAY,
      windows: [weekly({since: -2 * DAY, use: steady(0, 8)})], on: {ana: {name: 'Personal Codex'}}, expect: [{title: 'Personal Codex'}]},
    {kind: 'card', id: 'work-codex', provider: 'codex', plan: 'pro', machines: ['laptop'], history: DAY,
      windows: [weekly({since: -3 * DAY, use: steady(0, 9)})], on: {ana: {name: 'Work Codex'}, studio: {name: 'Work Codex', hidden: true}}, expect: [{title: 'Work Codex'}]},
    {kind: 'card', id: 'visible-claude', provider: 'claude', plan: 'Claude Pro', machines: ['laptop'], history: DAY,
      windows: [weekly({since: -DAY - HOUR, use: steady(0, 10)})], on: {ana: {name: 'Team Claude'}, studio: {name: 'Team Claude'}}, expect: [{title: 'Team Claude'}]},
    {kind: 'card', id: 'boris-claude', provider: 'claude', plan: 'Claude Pro', machines: ['boris-laptop'], history: DAY,
      windows: [weekly({since: -2 * DAY, use: steady(0, 10)})], on: {boris: {name: 'Boris Claude'}, studio: {name: 'Boris Claude', hidden: true}}, expect: [{title: 'Boris Claude'}]},
  ],
};

export const DEMO_ADDITION_KEYS = [
  {label: 'noExpiry', secret: MONEY_KEY(7)}, {label: 'partial', secret: MONEY_KEY(1)},
  {label: 'expired', secret: MONEY_KEY(8)}, {label: 'temporary', secret: MONEY_KEY(9)},
  {label: 'invalid', secret: MONEY_KEY(10)},
] as const;
