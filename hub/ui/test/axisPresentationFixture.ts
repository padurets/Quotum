import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {navigationKey, type AxisNavigation} from '../lib/axisNavigation';
import {slideOf, type DrawingGeometry} from '../components/timeAxis';

type Moving = {finished: Promise<void>; canceled: boolean; cancel(): void; finish(): void};

/** Executes the actual axis's intent and post-DOM presentation methods. */
export function axisPresentationFixture(base: DrawingGeometry, navigation: AxisNavigation, width = 600, scale = .5, left = 40, right = 20) {
  const classes = new Set<string>();
  const layers = [{style: {transform: ''}}, {style: {transform: ''}}];
  const slides = [{style: {transform: ''}}, {style: {transform: ''}}];
  const animations: Moving[] = [];
  const canceledFrames: number[] = [];
  let now = 0;
  const drawing = {current: base}, pose = {current: {a: 1, b: 0, offset: 0}};
  const wanted = {current: {navigation, projection: base}};
  const active = {current: null as number | null};
  const context = {drawing, pose, wanted, navigationKey, slideOf, width, scale, left, right,
    from: base.from, to: base.to, end: base.end, requestedNavigation: navigation,
    svg: {current: {dataset: {} as Record<string, string>, classList: {toggle: (name: string, on: boolean) => {if (on) classes.add(name); else classes.delete(name);}}}},
    box: {current: {querySelectorAll: () => slides}}, panLayers: {current: layers},
    finished: {current: null as {visual: DrawingGeometry; navigation: AxisNavigation; stop: {range: unknown; canceled: boolean}} | null},
    captured: {current: null}, finalFrame: {current: null as number | null}, foldTicket: {current: 0},
    motion: {current: null as {key: string; until: number; fold: boolean} | null}, animations: {current: new Map<object, Moving>()},
    cancelAnimationFrame: (frame: number) => canceledFrames.push(frame),
    cancelSlides: () => {for (const animation of context.animations.current.values()) animation.cancel(); context.animations.current.clear();},
    pan: {active: () => active.current, cancel: () => {active.current = null;}}, paintPan: {current: () => {}},
    performance: {now: () => now}, matchMedia: () => ({matches: false}), setFolding: (on: boolean) => {if (on) classes.add('is-panning'); else classes.delete('is-panning');},
    animateSlide: (layer: object) => {
      let finish!: () => void;
      const animation: Moving = {finished: new Promise(resolve => {finish = resolve;}), canceled: false, cancel() {this.canceled = true;}, finish: () => finish()};
      animations.push(animation); context.animations.current.set(layer, animation); return animation;
    },
    visualGeometry: () => {
      const span = Math.max(60_000, drawing.current.to - drawing.current.from), inner = width - left - right;
      const inverse = (px: number) => drawing.current.from + (((px - pose.current.offset) / scale - pose.current.b) / pose.current.a - left) / inner * span;
      return {from: inverse(left * scale), to: inverse((width - right) * scale), end: drawing.current.end};
    },
    useLayoutEffect: () => {}, publish: null as unknown as () => void,
    commit: null as unknown as (next: DrawingGeometry, ready: boolean) => void,
  };
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const projectionOf = ');
  const code = source.slice(start, source.indexOf('\n  return {box, svg', start));
  runInNewContext(ts.transpileModule(`${code}\nglobalThis.publish=publishWanted;globalThis.commit=commitDrawing;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const navigate = (next: DrawingGeometry, intent: AxisNavigation) => {context.from = next.from; context.to = next.to; context.end = next.end; context.requestedNavigation = intent; context.publish();};
  const point = (at: number) => scale * (pose.current.a * (left + (at - drawing.current.from) / (drawing.current.to - drawing.current.from) * (width - left - right)) + pose.current.b) + pose.current.offset;
  return {context, navigate, point, active, layers, slides, animations, classes, canceledFrames, advance: (ms: number) => {now += ms;}};
}
