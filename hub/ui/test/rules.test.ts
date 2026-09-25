import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentRows, DRAWN, drawn} from '../lib/agents';
import {outlook} from '../lib/forecast';
import {planNote, PLAN_NOTE_FROM} from '../lib/plan';
import {dotOf, PULSE_FOR, resetLine} from '../lib/quota';
import {resetLabel, type ResetStatus} from '../lib/resets';
import type {LiveSession, SourceState, View, Win} from '../lib/types';
import {boardState, cardId, isWindowHidden} from '../lib/view';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-09-24T12:00:00Z');
const EMPTY: View = {order: [], sizes: {}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}};

test('a reset announced or possible outranks one that happened, which outranks a change of limits', () => {
  const event = (at: number) => ({url: 'https://codex-resets.com/', text: '', at});
  const status = (change: Partial<ResetStatus>): ResetStatus => ({scheduled: null, watch: null, latest: null, policy: null, credit: {name: 'Codex Resets', url: ''}, ...change});
  const scheduled = {...event(now - HOUR), scheduledFor: now + DAY, kind: 'regular' as const};
  const watch = {...event(now - HOUR), expiresAt: now + DAY, chance: 40, window: ''};
  const latest = {...event(now - HOUR), scope: 'Max'};
  const policy = event(now - HOUR);
  assert.equal(resetLabel(status({scheduled, watch, latest, policy}), now)?.key, 'in');
  assert.equal(resetLabel(status({watch, latest, policy}), now)?.key, 'possible');
  assert.equal(resetLabel(status({latest, policy}), now)?.key, 'done');
  assert.equal(resetLabel(status({policy}), now)?.key, 'policy');
  assert.equal(resetLabel(status({latest: {...latest, at: now - DAY}, policy}), now)?.key, 'policy', 'a reset is news for a day');
  assert.equal(resetLabel(status({policy: event(now - 3 * DAY)}), now), null, 'a change of limits, for three');
  assert.equal(resetLabel(status({scheduled: {...scheduled, scheduledFor: now - 1}}), now)?.key, 'awaiting');
  assert.equal(resetLabel(status({scheduled: {...scheduled, scheduledFor: null}}), now)?.key, 'announced');
  assert.equal(resetLabel(status({scheduled: {...scheduled, kind: 'banked'}}), now)?.key, 'bankedIn');
  assert.deepEqual(resetLabel(status({latest: {...latest, scope: 'all'}}), now), {kind: 'notice', key: 'done', event: {...latest, scope: 'all'}, scope: ''});
});

test('a note under a limit takes a gap of ten points to the plan; behind it only for a week', () => {
  const week = (remaining: number, elapsed: number): Win => ({id: 'weekly', kind: 'weekly', label: null, used: 100 - remaining, remaining, resetAt: now - elapsed + 7 * DAY, minutes: 10080});
  // A day and a half into the week the default plan leaves 57.5%.
  assert.equal(planNote(week(57.5 + PLAN_NOTE_FROM, 1.5 * DAY), now, now)?.key, 'behind');
  assert.equal(planNote(week(57.5 + PLAN_NOTE_FROM - 1, 1.5 * DAY), now, now), null);
  assert.equal(planNote(week(57.5 - PLAN_NOTE_FROM, 1.5 * DAY), now, now)?.key, 'ahead');
  assert.equal(planNote(week(0, 1.5 * DAY), now, now), null, 'used up is past any plan');
  const hours: Win = {id: 'session', kind: 'session', label: null, used: 10, remaining: 90, resetAt: now + 2.5 * HOUR, minutes: 300};
  assert.equal(planNote(hours, now, now), null, 'five hours behind an even pace say nothing');
  assert.deepEqual(planNote({...hours, used: 70, remaining: 30}, now, now), {key: 'ahead', value: 20, weekly: false});
});

test('the table says where the pace leads, in its tone', () => {
  const live: Win = {id: 'weekly', kind: 'weekly', label: null, used: 50, remaining: 50, resetAt: now + 5 * DAY, minutes: 10080};
  assert.deepEqual(outlook({consumed: 0, coveredMs: HOUR}, {...live, remaining: 0, used: 100}, now, now, null), {key: 'usedUp', tone: 'v-crit'});
  assert.deepEqual(outlook({consumed: 0, coveredMs: HOUR}, {...live, resetAt: null}, now, now, null), {key: 'none', tone: ''});
  assert.deepEqual(outlook({consumed: 1, coveredMs: 29 * 60_000}, live, now, now, null), {key: 'needData', tone: ''});
  assert.equal(outlook({consumed: 0, coveredMs: DAY}, live, now, now, [15, 15, 15, 15, 15, 15, 10]).tone, 'muted', '~N% left when the plan ends');
  assert.equal(outlook({consumed: 0, coveredMs: DAY}, live, now, now, null).tone, '', '~N% left at the reset');
});

test('agents are drawn up to ten; the table leaves out hidden cards and says why it is empty', () => {
  const session = (): LiveSession => ({device: {id: 'd', name: 'laptop'}, origin: 'terminal', project: null, startedAt: now, working: true});
  assert.equal(drawn(Array.from({length: DRAWN}, session)), true);
  assert.equal(drawn(Array.from({length: DRAWN + 1}, session)), false);
  const source = (id: string, sessions: LiveSession[]) => ({id, sessions}) as unknown as SourceState;
  const hidden = {...EMPTY, hidden: [cardId('b')]};
  assert.equal(agentRows([source('a', []), source('b', [session()])], hidden).empty, 'noneShown');
  assert.equal(agentRows([source('a', []), source('b', [])], hidden).empty, 'none');
  assert.equal(agentRows([source('a', [session()]), source('b', [session()])], hidden).rows.length, 1);
});

test('a board without subscriptions invites to connect one; with every widget hidden, offers them back', () => {
  assert.equal(boardState([], EMPTY), 'onboarding');
  assert.equal(boardState([{id: 'a'}], EMPTY), 'widgets');
  assert.equal(boardState([{id: 'a'}], {...EMPTY, hidden: [cardId('a'), 'history', 'forecast']}), 'allHidden');
  assert.equal(boardState([{id: 'a'}], {...EMPTY, hidden: [cardId('a'), 'history', 'forecast'], shown: ['agents']}), 'widgets');
  assert.equal(isWindowHidden({...EMPTY, windows: ['a/weekly']}, 'a', 'weekly'), true);
  assert.equal(resetLine({resetAt: null}, now).key, 'resetUnknown');
  assert.deepEqual(dotOf(PULSE_FOR - 1), {pulsing: true, fresh: 1});
  assert.equal(dotOf(PULSE_FOR).pulsing, false);
});
