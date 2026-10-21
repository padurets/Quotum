import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as category from '../../server/domain/categoryColors';
import * as model from '../../server/domain/projectColors';
import {projectColorReply} from '../lib/projectColors';
import {INITIAL,reduce,type Snapshot} from '../lib/board';
import {createStore} from '../lib/store';
import {ApiError} from '../lib/http';
import {preparationFixture} from './preparationFixture';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value,...nodes(value.props.children)]:[];
const jsx={jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props})};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const initial:model.ProjectColorEnvelope={version:1,pins:[],revision:0,authority:'a'.repeat(43)};
const view={version:5 as const,layout:{columns:6,places:{}},names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{}};
const snapshot:Snapshot={board:{id:'board',name:'Board',personal:true},view,historyStart:0,workAuthority:'work',sources:[],sessions:{},cadence:{},refresh:{},forecast:{},mine:[],boards:[],resets:{resets:{},trackers:[],past:{}},projectColors:initial,projectColorsRevision:0,projectColorsAuthority:initial.authority};

function settingsFixture(){
  const hooks=preparationFixture(),page=createStore(reduce,INITIAL),requests:any[]=[];
  page.dispatch({type:'hub',event:{type:'snapshot',data:snapshot}});
  const modules:Record<string,any>={react:{...hooks,useEffect:hooks.useLayoutEffect,useId:()=> 'radio'},'react/jsx-runtime':jsx,
    '../../server/domain/categoryColors':category,'../../server/domain/projectColors':model,'../lib/projectColors':{projectColorReply},
    '../lib/board':{page,useProjectColorEnvelope:()=>page.get().board?.projectColors??null,useProjectColorGeneration:()=>page.get().projectColorsGeneration??0,useWorkAuthority:()=>page.get().board?.workAuthority},
    '../lib/http':{ApiError,call:(method:string,url:string,body:unknown,_timeout:number,signal:AbortSignal,headers:unknown)=>new Promise((resolve,reject)=>requests.push({method,url,body,signal,headers,resolve,reject}))},
    '../i18n':{t:(key:string)=>key},'./Kit':{ErrorLine:'ErrorLine',Field:'Field',Modal:'Modal'},'./Popover':{Popover:'Popover'}};
  const context={AbortController,URLSearchParams,exports:{} as any,require:(name:string)=>{if(!(name in modules))throw new Error(name);return modules[name];}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/ProjectColors.tsx',import.meta.url),'utf8')+'\nexport {Picker};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const board={id:'board',name:'Board',personal:true,role:'owner'};
  const render=()=>{hooks.begin();const tree=context.exports.ProjectColors({board});hooks.commit();return nodes(tree);};
  const resolveListing=async(projects:string[])=>{const request=requests.at(-1)!;request.resolve({projects,authority:page.get().board!.projectColors!.authority});await flush();};
  const picker=(tree:Node[])=>tree.find(node=>node.type===context.exports.Picker)!;
  return {page,board,requests,render,resolveListing,picker};
}

test('the settings picker sends one explicit patch, adopts its authoritative reply and serializes writes',async()=>{
  const f=settingsFixture();f.render();assert.equal(f.requests.length,1);await f.resolveListing(['A','B']);
  const save=f.picker(f.render()).props.save('#5e81ac');
  assert.equal(f.requests[1].method,'PUT');assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].body)),{version:1,authority:initial.authority,project:'A',color:'#5e81ac'});
  assert.equal(f.picker(f.render()).props.disabled,true);
  await f.picker(f.render()).props.save('#bf616a');assert.equal(f.requests.length,2,'a pending write cannot be overtaken');
  f.requests[1].resolve({...initial,revision:1,pins:[['A','#5e81ac']]});await save;
  assert.deepEqual(f.page.get().board!.projectColors!.pins,[['A','#5e81ac']]);
  assert.equal(f.picker(f.render()).props.disabled,false);
});

test('revocation aborts settings requests and a late save cannot restore a private row or pin',async()=>{
  const f=settingsFixture();f.render();await f.resolveListing(['private-canary']);const save=f.picker(f.render()).props.save('#bf616a');
  f.page.dispatch({type:'hub',event:{type:'snapshot',data:{...snapshot,workAuthority:'revoked',projectColorsAuthority:'b'.repeat(43),projectColors:{...initial,authority:'b'.repeat(43)}}}});
  const retired=f.render();assert.equal(retired.some(node=>node.type==='li'),false);assert.equal(f.requests[1].signal.aborted,true);
  f.requests[1].resolve({...initial,revision:1,pins:[['private-canary','#bf616a']]});await save;
  assert.deepEqual(f.page.get().board!.projectColors!.pins,[]);
});

test('an owner can reset an empty public map and a stale confirmation requires a new intent',async()=>{
  const f=settingsFixture();let tree=f.render();
  const reset=tree.find(node=>node.type==='button'&&node.props.children==='projectColors.reset')!;assert.equal(reset.props.disabled,false);
  reset.props.onClick();tree=f.render();
  let modal=tree.find(node=>node.type==='Modal')!;
  assert.equal(nodes(modal).find(node=>node.type==='button')!.props.autoFocus,true);
  const newer={...initial,revision:1};f.page.dispatch({type:'hub',event:{type:'board',data:{projectColorsRevision:1,projectColorsAuthority:initial.authority}}});f.page.dispatch({type:'hub',event:{type:'projectColors',data:newer}});
  tree=f.render();modal=tree.find(node=>node.type==='Modal')!;nodes(modal).find(node=>node.type==='button'&&node.props.children==='projectColors.reset')!.props.onClick();
  const request=f.requests.find(request=>request.method==='POST')!;assert.equal(request.headers['If-Match'],'"0"');assert.deepEqual(Object.keys(request.body).sort(),['authority','version']);
  request.reject(new ApiError(409,'project_colors_conflict',{error:'project_colors_conflict',...newer}));await flush();
  modal=f.render().find(node=>node.type==='Modal')!;
  assert.equal(nodes(modal).find(node=>node.type==='button'&&node.props.children==='projectColors.reset')!.props.disabled,true);
  assert.equal(f.requests.filter(request=>request.method==='POST').length,1);
});

test('members see saved colours without mutation controls',async()=>{
  const f=settingsFixture();f.board.role='member';f.render();await f.resolveListing(['A']);
  const tree=f.render();assert.equal(f.picker(tree),undefined);
  assert.equal(tree.some(node=>node.type==='button'&&node.props.children==='projectColors.reset'),false);
  assert.equal(tree.filter(node=>node.type==='li').length,1);
});

test('project colour settings are reachable on personal and local boards while local sharing stays closed',()=>{
  let path='/boards/board/settings/project-colors';
  const modules:Record<string,any>={react:{useEffect:()=>{},useState:()=>[],},'react/jsx-runtime':jsx,'../i18n':{t:(key:string)=>key},'../lib/http':{},
    '../lib/router':{useLocation:()=>path,useNavigationEntry:()=>0,settingsHref:(value:string)=>value},'../lib/session':{boardTitle:()=> 'Board'},'../lib/app':{inApp:()=>true,settingsSections:()=>[]},'../lib/board':{useApp:()=>null},'./ProjectColors':{ProjectColors:'ProjectColors'}};
  const context={exports:{} as any,require:(name:string)=>modules[name]??{}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/Settings.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const props={user:{id:'owner'},board:{id:'board',personal:true,role:'owner'},boards:[],local:true};
  const local=context.exports.Settings(props);assert.deepEqual(JSON.parse(JSON.stringify(local.props.sections.map((section:any)=>section.id))),['project-colors']);assert.equal(local.props.children.type,'ProjectColors');
  path='/boards/board/settings/members';assert.equal(context.exports.Settings(props).type,'main');
  path='/boards/board/settings/project-colors';const personal=context.exports.Settings({...props,local:false});assert.deepEqual(JSON.parse(JSON.stringify(personal.props.sections.map((section:any)=>section.id))),['general','project-colors']);
});
