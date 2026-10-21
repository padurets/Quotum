import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as category from '../../server/domain/categoryColors';
import * as model from '../../server/domain/projectColors';
import * as projectRules from '../lib/projects';
import {projectColorReply} from '../lib/projectColors';
import {INITIAL,reduce,type Snapshot} from '../lib/board';
import {createStore} from '../lib/store';
import {ApiError} from '../lib/http';
import {preparationFixture} from './preparationFixture';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value,...nodes(value.props.children)]:[];
const jsx={jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props})};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const initial:model.ProjectColorEnvelope={version:1,pins:[],revision:0,authority:'a'.repeat(43)};
const view={version:5 as const,layout:{columns:6,places:{}},names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{}};
const snapshot:Snapshot={board:{id:'board',name:'Board',personal:true},view,historyStart:0,workAuthority:'work',sources:[],sessions:{},cadence:{},refresh:{},forecast:{},mine:[],boards:[],resets:{resets:{},trackers:[],past:{}},projectColors:initial,projectColorsRevision:0,projectColorsAuthority:initial.authority};
const project={name:'A',reported:['A'],machines:[],lastAt:1,canRename:true,colorAllowed:true};

function fixture(file='Projects',component='Projects'){
  const hooks=preparationFixture(),page=createStore(reduce,INITIAL),requests:any[]=[];
  class FocusElement {
    constructor(private project:string|null=null){}
    closest(){return this.project===null?null:this;}
    getAttribute(){return this.project;}
  }
  const listeners=new Map<string,Set<(event:{target:FocusElement;key?:string})=>void>>();
  const document={body:new FocusElement(),documentElement:new FocusElement(),
    addEventListener:(type:string,listen:(event:{target:FocusElement;key?:string})=>void)=>{let set=listeners.get(type);if(!set)listeners.set(type,set=new Set());set.add(listen);},
    removeEventListener:(type:string,listen:(event:{target:FocusElement;key?:string})=>void)=>listeners.get(type)?.delete(listen),
  };
  page.dispatch({type:'hub',event:{type:'snapshot',data:snapshot}});
  const modules:Record<string,any>={react:{...hooks,useEffect:hooks.useLayoutEffect,useId:()=> 'radio',useCallback:(fn:unknown,deps:unknown[])=>hooks.useMemo(()=>fn,deps)},'react/jsx-runtime':jsx,
    '../../server/domain/categoryColors':category,'../../server/domain/projectColors':model,'../lib/projectColors':{projectColorReply},'../lib/projects':projectRules,
    '../lib/board':{page,useProjectColorEnvelope:()=>page.get().board?.projectColors??null,useProjectColorGeneration:()=>page.get().projectColorsGeneration??0,useWorkAuthority:()=>page.get().board?.workAuthority},
    '../lib/http':{ApiError,call:(method:string,url:string,body:unknown,_timeout:number,signal:AbortSignal,headers:unknown)=>new Promise((resolve,reject)=>requests.push({method,url,body,signal,headers,resolve,reject}))},
    '../i18n':{t:(key:string)=>key},'../lib/session':{boardTitle:()=> 'Board'},'../lib/format':{stamp:()=> 'time'},'lucide-react':{Pencil:'Pencil'},'./Time':{Ago:'Ago'},'./Kit':{ErrorLine:'ErrorLine',Field:'Field',Modal:'Modal'},'./Popover':{Popover:'Popover'},};
  const context={AbortController,URLSearchParams,document,Element:FocusElement,exports:{} as any,require:(name:string)=>{if(!(name in modules))throw new Error(name);return modules[name];}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/'+file+'.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const board={id:'board',name:'Board',personal:true,role:'owner'};
  const render=(props:Record<string,unknown>={})=>{hooks.begin();const tree=context.exports[component]({board,...props});hooks.commit();return nodes(tree);};
  const resolveListing=async(projects=[project])=>{requests.at(-1)!.resolve({projects,authority:page.get().board!.projectColors!.authority,keptDays:30});await flush();};
  const native=(type:string,target=document.body,key?:string)=>{for(const listen of [...listeners.get(type)??[]])listen({target,key});};
  return {page,board,requests,render,resolveListing,editor:context.exports.ProjectEditor,native,element:(project:string|null=null)=>new FocusElement(project)};
}

const palette=(f:ReturnType<typeof fixture>,colors:model.ProjectColorEnvelope)=>{
  f.page.dispatch({type:'hub',event:{type:'board',data:{projectColorsRevision:colors.revision,projectColorsAuthority:colors.authority}}});
  f.page.dispatch({type:'hub',event:{type:'projectColors',data:colors}});
};

async function openDraft(){
  const f=fixture(),before={...initial,revision:1,pins:[['A',category.CATEGORY_COLORS[7]]] as model.ProjectColorPins};
  palette(f,before);f.render();await f.resolveListing();
  const row=f.render().find(node=>node.type===f.editor)!,popup=fixture('Projects','ProjectEditor');
  let tree=popup.render(row.props);tree.find(node=>node.type==='Popover')!.props.onOpenChange(true);popup.render(row.props);
  const newer={...before,revision:2,pins:[['A',category.CATEGORY_COLORS[1]]] as model.ProjectColorPins};
  palette(f,newer);
  const props=f.render().find(node=>node.type===f.editor)!.props;
  tree=popup.render(props);
  return {f,popup,props,tree,newer};
}

test('the existing project list saves name and colour in one request and serializes writes',async()=>{
  const f=fixture();f.render();assert.ok(f.requests[0].url.startsWith('/api/projects?board=board'));await f.resolveListing();
  const editor=f.render().find(node=>node.type===f.editor)!;
  const save=editor.props.save('B','#5e81ac');assert.equal(f.requests[1].method,'PUT');
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].body)),{version:1,authority:initial.authority,project:'A',name:'B',color:'#5e81ac'});
  await editor.props.save('C','#bf616a');assert.equal(f.requests.length,2);
  f.requests[1].resolve({...initial,revision:1,pins:[['B','#5e81ac']]});await flush();await f.resolveListing([{...project,name:'B'}]);await save;
  assert.deepEqual(f.page.get().board!.projectColors!.pins,[['B','#5e81ac']]);
});

test('one popup contains the name and ten native colour choices and saves only on submit',async()=>{
  const f=fixture('Projects','ProjectEditor'),calls:any[]=[];
  const props={project,color:null,canColor:true,disabled:false,save:async(...values:unknown[])=>{calls.push(values);}};
  let tree=f.render(props);tree.find(node=>node.type==='Popover')!.props.onOpenChange(true);tree=f.render(props);
  tree.find(node=>node.type==='Field')!.props.onChange({target:{value:'Renamed'}});
  const radios=tree.filter(node=>node.type==='input'&&node.props.type==='radio');assert.equal(radios.length,10);radios[8].props.onChange();
  assert.equal(calls.length,0);tree=f.render(props);await tree.find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}});
  assert.deepEqual(calls,[['Renamed',category.CATEGORY_COLORS[7]]]);assert.equal(f.render(props).filter(node=>node.type==='Popover').length,1);
});

test('saving an unchanged open draft preserves a colour changed elsewhere',async()=>{
  const {f,tree,newer}=await openDraft();
  const submit=tree.find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}});await flush();
  assert.equal(f.requests[1].method,'GET');assert.equal(f.requests.filter(request=>request.method==='PUT').length,0);
  await f.resolveListing();await submit;
  assert.deepEqual(f.page.get().board!.projectColors!.pins,newer.pins);
});

test('a name-only open draft retains its original CAS instead of adopting an event revision',async()=>{
  const {f,popup,props,tree,newer}=await openDraft();
  tree.find(node=>node.type==='Field')!.props.onChange({target:{value:'B'}});
  const submit=popup.render(props).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}});await flush();
  const request=f.requests[1];assert.equal(request.method,'PUT');assert.equal(request.headers['If-Match'],'"1"');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)),{version:1,authority:initial.authority,project:'A',name:'B'});
  request.reject(new ApiError(409,'project_colors_conflict',{error:'project_colors_conflict',...newer}));await submit;
  assert.ok(popup.render(props).some(node=>node.type==='ErrorLine'&&node.props.error instanceof ApiError));
  assert.deepEqual(f.page.get().board!.projectColors!.pins,newer.pins);
  popup.render(props).find(node=>node.type==='Popover')!.props.onOpenChange(false);
  popup.render(props).find(node=>node.type==='Popover')!.props.onOpenChange(true);
  popup.render(props).find(node=>node.type==='Field')!.props.onChange({target:{value:'B'}});
  const retry=popup.render(props).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}});await flush();
  assert.equal(f.requests[2].headers['If-Match'],'"2"');
  assert.equal(f.requests[2].body.color,undefined);
  f.requests[2].resolve({...newer,revision:3,pins:[['B',category.CATEGORY_COLORS[1]]]});await flush();
  await f.resolveListing([{...project,name:'B'}]);await retry;
});

test('the combined project writer preserves an exact ending-space target',async()=>{
  const f=fixture();f.render();await f.resolveListing();
  const row=f.render().find(node=>node.type===f.editor)!;
  const save=row.props.save('B ',null);
  assert.equal(f.requests[1].method,'PUT');assert.equal(f.requests[1].body.name,'B ');
  f.requests[1].resolve(initial);await flush();await f.resolveListing([{...project,name:'B '}]);await save;
});

test('a save completing after reconnect leaves the new listing request and baseline intact',async()=>{
  const f=fixture();f.render();await f.resolveListing();
  const save=f.render().find(node=>node.type===f.editor)!.props.save('B',null);
  f.page.dispatch({type:'hub',event:{type:'hello',data:{epoch:'reconnected'}}});
  f.page.dispatch({type:'hub',event:{type:'snapshot',data:snapshot}});
  f.page.dispatch({type:'hub',event:{type:'projectColors',data:initial}});
  f.render();f.render();const current=f.requests[2];
  f.requests[1].resolve({...initial,revision:1});await flush();
  assert.equal(current.signal.aborted,false);
  assert.equal(f.requests.length,3,'a retired write must not start a stale listing');
  await save;
  await f.resolveListing([{...project,name:'Z'}]);
  assert.deepEqual(f.render().filter(node=>node.type===f.editor).map(node=>node.props.project.name),['Z']);
  assert.equal(f.page.get().board!.projectColors!.revision,0);
});

test('a late save refreshes the current search rather than restoring its captured query',async()=>{
  const f=fixture();f.render();await f.resolveListing();
  const save=f.render().find(node=>node.type===f.editor)!.props.save('B',null);
  f.render().find(node=>node.type==='input'&&node.props['aria-label']==='projectColors.search')!.props.onChange({target:{value:'Z'}});
  f.render().find(node=>node.type==='form'&&node.props.className==='project-search')!.props.onSubmit({preventDefault(){}});
  f.render();f.render();
  f.requests[1].resolve({...initial,revision:1});await flush();
  const refresh=f.requests.at(-1)!;
  assert.equal(new URL(refresh.url,'http://hub').searchParams.get('query'),'Z');
  await f.resolveListing([{...project,name:'Z'}]);await save;
  const tree=f.render();
  assert.equal(tree.find(node=>node.type==='input'&&node.props['aria-label']==='projectColors.search')!.props.value,'Z');
  assert.deepEqual(tree.filter(node=>node.type===f.editor).map(node=>node.props.project.name),['Z']);
});

function searchFor(f:ReturnType<typeof fixture>,value:string){
  f.render().find(node=>node.type==='input'&&node.props['aria-label']==='projectColors.search')!.props.onChange({target:{value}});
  f.render().find(node=>node.type==='form'&&node.props.className==='project-search')!.props.onSubmit({preventDefault(){}});
  f.render();f.render();
}

test('a rename outside the current query returns focus to search without stealing it on a later search',async()=>{
  const f=fixture();f.render();await f.resolveListing();searchFor(f,'A');await f.resolveListing();
  let searches=0;
  const field=f.render().find(node=>node.type==='input'&&node.props['aria-label']==='projectColors.search')!;
  if(field.props.ref)field.props.ref.current={focus:()=>{searches++;}};
  const save=f.render().find(node=>node.type===f.editor)!.props.save('B',null);
  f.requests.at(-1)!.resolve({...initial,revision:1});await flush();await f.resolveListing([]);await save;f.render();f.render();
  assert.equal(searches,1,'a filtered-out rename returns the keyboard to the current search');
  searchFor(f,'B');await f.resolveListing([{...project,name:'B'}]);
  assert.equal(f.render().find(node=>node.type===f.editor)!.props.focus,0,'the completed save cannot focus a result of a later independent search');
});

test('a new search retires the focus intent of a pending save even when its target becomes visible',async()=>{
  const f=fixture();f.render();await f.resolveListing();
  const save=f.render().find(node=>node.type===f.editor)!.props.save('B',null),write=f.requests.at(-1)!;
  searchFor(f,'B');await f.resolveListing([{...project,name:'B'}]);
  write.resolve({...initial,revision:1});await flush();await f.resolveListing([{...project,name:'B'}]);await save;
  f.render();assert.equal(f.render().find(node=>node.type===f.editor)!.props.focus,0);
});

test('a visible renamed row retains its explicit post-save keyboard focus',async()=>{
  const f=fixture();f.render();await f.resolveListing();
  const save=f.render().find(node=>node.type===f.editor)!.props.save('B',null);
  f.requests.at(-1)!.resolve({...initial,revision:1});await flush();await f.resolveListing([{...project,name:'B'}]);await save;
  f.render();assert.ok(f.render().find(node=>node.type===f.editor)!.props.focus>0);
  searchFor(f,'A');await f.resolveListing([]);
  searchFor(f,'B');await f.resolveListing([{...project,name:'B'}]);
  assert.equal(f.render().find(node=>node.type===f.editor)!.props.focus,0,'an applied focus token cannot be replayed when a later search remounts the row');
});

test('a replaced post-save reload cannot consume keyboard focus using the previous rows',async()=>{
  const f=fixture();f.render();await f.resolveListing();
  let searches=0;
  f.render().find(node=>node.type==='input'&&node.props['aria-label']==='projectColors.search')!.props.ref.current={focus:()=>{searches++;}};
  const save=f.render().find(node=>node.type===f.editor)!.props.save('B',category.CATEGORY_COLORS[1]);
  f.requests.at(-1)!.resolve({...initial,authority:'b'.repeat(43),revision:1,pins:[['B',category.CATEGORY_COLORS[1]]]});await flush();
  const replaced=f.requests.at(-1)!;
  f.render();f.render();assert.equal(replaced.signal.aborted,true,'adopting the renamed colour authority replaces the awaited loader');
  replaced.reject(new Error('aborted'));await save;f.render();
  assert.equal(searches,0,'an aborted reload cannot treat the old row list as a missing rename target');
  await f.resolveListing([{...project,name:'B'}]);f.render();
  assert.ok(f.render().find(node=>node.type===f.editor)!.props.focus>0,'only the successful current loader lands the rename');
});

const renamedSnapshot=(f:ReturnType<typeof fixture>,workAuthority='after-own-rename')=>{
  const colors=f.page.get().board!.projectColors!;
  f.page.dispatch({type:'hub',event:{type:'snapshot',data:{...snapshot,workAuthority,projectColors:undefined,projectColorsRevision:colors.revision,projectColorsAuthority:colors.authority}}});
  f.page.dispatch({type:'hub',event:{type:'projectColors',data:colors}});
  f.render();f.render();
};

test('a late own-rename work snapshot preserves the landed keyboard context through row replacement',async()=>{
  const f=fixture();f.render();await f.resolveListing();searchFor(f,'');await f.resolveListing();
  const save=f.render().find(node=>node.type===f.editor)!.props.save('B',null);
  f.requests.at(-1)!.resolve({...initial,revision:1});await flush();await f.resolveListing([{...project,name:'B'}]);await save;f.render();
  assert.ok(f.render().find(node=>node.type===f.editor)!.props.focus>0);
  f.native('focusin',f.element('B'));
  renamedSnapshot(f);
  assert.equal(f.render().filter(node=>node.type===f.editor).length,0,'the previous access projection is retired');
  await f.resolveListing([{...project,name:'B'}]);
  assert.ok(f.render().find(node=>node.type===f.editor)!.props.focus>0,'the replacement row retains the same keyboard owner');
});

test('a filtered-out save keeps search focus through its late own-rename snapshot until focus moves elsewhere',async()=>{
  const f=fixture();f.render();await f.resolveListing();searchFor(f,'A');await f.resolveListing();
  let searches=0;
  const control=Object.assign(f.element(),{focus:()=>{searches++;f.native('focusin',control);}});
  f.render().find(node=>node.type==='input'&&node.props['aria-label']==='projectColors.search')!.props.ref.current=control;
  const save=f.render().find(node=>node.type===f.editor)!.props.save('B',null);
  f.requests.at(-1)!.resolve({...initial,revision:1});await flush();await f.resolveListing([]);await save;f.render();f.render();
  assert.equal(searches,1);
  renamedSnapshot(f);await f.resolveListing([]);f.render();f.render();
  assert.equal(searches,2,'a replaced search input retains its keyboard ownership');
  assert.equal(f.render().find(node=>node.type==='input'&&node.props['aria-label']==='projectColors.search')!.props.value,'A');
  f.native('focusin',f.element());f.render();
  renamedSnapshot(f,'later-work');await f.resolveListing([]);f.render();f.render();
  assert.equal(searches,2,'moving to another control retires the fallback owner too');
});

test('new keyboard, pointer or focus ownership prevents a landed save from reclaiming another control',async()=>{
  for(const input of ['keydown','pointerdown','focusin']){
    const f=fixture();f.render();await f.resolveListing();
    const save=f.render().find(node=>node.type===f.editor)!.props.save('B',null);
    f.requests.at(-1)!.resolve({...initial,revision:1});await flush();await f.resolveListing([{...project,name:'B'}]);await save;f.render();
    assert.ok(f.render().find(node=>node.type===f.editor)!.props.focus>0);
    f.native(input,f.element(),'Tab');f.render();renamedSnapshot(f);await f.resolveListing([{...project,name:'B'}]);
    assert.equal(f.render().find(node=>node.type===f.editor)!.props.focus,0,input+' gives the keyboard context to the reader');
  }
});

test('new keyboard or pointer input also retires the focus intent of an unfinished save',async()=>{
  for(const input of ['keydown','pointerdown']){
    const f=fixture();f.render();await f.resolveListing();
    const save=f.render().find(node=>node.type===f.editor)!.props.save('B',null);
    f.native(input,f.element(),'Tab');
    f.requests.at(-1)!.resolve({...initial,revision:1});await flush();await f.resolveListing([{...project,name:'B'}]);await save;f.render();
    assert.equal(f.render().find(node=>node.type===f.editor)!.props.focus,0,input+' during the write retires its later landing');
  }
});

test('an existing whitespace-only name permits a colour-only save',async()=>{
  for(const name of [' ','\n']){
    const f=fixture('Projects','ProjectEditor'),calls:any[]=[];
    const props={project:{...project,name},color:null,canColor:true,disabled:false,save:async(...values:unknown[])=>{calls.push(values);}};
    let tree=f.render(props);tree.find(node=>node.type==='Popover')!.props.onOpenChange(true);tree=f.render(props);
    assert.equal(tree.find(node=>node.type==='button'&&node.props.children==='account.save')!.props.disabled,false);
    assert.equal(tree.find(node=>node.type==='Field')!.props.required,false,'an unchanged newline must not fail native text-input validation');
    tree.find(node=>node.type==='input'&&node.props.value===category.CATEGORY_COLORS[0])!.props.onChange();
    await f.render(props).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}});
    assert.deepEqual(calls,[[name,category.CATEGORY_COLORS[0]]]);
  }
});

test('the combined editor respects independent name and board-colour permissions',()=>{
  const f=fixture('Projects','ProjectEditor');
  const tree=f.render({project:{...project,canRename:false},color:null,canColor:false,disabled:false,save:async()=>{}});
  assert.equal(tree.find(node=>node.type==='Field')!.props.readOnly,true);
  assert.equal(tree.find(node=>node.type==='fieldset')!.props.disabled,true);
  assert.equal(tree.find(node=>node.type==='button'&&node.props.children==='account.save')!.props.disabled,true);
});

test('an owner can reset dormant colours from projects and stale confirmation requires a new intent',async()=>{
  const f=fixture('Projects','ResetProjectColors');let tree=f.render();
  tree.find(node=>node.type==='button'&&node.props.children==='projectColors.reset')!.props.onClick();tree=f.render();
  const newer={...initial,revision:1};f.page.dispatch({type:'hub',event:{type:'board',data:{projectColorsRevision:1,projectColorsAuthority:initial.authority}}});f.page.dispatch({type:'hub',event:{type:'projectColors',data:newer}});
  tree=f.render();const modal=tree.find(node=>node.type==='Modal')!;
  const confirm=nodes(modal).find(node=>node.type==='button'&&node.props.children==='projectColors.reset')!;confirm.props.onClick();
  const request=f.requests[0];assert.equal(request.headers['If-Match'],'"0"');request.reject(new ApiError(409,'project_colors_conflict',{error:'project_colors_conflict',...newer}));await flush();
  const failed=f.render().find(node=>node.type==='Modal')!;assert.equal(nodes(failed).find(node=>node.type==='button'&&node.props.children==='projectColors.reset')!.props.disabled,true);assert.equal(f.requests.length,1);
});

test('personal and local project settings use the same editor without a separate colour section',()=>{
  let path='/settings/projects';
  const modules:Record<string,any>={react:{useEffect:()=>{},useState:()=>[]},'react/jsx-runtime':jsx,'../i18n':{t:(key:string)=>key},'../lib/http':{},
    '../lib/router':{useLocation:()=>path,useNavigationEntry:()=>0,settingsHref:(value:string)=>value},'../lib/session':{boardTitle:()=> 'Board'},'../lib/app':{inApp:()=>true,settingsSections:()=>[]},'../lib/board':{useApp:()=>null},'./Projects':{Projects:'Projects'}};
  const context={exports:{} as any,require:(name:string)=>modules[name]??{}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/Settings.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const props={user:{id:'owner'},board:{id:'board',personal:true,role:'owner'},boards:[],local:true};
  for(const local of [false,true]){const settings=context.exports.Settings({...props,local});assert.equal(settings.props.children.type,'Projects');assert.equal(settings.props.children.props.board,props.board);assert.equal(settings.props.sections.some((section:any)=>section.id==='project-colors'),false);}
  path='/boards/board/settings/members';assert.equal(context.exports.Settings(props).type,'main');
});
