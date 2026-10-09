import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ApiError} from '../lib/http';
import {preparationFixture} from './preparationFixture';

type Node={type:unknown;props:Record<string,unknown>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function sharesFixture(){
  const hooks=preparationFixture(),requests:{method:string;path:string;body:unknown;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[];let refreshes=0;
  const callback=(fn:unknown,deps:unknown[])=>{const saved=hooks.useRef({fn,deps}) as {current:{fn:unknown;deps:unknown[]}};if(deps.some((value,i)=>!Object.is(value,saved.current.deps[i])))saved.current={fn,deps};return saved.current.fn;};
  const context={exports:{} as {SharesTab:(props:unknown)=>Node},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useLayoutEffect,useCallback:callback};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props})};
    if(name.endsWith('/http'))return {ApiError,call:(method:string,path:string,body:unknown)=>new Promise((resolve,reject)=>requests.push({method,path,body,resolve,reject}))};
    if(name.endsWith('/session'))return {rereadSession:()=>{refreshes++;}};
    if(name.endsWith('/board'))return {useTitles:()=>({})};
    if(name.endsWith('/providers'))return {PROVIDERS:{}};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    if(name==='./Kit'||name==='./logos')return {};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/BoardDialog.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  return {requests,refreshes:()=>refreshes,render:(id='shared')=>{hooks.begin();const tree=context.exports.SharesTab({board:{id,name:id,role:'owner',personal:false}});hooks.commit();return nodes(tree);}};
}
const financialShare=(source:string,enabled=false,revision='0')=>({source,provider:'codex',sharedBy:'',mine:true,budget:{enabled,revision}});
const toggle=(tree:Node[],checked:boolean)=>(tree.find(node=>node.type==='input')!.props.onChange as (event:unknown)=>void)({target:{checked}});

test('a financial toggle finishes after removing another shared source refreshes the list',async()=>{
  const ui=sharesFixture(),{requests}=ui,a=financialShare('a'),b=financialShare('b');
  ui.render();requests[0].resolve({shared:[a,b],mine:[]});await flush();
  toggle(ui.render(),true);
  const pending=ui.render();assert.equal(pending.find(node=>node.type==='input')!.props.disabled,true);
  (pending.filter(node=>node.type==='button'&&node.props.children==='shares.remove')[1].props.onClick as ()=>void)();
  assert.deepEqual(requests.map(r=>r.method),['GET','PUT','DELETE']);
  requests[2].resolve({ok:true});await flush();requests[3].resolve({shared:[a],mine:[]});await flush();
  assert.equal(ui.render().find(node=>node.type==='input')!.props.disabled,true);
  requests[1].resolve({ok:true});await flush();
  assert.equal(requests[4]?.method,'GET','the completed toggle refreshes its own result');
  requests[4].resolve({shared:[financialShare('a',true,'1')],mine:[]});await flush();
  const ready=ui.render();assert.equal(ready.find(node=>node.type==='input')!.props.disabled,false);assert.equal(ready.find(node=>node.type==='input')!.props.checked,true);
  toggle(ready,false);assert.equal(requests[5].method,'PUT');assert.equal((requests[5].body as {expectedRevision:string}).expectedRevision,'1');
});

test('an old board financial reply cannot clear a new board toggle or restore revoked rows',async()=>{
  const ui=sharesFixture(),{requests}=ui;
  ui.render('first');requests[0].resolve({shared:[financialShare('a')],mine:[]});await flush();toggle(ui.render('first'),true);
  ui.render('second');requests[2].resolve({shared:[financialShare('b')],mine:[]});await flush();toggle(ui.render('second'),true);
  requests[1].resolve({ok:true});await flush();
  assert.equal(requests.length,4,'a reply from the old board starts no refresh');assert.equal(ui.render('second').find(node=>node.type==='input')!.props.disabled,true);
  (ui.render('second').find(node=>node.type==='button'&&node.props.children==='shares.remove')!.props.onClick as ()=>void)();
  requests[4].reject(new ApiError(404,'board_not_found'));await flush();assert.equal(ui.refreshes(),1);
  requests[3].resolve({ok:true});await flush();
  assert.equal(requests.length,5,'a late toggle cannot refresh a revoked board');assert.equal(ui.render('second').some(node=>node.type==='input'||node.type==='button'),false);
});
test('a definite loss of board access clears the settings snapshot and refreshes membership',async()=>{
  const hooks=preparationFixture(),reads:{resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[];let refreshes=0;
  const memo=(read:()=>unknown,deps:unknown[])=>{const box=hooks.useRef(undefined) as {current?:{deps:unknown[];value:unknown}};if(!box.current||deps.some((value,i)=>!Object.is(value,box.current!.deps[i])))box.current={deps,value:read()};return box.current.value;};
  const context={exports:{} as {SharesTab:(props:unknown)=>Node},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useLayoutEffect,useCallback:(fn:unknown,deps:unknown[])=>memo(()=>fn,deps)};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props})};
    if(name.endsWith('/http'))return {ApiError,call:()=>new Promise((resolve,reject)=>reads.push({resolve,reject}))};
    if(name.endsWith('/session'))return {rereadSession:()=>{refreshes++;}};
    if(name.endsWith('/board'))return {useTitles:()=>({})};
    if(name.endsWith('/providers'))return {PROVIDERS:{}};
    if(name.endsWith('/i18n'))return {t:(key:string,values?:{name:string})=>values?.name??key};
    if(name==='./Kit'||name==='./logos')return {};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/BoardDialog.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{hooks.begin();const tree=context.exports.SharesTab({board:{id:'shared',name:'Shared',role:'member',personal:false}});hooks.commit();return nodes(tree);};
  const snapshot={shared:[{source:'source',provider:'openrouter',sharedBy:'Alice Private',mine:true},{source:'other',provider:'openrouter',sharedBy:'Alice Private',mine:true}],mine:[]};
  render();reads[0].resolve(snapshot);await flush();
  assert.equal(render().some(node=>node.props.children==='Alice Private'),true);
  const remove=render().find(node=>node.type==='button'&&node.props.children==='shares.remove')!;(remove.props.onClick as ()=>void)();
  reads[1].resolve({ok:true});await flush();
  assert.equal(reads.length,3,'successful unshare started a refresh');
  (render().find(node=>node.type==='button'&&node.props.children==='shares.remove')!.props.onClick as ()=>void)();
  reads[3].reject(new ApiError(404,'board_not_found'));await flush();
  assert.equal(render().some(node=>node.props.children==='Alice Private'),false);assert.equal(render().some(node=>node.type==='button'),false);
  assert.equal(refreshes,1);
  reads[2].resolve(snapshot);await flush();
  assert.equal(render().some(node=>node.props.children==='Alice Private'),false,'a late pre-revocation snapshot cannot resurrect private rows');
});

test('Members discards rows, invitations and delayed pre-revocation replies after known access loss',async()=>{
  const hooks=preparationFixture(),reads:{resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[];let refreshes=0,reload=()=>{};
  const memo=(read:()=>unknown,deps:unknown[])=>{const box=hooks.useRef(undefined) as {current?:{deps:unknown[];value:unknown}};if(!box.current||deps.some((value,i)=>!Object.is(value,box.current!.deps[i])))box.current={deps,value:read()};return box.current.value;};
  const context={confirm:()=>true,exports:{} as {MembersTab:(props:unknown)=>Node},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useLayoutEffect,useCallback:(fn:()=>void,deps:unknown[])=>{const value=memo(()=>fn,deps);reload=value as ()=>void;return value;}};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props})};
    if(name.endsWith('/http'))return {ApiError,call:()=>new Promise((resolve,reject)=>reads.push({resolve,reject}))};
    if(name.endsWith('/session'))return {rereadSession:()=>{refreshes++;}};
    if(name.endsWith('/board'))return {};
    if(name.endsWith('/providers'))return {PROVIDERS:{}};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    if(name==='./Kit'||name==='./logos')return {};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/BoardDialog.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{hooks.begin();const tree=context.exports.MembersTab({board:{id:'shared',name:'Shared',role:'owner',personal:false},userId:'owner'});hooks.commit();return nodes(tree);};
  const snapshot=[{id:'other',name:'Private member',email:'private@example.invalid',role:'member'}];render();reads[0].resolve(snapshot);await flush();
  assert.equal(render().some(node=>node.props.children==='private@example.invalid'),true);
  (render().find(node=>node.type==='button'&&node.props.children==='members.createLink')!.props.onClick as ()=>void)();
  reload();
  (render().find(node=>node.type==='button'&&node.props.children==='members.createLink')!.props.onClick as ()=>void)();
  reads[3].reject(new ApiError(404,'board_not_found'));await flush();
  assert.equal(render().some(node=>node.type==='button'),false);assert.equal(refreshes,1);
  reads[1].resolve({url:'private-invitation'});reads[2].resolve(snapshot);await flush();
  const current=render();assert.equal(current.some(node=>node.props.children==='private@example.invalid'||node.props.value==='private-invitation'),false);assert.equal(current.some(node=>node.type==='button'),false);
});
