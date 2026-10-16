import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

type Node={type:string;key?:string;props:{children?:unknown}};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const compile=(source:string)=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;

function navigation() {
  const initial='/settings/connections?board=board&source=codex%3Aaaaaaaaaaaaa';
  let url=new URL('http://fixture.example'+initial),state:unknown=null;
  const route={URLSearchParams,exports:{} as {onLocation:(fn:()=>void)=>()=>void;useLocation:()=>string;useNavigationEntry:()=>number;guardNavigation:(guard:(go:()=>void)=>void,entries?:boolean)=>()=>void;navigate:(path:string,replace?:boolean)=>void;measurementDevicesHref:(source:string)=>string},
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
  return {router,key,native,receive:()=>receive(),stop,url:()=>url};
}

test('only an accepted Devices navigation remounts the connection surface and its dialogs',()=>{
  const {router,key,native,receive,stop,url}=navigation();
  try {
    receive();const first=key();assert.ok(first);
    native.nativeIntent={revision:2,destination:null};receive();assert.equal(key(),first,'ordinary Open main preserves the current child draft and dialog');
    native.nativeIntent={revision:3,destination:{kind:'devices',sourceId:'codex:aaaaaaaaaaaa'}};receive();assert.notEqual(key(),first,'a repeated same-URL destination retires every old connection dialog and draft');
    assert.equal(url().searchParams.get('source'),'codex:aaaaaaaaaaaa');assert.equal(url().searchParams.get('board'),'board');
    const second=key();router.navigate('/settings/connections?board=board&source=codex%3Abbbbbbbbbbbb');assert.notEqual(key(),second);
  }finally{stop();}
});

test('a repeated Devices destination confirms a dirty connection before retiring its dialogs',()=>{
  const f=navigation();let proceed:(()=>void)|undefined;
  try {
    f.receive();const first=f.key();
    const off=f.router.guardNavigation(go=>{proceed=go;},true);
    try {
      f.native.nativeIntent={revision:2,destination:{kind:'devices',sourceId:'codex:aaaaaaaaaaaa'}};f.receive();
      assert.ok(proceed,'the dirty form must decide even when the URL is unchanged');
      assert.equal(f.key(),first,'Stay preserves the current connection and draft');
      proceed();assert.notEqual(f.key(),first,'only confirmed discard retires the old connection');
    }finally{off();}
  }finally{f.stop();}
});

test('a repeated Devices destination cannot retire a connection while its save or read is pending',()=>{
  const f=navigation();let blocked=0;
  try {
    f.receive();const first=f.key();
    const off=f.router.guardNavigation(()=>{blocked++;},true);
    try {
      for(const revision of [2,3]) {
        f.native.nativeIntent={revision,destination:{kind:'devices',sourceId:'codex:aaaaaaaaaaaa'}};f.receive();
        assert.equal(f.key(),first,'POST and authoritative GET both retain the existing form');
      }
      assert.equal(blocked,2);
    }finally{off();}
    f.native.nativeIntent={revision:4,destination:{kind:'devices',sourceId:'codex:aaaaaaaaaaaa'}};f.receive();
    assert.notEqual(f.key(),first,'an explicit destination can open after saving finishes');
  }finally{f.stop();}
});

test('replacing the same history entry does not ask a connection to discard its draft',()=>{
  const f=navigation();let asked=0;
  const off=f.router.guardNavigation(()=>{asked++;},true);
  try {const first=f.key();f.router.navigate(f.url().pathname+f.url().search,true);assert.equal(asked,0);assert.equal(f.key(),first);}
  finally{off();f.stop();}
});

test('a form that survives same-URL entries keeps the existing navigation behavior',()=>{
  const f=navigation();let asked=0;
  const off=f.router.guardNavigation(()=>{asked++;});
  try {f.router.navigate(f.url().pathname+f.url().search);assert.equal(asked,0);}
  finally{off();f.stop();}
});
