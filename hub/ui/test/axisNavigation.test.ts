import {test} from 'node:test';
import assert from 'node:assert/strict';
import {axisNavigation, navigationAt, navigationKey} from '../lib/axisNavigation';
import {axisPresentationFixture} from './axisPresentationFixture';
import {historyProjection} from '../lib/historyProjection';
import {frameOf} from '../lib/periods';

const H = 3_600_000;
const prefs = {range: '24h', kind: 'weekly' as const, horizon: 'auto' as const, showPlan: true, showForecast: true, activityBy: 'project' as const};
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const A = {from: 10 * H, to: 12 * H, end: 12 * H}, B = {from: 9 * H, to: 11 * H, end: 11 * H};

test('ordinary navigation immediately projects the retained drawing on both chart widths before preparation resumes', () => {
  const a = axisNavigation('board', A, prefs), b = axisNavigation('board', B, prefs);
  for (const [width, scale, left, right] of [[600, .5, 40, 20], [920, .73, 48, 12]]) {
    const h = axisPresentationFixture(A, a, width, scale, left, right);
    h.context.commit(A, true); h.navigate(B, b); h.context.commit(A, false);
    const shown = h.context.visualGeometry(); near(shown.from, B.from); near(shown.to, B.to);
    const point = h.point(10 * H);
    h.context.commit(B, true);
    near(h.point(10 * H), point);
    assert.equal(h.context.finished.current, null); assert.equal(h.context.pose.current.offset, 0);
    assert.equal(h.animations.length, 0, 'ready data cannot replay the already applied navigation');
  }
});

test('Back supersedes a held final owner including its unpainted RAF and never revives it on ready commits', async () => {
  const a = axisNavigation('board', A, prefs), b = axisNavigation('board', B, prefs);
  const h = axisPresentationFixture(A, a);
  h.context.pose.current.offset = 100; h.layers.forEach(layer => {layer.style.transform = 'translateX(100px)';});
  h.context.finished.current = {visual: A, navigation: a, stop: {range: A, canceled: false}};
  h.context.finalFrame.current = 7; h.classes.add('is-panning');
  h.navigate(B, b); h.context.commit(A, false);
  assert.equal(h.context.finished.current, null); assert.deepEqual(h.canceledFrames, [7]);
  assert.equal(h.context.pose.current.offset, 0); assert.ok(!h.classes.has('is-panning'));
  near(h.context.visualGeometry().from, B.from);
  h.context.commit(B, true); h.context.commit(B, true);
  near(h.context.visualGeometry().from, B.from); assert.equal(h.context.finalFrame.current, null);
  assert.equal(h.context.svg.current.dataset.drawReady, 'true');
});

test('preset or horizon changes supersede a fold even when the URL range stays the same', async () => {
  for (const updated of [{...prefs, range: '30d'}, {...prefs, horizon: '7d' as const}]) {
    const a = axisNavigation('board', A, prefs), b = axisNavigation('board', A, updated);
    const h = axisPresentationFixture(A, a);
    h.context.finished.current = {visual: {...A, to: A.to + H}, navigation: a, stop: {range: A, canceled: false}};
    h.context.commit(A, true); assert.ok(h.context.motion.current);
    h.navigate(A, b); assert.equal(h.context.motion.current, null);
    for (const animation of h.animations) animation.finish();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.context.motion.current, null); assert.ok(!h.classes.has('is-panning'));
    near(h.context.visualGeometry().from, A.from); near(h.context.visualGeometry().to, A.to);
  }
});

test('a new gesture before READY can freeze the borrowed frame without reading the desired URL as its old drawing', () => {
  const h = axisPresentationFixture(A, axisNavigation('board', A, prefs));
  h.navigate(B, axisNavigation('board', B, prefs)); h.context.commit(A, false);
  const captured = h.context.visualGeometry(), before = h.point(10 * H);
  h.active.current = 2;
  h.context.commit(A, false);
  near(h.point(10 * H), before); near(captured.from, B.from);
  assert.equal(navigationKey(h.context.wanted.current.navigation), navigationKey(axisNavigation('board', B, prefs)));
});

test('ready future hints place the current preset/horizon independently of the saved data frame', () => {
  const now = 100 * H, hints = {plan: true, forecast: true, announced: null, zeros: [now + 10 * H]};
  const frame = frameOf(null, prefs, now, 0);
  near(historyProjection(frame, now, prefs, hints), now + Math.max(frame.future, 10 * H));
  const next = {...prefs, range: '30d', horizon: '7d' as const};
  const wanted = frameOf(null, next, now, 0);
  near(historyProjection(wanted, now, next, hints), now + wanted.future);
  near(historyProjection(frameOf(B, prefs, now, 0), B.to, prefs, hints), B.to);
  assert.notEqual(navigationKey(axisNavigation('board', null, prefs)), navigationKey(axisNavigation('board', null, next)));
  assert.equal(navigationKey(navigationAt(axisNavigation('board', A, prefs), B)), navigationKey(axisNavigation('board', B, prefs)));
});
