import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {INITIAL, reduce, type PageState, type Snapshot} from '../lib/board';
import type {Device} from '../components/Machines';

type Node={type:unknown;props:Record<string,unknown>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const snapshot:Snapshot={board:{id:'b',name:'Board',personal:false},view:{version:2,layout:{columns:6,places:{}},names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{}},historyStart:0,sources:[],sessions:{},cadence:{},refresh:{},forecast:{},mine:[],boards:[],resets:{resets:{},trackers:[],past:{}}};
const device:Device={id:'d',name:'Laptop',reported:'Laptop',os:'linux',arch:'x86_64',agent:'quotum/0.7.0',via:'token',lastSeenAt:1,sources:[],failures:[],clients:[{clientId:'opencode',version:'1.2.3',seenAt:1}],sessions:[]};
const session={clientId:'opencode',device:{id:'d',name:'Laptop'},source:null,origin:'terminal' as const,project:'Current project',folder:null,startedAt:1,lastWorkedAt:null,working:false,workedMs:0};

function fixture(){
  const hooks=preparationFixture(),row={},modal={},errorLine={},reads:{resolve:(value:Device[])=>void;reject:(error:Error)=>void}[]=[];
  let state:PageState=reduce(INITIAL,{type:'hub',event:{type:'snapshot',data:snapshot}});
  const memo=(fn:unknown,deps:unknown[])=>{
    const slot=hooks.useRef(undefined) as {current?:{fn:unknown;deps:unknown[]}};
    if(!slot.current||deps.some((value,i)=>!Object.is(value,slot.current!.deps[i])))slot.current={fn,deps};
    return slot.current.fn;
  };
  const context={exports:{} as {Devices:(props:{local:boolean})=>unknown},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useLayoutEffect,useCallback:memo};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'fragment'};
    if(name.endsWith('/board'))return {useConnectionsRevision:()=>state.board?.connectionsRevision??0,useDevicesRevision:()=>state.devicesRevision??0};
    if(name.endsWith('/http'))return {call:(method:string,url:string)=>{assert.equal(method,'GET');assert.equal(url,'/api/devices');return new Promise<Device[]>((resolve,reject)=>reads.push({resolve,reject}));}};
    if(name.endsWith('/providers'))return {PROVIDERS:{}};
    if(name.endsWith('/format'))return {stamp:()=>''};
    if(name.endsWith('/quota'))return {errorText:()=>''};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key,rich:()=>''};
    if(name.endsWith('/clients'))return {clientName:(id:string)=>id};
    if(name==='./Kit')return {Modal:modal,ErrorLine:errorLine};
    if(name==='./Connections')return {ConnectionRow:row};
    if(name==='./Time')return {Ago:{}};
    if(name==='./logos')return {logoOf:()=>''};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/Machines.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{hooks.begin();const tree=nodes(context.exports.Devices({local:false}));hooks.commit();return tree;};
  const open=()=>{const connection=render().find(node=>node.type===row)!;const button=nodes(connection.props.actions).find(node=>node.type==='button'&&nodes(node.props.children).some(child=>child.props.children==='devices.clients'))!;(button.props.onClick as ()=>void)();render();};
  const close=()=>{(render().find(node=>node.type===modal)!.props.onClose as ()=>void)();render();};
  const hint=()=>{state=reduce(state,{type:'hub',event:{type:'devices',data:{}}});render();};
  const reconnect=()=>{state=reduce(state,{type:'hub',event:{type:'snapshot',data:snapshot}});render();};
  const projects=()=>render().filter(node=>node.type==='small').map(node=>node.props.children);
  return {render,reads,open,close,hint,reconnect,projects,errorLine};
}

test('device disclosure refreshes on opening, presence and reconnect, but closed presence hints make no reads',async()=>{
  const f=fixture();f.render();assert.equal(f.reads.length,1);
  f.reads[0].resolve([device]);await flush();f.render();
  f.hint();assert.equal(f.reads.length,1,'closed disclosure ignores presence');
  f.open();assert.equal(f.reads.length,2,'opening reads fresh owner data on a shared board');
  f.reads[1].resolve([{...device,sessions:[session]}]);await flush();assert.deepEqual(f.projects(),['Current project']);
  f.hint();assert.equal(f.reads.length,3);
  f.reads[2].resolve([device]);await flush();assert.deepEqual(f.projects(),[],'full replacement or expiry clears the current list');
  f.reconnect();assert.equal(f.reads.length,4);
  f.reads[3].resolve([device]);await flush();f.close();f.hint();assert.equal(f.reads.length,4);
  f.open();assert.equal(f.reads.length,5,'reopening cannot restore a cached session');
  f.reads[4].resolve([device]);await flush();assert.deepEqual(f.projects(),[]);
});

test('an obsolete device reply or error cannot restore a closed session after newer owner data',async()=>{
  const f=fixture();f.render();f.reads[0].resolve([device]);await flush();f.open();
  f.hint();f.reads[2].resolve([device]);await flush();
  f.reads[1].resolve([{...device,sessions:[session]}]);await flush();assert.deepEqual(f.projects(),[]);
  f.hint();f.hint();f.reads[4].resolve([device]);await flush();f.reads[3].reject(new Error('obsolete failure'));await flush();
  assert.ok(!f.render().some(node=>node.type===f.errorLine));
});
