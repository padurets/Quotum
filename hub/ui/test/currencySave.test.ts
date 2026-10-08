import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {ApiError} from '../lib/http';
import type {useSave,Dirty,Refresh} from '../components/CurrencyForms';

type Node={type:unknown;props:Record<string,unknown>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture(){
  const hooks=preparationFixture(),reads:{method:string;url:string;body:unknown;resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[];
  const drafts=new Map<string,()=>void>(),cleanups=new Set<()=>void>();
  const call=(method:string,url:string,body?:unknown)=>new Promise((resolve,reject)=>reads.push({method,url,body,resolve,reject}));
  const context={exports:{} as {useSave:typeof useSave},crypto:{randomUUID:()=> 'request'},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useId:()=> 'draft',useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>hooks.useLayoutEffect(()=>{const cleanup=effect();if(cleanup){cleanups.add(cleanup);return()=>{cleanups.delete(cleanup);cleanup();};}},deps)};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'fragment'};
    if(name.endsWith('/http'))return {ApiError,call};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    return {};
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/CurrencyForms.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const dirty:Dirty=(key,value,discard)=>{if(value)drafts.set(key,discard!);else drafts.delete(key);};
  const refresh:Refresh=()=>call('GET','/api/currencies/manage') as ReturnType<Refresh>;
  const render=(revision='1',changed=false)=>{hooks.begin();const result=context.exports.useSave(revision,changed,refresh,dirty);hooks.commit();return result;};
  const retry=()=>{const button=nodes(render().notice).find(n=>n.type==='button'&&n.props.children==='currencies.retry')!;assert.ok(button);(button.props.onClick as ()=>void)();};
  const notice=(key:string)=>nodes(render().notice).some(n=>n.props.children===key);
  return {reads,drafts,render,retry,notice,unmount:()=>{for(const cleanup of cleanups)cleanup();cleanups.clear();}};
}

for(const status of [503,403])test(`an acknowledged save keeps refresh failure ${status} recoverable without repeating the write`,async()=>{
  const f=fixture(),done:unknown[]=[];f.render().send('/api/currencies/id',{name:'Updated'},value=>done.push(value));
  f.reads[0].resolve({id:'id'});await flush();assert.equal(f.reads[1].method,'GET');
  f.reads[1].reject(new ApiError(status,'unavailable'));await flush();
  assert.equal(f.render().disabled,true);assert.equal(f.drafts.size,1);assert.deepEqual(done,[]);assert.ok(f.notice('currencies.savedRefresh'));assert.ok(!f.notice('currencies.saved'));
  f.retry();assert.deepEqual(f.reads.map(read=>read.method),['POST','GET','GET']);
  f.reads[2].resolve({registryRevision:'2'});await flush();assert.deepEqual(done,[{id:'id'}]);assert.equal(f.render().disabled,false);assert.equal(f.drafts.size,0);
});

test('a failed conflict refresh retains the draft and retries only the read before another save',async()=>{
  const f=fixture();f.render('1',true).send('/api/currencies/id/rates',{rate:'3000000'});
  f.reads[0].reject(new ApiError(409,'currency_conflict'));await flush();f.reads[1].reject(new Error('offline'));await flush();
  assert.ok(f.notice('currencies.conflictRefresh'));assert.equal(f.render().conflict,false);assert.equal(f.drafts.size,1);
  f.retry();f.reads[2].resolve({registryRevision:'4'});await flush();assert.equal(f.render('4',true).conflict,true);
  f.render('4',true).send('/api/currencies/id/rates',{rate:'3000000'});assert.equal((f.reads[3].body as {expectedRevision:string}).expectedRevision,'4');
  assert.deepEqual(f.reads.map(read=>read.method),['POST','GET','GET','POST']);
});

test('an unconfirmed write retries its exact payload and a discarded refresh cannot finish the form',async()=>{
  const f=fixture(),done:unknown[]=[];f.render().send('/api/currencies/id',{name:'Updated'},value=>done.push(value));
  f.reads[0].reject(new Error('lost response'));await flush();assert.ok(f.notice('currencies.unconfirmed'));f.retry();assert.equal(f.reads[1].body,f.reads[0].body);
  f.reads[1].resolve({id:'id'});await flush();f.render();[...f.drafts.values()][0]();
  f.reads[2].resolve({registryRevision:'2'});await flush();assert.deepEqual(done,[]);assert.equal(f.render().disabled,false);assert.equal(f.drafts.size,0);
});
