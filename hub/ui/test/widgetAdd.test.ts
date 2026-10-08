import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ApiError} from '../lib/http';
import {EMPTY_VIEW} from '../../server/domain/view';
import * as widgets from '../../server/domain/widgets';
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
  const instances = {AdditionRow: preparationFixture(), WidgetCatalogue: preparationFixture()};
  let hooks = instances.WidgetCatalogue;
  const document = {body: {}, activeElement: {} as any};
  const reads: {method: string; url: string; body: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void}[] = [];
  const modules: Record<string, any> = {};
  const board = {id: 'board', name: 'Team', role: 'owner', personal: false};
  const source = {id: 's', label: 'Account', provider: 'codex', origin: 'own', onBoard: false, visible: false, action: 'add'};
  const catalogue = {board, sources: [source], widgets: [], connectors: []};
  let view = {...EMPTY_VIEW, hidden: ['source:s']},
    lineup: string[] = [],
    revision = 0;
  const require = (name: string): any => {
    if (name === 'react')
      return {
        createContext: () => ({}),
        useContext: () => () => true,
        useState: (...args: Parameters<typeof hooks.useState>) => hooks.useState(...args),
        useRef: (...args: Parameters<typeof hooks.useRef>) => hooks.useRef(...args),
        useEffect: (...args: Parameters<typeof hooks.useLayoutEffect>) => hooks.useLayoutEffect(...args),
        useLayoutEffect: (...args: Parameters<typeof hooks.useLayoutEffect>) => hooks.useLayoutEffect(...args),
      };
    if (name === 'react/jsx-runtime')
      return {
        jsx: (type: unknown, props: unknown) => ({type, props}),
        jsxs: (type: unknown, props: unknown) => ({type, props}),
        Fragment: 'fragment',
      };
    if (name.endsWith('/domain/widgets')) return widgets;
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
      {exports, require, document, crypto: {randomUUID: () => 'request'}, AbortController},
    );
    modules[name] = exports;
  }
  const render = (component: keyof typeof instances, props: unknown, root?: unknown) => {
    hooks = instances[component];
    hooks.begin();
    const tree = modules.widgets[component](props);
    if (root) tree.props.ref.current = root;
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
  const menu = (root?: unknown) => render('WidgetCatalogue', {board, local: false, trustedKeys: {}, onClose: () => {}}, root);
  return {
    reads,
    row,
    menu,
    catalogue, document,
    setView: (next: typeof view, sources: string[] = []) => {view = next; lineup = sources; revision++;},
    change: () => {
      view = {...view, hidden: []};
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
  const others = Array.from({length: 10}, (_, i) => ({...f.catalogue.sources[0], id: 'other-' + i}));
  f.menu();
  f.reads[0].resolve({...f.catalogue, sources: [...f.catalogue.sources, ...others]});
  await flush();
  const findRow = (tree: Node[]) => tree.find(node => typeof node.type === 'function' && (node.type as Function).name === 'AdditionRow');
  findRow(f.menu())!.props.onStart();
  f.change();
  f.menu();
  f.reads[1].resolve({...f.catalogue, sources: others});
  await flush();
  assert.ok(findRow(f.menu()), 'losing eligibility must not unmount the operation');
  const search = f.menu().find(node => node.type === 'field')!;
  search.props.onChange({target: {value: 'different'}});
  assert.equal(findRow(f.menu())?.props.hidden, true, 'search hides the row without losing its receipt');
  search.props.onChange({target: {value: ''}});
  assert.equal(findRow(f.menu())?.props.hidden, false);
});

test('catalogue search starts above ten entries, survives filtering, and cannot hide a smaller refreshed list', async () => {
  for (const count of [0, 10, 11]) {
    const f = fixture();
    const sources = Array.from({length: count}, (_, i) => ({...f.catalogue.sources[0], id: 'source-' + i}));
    f.menu();f.reads[0].resolve({...f.catalogue, sources});await flush();
    const search = f.menu().find(node => node.type === 'field');
    assert.equal(!!search, count > 10);
    if (!search) continue;
    search.props.onChange({target: {value: 'no matching widget'}});
    assert.ok(f.menu().some(node => node.type === 'field'), 'filtering does not remove its own input');
    f.change();f.menu();f.reads[1].resolve({...f.catalogue, sources: sources.slice(0, 10)});await flush();
    const smaller = f.menu();
    assert.equal(smaller.some(node => node.type === 'field'), false);
    const rows = smaller.filter(node => node.props.item?.kind === 'sources');
    assert.equal(rows.length, 10);assert.ok(rows.every(node => !node.props.hidden), 'a hidden search cannot keep filtering');
  }
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


test('empty-board analytics use canonical placement and offer re-add after an external hide', async () => {
  const f = fixture();
  f.menu();
  f.reads[0].resolve({...f.catalogue, sources: [], widgets: [{id: 'budget-table'}]}); await flush();
  const props = () => f.menu().find(node => node.props.id === 'budget-table')!.props;
  addButton(f.row(props())).props.onClick(); await flush();
  const operation = {...receipt, item: {kind: 'widget', widgetId: 'budget-table'}};
  f.reads[1].resolve(operation); await flush();
  f.reads[2].resolve({...operation, state: 'complete', current: {boardAccessible: true, widgets: [{id: 'budget-table', placement: 'visible'}]}}); await flush();
  const placed = {...EMPTY_VIEW, shown: ['budget-table']};
  f.setView(placed);
  assert.equal(props().visible, true, 'explicit analytics placement needs no sources');
  assert.equal(addButton(f.row(props())).props['aria-disabled'], true);
  f.setView(placed, ['s']); assert.equal(props().visible, true);
  f.setView(placed); assert.equal(props().visible, true, 'removing the last source preserves placement');
  f.setView({...placed, hidden: ['budget-table']});
  const retry = addButton(f.row(props()));
  assert.equal(retry.props['aria-disabled'], false);
  const before = f.reads.length;
  retry.props.onClick(); await flush();
  assert.equal(f.reads.length, before + 1, 'an explicit re-add creates a new operation');
});

test('catalogue refresh preserves row focus and gives a removed search a local successor', async () => {
  const f = fixture(), document = f.document;
  const button = {isConnected: true, focus: () => {document.activeElement = button;}};
  const input = {isConnected: true, focus: () => {document.activeElement = input;}};
  let searchable = false;
  const root = {querySelector: (selector: string) => selector === 'input[type="search"]' ? searchable ? input : null : button};
  const sources = Array.from({length: 11}, (_, index) => ({...f.catalogue.sources[0], id: 's' + index}));
  f.menu(root); f.reads[0].resolve({...f.catalogue, sources: sources.slice(0, 10)}); await flush();
  const menu = f.menu(root);
  menu[0].props.onFocusCapture({target: button});
  assert.equal(document.activeElement, button);
  f.change(); f.menu(root); f.reads[1].resolve({...f.catalogue, sources}); await flush();
  searchable = true;
  const larger = f.menu(root);
  assert.equal(document.activeElement, button, 'new search cannot steal focus from a row');
  assert.ok(larger.filter(node => node.type === 'field').every(node => !node.props.autoFocus));
  input.focus(); larger[0].props.onFocusCapture({target: input});
  f.change(); f.menu(root); f.reads[2].resolve({...f.catalogue, sources: sources.slice(0, 10)}); await flush();
  searchable = false; input.isConnected = false; document.activeElement = document.body;
  f.menu(root);
  assert.equal(document.activeElement, button, 'removing the focused search keeps keyboard navigation in the list');
});
