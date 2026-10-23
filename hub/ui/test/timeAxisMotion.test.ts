import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Pan} from '../lib/pan';
import {navigationAt, navigationKey} from '../lib/axisNavigation';
import {axisPresentationFixture} from './axisPresentationFixture';
import {tickKeyframes, tickPresentation, tickVisible} from '../lib/axisTicks';

const offsetIs = (transform: string, expected: number, message?: string) => assert.ok(Math.abs(Number(transform.match(/translateX\(([-.\d]+)px\)/)?.[1] ?? 0) - expected) < 1e-9, message);

test('a wheel restart retains the range committed by its preceding gesture before React publishes it', () => {
  const H = 3_600_000, now = 100 * H;
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const paint = () => {');
  const paint = source.slice(start, source.indexOf('\n  useLayoutEffect(() => {\n    const unsubscribe', start));
  for (const returning of [false, true]) {
    let selected = returning ? {from: now - 2 * H, to: now - H} : null;
    const initial = navigationAt({context: 'test', range: 'live'}, selected);
    const base = selected ? {...selected, end: selected.to} : {from: now - H, to: now, end: now};
    const f = axisPresentationFixture(base, initial), frames: (() => void)[] = [];
    let commits = 0, deliveredAt = 1000;
    const pan = new Pan({now: () => now, commit: range => {selected = range; commits++;}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}}, () => deliveredAt);
    const chart = {current: Symbol('chart')};
    Object.assign(f.context, {pan, navigationAt, source: chart, folding: false,
      panPointer: {current: null}, wheelBounds: {current: null}, freezeSlides: f.context.cancelSlides,
      useLayoutEffect: (effect: () => void) => effect(),
    });
    Object.assign(f.context.svg.current.classList, {contains: (name: string) => f.classes.has(name), add: (name: string) => f.classes.add(name), remove: (name: string) => f.classes.delete(name)});
    runInNewContext(ts.transpileModule(paint, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, f.context);
    pan.subscribe(() => f.context.paintPan.current());
    const input = (timeStamp: number, deltaX: number) => ({timeStamp, deltaX, deltaY: 0, deltaMode: 0, cancelable: true, shiftKey: false});
    const begin = () => ({source: chart.current, selected, length: H, now, historyStart: 0, span: H, width: 270});
    assert.equal(pan.wheel(begin, input(1_000, returning ? 270 : -24)), true);
    frames.shift()!();
    deliveredAt = 1300;
    assert.equal(pan.wheel(begin, input(1_300, -12)), true);
    assert.equal(commits, 1);
    const token = pan.active(); assert.ok(token);
    const target = selected ? {...selected, end: selected.to} : {from: now - H, to: now, end: now};
    f.navigate(target, navigationAt(initial, selected));
    assert.equal(pan.active(), token, 'publishing the preceding commit must not cancel the new wheel');
    assert.equal(f.context.svg.current.dataset.panToken, String(token));
    f.navigate(target, {...navigationAt(initial, selected), context: 'another board'});
    assert.equal(pan.active(), null, 'a different navigation context still cancels the wheel');
  }
});

test('the actual axis publishes committed HTML owners and applies the captured CSS scale', () => {
  const H = 3_600_000, now = 100 * H, selected = {from: now - 2 * H, to: now - H};
  const frames: (() => void)[] = [];
  const pan = new Pan({now: () => now, commit: () => {}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const source = {current: Symbol('chart')};
  const token = pan.begin({source: source.current, input: 'pointer', selected, length: H, now, historyStart: 0, span: H, width: 270})!;
  pan.move(token, -27); frames.shift()!();
  const makeLayer = () => ({style: {transform: ''}});
  const old = makeLayer(), next = makeLayer();
  let owners = [old], released = 0;
  const box = {current: {
    querySelectorAll: (selector: string) => selector === '.plot-move' ? owners : [{getAnimations: () => []}],
    hasPointerCapture: () => true, releasePointerCapture: () => {released++;},
  }};
  const svg = {current: {dataset: {} as Record<string, string>, classList: {contains: () => false, add: () => {}, remove: () => {}, toggle: () => {}}}};
  const commits: (() => void)[] = [];
  const panLayers = {current: [] as ReturnType<typeof makeLayer>[]};
  const captured = {current: null};
  const paintPan = {current: () => {}};
  const context = {paintDrawing:{current:undefined},navigationAt,paintTicks:{current:()=>{}},pan, source, svg, box, panLayers, captured, paintPan, wanted: {current: {navigation: {context: 'test', range: 'range'}}}, motion: {current: null}, finished: {current: null}, foldTicket: {current: 0},
    drawing: {current: {...selected, end: selected.to}}, pose: {current: {a: 1, b: 0, offset: 0}}, finishPresentation: {current: null}, finalFrame: {current: null}, folding: false,
    visualGeometry: () => ({...selected, end: selected.to}), freezeSlides: () => {}, setFolding: () => {}, cancelSlides: () => {},
    width: 600, left: 40, right: 20, scale: .5, panPointer: {current: null as {id: number} | null}, wheelBounds: {current: null},
    useLayoutEffect: (commit: () => void) => commits.push(commit),
  };
  const code = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = code.indexOf('  const paint = () => {');
  const region = code.slice(start, code.indexOf('\n  useLayoutEffect(() => {\n    const unsubscribe', start));
  const publish = () => runInNewContext(ts.transpileModule(`{${region}}`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  publish();
  assert.equal(old.style.transform, '', 'preparing a render cannot publish or mutate its surface');
  commits.shift()!();
  offsetIs(old.style.transform, 27);
  assert.equal(Number(svg.current.dataset.panScale), H / 270);
  assert.equal(Number(svg.current.dataset.panMinEnd), pan.oldestEnd);
  assert.equal(Number(svg.current.dataset.panMaxEnd), pan.newestEnd);
  const committed = paintPan.current;
  publish();
  assert.equal(paintPan.current, committed, 'input before commit retains the displayed callback');
  committed();
  assert.equal(next.style.transform, '');
  owners = [next];
  commits.shift()!();
  offsetIs(next.style.transform, 27, 'a replacement surface starts at the same displayed time');
  context.panPointer.current = {id: 7};
  pan.cancel(); paintPan.current();
  assert.equal(released, 1, 'capture is released by the chart box, which owns the input');
  offsetIs(next.style.transform, 27, 'logical stop holds the last pose until its replacement commits');
  assert.equal(svg.current.dataset.panEnd, undefined);
  assert.equal(svg.current.dataset.panMinEnd, undefined);
  assert.equal(svg.current.dataset.panMaxEnd, undefined);
  const continued = pan.begin({source: source.current, input: 'pointer', selected, length: H, now, historyStart: 0, span: H, width: 270})!;
  pan.move(continued, -54); frames.shift()!(); paintPan.current();
  offsetIs(next.style.transform, 81, 'a new gesture can move the committed artwork before another render commits');
  pan.cancel(); paintPan.current();
});

test('the actual cursor follows shared Shift state after visibility-only cancellation', () => {
  const pan = new Pan({now: () => 0, commit: () => {}, requestFrame: () => null, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const classes = new Set<string>(), events = new Map<string, ((event?: {key: string; shiftKey: boolean}) => void)[]>();
  const listen = (type: string, callback: (event?: {key: string; shiftKey: boolean}) => void) => events.set(type, [...events.get(type) ?? [], callback]);
  const dispatch = (type: string, event?: {key: string; shiftKey: boolean}) => events.get(type)?.forEach(callback => callback(event));
  let mounted = false;
  const context = {pan, window: {}, document: {hidden: false, addEventListener: listen}, addEventListener: listen,
    removeEventListener: () => {}, onTimeRange: () => {}, onPrefs: () => {}, prefs: () => ({}),
    svg: {current: {classList: {toggle: (name: string, on: boolean) => {if (on) classes.add(name); else classes.delete(name);}, remove: (name: string) => classes.delete(name)}}},
    shifting: false, panning: null, folding: false, finished: {current: null},
    useLayoutEffect: (effect: () => void) => effect(),
    useEffect: (effect: () => void) => {if (!mounted) effect();},
  };
  const panSource = readFileSync(new URL('../lib/pan.ts', import.meta.url), 'utf8');
  const options = {compilerOptions: {target: ts.ScriptTarget.ES2022}};
  runInNewContext(ts.transpileModule(panSource.slice(panSource.indexOf("if (typeof window !== 'undefined')")), options).outputText, context);
  const axis = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const cursor = axis.slice(axis.indexOf("  useLayoutEffect(() => {svg.current?.classList.toggle('is-panning'"), axis.indexOf('  const measured ='));
  const render = () => {context.shifting = pan.shifting(); runInNewContext(ts.transpileModule(cursor, options).outputText, context); mounted = true;};
  render(); pan.onPhase(render);
  dispatch('keydown', {key: 'Shift', shiftKey: true});
  assert.ok(classes.has('is-grabbable'));
  context.document.hidden = true; dispatch('visibilitychange');
  assert.equal(pan.shifting(), false);
  assert.equal(classes.has('is-grabbable'), false, 'visibility-only cancellation clears the grab cursor without a blur or keyup');
  context.document.hidden = false; dispatch('visibilitychange');
  assert.equal(classes.has('is-grabbable'), false);
});

test('starting from a settled axis avoids a style flush but samples an interrupted fold', () => {
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const readPose = ');
  const body = source.slice(start, source.indexOf('  useLayoutEffect(() => pan.register(', start)) + '\nglobalThis.read=visualGeometry;';
  let reads = 0;
  const layer = {getAnimations: () => {throw new Error('animation lookup must not flush styles');}};
  const animations = {current: new Map()};
  const context = {box: {current: {querySelector: () => layer}}, animations, animationPoses: {current: new WeakMap()},
    captured:{current:null},finished:{current:null},motion:{current:null},wanted:{current:{projection:{from:0,to:1_000_000,end:800_000}}},
    drawing: {current: {from: 0, to: 1_000_000, end: 800_000}}, pose: {current: {a: 1, b: 0, offset: 0}}, scale: .5, left: 40, right: 12, width: 900,
    getComputedStyle: () => {reads++; return {transform: 'matrix'};},
    DOMMatrix: class {a = .5; e = 20;}, read: null as unknown as () => {from: number; to: number; end: number}};
  runInNewContext(ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  assert.equal(context.read().to, 1_000_000);
  assert.equal(reads, 0, 'the ordinary start must not flush styles for an unanimated SVG');
  animations.current.set(layer, {});
  const sampled = context.read();
  assert.equal(reads, 1);
  assert.equal(sampled.to - sampled.from, 2_000_000, 'an interrupted fold retains its actual displayed scale');
  assert.equal(sampled.end, sampled.to-200_000,'the sampled projection keeps its owned future extent');
});

test('the actual slide owner cancels replacements and releases only its own completed animation', async () => {
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const region = source.slice(source.indexOf('  const animations = '), source.indexOf('  const source = '));
  const cleanups: (() => void)[] = [];
  const context = {useRef: (current: unknown) => ({current}), useEffect: (effect: () => () => void) => cleanups.push(effect()),
    animateSlide: null as unknown as (layer: object, frames: object[], options: object) => unknown,
    animations: null as unknown as {current: Map<object, unknown>}};
  runInNewContext(ts.transpileModule(`{${region}\nglobalThis.animateSlide=animateSlide;globalThis.animations=animations;}`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const created: {finished: Promise<void>; finish(): void; cancel(): void; canceled: boolean}[] = [];
  const layer = {animate: () => {
    let finish!: () => void;
    const animation = {finished: new Promise<void>(resolve => {finish = resolve;}), finish: () => finish(), canceled: false, cancel() {this.canceled = true;}};
    created.push(animation); return animation;
  }};
  context.animateSlide(layer, [], {duration: 160});
  context.animateSlide(layer, [], {duration: 220});
  assert.equal(created[0].canceled, true);
  assert.equal(context.animations.current.size, 1);
  created[0].finish(); await Promise.resolve();
  assert.equal(context.animations.current.get(layer), created[1], 'a late completion cannot retire its replacement');
  created[1].finish(); await Promise.resolve();
  assert.equal(context.animations.current.size, 0);
  context.animateSlide(layer, [], {duration: 160});
  cleanups.forEach(cleanup => cleanup());
  assert.equal(created[2].canceled, true);
  assert.equal(context.animations.current.size, 0, 'unmount releases every owned animation');
});

test('the actual drawing commit preserves two landmarks through pending, replacement and the completed handoff', () => {
  const H = 3_600_000, width = 600, left = 40, right = 20, scale = .5, inner = width - left - right;
  const old = {from: 0, to: 2 * H, end: H}, initial = {a: .7, b: 5, offset: 13};
  const inverse = (px: number) => (((px - initial.offset) / scale - initial.b) / initial.a - left) / inner * 2 * H;
  const delta = -.25 * H, visual = {from: inverse(left * scale) + delta, to: inverse((width - right) * scale) + delta, end: H + delta};
  const selected = {from: visual.from, to: visual.end};
  const layers = [{style: {transform: 'held'}}], slides = [{style: {transform: 'frozen'}, closest: () => layers[0]}];
  const frames: Keyframe[][] = [];
  const pose = {current: {...initial, offset: initial.offset - delta / (visual.to - visual.from) * inner * scale}};
  const known = [H / 2, H];
  const before = known.map(at => scale * (pose.current.a * (left + at / (old.to - old.from) * inner) + pose.current.b) + pose.current.offset);
  const context = {document:{timeline:{currentTime:0}},animateTicks:{current:()=>[]},paintDrawing:{current:undefined},paintTicks:{current:()=>{}},shown: {current: old}, drawing: {current: old}, svg: {current: {dataset: {} as Record<string, string>}}, box: {current: {querySelectorAll: () => slides}},
    panLayers: {current: layers}, pose, pan: {active: () => null}, paintPan: {current: () => {}},
    navigationKey, wanted: {current: {navigation: {context: 'test', range: 'range'}, projection: {from: selected.from, to: selected.to, end: selected.to},positioned:true}}, requestedNavigation: {context: 'test', range: 'range'}, motion: {current: null}, captured: {current: null},
    finished: {current: {navigation: {context: 'test', range: 'range'}, visual, stop: {range: selected, canceled: false}} as {navigation: {context: string; range: string}; visual: typeof visual; stop: {range: typeof selected; canceled: boolean}} | null},
    finishPresentation: {current: null}, finalFrame: {current: 1 as number | null}, timeRange: () => selected, left, right, width, scale, from: selected.from, to: selected.to,
    foldTicket: {current: 0}, animations: {current: new Map()}, animationPoses: {current: new WeakMap()}, matchMedia: () => ({matches: false}), setFolding: () => {},
    animateSlide: (_layer: object, next: Keyframe[]) => {frames.push(next); return {finished: new Promise(() => {})};}, slideOf: () => 0,
    visualGeometry: () => visual, cancelSlides: () => {}, useLayoutEffect: () => {}, performance: {now: () => 0},
    commit: null as unknown as (geometry: typeof old, ready: boolean) => void,
  };
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const projectionOf = '), body = source.slice(start, source.indexOf('\n  return {box, svg', start));
  runInNewContext(ts.transpileModule(`${body}\nglobalThis.commit=commitDrawing;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  context.commit(old, false);
  assert.equal(layers[0].style.transform, 'held'); assert.equal(frames.length, 0);
  context.commit(old, true); assert.equal(frames.length, 0, 'the last accepted delta must first reach RAF');
  context.finalFrame.current = null;
  const next = {from: selected.from, to: selected.to, end: selected.to};
  context.commit(next, true);
  assert.equal(context.finished.current, null); assert.equal(layers[0].style.transform, '');
  const point = (at: number) => scale * (pose.current.a * (left + (at - next.from) / (next.to - next.from) * inner) + pose.current.b) + pose.current.offset;
  // The old oracle checked only the first animation keyframe, missing its final zoom.
  known.forEach((at,i) => assert.ok(Math.abs(point(at) - before[i]) < 1e-9, 'the fully settled matrix preserves both timestamps'));
  assert.equal(frames.length, 0, 'replacement is a change of numeric basis, not another navigation');
  context.commit(next, true);
  known.forEach((at,i) => assert.ok(Math.abs(point(at) - before[i]) < 1e-9, 'later ordinary commits cannot reframe the positioned view'));
});

test('sampling and freezing an owned fold keeps its matrix after cancelling the animation', () => {
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const readPose = '), body = source.slice(start, source.indexOf('  useLayoutEffect(() => pan.register(', start));
  const layer = {style: {transform: ''}}, other = {style: {transform: ''}}, animations = {current: new Map([[layer, {}]])};
  const pose = {current: {a: 1, b: 0, offset: 17}};
  const context = {paintTicks:{current:()=>{}},box: {current: {querySelector: () => layer, querySelectorAll: () => [layer, other]}}, animations, pose, animationPoses: {current: new WeakMap()},
    getComputedStyle: () => ({transform: 'matrix'}), DOMMatrix: class {a = .6; e = 21;}, cancelSlides: () => animations.current.clear(), freeze: null as unknown as () => void};
  runInNewContext(ts.transpileModule(`${body}\nglobalThis.freeze=freezeSlides;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  context.freeze();
  assert.equal(animations.current.size, 0); assert.equal(pose.current.offset, 17);
  assert.equal(layer.style.transform, 'translateX(21px) scaleX(0.6)');
  assert.equal(other.style.transform, layer.style.transform, 'every drawing layer keeps the same sampled SVG pose');
});

test('an interrupted HTML fold composes its CSS matrix with the final SVG pose before restoring strokes', () => {
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  const readPose = '), source.indexOf('  useLayoutEffect(() => pan.register('));
  for (const scale of [.5, .731, 1]) {
    const owner = {}, layer = {style: {transform: ''}}, other = {style: {transform: ''}};
    const pose = {current: {a: 1.25, b: -31, offset: 0}}, base = {from: 0, to: 3_600_000, end: 3_000_000};
    let canceled = false;
    const animation = {effect: {target: owner}};
    const animations = {current: new Map([[layer, animation]])};
    const context = {captured:{current:null},finished:{current:null},motion:{current:null},wanted:{current:{projection:base}},paintTicks:{current:()=>{}},drawing: {current: base}, box: {current: {querySelector: () => layer, querySelectorAll: () => [layer, other]}}, animations, pose, animationPoses: {current: new WeakMap()},
      scale, width: 600, left: 40, right: 20,
      getComputedStyle: (target: object) => {assert.equal(target, owner); return {transform: 'matrix(.63,0,0,1,27,0)'};},
      DOMMatrix: class {a = .63; e = 27;}, cancelSlides: () => {canceled = true; animations.current.clear();},
      read: null as unknown as () => {from: number; to: number}, freeze: null as unknown as () => void};
    runInNewContext(ts.transpileModule(`${body}\nglobalThis.read=visualGeometry;globalThis.freeze=freezeSlides;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
    const at = 1_000_000, drawn = 40 + at / base.to * 540;
    const before = .63 * scale * (1.25 * drawn - 31) + 27;
    const visible = context.read();
    assert.ok(Math.abs(scale * (40 + (at - visible.from) / (visible.to - visible.from) * 540) - before) < 1e-9);
    context.freeze();
    assert.equal(canceled, true); assert.equal(animations.current.size, 0);
    assert.ok(Math.abs(scale * (pose.current.a * drawn + pose.current.b) - before) < 1e-9);
    assert.equal(other.style.transform, layer.style.transform);
    assert.deepEqual(context.read(), visible, 'freezing cannot change the displayed time domain');
  }
});

test('only gesture completion scales the HTML surface; ordinary navigation retains SVG animation', () => {
  const base = {from: 0, to: 7_200_000, end: 3_600_000}, navigation = {context: 'test', range: 'range'};
  const f = axisPresentationFixture(base, navigation, 600, .731);
  const visual = {...base, from: -600_000};
  f.context.finished.current = {visual, navigation, stop: {range: null, canceled: false}};
  f.context.wanted.current.projection = {from: 600_000, to: 4_200_000, end: 4_200_000};
  f.context.commit(base, true);
  assert.equal(f.animations.length, 2);
  for (const [i, animation] of f.animations.entries()) {
    assert.equal(animation.owner, f.layers[i]); assert.equal(animation.options.duration, 160);
    assert.equal(animation.frames.at(-1)?.transform, 'none');
    assert.equal(f.slides[i].style.transform, 'translateX(-130px) scaleX(2)');
    const matrix = String(animation.frames[0].transform).match(/translateX\(([-.\de+]+)px\) scaleX\(([-.\de+]+)\)/)!;
    const at = 1_000_000;
    const shown = Number(matrix[2]) * f.point(at) + Number(matrix[1]);
    const expected = .731 * (40 + (at - visual.from) / (visual.to - visual.from) * 540);
    assert.ok(Math.abs(shown - expected) < 1e-9, 'the HTML frame composes with a nonidentity final SVG projection');
  }
  const ordinary = axisPresentationFixture({...base, end: base.to}, navigation);
  const next = {from: 1_800_000, to: 9_000_000, end: 9_000_000};
  ordinary.context.wanted.current.projection = next;
  ordinary.context.commit(next, true);
  for (const [i, animation] of ordinary.animations.entries()) {
    assert.equal(animation.owner, ordinary.slides[i]); assert.equal(animation.options.duration, 220);
  }
  assert.equal(ordinary.animations.length, 2);
});

test('a fold keeps whole-date owners in SVG while other drawing layers use HTML',()=>{
  const base={from:0,to:7_200_000,end:3_600_000},navigation={context:'test',range:'range'};
  const f=axisPresentationFixture(base,navigation);
  Object.assign(f.slides[0],{parentElement:{querySelector:()=>({})}});
  Object.assign(f.slides[1],{parentElement:{querySelector:()=>null}});
  f.context.finished.current={visual:{...base,from:-600_000},navigation,stop:{range:null,canceled:false}};
  f.context.wanted.current.projection={from:600_000,to:4_200_000,end:4_200_000};
  f.context.commit(base,true);
  assert.equal(f.animations[0].owner,f.slides[0],'independent glyph animation cannot inherit an HTML scale');
  assert.equal(f.animations[1].owner,f.layers[1],'the remaining drawing keeps the HTML fold');
  assert.equal(f.context.animationPoses.current.has(f.animations[0]),true);
  assert.equal(f.context.animationPoses.current.has(f.animations[1]),true);
});

test('the actual last-input RAF uses the gesture CSS scale rather than the mount-time axis closure', () => {
  const H = 3_600_000, now = 100 * H, selected = {from: now - 2 * H, to: now - H};
  const inputFrames: (() => void)[] = [], finalFrames: (() => void)[] = [];
  const pan = new Pan({now: () => now, commit: () => {}, requestFrame: run => {inputFrames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const token = pan.begin({source: Symbol('chart'), input: 'pointer', selected, length: H, now, historyStart: 0, span: H, width: 270})!;
  pan.move(token, -27); inputFrames.shift()!();
  const layer = {style: {transform: 'translateX(44px)'}};
  const context = {paintDrawing:{current:undefined},paintTicks:{current:()=>{}},pan, navigationAt, drawing: {current: {...selected, end: selected.to}}, box: {current: null}, width: 900, left: 40, right: 20, scale: 1,
    captured: {current: {token, ...selected, end: selected.to, visual: {...selected, end: selected.to}, pose: {a: 1, b: 0, offset: 17}, pixelsPerMs: 270 / H, navigation: {context: 'test', range: 'range'}, innerWidth: 540, cssScale: .5, left: 40}},
    finished: {current: null}, pose: {current: {a: 1, b: 0, offset: 44}}, finishPresentation: {current: null}, finalFrame: {current: null}, panLayers: {current: [layer]},
    setFolding: () => {}, present: () => {}, requestAnimationFrame: (run: () => void) => {finalFrames.push(run); return finalFrames.length;},
    useLayoutEffect: (effect: () => void) => effect(),
  };
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  useLayoutEffect(() => pan.onStop(stop => {');
  const body = source.slice(start, source.indexOf('  useEffect(() => () => {', start));
  runInNewContext(ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  pan.move(token, -13); pan.finish(token);
  assert.equal(layer.style.transform, 'translateX(44px)', 'logical release holds the last painted pose');
  finalFrames.shift()!();
  const offset = Number(layer.style.transform.match(/translateX\(([-.\d]+)px\)/)![1]);
  assert.ok(Math.abs(offset - 57) < 1e-9, 'the last 13px input is presented at the actual captured 270px plot width');
  assert.ok(Math.abs(context.pose.current.offset - 57) < 1e-9);
});

test('committed axis ticks reuse shaped widths across frames and measure only changed glyphs',async()=>{
  let reads=0;
  const tick=(text:string,x:number)=>({textContent:text,x,style:{visibility:'',transform:''},getAttribute:()=>String(x),getComputedTextLength:()=>{reads++;return 44;}});
  const ticks=[tick('14 Oct',60),tick('15 Oct',200)];
  const context={tickElements:{current:[]},animateTicks:{current:()=>[]},motion:{current:null},animations:{current:new Map()},animateSlide:()=>{throw Error('no animation without motion');},tickKeyframes,box:{current:{querySelectorAll:()=>ticks}},tickWidths:{current:new Map()},tickGlyphs:{current:new WeakMap()},paintTicks:{current:()=>{}},pose:{current:{a:1,b:0,offset:0}},scale:.73,left:48,right:12,width:920,tickPresentation,tickVisible,
    useLayoutEffect:(run:()=>void)=>run(),measure:null as unknown as ()=>void};
  const source=readFileSync(new URL('../components/timeAxis.ts',import.meta.url),'utf8'),start=source.indexOf('  useLayoutEffect(() => {\n    // Measure only after DOM commit.');
  const body=source.slice(start,source.indexOf('\n  return {box, svg',start));
  runInNewContext(ts.transpileModule('globalThis.measure=()=>{'+body+'};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  context.measure();assert.equal(reads,2);assert.equal(ticks[0].style.visibility,'hidden');assert.equal(ticks[1].style.visibility,'');
  for(let i=0;i<100;i++){context.pose.current.offset=i*.01;context.paintTicks.current();context.measure();}
  assert.equal(reads,2,'input and ordinary commits never force text layout for retained labels');
  ticks[0].textContent='16 Oct';context.measure();assert.equal(reads,3);
  ticks[0]=tick('16 Oct',60);ticks[1]=tick('15 Oct',200);context.measure();assert.equal(reads,3,'rebuilt strips reuse glyph widths without another forced layout');
  context.tickWidths.current.clear();context.measure();assert.equal(reads,5,'a font change retires the shaped widths');
  for(let i=0;i<200;i++){ticks[0].textContent='day '+i;context.measure();}
  assert.equal(context.tickWidths.current.size,128,'long navigation keeps the glyph cache bounded');
});

test('native tick movement never reparses unchanged glyph transforms after CSS rounds their coordinates',async()=>{
  let writes=0,gets=0,presentations=0,wanted='',serialized='';
  const tick=(x:number)=>({x,textContent:'14 Oct',style:{visibility:'',get transform(){gets++;return serialized;},set transform(value:string){writes++;wanted=value;serialized=value.replace(/-?\d+(?:\.\d+)?/g,n=>String(Number(Number(n).toPrecision(6))));}},getAttribute(){return String(this.x);},getComputedTextLength:()=>44});
  const ticks=[tick(500.123456789)],pose={current:{a:.731231231,b:4.123456789,offset:0}};
  const context={tickElements:{current:[]},animateTicks:{current:()=>[]},motion:{current:null},animations:{current:new Map()},animateSlide:()=>{throw Error('no animation without motion');},tickKeyframes,box:{current:{querySelectorAll:()=>ticks}},tickWidths:{current:new Map()},tickGlyphs:{current:new WeakMap()},paintTicks:{current:()=>{}},pose,scale:.73,left:48,right:12,width:920,tickVisible,tickPresentation:(...args:Parameters<typeof tickPresentation>)=>{presentations++;return tickPresentation(...args);},
    useLayoutEffect:(run:()=>void)=>run(),measure:null as unknown as ()=>void};
  const source=readFileSync(new URL('../components/timeAxis.ts',import.meta.url),'utf8'),start=source.indexOf('  useLayoutEffect(() => {\n    // Measure only after DOM commit.');
  const body=source.slice(start,source.indexOf('\n  return {box, svg',start));
  runInNewContext(ts.transpileModule('globalThis.measure=()=>{'+body+'};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  context.measure();assert.notEqual(wanted,serialized,'the browser normalizes a fractional CSS transform');
  assert.equal(writes,1);
  for(let i=0;i<100;i++){pose.current.offset=-i*4;context.paintTicks.current();context.measure();}
  assert.equal(writes,1,'native translation changes visibility without rewriting the glyph transform');
  assert.equal(presentations,1,'translation does not rebuild the unchanged glyph transform string');
  assert.equal(gets,0,'native frames do not read a normalized string just to write its equivalent again');
  assert.equal(ticks[0].style.visibility,'hidden');
  pose.current.a=1.23456789;context.paintTicks.current();assert.equal(writes,2,'a changed projection replaces the glyph transform');
  assert.equal(wanted,tickPresentation(500.123456789,44,pose.current,.73,48,908).transform);
  ticks[0]=tick(600.987654321);context.measure();assert.equal(writes,3,'new committed tick coordinates receive their own transform');
  ticks[0].x=610.123456789;context.measure();assert.equal(writes,4,'a reused node follows its new committed coordinate');
  assert.equal(wanted,tickPresentation(ticks[0].x,44,pose.current,.73,48,908).transform);
  pose.current.a=1;context.paintTicks.current();assert.equal(writes,5);
  ticks[0].x+=4;context.measure();assert.equal(writes,5,'identity glyph transforms do not depend on their new coordinate');
  pose.current.a=.5;context.paintTicks.current();assert.equal(writes,6);
  assert.equal(wanted,tickPresentation(ticks[0].x,44,pose.current,.73,48,908).transform);
});

for (const mode of ['idle', 'cancel', 'shift']) test(`all five axes retain accepted input on ${mode} before the final RAF`, () => {
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const region = (start: string, end: string) => {const i = source.indexOf(start), j = source.indexOf(end, i); assert.ok(i >= 0 && j > i); return source.slice(i, j);};
  const actual = [region('  const startPan = ', '  const wheelPan = '), region('  const readPose = ', '  useLayoutEffect(() => pan.register('), region('  const paint = () => {', '\n  useLayoutEffect(() => {\n    const unsubscribe'), region('  useLayoutEffect(() => pan.onStop(stop => {', '  useEffect(() => () => {\n    foldTicket.current++')].join('\n');
  const H = 3_600_000, now = 100 * H;
  const frames = new Map<number, () => void>(), timers = new Map<number, () => void>();
  const commits: ({from: number; to: number} | null)[] = [];
  let serial = 0, delivery = 1000, selected: {from: number; to: number} | null = null;
  const requestFrame = (run: () => void) => {const id = ++serial; frames.set(id, run); return id;};
  const cancelFrame = (id: unknown) => {frames.delete(id as number);};
  const hubNow = () => now + delivery - 1000;
  const pan = new Pan({now: hubNow, commit: range => {selected = range; commits.push(range);}, requestFrame, cancelFrame,
    setTimeout: (run, ms) => {assert.equal(ms, 200); const id = ++serial; timers.set(id, run); return id;},
    clearTimeout: id => {timers.delete(id as number);},
  }, () => delivery);
  const specs = [[600, .5, 40, 20], [700, .6, 48, 12], [760, .7, 48, 12], [800, .8, 76, 12], [900, 1, 76, 12]];
  const axes = specs.map(([width, scale, left, right]) => {
    const f = axisPresentationFixture({from: now - H, to: now, end: now}, {context: 'test', range: 'live'}, width, scale, left, right);
    const chart = {current: Symbol('chart')};
    Object.assign(f.context, {pan, source: chart, navigationAt, hubNow, historyStart: 0, timeRange: () => selected,
      prefs: () => ({range: '1h'}), periodOf: () => ({ms: H}), folding: false,
      panPointer: {current: null}, wheelBounds: {current: null}, requestAnimationFrame: requestFrame,
      cancelAnimationFrame: cancelFrame, useLayoutEffect: (effect: () => void) => effect(), present: () => {},
      getComputedStyle: () => {throw new Error('an ordinary restart must not read computed styles');},
    });
    Object.assign(f.context.box.current, {querySelector: () => f.slides[0], querySelectorAll: (selector: string) => selector === '.plot-move' ? f.layers : f.slides});
    Object.assign(f.context.svg.current.classList, {contains: (name: string) => f.classes.has(name), add: (name: string) => f.classes.add(name), remove: (name: string) => f.classes.delete(name)});
    const context = f.context as typeof f.context & {begin: () => Parameters<Pan['begin']>[0]};
    runInNewContext(ts.transpileModule(actual + "\nglobalThis.begin=()=>startPan('wheel');", {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
    pan.subscribe(() => context.paintPan.current());
    pan.register(chart.current, () => ({end: now, future: 0}));
    return {f, context, width, scale, left, right};
  });
  const input = (timeStamp: number, deltaX: number) => ({timeStamp, deltaX, deltaY: 0, deltaMode: 0, cancelable: true, shiftKey: false});
  if (mode === 'shift') pan.setShift(true);
  assert.equal(pan.wheel(axes[0].context.begin, input(1000, -448)), true);
  const first = pan.active(); assert.ok(first);
  if (mode === 'cancel') pan.cancel();
  delivery = 1302;
  assert.equal(pan.wheel(axes[0].context.begin, input(1301, -24)), true);
  const current = pan.active(); assert.ok(current);
  if (mode === 'shift') {
    assert.equal(current, first); assert.equal(commits.length, 0); assert.equal(timers.size, 0);
  } else {
    assert.notEqual(current, first); assert.equal(commits.length, mode === 'idle' ? 1 : 0);
  }
  delivery = 1352;
  if (mode !== 'cancel') {
    assert.equal(pan.wheel(axes[0].context.begin, input(1317, 279)), true);
    assert.equal(pan.active(), current);
  }
  if (mode === 'shift') pan.setShift(false);
  else {assert.equal(timers.size, 1); [...timers.values()][0]();}
  assert.equal(pan.active(), null); assert.equal(commits.length, mode === 'idle' ? 2 : 1);
  const wantedPixels = mode === 'cancel' ? 24 : 193;
  assert.equal(commits.at(-1)?.to, Math.round(now - wantedPixels * H / 270));
  for (const [id, run] of frames) {frames.delete(id); run();}
  for (const {f, context, width, scale, left, right} of axes) {
    const offset = wantedPixels * (width - left - right) * scale / 270;
    assert.ok(Math.abs(context.pose.current.offset - offset) < 1e-9, 'all followers keep the complete accepted CSS displacement');
    assert.ok(Math.abs(f.point(now) - ((width - right) * scale + offset)) < 1e-9);
  }
});
