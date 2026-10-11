import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activityEmpty, activityScale, atOnce, shownActivity, groupColors, mutedKey, OTHER_COLOR} from '../lib/activity';
import {CATEGORY_COLORS, PROVIDERS} from '../lib/providers';
import type {ActivityGroup, View} from '../lib/types';

const view: View = {version: 3 as const, layout: {columns: 6, places: {}}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};
const HOUR = 3_600_000;
const group = (key: string, change: Partial<ActivityGroup> = {}): ActivityGroup => ({key, name: key, agentMs: HOUR, activeMs: HOUR, agents: 1, cells: [], ...change});

// Colour science for the checks below: sRGB to CIELAB (D65), CIEDE2000, WCAG contrast.
const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
function lab(hex: string) {
  const [r, g, b] = channels(hex);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [X, Y, Z] = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883].map(f);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
function deltaE(a: string, b: string) {
  const [L1, a1, b1] = lab(a);
  const [L2, a2, b2] = lab(b);
  const rad = Math.PI / 180;
  const mean = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(mean ** 7 / (mean ** 7 + 25 ** 7)));
  const [p1, p2] = [(1 + G) * a1, (1 + G) * a2];
  const [C1, C2] = [Math.hypot(p1, b1), Math.hypot(p2, b2)];
  const hue = (x: number, y: number) => (Math.atan2(y, x) / rad + 360) % 360;
  const [h1, h2] = [hue(p1, b1), hue(p2, b2)];
  let dh = C1 * C2 === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const [L, C] = [(L1 + L2) / 2, (C1 + C2) / 2];
  let H = h1 + h2;
  if (C1 * C2 !== 0) H = (Math.abs(h1 - h2) > 180 ? H + (H < 360 ? 360 : -360) : H) / 2;
  const T = 1 - 0.17 * Math.cos((H - 30) * rad) + 0.24 * Math.cos(2 * H * rad) + 0.32 * Math.cos((3 * H + 6) * rad) - 0.2 * Math.cos((4 * H - 63) * rad);
  const RT = -Math.sin(60 * Math.exp(-(((H - 275) / 25) ** 2)) * rad) * 2 * Math.sqrt(C ** 7 / (C ** 7 + 25 ** 7));
  const [SL, SC, SH] = [1 + (0.015 * (L - 50) ** 2) / Math.sqrt(20 + (L - 50) ** 2), 1 + 0.045 * C, 1 + 0.015 * C * T];
  const [dL, dC, dh2] = [(L2 - L1) / SL, (C2 - C1) / SC, dH / SH];
  return Math.sqrt(dL ** 2 + dC ** 2 + dh2 ** 2 + RT * dC * dh2);
}

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const token = (name: string) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))![1];

test('the colour distance tells the same colour from black and white', () => {
  assert.equal(deltaE('#ffffff', '#ffffff'), 0);
  assert.ok(Math.abs(deltaE('#000000', '#ffffff') - 100) < 0.01);
});

test('projects and machines take colours no status and no provider has, told apart from each other and from the rest, readable on the surface', () => {
  const surface = token('surface');
  const statuses = ['ok', 'warn', 'crit'].map(token);
  const providers = Object.values(PROVIDERS).map(provider => provider.color);
  const all = [...CATEGORY_COLORS, token('other')];
  assert.equal(CATEGORY_COLORS.length, 7);
  for (const color of all) {
    assert.ok(contrast(color, surface) >= 3, `${color} on the surface`);
    for (const status of statuses) assert.ok(deltaE(color, status) >= 20, `${color} from ${status}: ${deltaE(color, status).toFixed(1)}`);
  }
  for (const color of CATEGORY_COLORS) for (const provider of providers) assert.ok(deltaE(color, provider) >= 14, `${color} from ${provider}`);
  for (const [i, a] of all.entries()) for (const b of all.slice(i + 1)) assert.ok(deltaE(a, b) >= 17, `${a} from ${b}: ${deltaE(a, b).toFixed(1)}`);
});

test('a subscription has its card colour; projects and machines take theirs by rank, and those past the palette a neutral', () => {
  const sources = Array.from({length: 9}, (_, i) => group(`codex:${i}`));
  assert.ok(
    groupColors(sources, 'source', view, () => 'codex').every(color => color === PROVIDERS.codex.color),
    'every subscription its card colour, however many',
  );
  assert.deepEqual(
    groupColors(sources.slice(0, 2), 'source', {...view, colors: {'codex:1': '#43aca1'}}, () => 'codex'),
    [PROVIDERS.codex.color, '#43aca1'],
  );
  const projects = Array.from({length: CATEGORY_COLORS.length + 2}, (_, i) => group(`"p${i}"`));
  assert.deepEqual(groupColors(projects, 'project', view, () => ''), [...CATEGORY_COLORS, OTHER_COLOR, OTHER_COLOR]);
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

test('switching groups off recomputes only shown agent time, including each bar', () => {
  const p = group('P', {agentMs: 3 * HOUR, cells: [[0, 3 * HOUR]]});
  const q = group('Q', {agentMs: HOUR, cells: [[0, HOUR]]});
  assert.deepEqual(shownActivity([p, q]), {agentMs: 4 * HOUR, cells: new Map([[0, 4 * HOUR]])});
  assert.deepEqual(shownActivity([p]), {agentMs: 3 * HOUR, cells: new Map([[0, 3 * HOUR]])});
  assert.deepEqual(shownActivity([]), {agentMs: 0, cells: new Map()});
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
  assert.deepEqual(activityEmpty({since, activity: activity({})}, 0), {key: 'noSources'});
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
