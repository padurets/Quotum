import * as viewContract from '../../server/domain/view';
import * as widgets from '../../server/domain/widgets';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ApiError} from '../lib/http';
import type {Arrange} from '../lib/view';
import type {View} from '../lib/types';
import {preparationFixture} from './preparationFixture';

const EMPTY:View={version:2,layout:{columns:6,places:{}},names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{},enabledWhenEmpty:[]};
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(platform?: 'electron'|'tauri') {
  const hooks=preparationFixture(),reads:{url:string;view:View;headers:Record<string,string>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[],events=new Map<string,()=>void>();
  const memo=(read:()=>unknown,deps:unknown[])=>{const box=hooks.useRef(undefined) as {current?:{deps:unknown[];value:unknown}};if(!box.current||deps.some((value,i)=>!Object.is(value,box.current!.deps[i])))box.current={deps,value:read()};return box.current.value;};
  const cleanups=new Set<()=>void>();
  const appContext={exports:{} as {inApp:()=>boolean},...(platform==='electron'?{__QUOTUM__:{invoke:()=>{}}}:platform==='tauri'?{__TAURI__:{core:{invoke:()=>{}}}}:{}),require:()=>({})};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/app.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,appContext);
  const keepalives:{body:string;headers:Record<string,string>}[]=[];
  const context={TextEncoder,AbortController,exports:{} as {useView:(id:string,view:View,owner:boolean,revision:number)=>Arrange;flushView:(id:string)=>Promise<void>;flushLargeViews:()=>Promise<void>},setTimeout:()=>0,clearTimeout:()=>{},window:{addEventListener:(name:string,fn:()=>void)=>events.set(name,fn),removeEventListener:(name:string)=>events.delete(name)},fetch:(_url:string,options:{body:string;headers:Record<string,string>})=>{keepalives.push(options);return Promise.resolve({});},require:(name:string)=>{
    if(name==='./app')return appContext.exports;
    if(name.endsWith('/domain/view'))return viewContract;
    if(name.endsWith('/domain/widgets'))return widgets;
    if(name==='react')return {useRef:hooks.useRef,useState:hooks.useState,useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>hooks.useLayoutEffect(()=>{const cleanup=effect();if(cleanup)cleanups.add(cleanup);return cleanup;},deps),useMemo:memo,useCallback:(fn:unknown,deps:unknown[])=>memo(()=>fn,deps)};
    if(name==='./http')return {ApiError,call:(_method:string,url:string,view:View,_timeout:number,_signal:unknown,headers:Record<string,string>)=>new Promise((resolve,reject)=>reads.push({url,view,headers,resolve,reject}))};
    if(name==='./plan')return {DEFAULT_PLAN:[],isValidPlan:()=>true};
    if(name==='./providers')return {PROVIDERS:{}};
    if(name.endsWith('/presentation'))return {};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/view.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const render=(id='board',view=EMPTY,revision=4)=>{hooks.begin();const result=context.exports.useView(id,view,true,revision);hooks.commit();return result;};
  return {render,reads,events,keepalives,leave:context.exports.flushLargeViews,flush:context.exports.flushView,unmount:()=>{for(const cleanup of cleanups)cleanup();cleanups.clear();}};
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

test('a failed save stays recoverable across settings navigation and retries with its captured revision',async()=>{
  const h=fixture();h.render('first',EMPTY,7).update(view=>({...view,names:{source:'unsent name'}}));
  const saving=h.flush('first');h.render('',EMPTY,0);
  h.reads[0].reject(new Error('network down'));await assert.rejects(saving,/network down/);
  const notice=h.render('',EMPTY,0);
  assert.equal(notice.saveFailures!.length,1);assert.equal(notice.saveFailures![0].board,'first');assert.equal(notice.saveFailures![0].retryable,true);
  const retry=notice.retrySave!('first');assert.equal(h.reads[1].headers['If-Match'],'"7"');assert.equal(h.reads[1].view.names.source,'unsent name');
  h.reads[1].resolve({view:h.reads[1].view,revision:8});await retry;
  assert.equal(h.render('',EMPTY,0).saveFailures!.length,0);
  assert.equal(h.render('first',EMPTY,7).view.names.source,'unsent name');
});

test('ending the owner shell prevents an unsent serial successor from moving to a later session',async()=>{
  const h=fixture();h.render().update(view=>({...view,names:{source:'first'}}));const saving=h.flush('board');
  h.render().update(view=>({...view,names:{source:'second'}}));h.unmount();
  h.reads[0].resolve({view:h.reads[0].view,revision:5});await saving;assert.equal(h.reads.length,1);
  await h.flush('board');assert.equal(h.reads.length,1);
});

const oversized={...EMPTY,names:Object.fromEntries(Array.from({length:200},(_,i)=>['name'+i,'é'.repeat(60)])),layout:{columns:6,places:Object.fromEntries(Array.from({length:1200},(_,i)=>['source:'+i,{x:0,y:i,w:3}]))}};
test('oversized UTF-8 drafts save immediately in one serial queue and protect browser closing until acknowledged',async()=>{
  const h=fixture();h.render().update(()=>oversized);
  assert.ok(new TextEncoder().encode(JSON.stringify(oversized)).byteLength>65536);
  assert.equal(h.reads.length,1);assert.equal(h.reads[0].headers['X-Quotum-View-Version'],'2');
  assert.equal(h.events.has('beforeunload'),true);
  h.events.get('pagehide')!();assert.equal(h.keepalives.length,0);
  h.render().update(()=>({...EMPTY,names:{s:'latest small draft'}}));
  assert.equal(h.reads.length,1);assert.equal(h.events.has('beforeunload'),true);
  let left=false;const leaving=h.leave().then(()=>{left=true;});
  h.reads[0].resolve({view:oversized,revision:5});await settle();
  assert.equal(left,false);assert.equal(h.reads.length,2);assert.equal(h.events.has('beforeunload'),true);
  h.reads[1].resolve({view:h.reads[1].view,revision:6});await leaving;
  assert.equal(left,true);assert.equal(h.events.has('beforeunload'),false);h.unmount();
});
test('failed large saves prevent saver-destroying browser navigation until retry or explicit discard',async()=>{
  const h=fixture();h.render().update(()=>oversized);
  h.reads[0].reject(new Error('offline'));await settle();
  assert.equal(h.events.has('beforeunload'),true);await assert.rejects(h.leave(),/offline/);
  h.render().dismissSave!('board');await h.leave();assert.equal(h.events.has('beforeunload'),false);h.unmount();
});
test('both native bridges retain immediate ordinary autosave without registering a browser close warning',async()=>{
  for(const platform of ['electron','tauri'] as const){const h=fixture(platform);h.render().update(()=>oversized);
    assert.equal(h.reads.length,1);assert.equal(h.events.has('beforeunload'),false);
    await h.leave();h.reads[0].reject(new Error('offline'));await settle();
    assert.equal(h.events.has('beforeunload'),false);assert.equal(h.render().saveFailures!.length,1);h.unmount();
  }
});
test('ordinary pagehide saves carry the writer version and clean boards have no close prompt',()=>{
  const h=fixture();h.render().update(view=>({...view,names:{s:'small'}}));
  assert.equal(h.reads.length,0);assert.equal(h.events.has('beforeunload'),false);
  h.events.get('pagehide')!();assert.equal(h.keepalives.length,1);assert.equal(h.keepalives[0].headers['X-Quotum-View-Version'],'2');h.unmount();
});

test('native Back and Forward retain the saver through dirty confirmation, failure and every serial successor', async () => {
  for (const delta of [-1, 1]) {
    const h = fixture(), events = new EventTarget();
    const entries = (delta < 0 ? ['/device', '/?board=board'] : ['/?board=board', '/device']).map((path, index) => ({url: new URL(path, 'http://fixture.example'), state: {quotumPosition: index}}));
    let index = delta < 0 ? 1 : 0, changes = 0, proceed: (() => void) | undefined;
    const original = index;
    const context = {exports: {} as {onLocation: (fn: () => void) => () => void; guardNavigation: (fn: (go: () => void) => void) => () => void},
      get location() {return entries[index].url;}, window: events,
      history: {get state() {return entries[index].state;}, replaceState(state: {quotumPosition: number}, _title: string, path: string) {entries[index] = {state, url: new URL(path, entries[index].url)};}, go(step: number) {index += step; events.dispatchEvent(new Event('popstate'));}},
      require: (name: string) => name === './view' ? {flushLargeViews: h.leave} : {},
    };
    runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/router.ts', import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText, context);
    const router = context.exports, stop = router.onLocation(() => {changes++; if (context.location.pathname === '/device') h.unmount();});
    const unguard = router.guardNavigation(go => {proceed = go;});
    try {
      h.render().update(() => oversized);
      h.render().update(view => ({...view, names: {...view.names, latest: 'second edit'}}));
      context.history.go(delta);
      assert.equal(index, original); assert.equal(changes, 0); assert.equal(h.events.has('beforeunload'), true);
      assert.ok(proceed, 'currency draft confirmation happens on the restored entry');
      proceed!();
      h.reads[0].reject(new Error('offline')); await settle();
      assert.equal(index, original); assert.equal(changes, 0); assert.equal(h.events.has('beforeunload'), true);
      unguard();
      const retry = h.render().retrySave!('board');
      h.render().update(view => ({...view, names: {...view.names, latest: 'third edit'}}));
      context.history.go(delta);
      assert.equal(index, original, 'unguarded Back/Forward also waits for the actual saver');
      h.reads[1].resolve({view: h.reads[1].view, revision: 5}); await settle();
      assert.equal(changes, 0); assert.equal(h.reads.length, 3);
      assert.equal(h.reads[2].view.names.latest, 'third edit');
      assert.equal(h.reads[2].headers['If-Match'], '"5"');
      context.history.go(delta);
      assert.equal(index, original, 'repeated Back/Forward still waits on the same queue');
      h.reads[2].resolve({view: h.reads[2].view, revision: 6}); await retry; await settle();
      assert.equal(index, original + delta); assert.equal(changes, 1);
      assert.equal(entries.length, 2, 'resuming traversal never creates a replacement history entry');
      assert.equal(h.events.has('beforeunload'), false);
    } finally {unguard(); stop(); h.unmount();}
  }
});
