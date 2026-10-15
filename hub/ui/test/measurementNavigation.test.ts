import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

type Node={type:string;key?:string;props:{children?:unknown}};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const compile=(source:string)=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;

test('only an accepted Devices navigation remounts the connection surface and its dialogs',()=>{
  const initial='/settings/connections?board=board&source=codex%3Aaaaaaaaaaaaa';
  let url=new URL('http://fixture.example'+initial),state:unknown=null;
  const route={URLSearchParams,exports:{} as {onLocation:(fn:()=>void)=>()=>void;useLocation:()=>string;useNavigationEntry:()=>number;navigate:(path:string)=>void;measurementDevicesHref:(source:string)=>string},
    get location(){return url;},window:new EventTarget(),
    history:{get state(){return state;},replaceState(value:unknown,_title:string,path:string){state=value;url=new URL(path,url);},pushState(value:unknown,_title:string,path:string){state=value;url=new URL(path,url);}},
    require:(name:string)=>name==='react'?{useSyncExternalStore:(_subscribe:unknown,get:()=>unknown)=>get()}:{flushLargeViews:async()=>{}},
  };
  runInNewContext(compile(readFileSync(new URL('../lib/router.ts',import.meta.url),'utf8')),route);
  const router=route.exports,stop=router.onLocation(()=>{});
  const context={URLSearchParams,exports:{} as {Settings:(props:unknown)=>Node},require:(name:string)=>{
    if(name==='react')return {useEffect:(fn:()=>void)=>fn()};
    if(name==='react/jsx-runtime')return {jsx:(type:string,props:Node['props'],key:string)=>({type,props,key}),jsxs:(type:string,props:Node['props'],key:string)=>({type,props,key})};
    if(name.endsWith('/router'))return router;
    if(name.endsWith('/board'))return {useApp:()=>null};
    if(name.endsWith('/app'))return {inApp:()=>false,settingsSections:()=>[]};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    return new Proxy({},{get:(_target,key)=>String(key)});
  }};
  runInNewContext(compile(readFileSync(new URL('../components/Settings.tsx',import.meta.url),'utf8')),context);
  const key=()=>nodes(context.exports.Settings({user:{id:'owner'},board:null,boards:[],local:false})).find(node=>node.type==='ConnectionsPage')!.key;
  // Execute the actual Dashboard receiving effect, including its null-destination branch.
  const main=readFileSync(new URL('../main.tsx',import.meta.url),'utf8'),start=main.indexOf('  useEffect(()=>{',main.indexOf('const nativeIntent=')),end=main.indexOf('  const active',start);
  let receive=()=>{};
  const native:{path:string;navigationRevision:number;nativeIntent:{revision:number;destination:{kind:string;sourceId:string}|null};useEffect:(fn:()=>void)=>void;navigate:typeof router.navigate;measurementDevicesHref:typeof router.measurementDevicesHref}={path:'/settings/connections',navigationRevision:0,nativeIntent:{revision:1,destination:{kind:'devices',sourceId:'codex:aaaaaaaaaaaa'}},useEffect:fn=>{receive=fn;},navigate:router.navigate,measurementDevicesHref:router.measurementDevicesHref};
  runInNewContext(compile(main.slice(start,end)),native);
  try {
    receive();const first=key();assert.ok(first);
    native.nativeIntent={revision:2,destination:null};receive();assert.equal(key(),first,'ordinary Open main preserves the current child draft and dialog');
    native.nativeIntent={revision:3,destination:{kind:'devices',sourceId:'codex:aaaaaaaaaaaa'}};receive();assert.notEqual(key(),first,'a repeated same-URL destination retires every old connection dialog and draft');
    assert.equal(url.searchParams.get('source'),'codex:aaaaaaaaaaaa');assert.equal(url.searchParams.get('board'),'board');
    const second=key();router.navigate('/settings/connections?board=board&source=codex%3Abbbbbbbbbbbb');assert.notEqual(key(),second);
  }finally{stop();}
});
