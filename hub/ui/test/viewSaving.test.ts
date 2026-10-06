import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ApiError} from '../lib/http';
import type {Arrange} from '../lib/view';
import type {View} from '../lib/types';
import {preparationFixture} from './preparationFixture';

const EMPTY:View={layout:{columns:6,places:{}},names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{},enabledWhenEmpty:[]};
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture() {
  const hooks=preparationFixture(),reads:{url:string;view:View;headers:Record<string,string>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[],events=new Map<string,()=>void>();
  const memo=(read:()=>unknown,deps:unknown[])=>{const box=hooks.useRef(undefined) as {current?:{deps:unknown[];value:unknown}};if(!box.current||deps.some((value,i)=>!Object.is(value,box.current!.deps[i])))box.current={deps,value:read()};return box.current.value;};
  const context={exports:{} as {useView:(id:string,view:View,owner:boolean,revision:number)=>Arrange;flushView:(id:string)=>Promise<void>},setTimeout:()=>0,clearTimeout:()=>{},window:{addEventListener:(name:string,fn:()=>void)=>events.set(name,fn),removeEventListener:(name:string)=>events.delete(name)},fetch:()=>Promise.resolve({}),require:(name:string)=>{
    if(name==='react')return {useRef:hooks.useRef,useState:hooks.useState,useEffect:hooks.useLayoutEffect,useMemo:memo,useCallback:(fn:unknown,deps:unknown[])=>memo(()=>fn,deps)};
    if(name==='./http')return {ApiError,call:(_method:string,url:string,view:View,_timeout:number,_signal:unknown,headers:Record<string,string>)=>new Promise((resolve,reject)=>reads.push({url,view,headers,resolve,reject}))};
    if(name==='./plan')return {DEFAULT_PLAN:[],isValidPlan:()=>true};
    if(name==='./providers')return {PROVIDERS:{}};
    if(name.endsWith('/presentation'))return {};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/view.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const render=(id='board',view=EMPTY,revision=4)=>{hooks.begin();const result=context.exports.useView(id,view,true,revision);hooks.commit();return result;};
  return {render,reads,flush:context.exports.flushView};
}

test('queued changes serialize and use their own committed revision',async()=>{
  const h=fixture();h.render().update(view=>({...view,names:{source:'first'}}));
  const saving=h.flush('board');assert.equal(h.reads.length,1);assert.equal(h.reads[0].headers['If-Match'],'"4"');
  h.render().update(view=>({...view,names:{source:'second'}}));const joined=h.flush('board');assert.equal(h.reads.length,1);
  h.reads[0].resolve({view:h.reads[0].view,revision:5});await settle();
  assert.equal(h.reads.length,2);assert.equal(h.reads[1].headers['If-Match'],'"5"');assert.equal(h.reads[1].view.names.source,'second');
  h.reads[1].resolve({view:h.reads[1].view,revision:6});await Promise.all([saving,joined]);
  assert.equal(h.render('board',EMPTY,4).view.names.source,'second','an older told view cannot undo the successful save');
});

test('navigation flushes the original board without applying its response to the new board',async()=>{
  const h=fixture();h.render('first',EMPTY,7).update(view=>({...view,hidden:['history']}));
  const second={...EMPTY,names:{other:'Second'}};assert.equal(h.render('second',second,12).view.names.other,'Second');
  assert.equal(h.reads[0].url,'/api/boards/first/view');assert.equal(h.reads[0].headers['If-Match'],'"7"');
  h.reads[0].resolve({view:h.reads[0].view,revision:8});await settle();
  assert.equal(h.render('second',second,12).view.names.other,'Second');
});

test('a conflict drops the stale draft, rejects its flush and leaves subsequent additive actions safe',async()=>{
  const h=fixture();h.render().update(view=>({...view,names:{source:'old draft'}}));
  const saving=h.flush('board'),current={...EMPTY,hidden:['history'],names:{source:'other window'}};
  h.reads[0].reject(new ApiError(409,'view_conflict',{view:current,revision:9}));
  await assert.rejects(saving,/view_conflict/);
  assert.equal(h.render('board',EMPTY,4).view.names.source,'other window');
  await h.flush('board');assert.equal(h.reads.length,1,'a subsequent Add has no stale full draft to resend');
  h.render('board',current,9).update(view=>({...view,colors:{source:'#abcdef'}}));const next=h.flush('board');
  assert.equal(h.reads[1].headers['If-Match'],'"9"');assert.deepEqual(h.reads[1].view.hidden,['history']);
  h.reads[1].resolve({view:h.reads[1].view,revision:10});await next;
});
