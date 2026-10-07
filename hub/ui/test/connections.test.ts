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

function fixture(initialOwner='u',local=false,boards:Session['boards']=[]){
  const hooks=preparationFixture(),errorLine={},field={},reads:{url:string;body:unknown;resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[];
  const cleanups=new Set<()=>void>(),modal={};let userId=initialOwner;
  const memo=(read:()=>unknown,deps:unknown[])=>{const box=hooks.useRef(undefined) as {current?:{deps:unknown[];value:unknown}};if(!box.current||deps.some((value,i)=>!Object.is(value,box.current!.deps[i])))box.current={deps,value:read()};return box.current.value;};
  let scopeActive=true;
  const context={exports:{} as {ConnectionsPage:(props:unknown)=>Node;KeyForm:(props:unknown)=>Node;useAddition:()=>{submit:(board:string,item:unknown,secret?:string)=>Promise<void>}},crypto:{randomUUID:()=> 'request'},AbortController,require:(name:string)=>{
    if(name==='react')return {createContext:()=>({}),useContext:()=>()=>scopeActive,useState:hooks.useState,useRef:hooks.useRef,useCallback:(fn:unknown,deps:unknown[])=>memo(()=>fn,deps),useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>hooks.useLayoutEffect(()=>{const cleanup=effect();if(!cleanup)return;cleanups.add(cleanup);return()=>{cleanups.delete(cleanup);cleanup();};},deps)};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'fragment'};
    if(name.endsWith('/http'))return {ApiError,call:(_method:string,url:string,body:unknown)=>new Promise((resolve,reject)=>reads.push({url,body,resolve,reject}))};
    if(name.endsWith('/board'))return {};
    if(name.endsWith('/view'))return {flushView:async()=>{}};
    if(name.endsWith('/router'))return {};
    if(name.endsWith('/session'))return {boardTitle:(board:{name:string})=>board.name};
    if(name.endsWith('/providers'))return {PROVIDERS:{openrouter:{name:'OpenRouter'},deepseek:{name:'DeepSeek'},zai:{name:'z.ai'}},catalogue:[{id:'openrouter',name:'OpenRouter',measuredBy:'hub'},{id:'deepseek',name:'DeepSeek',measuredBy:'hub'},{id:'zai',name:'z.ai',measuredBy:'hub'}]};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    if(name.endsWith('/format'))return {stamp:()=>''};
    if(name.endsWith('/widgetKind'))return {widgetKind:()=> 'resource.subscription'};
    if(name==='lucide-react')return {};
    if(name==='./Kit')return {Field:field,ErrorLine:errorLine,Modal:modal};
    if(name==='./Popover')return {};
    if(name==='./logos')return {logoOf:()=>''};
    if(name==='./Machines')return {};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/WidgetAdd.tsx',import.meta.url),'utf8')+'\nexports.KeyForm=KeyForm;exports.useAddition=useAddition;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{hooks.begin();const tree=context.exports.ConnectionsPage({userId,trustedKeys:{available:true},boards,local});hooks.commit();return nodes(tree);};
  const keyForm=(props:unknown)=>{hooks.begin();const tree=context.exports.KeyForm(props);hooks.commit();return nodes(tree);};
  const reply={connections:[{id:'c',provider:'openrouter',sourceId:null,hint:'abcd',lastError:null,expiresAt:null,label:'OpenRouter',lastSuccessAt:null,placements:[]}]};
  const addition=()=>{hooks.begin();const value=context.exports.useAddition();hooks.commit();return value;};
  return {reads,reply,render,keyForm,addition,endScope:()=>{scopeActive=false;},errorLine,event:()=>{const refresh=render().find(n=>n.type==='button'&&n.props.children==='refresh.action')!;(refresh.props.onClick as ()=>void)();},errors:()=>render().filter(n=>n.type===errorLine&&n.props.error),rows:()=>render().filter(n=>n.type==='article'&&n.props.className==='connection-record'),owner:(next:string)=>{userId=next;},unmount:()=>{for(const cleanup of cleanups)cleanup();cleanups.clear();},removing:()=>render().some(n=>n.type===modal)};
}

test('a recovered owner credential list clears the earlier network error',async()=>{
  const f=fixture();f.render();f.reads[0].reject(new Error('offline'));await flush();
  assert.equal(f.errors().length,1);f.event();f.reads[1].resolve(f.reply);await flush();
  assert.equal(f.rows().length,1);assert.equal(f.errors().length,0);
});

test('recovered replacement displays cleanup warnings and preserves later replacement or removal',()=>{
  const f=fixture(),initialOperation={id:'receipt',boardId:null,item:{kind:'replace',credentialId:'c'},createdAt:1,state:'complete',warning:'credential_cleanup_pending',current:{credential:{exists:true,revisionMatches:false}},result:{sourceIds:['s']}};
  const props={board:{id:'personal',name:'Personal',personal:true,role:'owner'},personal:true,available:true,onClose:()=>{},initialOperation};
  f.keyForm(props);const rendered=f.keyForm(props);
  assert.equal(rendered.some(node=>node.type==='h3'&&node.props.children==='add.keyChanged'),true);
  assert.equal(rendered.some(node=>node.type===f.errorLine&&(node.props.error as ApiError)?.code==='credential_cleanup_pending'),true);
  assert.equal(rendered.some(node=>node.type==='h3'&&node.props.children==='add.replaced'),false);
});

test('committed replacement retries only its cleanup receipt without another key or reservation',async()=>{
  const f=fixture(),operation={id:'receipt',boardId:null,item:{kind:'replace',credentialId:'c'},createdAt:1,state:'complete',warning:'credential_cleanup_pending',current:{credential:{exists:true,revisionMatches:true}},result:{sourceIds:['s']}};
  const props={board:{id:'personal',name:'Personal',personal:true,role:'owner'},personal:true,available:true,onClose:()=>{},initialOperation:operation};
  f.keyForm(props);const action=f.keyForm(props).find(node=>node.type==='button'&&node.props.children==='add.retryCleanup')!;
  (action.props.onClick as ()=>void)();await flush();
  assert.equal(f.reads.length,1);assert.equal(f.reads[0].url,'/api/additions/receipt/run');assert.equal(Object.keys(f.reads[0].body as object).length,0);
  f.reads[0].resolve({...operation,warning:undefined});await flush();
  assert.equal(f.keyForm(props).some(node=>node.type==='button'&&node.props.children==='add.retryCleanup'),false);
});

test('closing an addition form after submit still runs its reserved action in the same owner scope',async()=>{
  const f=fixture(),operation={id:'receipt',boardId:'board',item:{kind:'widget',widgetId:'history'},state:'ready',createdAt:1};
  const submitting=f.addition().submit('board',operation.item);await flush();assert.equal(f.reads.length,1);
  f.unmount();f.reads[0].resolve(operation);await flush();assert.equal(f.reads.length,2);
  f.reads[1].resolve({...operation,state:'complete',result:{sourceIds:[]}});await submitting;
});

test('ending the authenticated owner scope before reservation returns prevents the run',async()=>{
  const f=fixture(),operation={id:'receipt',boardId:'board',item:{kind:'widget',widgetId:'history'},state:'ready',createdAt:1};
  const submitting=f.addition().submit('board',operation.item);await flush();f.endScope();f.unmount();
  f.reads[0].resolve(operation);await submitting;assert.equal(f.reads.length,1);
});

test('adding a saved connection from local settings retains the local capability boundary',async()=>{
  const f=fixture('u',true,[{id:'personal',name:'Personal',personal:true,role:'owner'}]);f.render();f.reads[0].resolve(f.reply);await flush();
  (f.render().find(node=>node.type==='button'&&node.props.children==='add.toBoard')!.props.onClick as ()=>void)();
  const choice=f.render().find(node=>node.type==='button'&&node.props.className==='popover-row')!;
  (choice.props.onClick as ()=>void)();
  const add=f.render().find(node=>typeof node.type==='function'&&node.props.initialSourceId!==undefined || typeof node.type==='function'&&node.props.trigger==='Personal')!;
  assert.ok(add);assert.equal(add.props.local,true);
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
  let active=render();active.open=true;render();active.accounts.reply.connections[0].hint='ALIC';active.accounts.reads[0].resolve(active.accounts.reply);await flush();
  const removal=nodes(active.accounts.rows()[0]).find(n=>n.type==='button'&&n.props.children==='sources.remove')!;
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

test('z.ai form keeps its destination and requires unknown expiry plus same-account consent for replacement',async()=>{
  const f=fixture(),props={provider:'zai',board:{id:'team',name:'Team',personal:false,role:'member'},personal:false,available:true,onClose:()=>{},replace:{id:'zai-key',provider:'zai',sourceId:'zai-source',revision:0,identityOrigin:'declared',expiryKind:'unknown'}};
  let tree=f.keyForm(props);const key=tree.find(node=>node.props.label==='sources.apiKey')!;(key.props.onChange as (event:unknown)=>void)({target:{value:'synthetic-key'}});
  tree=f.keyForm(props);assert.equal(tree.filter(node=>node.type==='input'&&node.props.type==='checkbox').length,2);
  assert.equal(tree.find(node=>node.type==='button'&&node.props.children==='sources.replace')!.props.disabled,true);
  for(const checkbox of tree.filter(node=>node.type==='input'&&node.props.type==='checkbox'))(checkbox.props.onChange as (event:unknown)=>void)({target:{checked:true}});
  tree=f.keyForm(props);assert.equal(tree.find(node=>node.type==='button'&&node.props.children==='sources.replace')!.props.disabled,false);
  (tree.find(node=>node.type==='form')!.props.onSubmit as (event:unknown)=>void)({preventDefault:()=>{}});await flush();
  assert.equal(f.reads[0].url,'/api/additions');assert.deepEqual(JSON.parse(JSON.stringify((f.reads[0].body as {item:unknown}).item)),{kind:'replace',credentialId:'zai-key'});
  f.reads[0].resolve({id:'intent',boardId:null,item:{kind:'replace',credentialId:'zai-key',provider:'zai'},state:'ready'});await flush();
  assert.equal(f.reads[1].url,'/api/additions/intent/run');assert.deepEqual(JSON.parse(JSON.stringify(f.reads[1].body)),{secret:'synthetic-key',allowUnknownExpiry:true,sameAccount:true});f.unmount();
});

test('DeepSeek Add binds a named private account and one informed submission to the selected board',async()=>{
  const f=fixture(),props={provider:'deepseek',board:{id:'team',name:'Team',personal:false,role:'member'},personal:false,available:true,onClose:()=>{}};
  f.keyForm(props);assert.equal(f.reads[0].url,'/api/source-accounts?provider=deepseek&limit=10');f.reads[0].resolve({accounts:[],next:null});await flush();
  let tree=f.keyForm(props);
  (tree.find(node=>node.props.label==='sources.accountName')!.props.onChange as (event:unknown)=>void)({target:{value:'Personal'}});
  (tree.find(node=>node.props.label==='sources.apiKey')!.props.onChange as (event:unknown)=>void)({target:{value:'synthetic-key'}});
  tree=f.keyForm(props);assert.equal(tree.find(node=>node.type==='button'&&node.props.children==='add.connectAndAdd')!.props.disabled,true);
  (tree.find(node=>node.type==='input'&&node.props.type==='checkbox')!.props.onChange as (event:unknown)=>void)({target:{checked:true}});
  tree=f.keyForm(props);assert.equal(tree.find(node=>node.type==='button'&&node.props.children==='add.connectAndAdd')!.props.disabled,false);
  (tree.find(node=>node.type==='form')!.props.onSubmit as (event:unknown)=>void)({preventDefault:()=>{}});await flush();
  assert.deepEqual(JSON.parse(JSON.stringify((f.reads[1].body as {boardId:string;item:unknown}).item)),{kind:'connection',provider:'deepseek',account:{kind:'new'}});assert.equal((f.reads[1].body as {boardId:string}).boardId,'team');
  f.reads[1].resolve({id:'intent',boardId:'team',item:{kind:'connection',provider:'deepseek',account:{kind:'new'}},state:'ready'});await flush();assert.deepEqual(JSON.parse(JSON.stringify(f.reads[2].body)),{secret:'synthetic-key',allowUnknownExpiry:true,accountName:'Personal'});f.unmount();
});

test('unavailable connection forms retain matching-key and damaged-storage recovery reasons',()=>{
  for(const reason of ['secret_key_mismatch','secret_key_storage_invalid','secret_key_storage_missing','secret_key_storage_unavailable']) {
    const f=fixture(),rendered=f.keyForm({provider:'deepseek',board:{id:'personal',name:'Personal',personal:true,role:'owner'},personal:true,available:false,storageReason:reason,onClose:()=>{}});
    assert.equal(rendered.some(node=>reason==='secret_key_mismatch'?node.props.children==='trustedKeys.serverMismatch':node.type===f.errorLine&&(node.props.error as ApiError)?.code===reason),true);
    assert.equal(rendered.some(node=>node.props.children==='trustedKeys.serverMissing'),false);f.unmount();
  }
});
