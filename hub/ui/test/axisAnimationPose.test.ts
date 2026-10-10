import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {navigationKey} from '../lib/axisNavigation';
import type {DrawingGeometry} from '../components/timeAxis';

type Pose = {a: number; b: number; offset: number};
type Moving = {effect: {target: Surface; getComputedTiming(): {progress: number | null | undefined}}; frames: Keyframe[]; progress: number | null | undefined; finished: Promise<void>; canceled: boolean; cancel(): void};
type Surface = {style: {transform: string}; animate(frames: Keyframe[], options: KeyframeAnimationOptions): Moving; closest(): Surface | null};
const H = 3_600_000, base = {from: 0, to: 2 * H, end: 2 * H};
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const transformOf = (transform: string) => {
  if (transform === 'none') return {a: 1, b: 0};
  const m = transform.match(/^translateX\(([-.\de+]+)px\) scaleX\(([-.\de+]+)\)$/)!;
  assert.ok(m, transform); return {a: Number(m[2]), b: Number(m[1])};
};
const matrixOf = (animation: Moving) => {
  const from = transformOf(String(animation.frames[0].transform)), to = transformOf(String(animation.frames[1].transform));
  const progress = animation.progress ?? 1;
  return {a: from.a + (to.a - from.a) * progress, b: from.b + (to.b - from.b) * progress};
};

function fixture(scale: number) {
  let styleReads = 0;
  const created: Moving[] = [];
  const makeSurface = (): Surface => ({style: {transform: ''}, closest: () => null,
    animate(frames) {
      const animation: Moving = {effect: {target: this, getComputedTiming: () => ({progress: animation.progress})}, frames, progress: .61,
        finished: new Promise(() => {}), canceled: false, cancel() {this.canceled = true;}};
      created.push(animation); return animation;
    }});
  const owner = makeSurface(), layer = makeSurface(); layer.closest = () => owner;
  const context = {scale, width: 600, left: 40, right: 20, drawing: {current: base}, pose: {current: {a: 1, b: 0, offset: 0}},
    animations: {current: new Map<Surface, Moving>()}, animationPoses: {current: new WeakMap<Moving, {from: Pose; to: Pose}>()},
    panLayers: {current: [owner]}, box: {current: {querySelector: () => layer, querySelectorAll: () => [layer]}},
    foldTicket: {current: 0}, wanted: {current: {navigation: {context: 'test', range: 'range'}}}, navigationKey,
    motion: {current: null}, pan: {active: () => null}, setFolding: () => {}, performance: {now: () => 0}, matchMedia: () => ({matches: false}),
    getComputedStyle: (target: Surface) => {
      styleReads++; const animation = created.slice().reverse().find(a => !a.canceled && a.effect.target === target)!;
      const matrix = matrixOf(animation); return {transform: `matrix(${matrix.a},0,0,1,${matrix.b},0)`};
    },
    DOMMatrix: class {a: number; e: number; constructor(transform: string) {const parts = transform.slice(7, -1).split(',').map(Number); this.a = parts[0]; this.e = parts[4];}},
    animateProjection: null as unknown as (visual: DrawingGeometry, target: DrawingGeometry, duration: number, fold: boolean) => void,
    readPose: null as unknown as (layer: Surface) => Pose, visualGeometry: null as unknown as () => DrawingGeometry,
    freezeSlides: null as unknown as () => void,
  };
  const source = ts.createSourceFile('timeAxis.ts', readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const methods = new Map<string, string>();
  const visit = (node: ts.Node) => {if (ts.isVariableDeclaration(node) && node.initializer) methods.set(node.name.getText(source), node.initializer.getText(source)); ts.forEachChild(node, visit);};
  visit(source);
  const names = ['projectionOf', 'projectTo', 'animateSlide', 'cancelSlides', 'animateProjection', 'readPose', 'visualGeometry', 'freezeSlides'];
  const code = names.map(name => {assert.ok(methods.has(name)); return `globalThis.${name}=${methods.get(name)};`;}).join('\n');
  runInNewContext(ts.transpileModule(code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const checkPixels = (animation: Moving) => {
    const matrix = matrixOf(animation), shown = context.readPose(layer), final = context.pose.current;
    for (const x of [40, 123, 580]) {
      const native = animation.effect.target === layer ? scale * (matrix.a * x + matrix.b) : matrix.a * scale * (final.a * x + final.b) + matrix.b;
      near(scale * (shown.a * x + shown.b) + shown.offset, native);
    }
    return shown;
  };
  return {context, created, layer, checkPixels, styleReads: () => styleReads};
}

test('owned SVG and HTML projections read eased progress and freeze without a style flush', () => {
  for (const fold of [false, true]) for (const scale of [.5, .731, 1]) {
    const f = fixture(scale);
    f.context.animateProjection({from: -H, to: 29 * H, end: 2 * H}, {from: H, to: 4 * H, end: 2 * H}, 160, fold);
    const animation = f.created[0]; assert.ok(animation);
    const shown = f.checkPixels(animation), geometry = f.context.visualGeometry();
    f.context.freezeSlides();
    assert.equal(animation.canceled, true); assert.equal(f.context.animations.current.size, 0);
    near(f.context.pose.current.a, shown.a); near(f.context.pose.current.b, shown.b);
    assert.deepEqual(f.context.visualGeometry(), geometry, 'interrupting the animation retains its displayed time domain');
    assert.equal(f.styleReads(), 0, 'an owned projection must not force computed styles');
  }
});

test('retargeting an owned projection keeps the sampled position with fresh endpoints', () => {
  for (const fold of [false, true]) {
    const f = fixture(.731);
    f.context.animateProjection({from: -H, to: H, end: H}, base, 160, fold);
    const visual = f.context.visualGeometry(), before = f.context.readPose(f.layer);
    f.context.animateProjection(visual, {from: H, to: 3 * H, end: 2 * H}, 80, fold);
    assert.equal(f.created[0].canceled, true); assert.equal(f.created.length, 2);
    const next = f.created[1]; next.progress = 0;
    const start = f.checkPixels(next); near(start.a, before.a); near(start.b, before.b);
    next.progress = .37; f.checkPixels(next);
    next.progress = 1; f.checkPixels(next);
    assert.equal(f.styleReads(), 0);
  }
});

test('an inactive owned effect uses the final pose and missing timing retains the native fallback', () => {
  const f = fixture(.5);
  f.context.animateProjection({from: -H, to: H, end: H}, base, 160, true);
  const animation = f.created[0]; animation.progress = null;
  const inactive = f.context.readPose(f.layer), final = f.context.pose.current;
  near(inactive.a, final.a); near(inactive.b, final.b); near(inactive.offset, final.offset); assert.equal(f.styleReads(), 0);
  animation.progress = undefined; f.checkPixels(animation); assert.equal(f.styleReads(), 1);
  animation.progress = .43; f.context.animationPoses.current.delete(animation);
  f.checkPixels(animation); assert.equal(f.styleReads(), 2, 'an unknown projection still reads its actual native transform');
  f.context.animations.current.clear();
  assert.equal(f.context.readPose(f.layer), f.context.pose.current); assert.equal(f.styleReads(), 2);
});
