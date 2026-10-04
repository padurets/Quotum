import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {ApiError} from '../lib/http';

type Node={type:unknown;props:Record<string,unknown>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};

function fixture(){
  const hooks=preparationFixture(),errorLine={},reads:{resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[];
  let notify:(event:unknown)=>void=()=>{};
  const context={exports:{} as {ConnectedAccounts:(props:unknown)=>Node},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useLayoutEffect};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'fragment'};
    if(name.endsWith('/http'))return {ApiError,call:()=>new Promise((resolve,reject)=>reads.push({resolve,reject}))};
    if(name.endsWith('/board'))return {useTitles:()=>({}),page:{listen:(listener:typeof notify)=>{notify=listener;return()=>{};}}};
    if(name.endsWith('/providers'))return {PROVIDERS:{openrouter:{name:'OpenRouter'}}};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    if(name.endsWith('/format'))return {stamp:()=>''};
    if(name==='./Kit')return {ErrorLine:errorLine};
    if(name==='./Popover')return {};
    if(name==='./logos')return {logoOf:()=>''};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/Connections.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{hooks.begin();const tree=context.exports.ConnectedAccounts({userId:'u',trustedKeys:{available:true},onReplace:()=>{}});hooks.commit();return nodes(tree);};
  const reply={credentials:[{id:'c',provider:'openrouter',sourceId:null,hint:'abcd',lastError:null,expiresAt:null}]};
  return {reads,reply,render,event:()=>notify({type:'hub',event:{type:'sourceAccess'}}),errors:()=>render().filter(n=>n.type===errorLine),rows:()=>render().filter(n=>typeof n.type==='function'&&n.props.name==='OpenRouter')};
}

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
