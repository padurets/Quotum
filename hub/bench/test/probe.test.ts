import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {NODES, nodeOf, probeScript, rendered, type Fiber, type Reading} from '../probe.js';
import {measuredProblems} from '../budget.js';

/** A stand-in element: its tag, classes and attributes, and `closest` for the simple selectors the probe uses. */
class Element {
  readonly nodeType = 1;
  readonly children: Element[] = [];
  constructor(
    readonly tagName: string,
    readonly className: string,
    private readonly attributes: Record<string, string>,
    readonly parentElement: Element | null,
  ) {parentElement?.children.push(this);}
  hasAttribute(name: string) {
    return Object.hasOwn(this.attributes, name);
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  private matches(selector: string) {
    const attribute = selector.match(/^\[([\w-]+)\]$/);
    if (attribute) return this.hasAttribute(attribute[1]);
    const [tag, klass] = selector.split('.');
    return (!tag || this.tagName.toLowerCase() === tag) && this.className.split(' ').includes(klass);
  }
  closest(selector: string): Element | null {
    const any = selector.split(',').map(s => s.trim());
    for (let e: Element | null = this; e; e = e.parentElement) if (any.some(s => e!.matches(s))) return e;
    return null;
  }
  querySelectorAll(selector: string): Element[] {
    const selectors = selector.split(',').map(s => s.trim());
    return this.children.flatMap(child => [...(selectors.some(s => child.matches(s)) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}

const el = (tag: string, parent: Element | null, attributes: Record<string, string> = {}, className = '') =>
  new Element(tag.toUpperCase(), className, attributes, parent);

/** A fiber of the new tree; `was` is its version in the old one (null: mounted in this commit). */
function fiber(tag: number, options: {flags?: number; was?: Fiber | null; stateNode?: unknown; children?: Fiber[]} = {}): Fiber {
  const f: Fiber = {tag, flags: options.flags ?? 0, child: null, sibling: null, return: null, alternate: options.was ?? null, stateNode: options.stateNode ?? null};
  const children = options.children ?? [];
  children.forEach((c, i) => {
    c.return = f;
    c.sibling = children[i + 1] ?? null;
  });
  f.child = children[0] ?? null;
  return f;
}

const FUNCTION = 0;
const ROOT = 3;
const HOST = 5;
const MEMO = 15;
const PERFORMED = 1;

test('a component counts as rendered when it did work or was mounted; a subtree React did not go into does not count, whatever flags it kept', () => {
  const oldChild = fiber(FUNCTION, {flags: PERFORMED});
  const untouched = fiber(ROOT, {was: fiber(ROOT, {children: [oldChild]})});
  untouched.child = oldChild;
  assert.deepEqual(rendered(untouched), [], 'the same child as before: nothing below rendered');

  const worked = fiber(FUNCTION, {flags: PERFORMED, was: fiber(FUNCTION)});
  const bailed = fiber(MEMO, {flags: 0, was: fiber(MEMO)});
  const mountedLeaf = fiber(MEMO);
  const mounted = fiber(FUNCTION, {children: [mountedLeaf]});
  const parent = fiber(FUNCTION, {flags: PERFORMED, was: fiber(FUNCTION, {children: [fiber(FUNCTION)]}), children: [worked, bailed, mounted]});
  const root = fiber(ROOT, {was: fiber(ROOT, {children: [fiber(FUNCTION)]}), children: [parent]});
  assert.deepEqual(new Set(rendered(root)), new Set([parent, worked, mounted, mountedLeaf]));
});

test("a component's work is counted in the part of the page its first element is in: a label that shows time, not the card around it", () => {
  const card = el('article', null, {'data-card': 's1'}, 'card');
  const label = el('span', card, {'data-time': ''});
  const labelLeaf = fiber(FUNCTION, {children: [fiber(HOST, {stateNode: label})]});
  const cardComponent = fiber(FUNCTION, {children: [fiber(HOST, {stateNode: card, children: [labelLeaf]})]});
  assert.equal(nodeOf(labelLeaf, NODES), label);
  assert.equal(nodeOf(cardComponent, NODES), card);
  // One that renders nothing of its own counts where it sits.
  const empty = fiber(FUNCTION);
  const host = fiber(HOST, {stateNode: el('div', card), children: [empty]});
  assert.equal(host.child, empty);
  assert.equal(nodeOf(empty, NODES), card);
  assert.equal(nodeOf(fiber(FUNCTION, {children: [fiber(HOST, {stateNode: el('main', null)})]}), NODES), null, 'outside every part: the page');
});

/** Runs the probe as the browser gets it, in a context of its own with a stand-in DOM. */
function page() {
  type Mutation = {type?: string; attributeName?: string; target: unknown; addedNodes?: unknown[]};
  let observer: ((records: Mutation[]) => void) | undefined;
  let observing = false;
  const context: Record<string, unknown> = {
    performance,
    document: {body: {}, readyState: 'complete', addEventListener() {}},
    MutationObserver: class {
      constructor(callback: (records: Mutation[]) => void) {
        observer = callback;
      }
      observe() {observing = true;}
      disconnect() {observing = false;}
    },
  };
  vm.runInNewContext(probeScript(), context);
  const hook = context.__REACT_DEVTOOLS_GLOBAL_HOOK__ as {supportsFiber: boolean; onCommitFiberRoot(id: number, root: {current: Fiber}): void};
  const probed = context.__quotumBench as {reset(): void; pause(): void; read(): Reading; moneyChanged(id: string, amount: string): number | null; seriesChanged(key: string, last: string): number | null; forgetCards(): void};
  // What the page answers comes over as JSON, as Runtime.evaluate returns it.
  const bench = {reset: () => probed.reset(), pause: () => probed.pause(), read: (): Reading => JSON.parse(JSON.stringify(probed.read())), moneyChanged: (id: string, amount: string) => probed.moneyChanged(id, amount), seriesChanged: (key: string, last: string) => probed.seriesChanged(key, last), forget: () => probed.forgetCards()};
  return {hook, bench, observing: () => observing, mutate: (...targets: unknown[]) => observer!(targets.map(target => ({target}))),
    record: (...records: Mutation[]) => observer!(records),
    insert: (target: Element, ...addedNodes: unknown[]) => observer!([{type: 'childList', target, addedNodes}])};
}

test('the live probe distinguishes subscription funds, quota and wallets inside shared analytics',()=>{
  const p=page(),analytics=el('section',null,{},'analytics');
  for(const [name,widget] of [['history','quota'],['forecast','quota'],['budget-history','budget'],['budget-table','budget'],['subscription-funds','funds'],['activity','activity']] as const) {
    const panel=el('section',analytics,name.endsWith('table')||name==='forecast'?{}:{'data-time':'chart'},name);
    p.bench.reset();
    p.hook.onCommitFiberRoot(1,{current:fiber(FUNCTION,{children:[fiber(HOST,{stateNode:panel})]})});
    p.mutate(panel);
    const reading=p.bench.read();assert.equal(reading.renders[0].widget,widget);assert.equal(reading.mutations[0].widget,widget);
    assert.equal(reading.renders[0].region,'analytics');
  }
});

test('a finished measurement probe disconnects and reset resumes complete counting', () => {
  const {hook, bench, mutate, observing} = page();
  const card = el('article', null, {'data-card': 's1'}, 'card');
  const root = fiber(ROOT, {children: [fiber(FUNCTION, {children: [fiber(HOST, {stateNode: card})]})]});
  hook.onCommitFiberRoot(1, {current: root}); mutate(card);
  const before = bench.read();
  bench.pause(); assert.equal(observing(), false);
  hook.onCommitFiberRoot(1, {current: root}); mutate(card);
  assert.deepEqual(bench.read(), before, 'even a late callback cannot resume the finished phase');
  bench.reset(); assert.equal(observing(), true);
  assert.equal(bench.read().commits, 0);
  hook.onCommitFiberRoot(1, {current: root}); mutate(card);
  const resumed = bench.read();
  assert.equal(resumed.commits, 1); assert.equal(resumed.renders[0].count, 1); assert.equal(resumed.mutations[0].count, 1);
  assert.deepEqual(Object.keys(resumed.cardChanged), ['s1']);
});

test('the probe, sent as text, counts a part of the page once per commit however many components rendered in it', () => {
  const {hook, bench} = page();
  assert.equal(hook.supportsFiber, true, 'React injects into it');
  const card = el('article', null, {'data-card': 's1'}, 'card');
  const header = el('header', null, {}, 'topbar');
  const inCard = () => fiber(FUNCTION, {flags: PERFORMED, was: fiber(FUNCTION), children: [fiber(HOST, {stateNode: el('div', card)})]});
  const root = fiber(ROOT, {was: fiber(ROOT), children: [inCard(), inCard(), inCard(), fiber(FUNCTION, {children: [fiber(HOST, {stateNode: header})]})]});
  hook.onCommitFiberRoot(1, {current: root});
  hook.onCommitFiberRoot(1, {current: root});
  const reading = bench.read();
  assert.equal(reading.commits, 2);
  assert.deepEqual(reading.renders.map(r => [r.region, r.time, r.count]).sort(), [
    ['card:s1', false, 2],
    ['header', false, 2],
  ]);
  assert.ok(reading.instrumentMs >= 0);
  bench.reset();
  assert.deepEqual(bench.read().renders, []);
});

test('a graph measurement is seen only at its expected point value', () => {
  const {bench, mutate} = page();
  const attrs = {'data-series': 's1 weekly', 'data-last': '60000:80'};
  const path = el('path', el('section', null, {}, 'analytics'), attrs);
  mutate(path);
  assert.ok(bench.seriesChanged('s1 weekly', '60000:80') !== null);
  assert.equal(bench.seriesChanged('s1 weekly', '60000:79'), null);
  attrs['data-last'] = '60000:79';
  mutate(path);
  assert.ok(bench.seriesChanged('s1 weekly', '60000:79') !== null);
  bench.forget();
  assert.equal(bench.seriesChanged('s1 weekly', '60000:79'), null);
});

test('the first plotted point counts when React inserts a ready series or its whole SVG subtree', () => {
  const {bench, insert} = page();
  const region = el('section', null, {}, 'analytics');
  const svg = el('svg', region);
  const series = el('g', svg, {'data-series': 's1 weekly', 'data-last': '60000:79'});
  el('path', series);
  assert.equal(bench.seriesChanged('s1 weekly', '60000:79'), null, 'building detached geometry is not a DOM change');
  insert(svg, series);
  const first = bench.seriesChanged('s1 weekly', '60000:79');
  assert.ok(Number.isFinite(first), 'childList targets the parent, not the new series');
  assert.equal(bench.seriesChanged('s1 weekly', '60000:80'), null, 'an inserted point still needs the expected value');
  insert(svg, series);
  assert.equal(bench.seriesChanged('s1 weekly', '60000:79'), first, 'keep the first observed commit');
  bench.forget();
  insert(region, svg, {nodeType: 3});
  assert.ok(Number.isFinite(bench.seriesChanged('s1 weekly', '60000:79')), 'a new ancestor carries its plotted descendants');
});

test('the probe observes the exact changed financial value inside a timed card tray', () => {
  const {bench, record, hook} = page();
  const card = el('article', null, {'data-card': 'codex:fixture'}, 'card');
  const tray = el('footer', card, {'data-time': 'tray'}, 'card-foot');
  const trigger = el('button', el('span', tray, {}, 'funds-tray'), {}, 'tray-pill funds-mark');
  const attributes = {'data-money': '100000000'};
  const value = el('b', trigger, attributes, 'funds-value');
  assert.equal(bench.moneyChanged('codex:fixture', '100000000'), null, 'an existing value is not new evidence');
  // A store update renders the memoized SourceCard and its timed money child.
  const funds = fiber(FUNCTION, {flags: PERFORMED, was: fiber(FUNCTION), children: [fiber(HOST, {stateNode: trigger})]});
  const source = fiber(MEMO, {flags: PERFORMED, was: fiber(MEMO), children: [fiber(HOST, {stateNode: card, children: [funds]})]});
  hook.onCommitFiberRoot(1, {current: fiber(ROOT, {was: fiber(ROOT), children: [source]})});
  attributes['data-money'] = '99960000';
  record({type: 'attributes', attributeName: 'data-money', target: value});
  const first = bench.moneyChanged('codex:fixture', '99960000');
  assert.ok(typeof first === 'number' && Number.isFinite(first));
  assert.equal(bench.moneyChanged('codex:fixture', '100000000'), null, 'the old amount cannot satisfy the next measurement');
  assert.equal(bench.moneyChanged('codex:other', '99960000'), null, 'the evidence belongs to its card');
  record({type: 'characterData', target: {nodeType: 3, parentElement: value}});
  assert.equal(bench.moneyChanged('codex:fixture', '99960000'), first, 'keep the first observed commit');
  assert.deepEqual(bench.read().cardChanged, {}, 'generic clock exclusion remains intact');
  assert.deepEqual(bench.read().mutations.map(row => [row.region, row.time, row.kind]), [['card:codex:fixture', true, 'tray']]);
  const reading = bench.read(), measurement = {card: 'codex:fixture', ...reading, latencies: [0], from: first!, to: first! + 1};
  assert.deepEqual(measuredProblems(measurement), [], 'finite amount evidence still passes through the full card render budget');
  assert.ok(measuredProblems({...measurement, renders: reading.renders.filter(row => row.time)}).some(problem => problem.includes('the card rendered 0 times')),
    'a missing parent render cannot be hidden by the new latency evidence');
  bench.forget();
  assert.equal(bench.moneyChanged('codex:fixture', '99960000'), null);
  record({type: 'characterData', target: {nodeType: 3, parentElement: value}});
  assert.ok(bench.moneyChanged('codex:fixture', '99960000') !== null, 'text changes within the amount are observed too');
  bench.reset();
  assert.equal(bench.moneyChanged('codex:fixture', '99960000'), null);
  bench.pause();
  record({type: 'attributes', attributeName: 'data-money', target: value});
  assert.equal(bench.moneyChanged('codex:fixture', '99960000'), null, 'a late callback cannot revive a paused observer');
});

test('clock, status and other-card changes cannot stand in for the requested financial value', () => {
  const {bench, record, insert} = page();
  const card = el('article', null, {'data-card': 'codex:fixture'}, 'card');
  const tray = el('footer', card, {'data-time': 'tray'}, 'card-foot');
  const value = el('b', tray, {'data-money': '99960000'}, 'funds-value');
  const time = el('span', tray, {'data-time': 'ago'});
  record({type: 'characterData', target: {nodeType: 3, parentElement: time}},
    {type: 'attributes', attributeName: 'class', target: tray},
    {type: 'attributes', attributeName: 'class', target: value});
  insert(tray, el('span', tray, {'data-time': 'ago'}));
  const otherValue = el('b', el('article', null, {'data-card': 'codex:other'}), {'data-money': '99960000'});
  record({type: 'attributes', attributeName: 'data-money', target: otherValue});
  record({type: 'attributes', attributeName: 'data-money', target: el('b', null, {'data-money': '99960000'})});
  assert.equal(bench.moneyChanged('codex:fixture', '99960000'), null);
  assert.ok(bench.moneyChanged('codex:other', '99960000') !== null);
  assert.equal(bench.moneyChanged('codex:other', '99920000'), null);
});

test('inserted financial values are observed in their card without scanning unchanged siblings', () => {
  const {bench, insert} = page();
  const card = el('article', null, {'data-card': 'codex:fixture'});
  const tray = el('footer', card, {'data-time': 'tray'});
  const existing = el('b', tray, {'data-money': '100000000'});
  const mark = el('span', tray), value = el('b', mark, {'data-money': '99960000'});
  insert(mark, value);
  assert.ok(bench.moneyChanged('codex:fixture', '99960000') !== null);
  assert.equal(bench.moneyChanged('codex:fixture', '100000000'), null);
  bench.forget();
  insert(tray, mark);
  assert.ok(bench.moneyChanged('codex:fixture', '99960000') !== null, 'a ready subtree carries its value');
  assert.equal(bench.moneyChanged('codex:fixture', existing.getAttribute('data-money')!), null);
});

test('the probe counts DOM changes by part once per callback, and notes when a card first changed outside what shows time', () => {
  const {bench, mutate} = page();
  const card = el('article', null, {'data-card': 's1'}, 'card');
  const label = el('span', card, {'data-time': 'ago'});
  const text = {nodeType: 3, parentElement: label};
  mutate(text, label);
  assert.deepEqual(bench.read().cardChanged, {}, 'a label that shows time is the clock, not news');
  mutate(el('b', card), el('i', card));
  const reading = bench.read();
  assert.deepEqual(
    reading.mutations.map(m => [m.region, m.time, m.count]),
    [
      ['card:s1', true, 1],
      ['card:s1', false, 1],
    ],
  );
  assert.deepEqual(Object.keys(reading.cardChanged), ['s1']);
  assert.match(reading.mutations[0].node, /^span\[data-time=ago\]#\d+$/);
});
