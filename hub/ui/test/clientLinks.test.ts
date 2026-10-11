import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {ApiError} from '../lib/http';
import type {ClientLink, LinkInput} from '../../server/domain/links';

type Node = {type: unknown; props: Record<string, unknown>};
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value ? [value as Node, ...nodes((value as Node).props.children)] : [];
const flush = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};
const link: ClientLink = {id: 'rule', clientId: 'opencode', deviceId: 'laptop', sourceId: 'openrouter:one', route: {class: 'api', provider: 'openrouter'}, from: 1_791_675_600_123, to: 1_791_679_200_456, createdAt: 1};

function fixture(operation: 'create' | 'correct' | 'change' | 'delete', input: LinkInput & {id?: string} = link) {
  const hooks = preparationFixture(), select = {}, field = {}, modal = {}, errorLine = {};
  const reads: {method: string; url: string; body: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void}[] = [];
  const paths: string[] = []; let request = 0, saved = 0;
  const inventory = {revision: '1', links: [], clients: ['codex', 'opencode'], devices: [{id: 'laptop', name: 'Laptop'}], sources: [{id: 'openrouter:one', provider: 'openrouter', name: 'Wallet'}, {id: 'codex:one', provider: 'codex', name: 'Subscription'}]};
  const context = {exports: {} as {LinkForm: (props: unknown) => Node; openClientLinks: (context?: {deviceId: string; clientId?: string; route?: LinkInput['route']}, sourceId?: string) => void}, URL, location: {origin: 'https://hub.invalid'}, crypto: {randomUUID: () => 'request-' + ++request}, require: (name: string) => {
    if (name === 'react') return {useState: hooks.useState, useRef: hooks.useRef};
    if (name === 'react/jsx-runtime') return {jsx: (type: unknown, props: Node['props']) => ({type, props}), jsxs: (type: unknown, props: Node['props']) => ({type, props}), Fragment: 'fragment'};
    if (name.endsWith('/clients')) return {clientName: (id: string) => id};
    if (name.endsWith('/providers')) return {catalogue: [{id: 'openrouter', name: 'OpenRouter'}]};
    if (name.endsWith('/i18n')) return {t: (key: string) => key};
    if (name.endsWith('/http')) return {ApiError, call: (method: string, url: string, body: Record<string, unknown>) => new Promise((resolve, reject) => reads.push({method, url, body, resolve, reject}))};
    if (name.endsWith('/format')) return {stamp: (at: number) => String(at)};
    if (name.endsWith('/router')) return {settingsHref: (path: string) => path + '?board=personal&from=10&to=20', navigate: (path: string) => paths.push(path)};
    if (name === './Kit') return {SelectField: select, Field: field, Modal: modal, ErrorLine: errorLine};
    return {};
  }};
  const source = readFileSync(new URL('../components/ClientLinks.tsx', import.meta.url), 'utf8') + '\nexports.LinkForm = LinkForm;';
  runInNewContext(ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, context);
  const render = () => {hooks.begin(); const tree = context.exports.LinkForm({edit: {operation, link: input, revision: '1'}, inventory, onClose: () => {}, onSaved: async () => {saved++;}, reload: async () => ({...inventory, revision: '4'})}); hooks.commit(); return nodes(tree);};
  const choose = (label: string, value: string) => {const control = render().find(node => (node.type === select || node.type === field) && node.props.label === label)!; assert.ok(control, label); (control.props.onChange as (event: unknown) => void)({target: {value}});};
  const submit = () => {const form = render().find(node => node.type === 'form')!; (form.props.onSubmit as (event: unknown) => void)({preventDefault() {}});};
  return {render, choose, submit, reads, paths, open: context.exports.openClientLinks, saved: () => saved, errors: () => render().filter(node => node.type === errorLine && node.props.error)};
}

test('device and source entry points open the visible section without writing and preserve the board range', () => {
  const f = fixture('create');
  f.open({deviceId: 'laptop', clientId: 'opencode', route: {class: 'api', provider: 'openrouter'}}, 'openrouter:one');
  const url = new URL(f.paths[0], 'https://hub.invalid');
  assert.equal(url.pathname, '/settings/links');
  assert.deepEqual(Object.fromEntries(url.searchParams), {board: 'personal', from: '10', to: '20', device: 'laptop', client: 'opencode', route: 'api', provider: 'openrouter', source: 'openrouter:one'});
  assert.equal(f.reads.length, 0);
});

test('an empty draft cannot assign an arbitrary first client or source', () => {
  const f = fixture('create', {...link, id: undefined, clientId: '', sourceId: '', route: null, to: null});
  f.submit(); assert.equal(f.reads.length, 0); assert.equal(f.errors().length, 1);
  f.choose('links.client', 'opencode'); f.submit(); assert.equal(f.reads.length, 0);
  f.choose('links.source', 'openrouter:one'); f.submit(); assert.equal(f.reads.length, 1);
});

test('editing with collapsed fields preserves exact original interval bounds and the route', async () => {
  const f = fixture('correct'); f.submit();
  const body = JSON.parse(JSON.stringify(f.reads[0].body));
  assert.equal(body.from, link.from); assert.equal(body.to, link.to); assert.deepEqual(body.route, link.route);
  assert.equal(f.reads[0].url, '/api/links/rule'); assert.equal(body.expectedRevision, '1');
  f.reads[0].resolve({}); await flush(); assert.equal(f.saved(), 1);
});

test('a lost edit reply retries the exact successful command and locks fields while it is in flight', async () => {
  const f = fixture('correct'); f.submit();
  assert.equal(f.render().find(node => node.type === 'fieldset')!.props.disabled, true);
  f.reads[0].reject(new Error('lost reply')); await flush(); f.submit();
  assert.equal(f.reads[1].body, f.reads[0].body);
  assert.equal(f.reads[1].body.requestId, 'request-1');
});

test('a conflict reload retains the draft and creates a command against the new revision', async () => {
  const f = fixture('correct'); f.choose('links.source', 'codex:one'); f.submit();
  f.reads[0].reject(new ApiError(409, 'links_changed')); await flush();
  const reload = f.render().find(node => node.type === 'button' && node.props.children === 'links.reload')!;
  (reload.props.onClick as () => void)(); await flush(); f.submit();
  assert.equal(f.reads[1].body.expectedRevision, '4'); assert.equal(f.reads[1].body.sourceId, 'codex:one');
  assert.notEqual(f.reads[1].body.requestId, f.reads[0].body.requestId);
});

test('a dated change sends only its new source and split date, while deletion sends neither', () => {
  const change = fixture('change'); change.choose('links.source', 'codex:one'); change.choose('links.changeAt', '2026-10-10T15:30'); change.submit();
  assert.equal(change.reads[0].url, '/api/links/rule/change');
  assert.deepEqual(Object.keys(change.reads[0].body).sort(), ['at', 'expectedRevision', 'newSourceId', 'requestId']);
  assert.equal(change.reads[0].body.at, new Date('2026-10-10T15:30').getTime());
  const remove = fixture('delete'); remove.submit();
  assert.equal(remove.reads[0].method, 'DELETE'); assert.equal(remove.reads[0].url, '/api/links/rule');
  assert.deepEqual(Object.keys(remove.reads[0].body).sort(), ['expectedRevision', 'requestId']);
});

test('changing a newly created link now never rounds the split before its start', () => {
  const from = Date.now(), f = fixture('change', {...link, from, to: null});
  f.choose('links.source', 'codex:one'); f.submit();
  assert.equal(f.reads.length, 1); assert.ok((f.reads[0].body.at as number) >= from);
});

test('a dated change of a past or future link starts within its original period', () => {
  const now = Date.now();
  for (const [from, to] of [[now - 120_000, now - 60_000], [now + 60_000, now + 120_000]]) {
    const f = fixture('change', {...link, from, to}); f.choose('links.source', 'codex:one'); f.submit();
    assert.equal(f.reads.length, 1); assert.equal(f.reads[0].body.at, from);
  }
});
