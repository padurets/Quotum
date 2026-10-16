import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {INITIAL, reduce, type PageState, type Snapshot} from '../lib/board';
import type {Device} from '../components/Machines';
import * as view from '../../server/domain/view';

type Node={type:unknown;props:Record<string,unknown>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const snapshot:Snapshot={board:{id:'b',name:'Board',personal:false},view:{version:4,layout:{columns:6,places:{}},names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{}},historyStart:0,sources:[],sessions:{},cadence:{},refresh:{},forecast:{},mine:[],boards:[],resets:{resets:{},trackers:[],past:{}}};
const device:Device={id:'d',name:'Laptop',reported:'Laptop',os:'linux',arch:'x86_64',agent:'quotum/0.7.0',via:'token',lastSeenAt:1,sources:[],failures:[],clients:[{clientId:'opencode',version:'1.2.3',seenAt:1}],sessions:[]};
const session={clientId:'opencode',device:{id:'d',name:'Laptop'},source:null,origin:'terminal' as const,project:'Current project',folder:null,startedAt:1,lastWorkedAt:null,working:false,workedMs:0};

function fixture(focused:string|null=null){
  const urls:string[]=[],fundingNode={},fundingReads:{url:string;resolve:(value:unknown)=>void}[]=[];
  const hooks=preparationFixture(),row={},modal={},errorLine={},participation={},preference={},reads:{resolve:(value:Device[])=>void;reject:(error:Error)=>void}[]=[];
  const passive:(()=>void)[]=[],busy:boolean[]=[],events=new EventTarget();
  const onBusyChange=(value:boolean)=>{busy.push(value);};
  const useEffect=(effect:()=>void|(()=>void),deps:unknown[])=>hooks.useLayoutEffect(()=>{
    let active=true,cleanup:(()=>void)|undefined;
    passive.push(()=>{if(active){const stop=effect();if(typeof stop==='function')cleanup=stop;}});
    return()=>{active=false;cleanup?.();};
  },deps);
  const sources=focused?[focused,'codex:bbbbbbbbbbbb'].map(source=>({source,provider:'codex',preference:{kind:'auto',device:null,revision:0},candidates:[],origins:[],duty:'none',pending:false})):[];
  let guarded:(go:()=>void)=>void=go=>go();
  let focuses=0;
  const jsx=(type:unknown,props:Node['props'])=>{if(props.ref)(props.ref as {current:unknown}).current={scrollIntoView:()=>{},focus:()=>{focuses++;}};return {type,props};};
  let state:PageState=reduce(INITIAL,{type:'hub',event:{type:'snapshot',data:snapshot}});
  const memo=(fn:unknown,deps:unknown[])=>{
    const slot=hooks.useRef(undefined) as {current?:{fn:unknown;deps:unknown[]}};
    if(!slot.current||deps.some((value,i)=>!Object.is(value,slot.current!.deps[i])))slot.current={fn,deps};
    return slot.current.fn;
  };
  const context={URLSearchParams,window:events,exports:{} as {Devices:(props:{local:boolean;onBusyChange?:(busy:boolean)=>void})=>unknown},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useRef:hooks.useRef,useEffect,useLayoutEffect:hooks.useLayoutEffect,useCallback:memo,useId:()=> 'device-tabs'};
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'};
    if(name.endsWith('/router'))return {useLocation:()=>'/settings/connections'+(focused?'?source='+focused:''),guardNavigation:(leave:typeof guarded)=>{guarded=leave;return ()=>{};}};
    if(name==='./MeasurementDevices')return {ParticipationSettings:participation,PreferenceSettings:preference,versionSummary:()=> 'Agent 0.7.0'};
    if(name.endsWith('/board'))return {useConnectionsRevision:()=>state.board?.connectionsRevision??0,useDevicesRevision:()=>state.devicesRevision??0};
    if(name.endsWith('/http'))return {call:(method:string,url:string)=>{assert.equal(method,'GET');urls.push(url);if(url==='/api/links')return new Promise(resolve=>fundingReads.push({url,resolve}));assert.match(url,/^\/api\/devices\?measurement=1(?:&details=d)?$/);return new Promise((resolve,reject)=>reads.push({resolve:devices=>resolve({devices,hubVersion:'0.7.0',sources}),reject}));}};
    if(name.endsWith('/providers'))return {PROVIDERS:{}};
    if(name.endsWith('/format'))return {stamp:()=>''};
    if(name.endsWith('/quota'))return {errorText:()=>''};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key,rich:()=>''};
    if(name.endsWith('/clients'))return {clientName:(id:string)=>id};
    if(name.endsWith('/view'))return view;
    if(name==='./Kit')return {Modal:modal,ErrorLine:errorLine};
    if(name==='./Connections')return {ConnectionRow:row};
    if(name==='./ClientLinks')return {openClientLinks:()=>{},SessionFunding:fundingNode};
    if(name==='./Time')return {Ago:{}};
    if(name==='./logos')return {logoOf:()=>''};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/Machines.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=(effects=true)=>{hooks.begin();const tree=nodes(context.exports.Devices({local:false,onBusyChange}));hooks.commit();if(effects)passive.splice(0).forEach(run=>run());return tree;};
  const open=()=>{const connection=render().find(node=>node.type===row)!;(connection.props.onOpen as ()=>void)();render();};
  const close=()=>{(render().find(node=>node.type===modal)!.props.onClose as ()=>void)();render();};
  const hint=()=>{state=reduce(state,{type:'hub',event:{type:'devices',data:{}}});render();};
  const contact=(lastSeenAt:number)=>{state=reduce(state,{type:'hub',event:{type:'deviceContacts',data:{devices:[{deviceId:device.id,lastSeenAt}]}}});render();};
  const reconnect=()=>{state=reduce(state,{type:'hub',event:{type:'snapshot',data:snapshot}});render();};
  const projects=()=>{const section=render().find(node=>node.type==='div'&&nodes(node.props.children).some(child=>child.type==='h3'&&child.props.children==='agents.title'));return Array.from(nodes(section?.props.children).filter(node=>node.type==='small').map(node=>node.props.children));};
  const reload=()=>render().find(node=>node.type===participation)!.props.reload as ()=>Promise<void>;
  const select=(value:string)=>{const index=sources.findIndex(source=>source.source===value);const connection=render().filter(node=>node.type===row)[index+1];(connection.props.onOpen as ()=>void)();};
  const formState=(dirty:boolean,busy=false,effects=true)=>{const form=render().find(node=>node.type===participation||node.type===preference)!;(form.props.onStateChange as (state:unknown)=>void)({dirty,busy});render(effects);};
  const unload=()=>{const event=new Event('beforeunload',{cancelable:true});events.dispatchEvent(event);return event.defaultPrevented;};
  return {render,reads,open,close,hint,contact,reconnect,projects,errorLine,fundingReads,fundingNode,urls,reload,select,formState,modal,preference,busy,unload,navigate:(go:()=>void)=>guarded(go),focuses:()=>focuses};
}

test('an open Devices view coalesces owner hints and loads private explanations only for diagnostics',async()=>{
  const f=fixture();f.render();assert.equal(f.reads.length,1);
  f.reads[0].resolve([device]);await flush();f.render();
  for(let at=2;at<=10;at++)f.contact(at);
  assert.equal(f.reads.length,1,'live contact deltas do not reload an open Devices view');
  f.open();assert.equal(f.reads.length,2,'opening diagnostics requests same-row private evidence');
  f.reads[1].resolve([device]);await flush();
  f.hint();assert.equal(f.reads.length,3);
  f.reads[2].resolve([{...device,sessions:[session]}]);await flush();assert.deepEqual(f.projects(),['Current project']);
  f.hint();assert.equal(f.reads.length,4);
  f.reads[3].resolve([device]);await flush();assert.deepEqual(f.projects(),[]);
  f.reconnect();assert.equal(f.reads.length,5);
  f.reads[4].resolve([device]);await flush();f.close();assert.equal(f.reads.length,5);f.open();assert.equal(f.reads.length,6);
});

test('an obsolete device reply or error cannot restore a session after newer owner data',async()=>{
  const f=fixture();f.render();f.reads[0].resolve([device]);await flush();f.open();
  f.hint();f.hint();f.reads[3].resolve([device]);await flush();
  f.reads[2].resolve([{...device,sessions:[session]}]);await flush();assert.deepEqual(f.projects(),[]);
  f.hint();f.hint();f.reads[5].resolve([device]);await flush();f.reads[4].reject(new Error('obsolete failure'));await flush();
  assert.ok(!f.render().some(node=>node.type===f.errorLine&&node.props.error));
});

test('a mutation refresh waits for the newer owner read that supersedes it',async()=>{
  const f=fixture();f.render();f.reads[0].resolve([{...device,policy:{revision:0,enabled:true,collectors:{codex:{enabled:true}}} as Device['policy']}]);await flush();f.open();
  let completed=false;const refresh=f.reload()().then(()=>{completed=true;});
  f.hint();assert.equal(f.reads.length,3);
  f.reads[1].resolve([device]);await flush();assert.equal(completed,false,'an ignored old reply is not an authoritative refresh');
  f.reads[2].resolve([device]);await refresh;assert.equal(completed,true);
});


test('semantic refresh preserves a manual subscription choice and its open disclosure',async()=>{
  const f=fixture('codex:aaaaaaaaaaaa');f.render();f.reads[0].resolve([device]);await flush();f.render();
  f.select('codex:bbbbbbbbbbbb');f.hint();f.reads[1].resolve([device]);await flush();
  assert.equal((f.render().find(node=>node.type===f.preference)!.props.source as {source:string}).source,'codex:bbbbbbbbbbbb');
  assert.equal(f.focuses(),0,'metadata does not reclaim the navigation focus from the shared Modal');
});

test('a source dialog retains a draft on close or navigation and cannot close during its save',async()=>{
  const f=fixture('codex:aaaaaaaaaaaa');f.render();f.reads[0].resolve([device]);await flush();f.render();
  f.formState(true);f.close();
  assert.equal(f.render().filter(node=>node.type===f.modal).length,2,'closing asks before discarding the source draft');
  const stay=f.render().find(node=>node.type==='button'&&node.props.children==='connections.stay')!;(stay.props.onClick as ()=>void)();
  assert.equal(f.render().filter(node=>node.type===f.modal).length,1);
  f.formState(true,true);
  assert.equal(f.render().find(node=>node.type===f.modal)!.props.onClose,undefined);
  let left=false;f.navigate(()=>{left=true;});assert.equal(left,false,'navigation cannot abandon the pending authoritative refresh');
  f.formState(true,false);f.navigate(()=>{left=true;});assert.equal(left,false);
  const discard=f.render().find(node=>node.type==='button'&&node.props.children==='connections.discard')!;(discard.props.onClick as ()=>void)();
  assert.equal(left,true,'explicit discard permits the requested navigation');
});

test('navigation and unload guards protect the committed form before delayed effects run',async()=>{
  const f=fixture('codex:aaaaaaaaaaaa');f.render();f.reads[0].resolve([device]);await flush();f.render();
  f.formState(true,false,false);
  let left=false;f.navigate(()=>{left=true;});
  assert.equal(left,false,'navigation immediately after editing must see the draft');
  assert.equal(f.unload(),true,'closing the tab must see the same committed draft');
  f.formState(true,true,false);
  assert.equal(f.busy.at(-1),true,'connection segments lock with the form');
  f.navigate(()=>{left=true;});assert.equal(left,false);
  f.formState(false,false,false);
  assert.equal(f.busy.at(-1),false);assert.equal(f.unload(),false);
  f.navigate(()=>{left=true;});assert.equal(left,true);
});


test('private source names load only inside an open device and an obsolete reply cannot replace newer names', async () => {
  const f=fixture(); f.render(); f.reads[0].resolve([{...device,sessions:[session]}]); await flush();
  f.hint(); assert.equal(f.fundingReads.length,0);
  f.open(); assert.ok(f.urls.includes('/api/devices?measurement=1&details=d')); assert.equal(f.fundingReads.length,1); f.close(); f.open(); assert.equal(f.fundingReads.length,2);
  const inventory={links:[],sources:[],revision:'fresh'};
  f.fundingReads[1].resolve(inventory); await flush();
  assert.equal(f.render().find(node=>node.type===f.fundingNode)?.props.inventory,inventory);
  f.fundingReads[0].resolve({links:[],sources:[],revision:'obsolete'});await flush();
  assert.equal(f.render().find(node=>node.type===f.fundingNode)?.props.inventory,inventory);
  f.close();f.hint();assert.equal(f.fundingReads.length,2);
});
