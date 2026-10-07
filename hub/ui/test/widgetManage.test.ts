import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as refresh from '../lib/refresh';
import {preparationFixture} from './preparationFixture';

type Node = {type: unknown; props: Record<string, any>};
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value ? [value as Node, ...nodes((value as Node).props.children)] : [];

test('widget management never refreshes on open or reopen; the explicit action requests only permitted sources', async () => {
  const hooks = preparationFixture(), requested: string[] = [];
  const state = {board: {id: 'board', refresh: {client: {}, owned: {by: 'hub'}, foreign: {by: 'hub'}}, sourceAccess: {owned: {canRefresh: true}, foreign: {canRefresh: false}}}};
  const context = {exports: {} as {WidgetManage: (props: unknown) => Node}, require: (name: string) => {
    if (name === 'react') return {useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useLayoutEffect};
    if (name === 'react/jsx-runtime') return {jsx: (type: unknown, props: Node['props']) => ({type, props}), jsxs: (type: unknown, props: Node['props']) => ({type, props})};
    if (name.endsWith('/i18n')) return {t: (key: string) => key, useLocale: () => {}};
    if (name.endsWith('/board')) return {page: {get: () => state, listen: () => () => {}}, useConnection: () => ({status: 'live'})};
    if (name.endsWith('/refresh')) return {...refresh, requestRefresh: async (_board: string, id: string) => {requested.push(id);}};
    if (name.endsWith('/clock')) return {hubNow: () => 1_000};
    if (name.endsWith('/providers') || name.endsWith('/format') || name.endsWith('/quota') || name.endsWith('/widgetKind') || name === 'lucide-react' || name === './logos' || name === './RefreshAction') return {};
    if (name === './Popover') return {Popover: 'popover'};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/WidgetManage.tsx', import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, context);
  const ids = ['client', 'owned', 'foreign'];
  const render = () => {hooks.begin(); const tree = context.exports.WidgetManage({board: 'board', ids, widgets: ids.map(id => ({id: 'source:' + id, title: id})), owner: false, locked: true, personal: true, onSettings: null, onLock: () => {}}); hooks.commit(); return tree;};
  render().props.onOpenChange(true);
  const opened = render();
  assert.deepEqual(requested, [], 'opening the menu is a read-only action');
  const action = nodes(opened).find(node => typeof node.props.send === 'function')!;
  action.props.send();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(requested.sort(), ['client', 'owned']);
  render().props.onOpenChange(false); render().props.onOpenChange(true); render();
  assert.deepEqual(requested.sort(), ['client', 'owned'], 'reopening keeps the attempt without starting another one');
});
