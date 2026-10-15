import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

function fixture(kind:'preference'|'participation') {
  const hooks=preparationFixture(),posts:{body:any;resolve:(value:unknown)=>void}[]=[];
  let refreshed=()=>{},failed=(_error:Error)=>{},reads=0;
  const source={source:'codex:0123456789ab',preference:{kind:'auto',revision:0},candidates:[{device:'a',reason:'eligible'},{device:'b',reason:'eligible'}],origins:[],duty:'none'};
  const device={id:'a',policy:{revision:0,enabled:true,collectors:Object.fromEntries(['claude','codex','antigravity'].map(id=>[id,{enabled:true}]))}};
  const reload=()=>{reads++;return new Promise<void>((resolve,reject)=>{refreshed=()=>{
    source.preference={kind:'preferred',revision:1,device:'a'} as typeof source.preference;
    device.policy={...device.policy,revision:1,enabled:false};resolve();
  };failed=reject;});};
  const context={crypto:{randomUUID:()=>`operation-${posts.length}`},exports:{} as Record<string,(props:any)=>unknown>,require:(name:string)=>{
    if(name==='react')return {useRef:hooks.useRef,useState:hooks.useState,useEffect:hooks.useLayoutEffect};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'fragment'};
    if(name.endsWith('/providers'))return {clientProviders:['claude','codex','antigravity']};
    if(name.endsWith('/clients'))return {clientName:(id:string)=>id};
    if(name.endsWith('/http'))return {call:(method:string,_path:string,body:any)=>{assert.equal(method,'POST');return new Promise(resolve=>posts.push({body,resolve}));}};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    return {};
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MeasurementDevices.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{hooks.begin();const tree=nodes(kind==='preference'?context.exports.PreferenceSettings({source,devices:[],reload}):context.exports.ParticipationSettings({device,reload}));hooks.commit();return tree;};
  const edit=()=>{const tree=render();const control=tree.find(node=>node.type===(kind==='preference'?'select':'input'))!;control.props.onChange({target:kind==='preference'?{value:'a'}:{checked:false}});};
  const submit=()=>render().find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}}) as Promise<void>;
  const locked=()=>render().find(node=>node.type==='fieldset')!.props.disabled;
  const value=()=>{const tree=render();return kind==='preference'?tree.find(node=>node.type==='select')!.props.value:tree.find(node=>node.type==='input')!.props.checked;};
  render();return {render,edit,submit,locked,value,posts,reads:()=>reads,refresh:()=>refreshed(),fail:(error:Error)=>failed(error)};
}

for(const kind of ['preference','participation'] as const) {
  test(`${kind} keeps edits locked through the write and authoritative refresh`,async()=>{
    const f=fixture(kind);f.edit();const saving=f.submit();assert.equal(f.locked(),true);
    f.posts[0].resolve({});await flush();assert.equal(f.reads(),1);assert.equal(f.locked(),true,'POST acknowledgement alone does not end Save');
    f.refresh();await saving;f.render();assert.equal(f.locked(),false);assert.equal(f.value(),kind==='preference'?'a':false);
    const control=f.render().find(node=>node.type===(kind==='preference'?'select':'input'))!;
    control.props.onChange({target:kind==='preference'?{value:'b'}:{checked:true}});f.render();
    assert.equal(f.value(),kind==='preference'?'b':true,'the next draft survives completion of the earlier Save');
  });

  test(`${kind} retries an acknowledged write with the same receipt after a failed refresh`,async()=>{
    const f=fixture(kind);f.edit();const first=f.submit();f.posts[0].resolve({});await flush();f.fail(new Error('read unavailable'));await first;
    assert.equal(f.value(),kind==='preference'?'a':false,'the unconfirmed projection keeps the draft');
    const retry=f.submit();assert.equal(f.posts[1].body.operationId,f.posts[0].body.operationId);assert.equal(f.posts[1].body.expectedRevision,0);
    f.posts[1].resolve({});await flush();f.refresh();await retry;assert.equal(f.locked(),false);
  });
}
