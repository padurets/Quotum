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
  render();reads[0].resolve({shared:[{source:'source',provider:'openrouter',sharedBy:'Alice Private',mine:true}],mine:[]});await flush();
  assert.equal(render().some(node=>node.props.children==='Alice Private'),true);
  const remove=render().find(node=>node.type==='button'&&node.props.children==='shares.remove')!;(remove.props.onClick as ()=>void)();
  reads[1].reject(new ApiError(404,'board_not_found'));await flush();
  assert.equal(render().some(node=>node.props.children==='Alice Private'),false);assert.equal(render().some(node=>node.type==='button'),false);
  assert.equal(refreshes,1);
});
