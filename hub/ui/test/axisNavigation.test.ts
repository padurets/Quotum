import {test} from 'node:test';
import assert from 'node:assert/strict';
import {axisNavigation, navigationAt, navigationKey} from '../lib/axisNavigation';
import {axisPresentationFixture} from './axisPresentationFixture';
import {historyProjection} from '../lib/historyProjection';
import {frameOf} from '../lib/periods';
import {activityAxisFixture} from './activityAxisFixture';

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

test('preset or horizon changes retire a positioned projection even when the URL range stays the same', async () => {
  for (const updated of [{...prefs, range: '30d'}, {...prefs, horizon: '7d' as const}]) {
    const a = axisNavigation('board', A, prefs), b = axisNavigation('board', A, updated);
    const h = axisPresentationFixture(A, a);
    h.context.finished.current = {visual: {...A, to: A.to + H}, navigation: a, stop: {range: A, canceled: false}};
    h.context.commit(A, true); assert.ok(h.context.wanted.current.positioned);
    h.navigate(A, b); assert.equal(h.context.motion.current, null);
    for (const animation of h.animations) animation.finish();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.context.motion.current, null); assert.ok(!h.classes.has('is-panning'));
    near(h.context.visualGeometry().from, A.from); near(h.context.visualGeometry().to, A.to);
  }
});

test('ready commits and late projection hints cannot zoom a positioned historical view', () => {
  const nav=axisNavigation('board',B,prefs),visual={...B,to:B.to+1.72*H};
  for(const [width,scale,left] of [[600,.5,40],[920,.73,48]]){
    const h=axisPresentationFixture(A,nav,width,scale,left);
    h.context.finished.current={visual,navigation:nav,stop:{range:B,canceled:false}};
    h.context.commit(B,true);
    const points=[10*H,11*H].map(h.point);
    for(const ready of [false,true,true]){
      h.navigate({...B,to:B.to+H/3},nav);
      h.context.commit({...B,to:B.to+H/3},ready);
      [10*H,11*H].forEach((at,i)=>near(h.point(at),points[i]));
    }
    const next={...B,from:B.from-H,to:B.to-H},nextNav=axisNavigation('board',next,prefs);
    h.navigate(next,nextNav);h.context.commit(next,true);
    assert.equal(h.context.wanted.current.positioned,false);
    near(h.context.visualGeometry().from,next.from);near(h.context.visualGeometry().to,next.to);
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

test('a coherent answer adopts its requested past endpoints when a retained duration or retention clamp differs',()=>{
  for(const held of [{from:0,to:72*H,end:72*H},{from:47*H,to:71*H,end:71*H}]){
    const range={from:48*H,to:72*H},target={...range,end:range.to},nav=axisNavigation('board',range,prefs);
    const f=axisPresentationFixture(held,nav);
    f.context.finished.current={visual:held,navigation:nav,stop:{range,canceled:false}};
    f.context.from=target.from;f.context.to=target.to;f.context.end=target.end;
    const pending=f.context.presentation(false);near(pending.from,held.from);near(pending.to,held.to);
    const ready=f.context.presentation(true);near(ready.from,target.from);near(ready.to,target.to);
    f.context.publish();f.context.commit(target,true);
    assert.equal(f.context.wanted.current.positioned,false);
    near(f.context.visualGeometry().from,target.from);near(f.context.visualGeometry().end,target.end);
  }
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

test('stationary overlay coordinates use the actual affine pose and stay finite on an empty axis', () => {
  for (const base of [A, {from: 10 * H, to: 10 * H, end: 10 * H}]) {
    const h = axisPresentationFixture(base, axisNavigation('board', null, prefs));
    h.context.pose.current = {a: 1.3, b: -70, offset: 30};
    for (const at of [base.from, base.from + 60_000]) {
      const x = h.context.screenX(at); assert.ok(Number.isFinite(x));
      near(x * h.context.scale, h.point(at));
    }
  }
});

test('rendered presentation anticipates explicit navigation without mutating a superseded final owner',()=>{
  const a=axisNavigation('board',A,prefs),b=axisNavigation('board',B,prefs),f=axisPresentationFixture(A,a);
  f.context.finished.current={visual:A,navigation:a,stop:{range:A,canceled:false}};
  f.context.finalFrame.current=7;f.context.pose.current.offset=50;
  const before=f.context.visualGeometry(),held=f.context.finished.current;
  f.context.from=B.from;f.context.to=B.to;f.context.end=B.end;f.context.requestedNavigation=b;
  const view=f.context.presentation(false);
  near(view.from,B.from);near(view.to,B.to);
  assert.equal(f.context.finished.current,held);assert.equal(f.context.finalFrame.current,7);
  assert.deepEqual(f.context.visualGeometry(),before,'the render calculation never changes the physical owner');
  f.context.publish();f.context.commit(A,false);
  near(f.context.visualGeometry().from,view.from);near(f.context.visualGeometry().to,view.to);
});

test('presentation respects actual capture and cancellation RAF before the ready live target',()=>{
  const base={from:0,to:72*H,end:72*H},target={from:71*H,to:72*H,end:72*H},nav=axisNavigation('board',null,prefs);
  const same=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-6,'sub-microsecond affine inversion tolerance');
  for(const [width,scale,left,right]of [[600,.5,40,20],[920,.73,48,12]]){
    const f=axisPresentationFixture(base,nav,width,scale,left,right);
    Object.assign(f.context,{from:target.from,to:target.to,end:target.end});
    f.active.current=4;f.context.captured.current={token:4,navigation:nav};f.context.pose.current.offset=25;
    const shown=f.context.visualGeometry();
    for(const ready of [false,true]){
      const view=f.context.presentation(ready);same(view.from,shown.from);same(view.to,shown.to);
    }
    f.active.current=null;f.context.captured.current=null;
    f.context.finished.current={visual:base,navigation:nav,stop:{range:null,canceled:true}};
    f.context.finalFrame.current=9;
    const waiting=f.context.presentation(true);same(waiting.from,shown.from);same(waiting.to,shown.to);
    f.context.commit(base,true);
    assert.equal(f.context.finalFrame.current,9,'coherent readiness cannot consume an unpainted cancellation');
    f.context.pose.current.offset=0;f.context.finalFrame.current=null;
    const pending=f.context.presentation(false);same(pending.from,base.from);same(pending.to,base.to);
    const ready=f.context.presentation(true);same(ready.from,target.from);same(ready.to,target.to);
    assert.equal(f.context.finished.current?.stop.canceled,true,'presentation selection itself does not retire the hold');
  }
});

test('presentation keeps a shifted historical viewport and follows an ordinary clock target',()=>{
  const nav=axisNavigation('board',B,prefs),f=axisPresentationFixture(A,nav);
  f.context.pose.current.offset=135;
  const shifted=f.context.visualGeometry();
  f.context.finished.current={visual:shifted,navigation:nav,stop:{range:B,canceled:false}};
  for(const ready of [false,true]){
    const view=f.context.presentation(ready);near(view.from,shifted.from);near(view.to,shifted.to);
  }
  const live=axisPresentationFixture(A,axisNavigation('board',null,prefs));
  live.context.from+=60_000;live.context.to+=60_000;live.context.end+=60_000;
  for(const ready of [false,true]){
    const view=live.context.presentation(ready);near(view.from,A.from+60_000);near(view.to,A.to+60_000);
  }
});

test('a ready live replacement supplies the next actual gesture with its new duration',()=>{
  const M=60_000,to=Date.UTC(2026,9,23,3,17,17),now=to+1000;
  for(const periodMs of [H,24*H]){
    const landmarks=[to-20*M,to-10*M],f=activityAxisFixture(false,{range:{from:to-72*H,to},periodMs,now,cells:landmarks.map(at=>[at,H]),landmarks,warmup:false});
    f.pointerDown();f.flush();f.pointerMove(198);f.runFrame();f.settle();
    f.props.prepared=false;f.pointerUp();f.runFrame();f.flush();f.settle();
    f.props.prepared=true;f.stageModel();f.settle();
    const before=f.snapshot('ready replacement'),token=f.pointerDown();
    assert.equal(before.drawReady,'true');
    for(const value of [f.snapshot('before React'),(f.flush(),f.snapshot('after React'))]){
      assert.equal(value.ratio,1);assert.ok(Math.abs(value.viewport.to-value.viewport.from-periodMs)<1);
      assert.deepEqual(value.timeTicks,before.timeTicks);
    }
    f.pan.cancel(token);f.runFrame();f.flush();f.settle();
    assert.deepEqual(f.snapshot('cancelled').landmarks,before.landmarks);
  }
});
