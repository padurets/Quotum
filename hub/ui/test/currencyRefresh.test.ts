import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import type {CurrencyManagement} from '../../server/domain/currency';

type Node={props:Record<string,unknown>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture(){
  const hooks=preparationFixture(),reads:{resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[],listeners=new Map<string,()=>void>();
  const callback=(fn:unknown,deps:unknown[])=>{const saved=hooks.useRef({fn,deps}) as {current:{fn:unknown;deps:unknown[]}};if(deps.some((value,i)=>!Object.is(value,saved.current.deps[i])))saved.current={fn,deps};return saved.current.fn;};
  const context={exports:{} as {CurrencySettings:()=>Node},window:{addEventListener:(name:string,fn:()=>void)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name)},document:{visibilityState:'visible',addEventListener:()=>{},removeEventListener:()=>{}},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useId:()=> 'tabs',useEffect:hooks.useLayoutEffect,useCallback:callback};
    if(name==='react/jsx-runtime')return {jsx:(_type:unknown,props:Node['props'])=>({props}),jsxs:(_type:unknown,props:Node['props'])=>({props}),Fragment:'fragment'};
    if(name.endsWith('/http'))return {call:()=>new Promise((resolve,reject)=>reads.push({resolve,reject}))};
    if(name.endsWith('/board'))return {useCurrencyRegistryRevision:()=>undefined};
    if(name.endsWith('/router'))return {guardNavigation:()=>()=>{}};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    return {};
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/CurrencySettings.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{hooks.begin();const tree=context.exports.CurrencySettings();hooks.commit();return nodes(tree).find(node=>node.props.data)?.props.data as CurrencyManagement|undefined;};
  const data=(revision:string):CurrencyManagement=>({registryRevision:revision,selected:'USD',standards:[],personal:[],maxActive:64});
  return {render,reads,data,focus:()=>listeners.get('focus')!()};
}

test('a successful save refresh applies even when a later independent refresh fails',async()=>{
  const f=fixture();f.render();f.reads[0].resolve(f.data('1'));await flush();assert.equal(f.render()?.registryRevision,'1');
  f.focus();f.focus();f.reads[2].reject(new Error('offline'));await flush();f.reads[1].resolve(f.data('2'));await flush();
  assert.equal(f.render()?.registryRevision,'2');
});

test('out of order management replies never replace a newer registry revision',async()=>{
  const f=fixture();f.render();f.focus();f.reads[1].resolve(f.data('12'));await flush();assert.equal(f.render()?.registryRevision,'12');
  f.reads[0].resolve(f.data('9'));await flush();assert.equal(f.render()?.registryRevision,'12');
});
