import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {ApiError} from '../lib/http';
import {SessionReader} from '../lib/sessionReader';
import type {Session} from '../lib/session';
import * as jsxRuntime from 'react/jsx-runtime';

type Node={type:unknown;props:Record<string,unknown>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};

function fixture(initialOwner='u'){
  const hooks=preparationFixture(),errorLine={},field={},reads:{resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[];
  const calls:{method:string;url:string;body:unknown}[]=[];
  const cleanups=new Set<()=>void>(),modal={};let userId=initialOwner;
  let notify:(event:unknown)=>void=()=>{};
  const context={crypto,window:{addEventListener:()=>{},removeEventListener:()=>{}},exports:{} as {ConnectedAccounts:(props:unknown)=>Node;ConnectSource:(props:unknown)=>Node},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>hooks.useLayoutEffect(()=>{const cleanup=effect();if(!cleanup)return;cleanups.add(cleanup);return()=>{cleanups.delete(cleanup);cleanup();};},deps)};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'fragment'};
    if(name.endsWith('/http'))return {ApiError,call:(method:string,url:string,body:unknown)=>{calls.push({method,url,body});return new Promise((resolve,reject)=>reads.push({resolve,reject}));}};
    if(name.endsWith('/board'))return {useApp:()=>null,useTitles:()=>({}),page:{listen:(listener:typeof notify)=>{notify=listener;return()=>{};}}};
    if(name.endsWith('/providers'))return {PROVIDERS:{openrouter:{name:'OpenRouter'},deepseek:{name:'DeepSeek'}}};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    if(name.endsWith('/format'))return {stamp:()=>''};
    if(name==='./Kit')return {Field:field,ErrorLine:errorLine,Modal:modal};
    if(name==='./Popover')return {};
    if(name==='./logos')return {logoOf:()=>''};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/Connections.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{hooks.begin();const tree=context.exports.ConnectedAccounts({userId,trustedKeys:{available:true},onReplace:()=>{}});hooks.commit();return nodes(tree);};
  const form=()=>{hooks.begin();const node=context.exports.ConnectSource({provider:'deepseek',userId,local:false,trustedKeys:{available:true},onClose:()=>{}}),tree=(node.type as (props:unknown)=>Node)(node.props);hooks.commit();return nodes(tree);};
  const reply={credentials:[{id:'c',provider:'openrouter',sourceId:null,hint:'abcd',lastError:null,expiresAt:null}]};
  return {reads,calls,reply,render,form,field,event:()=>notify({type:'hub',event:{type:'sourceAccess'}}),errors:()=>render().filter(n=>n.type===errorLine),rows:()=>render().filter(n=>typeof n.type==='function'&&n.props.name==='OpenRouter'),owner:(next:string)=>{userId=next;},unmount:()=>{for(const cleanup of cleanups)cleanup();cleanups.clear();},removing:()=>render().some(n=>n.type===modal)};
}

test('the connection form keeps paging accounts and their attestations in the current page',async()=>{
  const f=fixture(),first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
  const select=()=>f.form().find(n=>n.type==='select')!;
  const button=(key:string)=>f.form().find(n=>n.type==='button'&&n.props.children===key)!;
  const change=(node:Node,value:string|boolean)=>(node.props.onChange as (event:unknown)=>void)({target:{value,checked:value}});
  f.form();f.reads[0].resolve({accounts:[{id:first,name:'Personal',connected:true}],next:first});await flush();
  const oldSelector=select();(button('sources.moreAccounts').props.onClick as ()=>void)();f.form();
  assert.equal(select().props.disabled,true,'old page must not remain interactive while the new page loads');
  assert.equal(button('sources.moreAccounts').props.disabled,true);assert.equal(button('sources.backAccounts').props.disabled,true);
  // An obsolete selection callback must not make a hidden account submittable either.
  change(oldSelector,first);change(f.form().find(n=>n.type===f.field&&n.props.type==='password')!,'synthetic-key');
  const checks=()=>f.form().filter(n=>n.type==='input'&&n.props.type==='checkbox');
  change(checks()[0],true);change(checks()[1],true);
  await (f.form().find(n=>n.type==='form')!.props.onSubmit as (event:unknown)=>Promise<void>)({preventDefault:()=>{}});
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0,'a hidden account cannot be submitted');
  f.reads[1].resolve({accounts:[{id:second,name:'Work',connected:false}],next:null});await flush();
  assert.equal(select().props.value,'new');assert.equal(checks().length,1,'old same-account attestation is withdrawn');
  change(select(),second);change(checks()[0],true);
  const saving=(f.form().find(n=>n.type==='form')!.props.onSubmit as (event:unknown)=>Promise<void>)({preventDefault:()=>{}});
  const post=f.calls.find(c=>c.method==='POST');assert.ok(post);
  assert.deepEqual(JSON.parse(JSON.stringify((post.body as {account:unknown}).account)),{kind:'existing',id:second});
  f.reads[2].resolve({});await saving;
  f.unmount();
});

test('a recovered owner credential list clears the earlier network error',async()=>{
  const f=fixture();f.render();f.reads[0].reject(new Error('offline'));await flush();
  assert.equal(f.errors().length,1);f.event();f.reads[1].resolve(f.reply);await flush();
  assert.equal(f.rows().length,1);assert.equal(f.errors().length,0);
});

test('an obsolete failed credential read cannot restore an error after the latest reply',async()=>{
  const f=fixture();f.render();f.event();f.reads[1].resolve(f.reply);await flush();
  f.reads[0].reject(new Error('obsolete offline'));await flush();
  assert.equal(f.rows().length,1);assert.equal(f.errors().length,0);
});

for(const local of [false,true])test(`a changed ${local?'local':'remote'} session owner discards open private connection actions`,async()=>{
  const session=(id:string):Session=>({user:{id,name:id,email:id+'@example.invalid'},local,boards:[],signup:{first:false,open:false}});
  let current=session('alice'),next=current;
  const reader=new SessionReader(async()=>next,value=>{current=value;},()=>{});
  const Dashboard=()=>null;
  const context={exports:{} as {App:()=>{type:unknown;key:string|null;props:{user:{id:string}}}},Dashboard,useLocale:()=>{},usePath:()=> '/',useSession:()=>({session:current,failed:false,refresh:()=>reader.refresh(),setSession:(value:Session)=>reader.accept(value)}),require:()=>jsxRuntime};
  const source=readFileSync(new URL('../main.tsx',import.meta.url),'utf8'),from=source.indexOf('function App()');
  runInNewContext(ts.transpileModule(source.slice(from,source.indexOf('\ncreateRoot(',from))+'\nexports.App=App;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  let key:string|null|undefined,scope:{open:boolean;accounts:ReturnType<typeof fixture>};
  // React retains a child's state only while its type and key retain their identity.
  const render=()=>{const node=context.exports.App();assert.equal(node.type,Dashboard);if(!scope||node.key!==key){scope?.accounts.unmount();scope={open:false,accounts:fixture(node.props.user.id)};key=node.key;}scope.accounts.owner(node.props.user.id);if(scope.open)scope.accounts.render();return scope;};
  let active=render();active.open=true;render();active.accounts.reply.credentials[0].hint='ALIC';active.accounts.reads[0].resolve(active.accounts.reply);await flush();
  const removal=nodes(active.accounts.rows()[0].props.actions).find(n=>n.type==='button'&&n.props.className==='popover-row danger')!;
  (removal.props.onClick as ()=>void)();assert.equal(active.accounts.removing(),true);
  next={...current};await reader.refresh();assert.equal(render(),active,'a normal session refresh preserves the open action');
  active.accounts.event();const obsolete=active.accounts.reads[1];
  next=session('bob');await reader.refresh();const bob=render();
  assert.notEqual(bob,active);assert.equal(bob.open,false);assert.equal(bob.accounts.removing(),false);
  bob.open=true;render();bob.accounts.reads[0].reject(new Error('bob offline'));obsolete.resolve(active.accounts.reply);await flush();
  assert.equal(bob.accounts.rows().length,0,'previous owner hints cannot survive a failed new-owner load');
  assert.equal(bob.accounts.errors().length,1);assert.equal(bob.accounts.removing(),false);
  active=bob;active.accounts.unmount();
});
