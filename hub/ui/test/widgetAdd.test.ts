import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ApiError} from '../lib/http';
import {preparationFixture} from './preparationFixture';

type Node = {type: unknown; props: Record<string, any>};
const nodes = (value: any): Node[] =>
  Array.isArray(value)
    ? value.flatMap(nodes)
    : value && typeof value === 'object' && 'props' in value
      ? [value, ...nodes(value.props.children)]
      : [];
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function fixture() {
  const hooks = preparationFixture();
  const reads: {method: string; url: string; body: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void}[] = [];
  const modules: Record<string, any> = {};
  const board = {id: 'board', name: 'Team', role: 'owner', personal: false};
  const source = {id: 's', label: 'Account', provider: 'codex', origin: 'own', onBoard: false, visible: false, action: 'add'};
  const catalogue = {board, sources: [source], widgets: [], connectors: []};
  let view = {hidden: ['source:s']},
    lineup: string[] = [],
    revision = 0;
  const require = (name: string): any => {
    if (name === 'react')
      return {
        createContext: () => ({}),
        useContext: () => () => true,
        useState: hooks.useState,
        useRef: hooks.useRef,
        useEffect: hooks.useLayoutEffect,
      };
    if (name === 'react/jsx-runtime')
      return {
        jsx: (type: unknown, props: unknown) => ({type, props}),
        jsxs: (type: unknown, props: unknown) => ({type, props}),
        Fragment: 'fragment',
      };
    if (name.endsWith('/addition')) return modules.addition;
    if (name.endsWith('/i18n')) return {t: (key: string) => key};
    if (name.endsWith('/http'))
      return {
        ApiError,
        call: (method: string, url: string, body: unknown) =>
          new Promise((resolve, reject) => reads.push({method, url, body, resolve, reject})),
      };
    if (name.endsWith('/session')) return {boardTitle: () => 'Team'};
    if (name.endsWith('/board'))
      return {useBoardId: () => 'board', useServerView: () => view, useLineup: () => lineup, useConnectionsRevision: () => revision};
    if (name.endsWith('/view'))
      return {
        flushView: async () => {},
        cardId: (id: string) => 'source:' + id,
        isHidden: (v: typeof view, id: string) => v.hidden.includes(id),
      };
    if (name.endsWith('/providers')) return {PROVIDERS: {codex: {name: 'Codex'}}};
    if (name.endsWith('/widgetKind')) return {widgetKind: () => 'resource.subscription'};
    if (name === './logos') return {logoOf: () => ''};
    if (name === './Kit') return {Field: 'field', ErrorLine: 'error'};
    if (name === './Popover') return {PopoverHeading: 'heading'};
    if (name === './ConnectionForms' || name === 'lucide-react') return {};
    throw new Error(name);
  };
  for (const [name, file, extra] of [
    ['addition', '../lib/addition.ts', ''],
    ['widgets', '../components/WidgetAdd.tsx', '\nexports.AdditionRow = AdditionRow;'],
  ]) {
    const exports = {};
    runInNewContext(
      ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8') + extra, {
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
      }).outputText,
      {exports, require, crypto: {randomUUID: () => 'request'}, AbortController},
    );
    modules[name] = exports;
  }
  const render = (component: string, props: unknown) => {
    hooks.begin();
    const tree = modules.widgets[component](props);
    hooks.commit();
    return nodes(tree);
  };
  const row = (extra = {}) =>
    render('AdditionRow', {
      board,
      id: 'source:s',
      item: {kind: 'sources', sourceIds: ['s']},
      label: 'Account',
      kind: 'Subscription',
      icon: null,
      publish: true,
      hidden: false,
      visible: false,
      onStart: () => {},
      ...extra,
    });
  const menu = () => render('WidgetCatalogue', {board, local: false, trustedKeys: {}, onClose: () => {}});
  return {
    reads,
    row,
    menu,
    catalogue,
    change: () => {
      view = {hidden: []};
      lineup = ['s'];
      revision++;
    },
  };
}

const addButton = (tree: Node[]) => tree.find(node => node.type === 'button' && node.props.className === 'button')!;
const receipt = {id: 'r', boardId: 'board', item: {kind: 'sources', sourceIds: ['s']}, state: 'ready', createdAt: 1};
const complete = {...receipt, state: 'complete', current: {boardAccessible: true, sources: [{id: 's', placement: 'visible'}]}};

test('one informed row action adds a source, preserves focusable completion and cannot submit twice', async () => {
  const f = fixture();
  assert.ok(f.row().some(node => node.props.children === 'add.shareInline'));
  const button = addButton(f.row());
  button.props.onClick();
  button.props.onClick();
  await flush();
  assert.equal(f.reads.length, 1);
  f.reads[0].resolve(receipt);
  await flush();
  assert.equal(f.reads[1].url, '/api/additions/r/run');
  f.reads[1].resolve(complete);
  await flush();
  const tree = f.row({visible: true}),
    done = addButton(tree);
  assert.equal(done.props['aria-disabled'], true);
  assert.equal(done.props.disabled, undefined, 'the focused button remains in the keyboard sequence');
  assert.ok(tree.some(node => node.type === 'span' && node.props.className === 'sr-only' && node.props.children === 'add.addedLabel'));
  done.props.onClick();
  await flush();
  assert.equal(f.reads.length, 2);
  assert.equal(
    tree.some(node => node.type === 'h3'),
    false,
    'no confirmation or completion screen',
  );
});

test('lost run response is recovered in the row without another reservation or addition', async () => {
  const f = fixture();
  addButton(f.row()).props.onClick();
  await flush();
  f.reads[0].resolve(receipt);
  await flush();
  f.reads[1].reject(new Error('lost reply'));
  await flush();
  const check = f.row().find(node => node.type === 'button' && node.props.children === 'add.checkResult')!;
  check.props.onClick();
  check.props.onClick();
  await flush();
  assert.equal(f.reads.length, 3);
  assert.equal(f.reads[2].method, 'GET');
  f.reads[2].resolve(complete);
  await flush();
  assert.equal(addButton(f.row()).props['aria-disabled'], true);
});

test('the catalogue retains an attempted row through board events and search changes', async () => {
  const f = fixture();
  f.menu();
  f.reads[0].resolve(f.catalogue);
  await flush();
  const findRow = (tree: Node[]) => tree.find(node => typeof node.type === 'function' && (node.type as Function).name === 'AdditionRow');
  findRow(f.menu())!.props.onStart();
  f.change();
  f.menu();
  f.reads[1].resolve({...f.catalogue, sources: []});
  await flush();
  assert.ok(findRow(f.menu()), 'losing eligibility must not unmount the operation');
  const search = f.menu().find(node => node.type === 'field')!;
  search.props.onChange({target: {value: 'different'}});
  assert.equal(findRow(f.menu())?.props.hidden, true, 'search hides the row without losing its receipt');
  search.props.onChange({target: {value: ''}});
  assert.equal(findRow(f.menu())?.props.hidden, false);
});

test('a later hide offers an explicit addition without replay resurrecting it automatically', async () => {
  const f = fixture();
  addButton(f.row()).props.onClick();
  await flush();
  f.reads[0].resolve(receipt);
  await flush();
  f.reads[1].resolve(complete);
  await flush();
  f.row({visible: true});
  assert.equal(addButton(f.row({visible: false})).props['aria-disabled'], false);
  assert.equal(f.reads.length, 2);
});
