import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {ApiError} from '../lib/http';
import {widgetKind} from '../lib/widgetKind';
import {resolveLink, type ClientLink, type LinkInput} from '../../server/domain/links';

type Node = {type: unknown; props: Record<string, unknown>};
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value ? [value as Node, ...nodes((value as Node).props.children)] : [];
const flush = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};
const link: ClientLink = {id: 'rule', clientId: 'opencode', deviceId: 'laptop', sourceId: 'openrouter:one', route: {class: 'api', provider: 'openrouter'}, from: 1_791_675_600_123, to: 1_791_679_200_456, createdAt: 1};

function fixture(operation: 'create' | 'edit' | 'delete', input: LinkInput & {id?: string} = link, suggestions: LinkInput[] = []) {
  const hooks = preparationFixture(), select = {}, field = {}, modal = {}, errorLine = {};
  const reads: {method: string; url: string; body: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void}[] = [];
  const paths: string[] = []; let request = 0, saved = 0;
  const inventory = {revision: '1', links: [], clients: ['codex', 'opencode'], devices: [{id: 'laptop', name: 'Laptop'}], sources: [{id: 'openrouter:one', provider: 'openrouter', name: 'Wallet'}, {id: 'codex:one', provider: 'codex', name: 'Subscription'}]};
  const context = {exports: {} as {LinkForm: (props: unknown) => Node; contextualLink: (inventory: unknown, device: string | null, client: string, route: LinkInput['route']) => ClientLink | undefined; SessionFunding: (props: unknown) => Node; openClientLinks: (context?: {deviceId: string; clientId?: string; route?: LinkInput['route']}, sourceId?: string) => void}, URL, location: {origin: 'https://hub.invalid'}, Date, crypto: {randomUUID: () => 'request-' + ++request}, require: (name: string) => {
    if (name === 'react') return {useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useLayoutEffect};
    if (name === 'react/jsx-runtime') return {jsx: (type: unknown, props: Node['props']) => ({type, props}), jsxs: (type: unknown, props: Node['props']) => ({type, props}), Fragment: 'fragment'};
    if (name.endsWith('/clients')) return {clientName: (id: string) => id};
    if (name.endsWith('/links')) return {resolveLink};
    if (name.endsWith('/providers')) return {catalogue: [{id: 'openrouter', name: 'OpenRouter'}]};
    if (name.endsWith('/i18n')) return {t: (key: string) => key};
    if (name.endsWith('/board')) return {useDevicesRevision: () => 0};
    if (name.endsWith('/http')) return {ApiError, call: (method: string, url: string, body: Record<string, unknown>) => method === 'GET' ? Promise.resolve({suggestions}) : new Promise((resolve, reject) => reads.push({method, url, body, resolve, reject}))};
    if (name.endsWith('/widgetKind')) return {widgetKind};
    if (name.endsWith('/format')) return {stamp: (at: number) => String(at)};
    if (name.endsWith('/router')) return {settingsHref: (path: string) => path + '?board=personal&from=10&to=20', navigate: (path: string) => paths.push(path)};
    if (name === './Kit') return {SelectField: select, Field: field, Modal: modal, ErrorLine: errorLine};
    return {};
  }};
  const source = readFileSync(new URL('../components/ClientLinks.tsx', import.meta.url), 'utf8') + '\nexports.LinkForm = LinkForm;exports.contextualLink=contextualLink;exports.SessionFunding=SessionFunding;';
  runInNewContext(ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, context);
  const render = () => {hooks.begin(); const tree = context.exports.LinkForm({edit: {operation, link: input, revision: '1'}, inventory, onClose: () => {}, onSaved: async () => {saved++;}, reload: async () => ({...inventory, revision: '4'})}); hooks.commit(); return nodes(tree);};
  const choose = (label: string, value: string) => {const control = render().find(node => (node.type === select || node.type === field) && node.props.label === label)!; assert.ok(control, label); (control.props.onChange as (event: unknown) => void)({target: {value}});};
  const submit = () => {const form = render().find(node => node.type === 'form')!; (form.props.onSubmit as (event: unknown) => void)({preventDefault() {}});};
  return {funding: (props: unknown) => {hooks.begin(); return nodes(context.exports.SessionFunding(props));}, render, choose, submit, reads, paths, open: context.exports.openClientLinks, contextual: context.exports.contextualLink, inventory, saved: () => saved, errors: () => render().filter(node => node.type === errorLine && node.props.error)};
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
  const f = fixture('edit'); f.choose('links.source', 'codex:one'); f.submit();
  const body = JSON.parse(JSON.stringify(f.reads[0].body));
  assert.equal(body.from, link.from); assert.equal(body.to, link.to); assert.deepEqual(body.route, link.route);
  assert.equal(f.reads[0].url, '/api/links/rule'); assert.equal(body.expectedRevision, '1');
  f.reads[0].resolve({}); await flush(); assert.equal(f.saved(), 1);
});

test('a lost edit reply retries the exact successful command and locks fields while it is in flight', async () => {
  const f = fixture('edit'); f.choose('links.source', 'codex:one'); f.submit();
  assert.equal(f.render().find(node => node.type === 'fieldset')!.props.disabled, true);
  f.reads[0].reject(new Error('lost reply')); await flush(); f.submit();
  assert.equal(f.reads[1].body, f.reads[0].body);
  assert.equal(f.reads[1].body.requestId, 'request-1');
});

test('a conflict reload retains the draft and creates a command against the new revision', async () => {
  const f = fixture('edit'); f.choose('links.source', 'codex:one'); f.submit();
  f.reads[0].reject(new ApiError(409, 'links_changed')); await flush();
  const reload = f.render().find(node => node.type === 'button' && node.props.children === 'links.reload')!;
  (reload.props.onClick as () => void)(); await flush(); f.submit();
  assert.equal(f.reads[1].body.expectedRevision, '4'); assert.equal(f.reads[1].body.sourceId, 'codex:one');
  assert.notEqual(f.reads[1].body.requestId, f.reads[0].body.requestId);
});

test('the same editor applies all changed fields from a date while deletion sends no replacement', () => {
  const date=new Date(link.from+30*60_000),at=new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);
  const change = fixture('edit'); change.choose('links.source', 'codex:one'); change.choose('links.client', 'codex'); change.choose('links.apply', 'date'); change.choose('links.date', at); change.submit();
  assert.equal(change.reads[0].url, '/api/links/rule/change');
  assert.deepEqual(Object.keys(change.reads[0].body).sort(), ['at', 'clientId', 'deviceId', 'expectedRevision', 'newSourceId', 'requestId', 'route', 'to']);
  assert.equal(change.reads[0].body.at, new Date(at).getTime());
  assert.equal(change.reads[0].body.clientId, 'codex');assert.deepEqual(JSON.parse(JSON.stringify(change.reads[0].body.route)),link.route);assert.equal(change.reads[0].body.to,link.to);
  const remove = fixture('delete'); remove.submit();
  assert.equal(remove.reads[0].method, 'DELETE'); assert.equal(remove.reads[0].url, '/api/links/rule');
  assert.deepEqual(Object.keys(remove.reads[0].body).sort(), ['expectedRevision', 'requestId']);
});

test('an active link changes from saving by default and a lost reply keeps that exact instant', async t => {
  let now=link.from+1000;t.mock.method(Date,'now',()=>now);
  const f=fixture('edit');f.choose('links.source','codex:one');f.submit();
  assert.equal(f.reads[0].body.at,now);assert.equal(f.reads[0].url,'/api/links/rule/change');
  f.reads[0].reject(new Error('lost reply'));await flush();now+=30_000;f.submit();
  assert.equal(f.reads[1].body,f.reads[0].body);assert.equal(f.reads[1].body.at,link.from+1000);
});

test('one editor can explicitly correct the whole period without rounding its original milliseconds', t => {
  t.mock.method(Date,'now',()=>link.from+1000);
  const f=fixture('edit');f.choose('links.source','codex:one');f.choose('links.apply','original');f.submit();
  assert.equal(f.reads[0].url,'/api/links/rule');assert.equal(f.reads[0].body.from,link.from);assert.equal(f.reads[0].body.to,link.to);
});

test('editing a past or future link uses its own original period by default', () => {
  const now=Date.now();
  for(const [from,to] of [[now-120_000,now-60_000],[now+60_000,now+120_000]]){
    const f=fixture('edit',{...link,from,to});f.choose('links.source','codex:one');f.submit();
    assert.equal(f.reads[0].url,'/api/links/rule');assert.equal(f.reads[0].body.from,from);assert.equal(f.reads[0].body.to,to);
  }
});

test('the same editor can reschedule an entire future period beyond its former end', t=>{
  t.mock.method(Date,'now',()=>link.from-60_000);
  const local=(at:number)=>{const date=new Date(at);return new Date(at-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);};
  const f=fixture('edit'),from=local(link.to!+60_000),to=local(link.to!+3_600_000);
  f.choose('links.date',from);f.choose('links.to',to);f.submit();
  assert.equal(f.reads[0].url,'/api/links/rule');assert.equal(f.reads[0].body.from,new Date(from).getTime());assert.equal(f.reads[0].body.to,new Date(to).getTime());
});

test('an unchanged edit does not write or offer an enabled Save action',()=>{
  const f=fixture('edit');f.submit();assert.equal(f.reads.length,0);
  const save=f.render().find(node=>node.type==='button'&&node.props.children==='account.save');assert.equal(save?.props.disabled,true);
});

test('device and session context selects its existing winning link, including disconnected targets',t=>{
  t.mock.method(Date,'now',()=>link.from+1000);const f=fixture('edit');
  const generic={...link,id:'generic',deviceId:null,route:null},scoped={...link,id:'scoped',sourceId:'disconnected'};
  const inventory={...f.inventory,links:[generic,scoped]};
  assert.equal(f.contextual(inventory,'laptop','opencode',link.route)?.id,'scoped');
  assert.equal(f.contextual(inventory,'laptop','opencode',null)?.id,'generic');
  assert.equal(f.contextual(inventory,'another-device','opencode',link.route)?.id,'generic');
  assert.equal(f.contextual(inventory,'laptop','codex',null),undefined);
  assert.equal(f.contextual(inventory,null,'opencode',link.route),undefined,'a source-only entry still starts a deliberate new link');
});


test('choosing a recommended source fills its exact device, route and free period without writing before Save', async () => {
  const candidate = {...link, id: undefined, createdAt: undefined};
  const f = fixture('create', {...link, id: undefined, clientId: '', sourceId: '', deviceId: null, route: null, to: null}, [candidate]);
  f.render(); await flush(); f.choose('links.client', 'opencode'); f.choose('links.deviceScope', 'laptop');
  assert.ok(f.render().some(node => node.props.hint === 'links.recommendation'));
  f.choose('links.source', 'openrouter:one'); assert.equal(f.reads.length, 0);
  const date = f.render().find(node => node.props.label === 'links.date'); assert.ok(date, 'the suggested start is visible without expanding anything');
  f.submit(); assert.equal(f.reads.length, 1);
  const body = JSON.parse(JSON.stringify(f.reads[0].body));
  assert.equal(body.deviceId, 'laptop'); assert.deepEqual(body.route, link.route);
  assert.equal(body.from, link.from); assert.equal(body.to, link.to);
  assert.equal(body.suggestion, undefined, 'reviewed form values are an explicit manual command');
});

test('an ambiguous recommendation or another device leaves the manual source and period choices intact', async () => {
  const f = fixture('create', {...link, id: undefined, sourceId: '', deviceId: null, route: null, to: null}, [link, {...link, sourceId: 'codex:one'}]);
  f.render(); await flush(); assert.ok(!f.render().some(node => node.props.hint));
  f.choose('links.deviceScope', 'laptop'); assert.ok(!f.render().some(node => node.props.hint));
  f.choose('links.source', 'openrouter:one'); f.submit();
  assert.equal(f.reads[0].body.route, null); assert.equal(f.reads[0].body.to, null);
});

test('a disconnected winning link is explained with its saved name instead of suggesting account fallback', () => {
  const f = fixture('edit');
  const tree = f.funding({session: {source: null, device: {id: 'laptop'}}, evidence: {source: null, by: 'link', active: false, linkId: 'rule', accountSourceId: 'codex:one', disagreement: 'account'}, inventory: {...f.inventory, links: [{...link, active: false}], sources: [f.inventory.sources[1]], targets: [f.inventory.sources[0]]}, error: null});
  assert.ok(tree.some(node => node.props.children === 'links.inactiveExplanation'));
  assert.ok(tree.some(node => node.type === 'dd' && Array.isArray(node.props.children) && node.props.children[0] === 'Wallet'));
  assert.ok(!tree.some(node => node.props.children === 'links.disagreement'), 'a disconnected target has one actionable explanation');
});
