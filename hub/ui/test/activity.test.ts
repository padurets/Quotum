import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activityEmpty, activityScale, atOnce, groupColors, mutedKey, OTHER_COLOR} from '../lib/activity';
import {CATEGORY_COLORS, PROVIDERS} from '../lib/providers';
import type {ActivityGroup, View} from '../lib/types';

const view: View = {version:5 as const, layout: {columns: 6, places: {}}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};
const HOUR = 3_600_000;
const group = (key: string, change: Partial<ActivityGroup> = {}): ActivityGroup => ({key, name: key, agentMs: HOUR, activeMs: HOUR, agents: 1, cells: [], ...change});

// WCAG contrast from linear sRGB luminance.
const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const token = (name: string) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))![1];

test('projects and machines use the exact Nord Warm order, with unique colours readable on the surface', () => {
  assert.deepEqual(CATEGORY_COLORS, ['#bf616a', '#d08770', '#ebcb8b', '#a3be8c', '#8fbcbb', '#88c0d0', '#81a1c1', '#5e81ac', '#b48ead']);
  const all = [...CATEGORY_COLORS, token('other')];
  assert.equal(new Set(all).size, all.length);
  for (const color of all) assert.ok(contrast(color, token('surface')) >= 3, `${color} on the surface`);
});

test('a subscription has its card colour; projects and machines take theirs by rank, and those past the palette a neutral', () => {
  const sources = Array.from({length: 11}, (_, i) => group(`codex:${i}`));
  assert.ok(
    groupColors(sources, 'source', view, () => 'codex').every(color => color === PROVIDERS.codex.color),
    'every subscription its card colour, however many',
  );
  assert.deepEqual(
    groupColors(sources.slice(0, 2), 'source', {...view, colors: {'codex:1': '#43aca1'}}, () => 'codex'),
    [PROVIDERS.codex.color, '#43aca1'],
  );
  assert.deepEqual(groupColors([group('unknown'), group('notProvided')], 'source', view, () => 'codex'), [OTHER_COLOR, OTHER_COLOR]);
  for (const by of ['project', 'device'] as const) for (const count of [2, 3, 5, 7, 9, 11]) {
    const groups = Array.from({length: count}, (_, i) => group(`g${i}`));
    assert.deepEqual(groupColors(groups, by, view, () => ''), Array.from({length: count}, (_, i) => CATEGORY_COLORS[i] ?? OTHER_COLOR), `${by}: ${count} groups`);
  }
});

test('the scale shows agent-hours beyond a bar, with at most three round marks above zero', () => {
  const MINUTE = 60_000;
  assert.deepEqual(activityScale(50 * MINUTE), {max: HOUR, ticks: [0, 30 * MINUTE, HOUR]});
  assert.deepEqual(activityScale(20 * MINUTE), {max: 20 * MINUTE, ticks: [0, 10 * MINUTE, 20 * MINUTE]});
  assert.deepEqual(activityScale(1.7 * HOUR), {max: 2 * HOUR, ticks: [0, HOUR, 2 * HOUR]});
  assert.deepEqual(activityScale(4.5 * MINUTE), {max: 6 * MINUTE, ticks: [0, 2 * MINUTE, 4 * MINUTE, 6 * MINUTE]});
  assert.deepEqual(activityScale(4 * HOUR), {max: 4 * HOUR, ticks: [0, 2 * HOUR, 4 * HOUR]});
  assert.deepEqual(activityScale(20 * HOUR), {max: 24 * HOUR, ticks: [0, 12 * HOUR, 24 * HOUR]});
  for (const hours of [48, 120, 240, 480, 1440, 10000]) {
    const scale = activityScale(hours * HOUR);
    assert.ok(scale.max >= hours * HOUR && scale.ticks.length <= 4);
    assert.equal(scale.ticks.at(-1), scale.max);
  }
});


test('at once reads the mean during active time, in each language', async () => {
  const {setLocale} = await import('../i18n');
  for (const [locale, fraction] of [
    ['en', '2.5'],
    ['ru', '2,5'],
  ] as const) {
    setLocale(locale);
    assert.equal(atOnce(4 * HOUR, HOUR), '4');
    assert.equal(atOnce(5 * HOUR, 2 * HOUR), fraction);
    assert.equal(atOnce(0, 0), '0');
  }
  setLocale('en');
});

test('the widget says why it has no stacks, and never calls a period idle before work was known', () => {
  const since = Date.parse('2026-09-01T00:00:00Z');
  const activity = (change: object) => ({
    since,
    known: {from: since, to: since + 30 * 24 * HOUR},
    barMs: HOUR,
    activeMs: 0,
    agentMs: 0,
    agents: 0,
    cells: [],
    by: {source: [], project: [], device: []},
    ...change,
  });
  assert.deepEqual(activityEmpty(null, 1), {key: 'loading'});
  assert.deepEqual(activityEmpty({since, activity: activity({})},0),{key:'none'});
  assert.deepEqual(activityEmpty({since, activity: activity({known: null, since: since + HOUR})}, 1), {key: 'knownFrom', at: since + HOUR});
  assert.deepEqual(activityEmpty({since, activity: activity({})}, 1), {key: 'none'});
  assert.deepEqual(activityEmpty({since, activity: activity({known: {from: since + 20 * 24 * HOUR, to: since + 30 * 24 * HOUR}})}, 1), {
    key: 'noneSince',
    at: since + 20 * 24 * HOUR,
  });
  assert.equal(activityEmpty({since, activity: activity({activeMs: HOUR})}, 1), null);
});

test('a group switched off is kept apart for each way of splitting', () => {
  assert.notEqual(mutedKey('project', '"atlas"'), mutedKey('device', '"atlas"'));
  assert.equal(mutedKey('source', 'claude:1'), 'activity:source:claude:1');
});
