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
  const passive:(()=>void)[]=[],states:{dirty:boolean;busy:boolean}[]=[];
  const onStateChange=(state:{dirty:boolean;busy:boolean})=>{states.push({...state});};
  const useEffect=(effect:()=>void|(()=>void),deps:unknown[])=>hooks.useLayoutEffect(()=>{
    let active=true,cleanup:(()=>void)|undefined;
    passive.push(()=>{if(active){const stop=effect();if(typeof stop==='function')cleanup=stop;}});
    return()=>{active=false;cleanup?.();};
  },deps);
  let refreshed=()=>{},failed=(_error:Error)=>{},reads=0;
  const source={source:'codex:0123456789ab',preference:{kind:'auto',revision:0,device:null as string|null},candidates:[{device:'a',reason:'eligible'},{device:'b',reason:'eligible'}],origins:[],duty:'none'};
  const device={id:'a',policy:{revision:0,enabled:true,collectors:Object.fromEntries(['claude','codex','antigravity'].map(id=>[id,{enabled:true}]))}};
  const reload=()=>{reads++;return new Promise<void>((resolve,reject)=>{refreshed=()=>{
    const selected=posts.at(-1)!.body.desired;
    source.preference={kind:selected===null?'auto':'preferred',revision:source.preference.revision+1,device:selected};
    device.policy={...device.policy,revision:1,enabled:false};resolve();
  };failed=reject;});};
  const context={crypto:{randomUUID:()=>`operation-${posts.length}`},exports:{} as Record<string,(props:any)=>unknown>,require:(name:string)=>{
    if(name==='react')return {useRef:hooks.useRef,useState:hooks.useState,useEffect,useLayoutEffect:hooks.useLayoutEffect};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'fragment'};
    if(name.endsWith('/providers'))return {clientProviders:['claude','codex','antigravity']};
    if(name.endsWith('/clients'))return {clientName:(id:string)=>id};
    if(name.endsWith('/http'))return {call:(method:string,_path:string,body:any)=>{assert.equal(method,'POST');return new Promise(resolve=>posts.push({body,resolve}));}};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    return {};
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MeasurementDevices.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=(effects=true)=>{hooks.begin();const tree=nodes(kind==='preference'?context.exports.PreferenceSettings({source,devices:[],reload,onStateChange}):context.exports.ParticipationSettings({device,reload,onStateChange}));hooks.commit();if(effects)passive.splice(0).forEach(run=>run());return tree;};
  const edit=()=>{const tree=render();const control=tree.find(node=>node.type===(kind==='preference'?'select':'input'))!;control.props.onChange({target:kind==='preference'?{value:'a'}:{checked:false}});};
  const submit=()=>render().find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}}) as Promise<void>;
  const locked=()=>render().find(node=>node.type==='fieldset')!.props.disabled;
  const value=()=>{const tree=render();return kind==='preference'?tree.find(node=>node.type==='select')!.props.value:tree.find(node=>node.type==='input')!.props.checked;};
  render();return {source,render,edit,submit,locked,value,posts,states,reads:()=>reads,refresh:()=>refreshed(),fail:(error:Error)=>failed(error)};
}

test('a disconnected preference remains visible and can be explicitly cleared',async()=>{
  const f=fixture('preference');
  f.source.preference={kind:'preferred',revision:1,device:'a'};
  f.source.candidates=f.source.candidates.filter(candidate=>candidate.device!=='a');
  f.render();
  const tree=f.render(),select=tree.find(node=>node.type==='select')!;
  assert.equal(select.props.value,'a');
  assert.ok(tree.some(node=>node.type==='option'&&node.props.value==='a'&&node.props.disabled),'the current unavailable choice must not silently display Auto');
  select.props.onChange({target:{value:'auto'}});
  assert.equal(f.render().find(node=>node.type==='button')!.props.disabled,false);
  const saving=f.submit();assert.equal(f.posts[0].body.desired,null);assert.equal(f.posts[0].body.expectedRevision,1);
  f.posts[0].resolve({});await flush();f.refresh();await saving;f.render();assert.equal(f.value(),'auto');
});

for(const kind of ['preference','participation'] as const) {
  test(`${kind} protects edits and saving before delayed effects run`,async()=>{
    const f=fixture(kind);f.edit();f.render(false);
    assert.equal(f.states.at(-1)?.dirty,true,'Escape immediately after editing must see the draft');
    const saving=f.submit();f.render(false);
    assert.equal(f.states.at(-1)?.busy,true,'the dialog must lock before another input can close it');
    f.posts[0].resolve({});await flush();f.render(false);
    assert.equal(f.states.at(-1)?.busy,true,'the authoritative read keeps the dialog locked');
    f.refresh();await saving;f.render(false);
    assert.equal(f.states.at(-1)?.busy,false);
    assert.equal(f.states.at(-1)?.dirty,false);
  });

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
