import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const compile=(file:string)=>ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;

function fixture(path:string,local=false) {
  let url=new URL('http://fixture.example'+path),state:unknown=null;
  const route={URLSearchParams,exports:{} as {onLocation:(fn:()=>void)=>()=>void;useLocation:()=>string;useNavigationEntry:()=>number;navigate:(path:string,replace?:boolean)=>void},
    get location(){return url;},window:new EventTarget(),
    history:{get state(){return state;},replaceState(value:unknown,_title:string,path:string){state=value;url=new URL(path,url);},pushState(value:unknown,_title:string,path:string){state=value;url=new URL(path,url);}},
    require:(name:string)=>name==='react'?{useSyncExternalStore:(_subscribe:unknown,get:()=>unknown)=>get()}:{flushLargeViews:async()=>{}},
  };
  runInNewContext(compile('../lib/router.ts'),route);
  const stop=route.exports.onLocation(()=>{}),hooks=preparationFixture();
  const context={URLSearchParams,exports:{} as {ConnectionsPage:(props:unknown)=>unknown},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useId:()=> 'connection-tabs'};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'fragment'};
    if(name.endsWith('/router'))return route.exports;
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    if(name==='./Machines')return {Devices:'devices',DeviceTokens:'tokens'};
    if(name==='./Kit')return {Segmented:'segments'};
    return {};
  }};
  runInNewContext(compile('../components/ConnectionsPage.tsx'),context);
  const render=()=>{hooks.begin();const result=nodes(context.exports.ConnectionsPage({userId:'owner',boards:[],local}));hooks.commit();return result;};
  const segments=()=>render().find(node=>node.type==='segments')!;
  return {render,segments,stop,url:()=>url,entry:()=>route.exports.useNavigationEntry()};
}

test('connection segments keep board context, retire hidden data readers and preserve the keyboard entry',()=>{
  const f=fixture('/settings/connections?board=team&from=10&to=20');
  try {
    assert.equal(f.segments().props.value,'accounts');
    assert.ok(f.render().some(node=>typeof node.type==='function'&&node.type.name==='ProviderConnections'));
    assert.ok(!f.render().some(node=>node.type==='devices'||node.type==='tokens'));
    const entry=f.entry();f.segments().props.onChange('devices');
    assert.equal(f.url().searchParams.get('tab'),'devices');
    assert.equal(f.url().searchParams.get('board'),'team');assert.equal(f.url().searchParams.get('from'),'10');assert.equal(f.url().searchParams.get('to'),'20');
    assert.equal(f.entry(),entry,'segment changes replace the query without remounting the focused shared control');
    assert.ok(f.render().some(node=>node.type==='devices'));
    assert.ok(!f.render().some(node=>typeof node.type==='function'||node.type==='tokens'));
    f.segments().props.onChange('tokens');
    assert.ok(f.render().some(node=>node.type==='tokens'));
    assert.ok(!f.render().some(node=>node.type==='devices'),'hidden Devices unmounts its owner read and semantic-event subscription');
  }finally{f.stop();}
});

test('a contextual subscription entry selects Devices directly and manual navigation clears its target',()=>{
  const f=fixture('/settings/connections?source=codex%3Aaaaaaaaaaaaa&board=team');
  try {
    assert.equal(f.segments().props.value,'devices');
    assert.ok(f.render().some(node=>node.type==='devices'));
    f.segments().props.onChange('accounts');
    assert.equal(f.url().searchParams.has('source'),false);
    assert.equal(f.segments().props.value,'accounts');
    assert.equal(f.url().searchParams.get('board'),'team');
  }finally{f.stop();}
});

test('a pending device write and authoritative read disable all connection segments',()=>{
  const f=fixture('/settings/connections?tab=devices');
  try {
    f.render().find(node=>node.type==='devices')!.props.onBusyChange(true);
    assert.equal(f.segments().props.disabled,true);
    f.render().find(node=>node.type==='devices')!.props.onBusyChange(false);
    assert.equal(f.segments().props.disabled,false);
  }finally{f.stop();}
});

test('local connections omit Tokens even when its query is requested',()=>{
  const f=fixture('/settings/connections?tab=tokens',true);
  try {
    assert.deepEqual(Array.from(f.segments().props.options,(option:string[])=>option[0]),['accounts','devices']);
    assert.equal(f.segments().props.value,'accounts');
    assert.ok(!f.render().some(node=>node.type==='tokens'));
    f.segments().props.onChange('devices');
    assert.equal(f.render().find(node=>node.type==='devices')!.props.local,true);
  }finally{f.stop();}
});
