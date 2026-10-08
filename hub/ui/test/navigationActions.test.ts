import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as router from '../lib/router';

type Node = {type: unknown; props: Record<string, any>};
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes)
  : value && typeof value === 'object' && 'props' in value ? [value as Node, ...nodes((value as Node).props.children)] : [];
const jsx = {jsx: (type: unknown, props: Node['props']) => ({type, props}), jsxs: (type: unknown, props: Node['props']) => ({type, props})};

function component(file: string, modules: Record<string, unknown>, globals = {}) {
  const exports: Record<string, (props: any) => Node> = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
  }).outputText, {exports, ...globals, require: (name: string) => name === 'react/jsx-runtime' ? jsx : modules[name] ?? {}});
  return exports;
}

test('the header returns from settings to its selected board and range through the router', () => {
  const previous = Object.getOwnPropertyDescriptors(globalThis), events = new EventTarget();
  let address = new URL('http://fixture.example/settings/profile?board=B&from=1800000000000&to=1800003600000');
  let state: unknown = null;
  const history = {get state() {return state;}, pushState: (next: unknown, _title: string, href: string) => {state = next; address = new URL(href, address);}, replaceState: (next: unknown, _title: string, href: string) => {state = next; address = new URL(href, address);}};
  Object.defineProperties(globalThis, {
    location: {configurable: true, get: () => address}, history: {configurable: true, value: history},
    window: {configurable: true, value: events}, PopStateEvent: {configurable: true, value: Event},
  });
  const stop = router.onLocation(() => {});
  try {
    const Brand = 'brand';
    const {Header} = component('../components/Header.tsx', {
      react: {useState: (value: unknown) => [value, () => {}]},
      '../lib/router': {...router, useLocation: () => address.pathname + address.search},
      '../lib/session': {boardTitle: (board: {name: string}) => board.name},
      '../i18n': {t: (key: string) => key}, './Kit': {Brand},
    });
    const board = {id: 'B', name: 'Board B', personal: false, role: 'owner'};
    const tree = Header({board, boards: [board], user: {name: 'Reader', email: 'reader@example.invalid'}, local: false});
    let link = tree.props.children.props.children[0] as Node;
    while (typeof link.type === 'function') link = link.type(link.props);
    assert.equal(link.type, Brand);
    assert.equal(link.props.href, '/?board=B&from=1800000000000&to=1800003600000');
    let prevented = 0;
    link.props.onClick({button: 0, ctrlKey: true, preventDefault: () => prevented++});
    assert.equal(prevented, 0, 'modified clicks retain normal link behavior');
    link.props.onClick({button: 0, preventDefault: () => prevented++});
    assert.equal(prevented, 1);
    assert.equal(address.pathname + address.search, link.props.href);
  } finally {
    stop();
    for (const key of ['location', 'history', 'window', 'PopStateEvent']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a completed addition opens its board from settings before focusing the visible widget', () => {
  for (const path of ['/settings/profile', '/boards/board/settings/general', '/']) {
    const navigations: string[] = [], frames: (() => void)[] = [];
    let route = path, closed = 0, focused = 0;
    const element = {tabIndex: 0, scrollIntoView: () => {}, focus: () => focused++};
    const {Completion} = component('../components/ConnectionForms.tsx', {
      '../lib/router': {usePath: () => route, boardHref: (id: string) => '/?board=' + id, navigate: (href: string) => {navigations.push(href); route = '/';}},
      '../lib/board': {useBoardId: () => 'board', useLineup: () => ['source'], useServerView: () => ({hidden: []})},
      '../lib/view': {cardId: (id: string) => 'source:' + id, isHidden: () => false},
      '../lib/session': {boardTitle: () => 'Team'}, '../i18n': {t: (key: string) => key},
    }, {
      requestAnimationFrame: (run: () => void) => {frames.push(run);},
      document: {querySelector: (selector: string) => {
        assert.equal(route, '/', 'the widget exists only after dashboard navigation');
        assert.equal(selector, '[data-widget="source:source"]');
        return element;
      }},
    });
    const tree = Completion({board: {id: 'board', name: 'Team'}, personal: false, onClose: () => closed++, operation: {
      id: 'receipt', boardId: 'board', item: {kind: 'connection', provider: 'openrouter'}, state: 'complete',
      result: {sourceIds: ['source']}, current: {boardAccessible: true, sources: [{id: 'source', placement: 'visible'}]},
    }});
    nodes(tree).find(node => node.type === 'button' && node.props.className === 'button primary')!.props.onClick();
    assert.equal(closed, 1);
    assert.deepEqual(navigations, path === '/' ? [] : ['/?board=board']);
    assert.equal(focused, 0, 'focus waits for the dashboard to mount');
    frames.forEach(run => run());
    assert.equal(focused, 1);
  }
});
