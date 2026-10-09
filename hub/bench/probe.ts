/**
 * What the benchmark puts in the page before its scripts run: a stand-in for React
 * DevTools' hook, which React calls on every commit, and a MutationObserver. Between them
 * they count which parts of the board React rendered and which the DOM changed in.
 *
 * The functions here run in the page, turned to text: each uses nothing from outside it
 * but its arguments. `rendered` and `nodeOf` are tested on stand-in fibers.
 */

/** The parts of a React fiber the probe reads. */
export type Fiber = {
  tag: number;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate: Fiber | null;
  stateNode: unknown;
};

/** What the probe relates work to: a DOM element that can say where it is. */
export type Place = {closest(selector: string): Place | null};

/**
 * The parts of the page work is counted by, the nearest first: a label that shows time, a
 * card, the header, the list of agents, the analytics. Anything else is the page.
 */
export const NODES = '[data-time], [data-card], header.topbar, section.agents-panel, section.forecast, section.budget-table, section.analytics';

/**
 * The components that rendered in a commit, found as React DevTools finds them: walking
 * the new tree beside the old one, and not going down where a subtree was not rendered
 * (its child is the same object as before: flags there are left from an earlier render).
 * A component rendered when it was mounted or has React's `PerformedWork` flag (1), which
 * React sets on components only.
 */
export function rendered(current: Fiber): Fiber[] {
  // Function, class, forwardRef, memo and simple memo components.
  const composite = (fiber: Fiber) => fiber.tag === 0 || fiber.tag === 1 || fiber.tag === 11 || fiber.tag === 14 || fiber.tag === 15;
  const found: Fiber[] = [];
  const stack: [Fiber, Fiber | null][] = [[current, current.alternate]];
  while (stack.length) {
    const [next, prev] = stack.pop()!;
    if (composite(next) && (prev === null || (next.flags & 1) === 1)) found.push(next);
    if (prev !== null && next.child === prev.child) continue;
    for (let child = next.child; child; child = child.sibling) stack.push([child, prev === null ? null : child.alternate]);
  }
  return found;
}

/**
 * The part of the page a component's work shows in: from the DOM of its first host
 * descendant, as DevTools finds a component's nodes (else its nearest host ancestor, for
 * one that renders nothing of its own), the nearest element matching `selector`, itself
 * included; null when none does.
 */
export function nodeOf(fiber: Fiber, selector: string): Place | null {
  const element = (f: Fiber) =>
    (f.tag === 5 || f.tag === 26 || f.tag === 27) && f.stateNode && typeof (f.stateNode as Place).closest === 'function' ? (f.stateNode as Place) : null;
  const first = (from: Fiber | null): Place | null => {
    for (let f = from; f; f = f.sibling) {
      const found = element(f) ?? first(f.child);
      if (found) return found;
    }
    return null;
  };
  let host = first(fiber.child);
  for (let f = fiber.return; !host && f; f = f.return) host = element(f);
  return host ? host.closest(selector) : null;
}

/**
 * One part of the page and how many times it rendered or changed. `time`: it shows time,
 * and `kind` is what (its `data-time`: a label, a cell of the table, the chart).
 */
export type Counted = {node: string; time: boolean; kind: string | null; region: string; count: number; widget?:'quota'|'budget'|'funds'|'activity'};

/** What the probe counted since its last `reset`. */
export type Reading = {
  /** Time the probe itself took, in milliseconds. */
  instrumentMs: number;
  commits: number;
  /** Once per commit for every part of the page React rendered anything in. */
  renders: Counted[];
  /** Once per MutationObserver callback for every part of the page the DOM changed in. */
  mutations: Counted[];
  /** When the DOM of each card first changed outside what shows time, as `Date.now()` in the page. */
  cardChanged: Record<string, number>;
};

/**
 * Installs the probe as `window.__quotumBench`: `reset()`, `pause()`, `read()`, and for one card at a
 * time `forgetCards()`, `cardChanged(id)` and `moneyChanged(id, amount)`. Runs in the page, before React loads, with
 * `rendered` and `nodeOf` passed in. Pausing disconnects measurement instrumentation;
 * resetting begins a fresh, fully observed phase.
 */
export function probe(tools: {rendered: typeof rendered; nodeOf: typeof nodeOf}, selector: string) {
  type Element = {
    closest(selector: string): Element | null;
    hasAttribute(name: string): boolean;
    getAttribute(name: string): string | null;
    querySelectorAll(selector: string): Iterable<Element>;
    tagName: string;
    className: unknown;
  };
  const page = globalThis as unknown as {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: object;
    __quotumBench: {reset(): void; pause(): void; read(): Reading; forgetCards(): void; cardChanged(id: string): number | null; moneyChanged(id: string, amount: string): number | null; seriesChanged(key: string, last: string): number | null};
    MutationObserver: new (callback: (records: {type: string; attributeName?: string | null; target: {nodeType: number; parentElement: Element | null}; addedNodes?: Iterable<{nodeType: number}>}[]) => void) => {
      observe(target: unknown, options: object): void;
      disconnect(): void;
    };
    document: {body: unknown; readyState: string; addEventListener(type: string, listener: () => void): void};
    performance: {now(): number; timeOrigin: number};
  };
  const clock = page.performance;
  let recording = true;
  let instrumentMs = 0;
  let commits = 0;
  let renders = new Map<Element | null, number>();
  let mutations = new Map<Element | null, number>();
  let cardChanged: Record<string, number> = {};
  let moneyChanged: Record<string, number> = {};
  let seriesChanged: Record<string, number> = {};
  const names = new WeakMap<Element, number>();
  let named = 0;

  const bump = (counts: Map<Element | null, number>, nodes: Set<Element | null>) => {
    for (const node of nodes) counts.set(node, (counts.get(node) ?? 0) + 1);
  };
  const regionOf = (node: Element | null) => {
    if (!node) return 'page';
    const card = node.closest('[data-card]');
    if (card) return `card:${card.getAttribute('data-card')}`;
    if (node.closest('header.topbar')) return 'header';
    if (node.closest('section.agents-panel')) return 'agents';
    if (node.closest('section.analytics')) return 'analytics';
    return 'page';
  };
  const describe = (node: Element | null) => {
    if (!node) return 'page';
    if (!names.has(node)) names.set(node, ++named);
    const classes = typeof node.className === 'string' && node.className ? `.${node.className.trim().split(/\s+/).join('.')}` : '';
    const time = node.getAttribute('data-time');
    return `${node.tagName.toLowerCase()}${classes}${time ? `[data-time=${time}]` : ''}#${names.get(node)}`;
  };
  const listed = (counts: Map<Element | null, number>): Counted[] =>
    [...counts].map(([node, count]) => ({
      node: describe(node),
      time: !!node?.hasAttribute('data-time'),
      kind: node?.getAttribute('data-time') ?? null,
      region: regionOf(node),
      ...(node?.closest('section.history, section.forecast')?{widget:'quota' as const}:node?.closest('section.budget-history, section.budget-table')?{widget:'budget' as const}:node?.closest('section.subscription-funds')?{widget:'funds' as const}:node?.closest('section.activity')?{widget:'activity' as const}:{}),
      count,
    }));

  page.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot(_renderer: number, root: {current: Fiber}) {
      if (!recording) return;
      const began = clock.now();
      try {
        commits++;
        bump(renders, new Set(tools.rendered(root.current).map(fiber => tools.nodeOf(fiber, selector) as Element | null)));
      } finally {
        instrumentMs += clock.now() - began;
      }
    },
  };

  const observer = new page.MutationObserver(records => {
    if (!recording) return;
    const began = clock.now();
    const nodes = new Set<Element | null>();
    const at = clock.timeOrigin + clock.now();
    const changedSeries = (series: Element | null | undefined) => {
      if (!series) return;
      const key = `${series.getAttribute('data-series')}\n${series.getAttribute('data-last')}`;
      seriesChanged[key] ??= at;
    };
    const changedMoney = (value: Element | null | undefined) => {
      const amount = value?.getAttribute('data-money'), card = value?.closest('[data-card]')?.getAttribute('data-card');
      if (card && amount !== null && amount !== undefined) moneyChanged[`${card}\n${amount}`] ??= at;
    };
    for (const record of records) {
      const element = record.target.nodeType === 1 ? (record.target as unknown as Element) : record.target.parentElement;
      nodes.add(element ? element.closest(selector) : null);
      changedSeries(element?.closest('[data-series]'));
      // A financial value can live inside a tray that also shows time. Only its
      // value mutations prove a balance update; a clock or status change cannot.
      if (record.type === 'characterData' || record.type === 'childList' || record.attributeName === 'data-money') changedMoney(element?.closest('[data-money]'));
      // Mounted subtrees arrive with their attributes already set. Their mutation
      // targets the parent, so looking only above it misses the new values.
      for (const node of record.addedNodes ?? []) if (node.nodeType === 1) {
        const added = node as unknown as Element;
        changedSeries(added.closest('[data-series]'));
        if (added.hasAttribute('data-money')) changedMoney(added);
        for (const value of added.querySelectorAll('[data-series], [data-money]')) {
          if (value.hasAttribute('data-series')) changedSeries(value);
          if (value.hasAttribute('data-money')) changedMoney(value);
        }
      }
    }
    bump(mutations, nodes);
    for (const node of nodes) {
      if (!node || node.hasAttribute('data-time')) continue;
      const card = node.closest('[data-card]')?.getAttribute('data-card');
      if (card && !(card in cardChanged)) cardChanged[card] = at;
    }
    instrumentMs += clock.now() - began;
  });
  const observe = () => {if (recording && page.document.body) observer.observe(page.document.body, {subtree: true, childList: true, attributes: true, characterData: true});};
  if (page.document.body) observe();
  else page.document.addEventListener('DOMContentLoaded', observe);

  page.__quotumBench = {
    reset() {
      recording = true;
      observe();
      instrumentMs = 0;
      commits = 0;
      renders = new Map();
      mutations = new Map();
      cardChanged = {};
      moneyChanged = {};
      seriesChanged = {};
    },
    pause() {recording = false; observer.disconnect();},
    read: () => ({instrumentMs, commits, renders: listed(renders), mutations: listed(mutations), cardChanged}),
    forgetCards() {
      cardChanged = {};
      moneyChanged = {};
      seriesChanged = {};
    },
    cardChanged: id => cardChanged[id] ?? null,
    moneyChanged: (id, amount) => moneyChanged[`${id}\n${amount}`] ?? null,
    seriesChanged: (key, last) => seriesChanged[`${key}\n${last}`] ?? null,
  };
}

/**
 * The probe as a script for `Page.addScriptToEvaluateOnNewDocument`. The functions are
 * sent as their source; `__name` stands in for the helper a transpiler may leave in it.
 */
export const probeScript = () => `(() => { const __name = f => f; (${probe})({rendered: ${rendered}, nodeOf: ${nodeOf}}, ${JSON.stringify(NODES)}); })();`;
