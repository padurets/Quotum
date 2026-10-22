import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {DataFilterState} from '../lib/filterState';
import {defaultFilters} from '../../server/domain/dataFilters';
import {ApiError} from '../lib/http';

type VNode={type:unknown;props:Record<string,any>};
const nodes=(value:any):VNode[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];

/** Explicit DOM ref-detachment phases; native focus and placement are checked on the demo. */
function fixture(header=false){
  const hooks=preparationFixture(),calls:{name:string;controlled:boolean}[]=[];
  const document={activeElement:null as Element|null};
  let focus:any;
  class Element{
    isConnected=true;disabled=false;hidden=false;inert=false;visibility='visible';
    parent:Element|null=null;children:Element[]=[];
    constructor(readonly name:string,readonly kind:string,parent?:Element){if(parent){this.parent=parent;parent.children.push(this);}}
    contains(element:Element|null):boolean{return !!element&&(element===this||this.children.some(child=>child.contains(element)));}
    closest(selector:string):Element|null{
      const match=(node:Element)=>selector==='[hidden],[inert]'?node.hidden||node.inert:selector==='.'+node.kind||selector.split(',').includes('.'+node.kind);
      return match(this)?this:this.parent?.closest(selector)??null;
    }
    matches(selector:string){return selector===':disabled'&&this.disabled;}
    getClientRects(){return this.hidden?[]:[{}];}
    querySelector(selector:string):Element|null{return selector===':scope > button'?this.children.find(child=>child.kind==='trigger')??null:selector==='.panel-head h2'?heading:null;}
    querySelectorAll(){return [status,disabled,settings,filter].filter(node=>this.contains(node));}
    focus(){document.activeElement=this;calls.push({name:this.name,controlled:focus.isFocusReturn()});}
    remove(){if(this.contains(document.activeElement))document.activeElement=body;const retire=(node:Element)=>{node.isConnected=false;node.children.forEach(retire);};retire(this);}
  }
  const body=new Element('body','body'),panel=new Element('panel',header?'analytics-head-inner':'panel',body),heading=new Element('heading','heading',panel);
  const scope=new Element('error scope','reader-state',panel),picker=new Element('picker','picker',scope),trigger=new Element('error trigger','trigger',picker),surface=new Element('surface','surface',picker),retry=new Element('retry','action',surface);
  const status=trigger,disabled=new Element('disabled control','control',panel),settings=new Element('settings','control',panel),filter=new Element('resource filter','control',panel),outside=new Element('outside','control',body);
  disabled.disabled=true;filter.hidden=!header;settings.hidden=header;
  document.activeElement=body;
  const jsx=(type:unknown,props:Record<string,any>)=>({type,props});
  const useCallback=(fn:unknown,deps:readonly unknown[])=>hooks.useMemo(()=>fn,deps);
  const vm=(file:string,modules:Record<string,any>,slice?:(source:string)=>string)=>{
    const context={exports:{} as any,document,getComputedStyle:(element:Element)=>({visibility:element.visibility}),require:(name:string)=>modules[name]};
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    runInNewContext(ts.transpileModule(slice?slice(source):source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);return context.exports;
  };
  focus=vm('../components/focusReturn.ts',{react:{...hooks,useCallback}});
  const modules={'react/jsx-runtime':{jsx,jsxs:jsx},'./focusReturn':focus,'./Popover':{Popover:'popover'},'../i18n':{t:(key:string)=>key},'../lib/timeRange':{timeRangeLabel:()=> 'range'}};
  const read=vm('../components/ReadState.tsx',modules).ReadState;
  let oldScope:VNode|undefined,oldAction:VNode|undefined;
  const render=(props:Record<string,unknown>,reverse=false)=>{
    hooks.begin();const tree=read(props),flat=nodes(tree),nextScope=flat.find(node=>node.props.className==='reader-state'),nextAction=flat.find(node=>node.type==='button');hooks.commit();
    const removals:[VNode|undefined,VNode|undefined,Element][]=[[oldScope,nextScope,scope],[oldAction,nextAction,retry]];
    if(reverse)removals.reverse();
    for(const [old,next] of removals)if(old&&!next)old.props.ref?.(null);
    for(const [old,next,node] of removals)if(old&&!next)node.remove();
    if(nextScope&&!oldScope)nextScope.props.ref?.(scope);if(nextAction&&!oldAction)nextAction.props.ref?.(retry);
    oldScope=nextScope;oldAction=nextAction;return tree;
  };
  return {hooks,document,calls,panel,heading,scope,trigger,retry,settings,filter,outside,render,vm,jsx,focus};
}

for(const reverse of [false,true])for(const at of ['retry','trigger'] as const)test(`retiring an error-only reader returns ${at} focus to stable controls (child first=${reverse})`,()=>{
  const f=fixture();f.render({error:'history_failed',retry:()=>{}});f.document.activeElement=f[at];
  f.render({retry:()=>{}},reverse);
  assert.equal(f.document.activeElement,f.settings);assert.ok(f.calls.every(call=>call.controlled));assert.equal(f.focus.isFocusReturn(),false);f.hooks.dispose();
});
for(const retained of [{retained:true},{children:'Independent overflow details'},{loading:true}])test(`removing Retry returns to its surviving trigger: ${Object.keys(retained)[0]}`,()=>{
  const f=fixture();f.render({error:'history_failed',retry:()=>{},...retained});f.document.activeElement=f.retry;
  f.render({retry:()=>{},...retained});assert.equal(f.document.activeElement,f.trigger);assert.equal(f.trigger.isConnected,true);assert.equal(f.retry.isConnected,false);f.hooks.dispose();
});
test('automatic recovery does not move a newer external focus',()=>{
  const f=fixture();f.render({error:'history_failed',retry:()=>{}});f.document.activeElement=f.outside;
  f.render({retry:()=>{}});assert.equal(f.document.activeElement,f.outside);assert.deepEqual(f.calls,[]);f.hooks.dispose();
});
test('a readonly panel without heading controls uses its existing heading',()=>{
  const f=fixture();f.settings.hidden=true;f.render({error:'history_failed',retry:()=>{}});f.document.activeElement=f.retry;
  f.render({retry:()=>{}});assert.equal(f.document.activeElement,f.heading);f.hooks.dispose();
});
test('hidden or inert contextual controls cannot receive a recovery return',()=>{
  const f=fixture();f.settings.inert=true;f.render({error:'history_failed',retry:()=>{}});f.document.activeElement=f.retry;
  f.render({retry:()=>{}});assert.equal(f.document.activeElement,f.heading);f.hooks.dispose();
});
test('a control with CSS visibility hidden cannot take the contextual return',()=>{
  const f=fixture();f.settings.visibility='hidden';f.render({error:'history_failed',retry:()=>{}});f.document.activeElement=f.retry;
  f.render({retry:()=>{}});assert.equal(f.document.activeElement,f.heading);f.hooks.dispose();
});

test('actual filter Save retry retires its error popup into the resource control through pending and a second failure',async()=>{
  const f=fixture(true),rejects:((error:unknown)=>void)[]=[];
  const state=new DataFilterState({save:()=>new Promise((_resolve,reject)=>rejects.push(reject))});
  state.open('user','board');state.accept({filters:defaultFilters(),revision:1,authority:'authority-focus-return',unavailable:{sources:0,windows:0,wallet:0,funds:0,projects:0,devices:0,clients:0}});state.toggle('projects','A project',false);
  let saving:Promise<void>|undefined;
  // Resolve the existing component's imported names without replacing its Save producer.
  const source=readFileSync(new URL('../components/DataFilters.tsx',import.meta.url),'utf8');
  const context:any={exports:{},require:()=>({jsx:f.jsx,jsxs:f.jsx}),useRemovalFocus:f.focus.useRemovalFocus,useDataFilters:state.get,useRole:()=> 'owner',t:(key:string)=>key,messageOf:()=> 'failed',executableWorkFilters:()=>true,dataFilters:{save:()=>saving=state.save(),restore:()=>state.restore()},Save:'save',RotateCcw:'restore',TriangleAlert:'alert',ErrorLine:'error',Popover:'popover'};
  runInNewContext(ts.transpileModule(source.slice(source.indexOf('export function FilterSaveActions')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const draw=()=>{f.hooks.begin();const flat=nodes(context.exports.FilterSaveActions());f.hooks.commit();return flat;};
  const first=state.save();rejects[0](new ApiError(503,'unavailable'));await first;
  const failed=draw(),scope=failed.find(node=>node.props.className==='reader-state is-warn')!,retry=failed.find(node=>node.type==='button'&&node.props.children==='filters.save')!;
  scope.props.ref?.(f.scope);retry.props.ref?.(f.retry);f.document.activeElement=f.retry;
  retry.props.onClick();assert.equal(state.get().saving,true);assert.equal(state.get().error,null);
  const pending=draw();assert.equal(pending.some(node=>node.type==='popover'),false);assert.equal(pending.find(node=>node.props['aria-label']==='filters.saving')?.props.disabled,true);
  scope.props.ref?.(null);retry.props.ref?.(null);f.scope.remove();assert.equal(f.document.activeElement,f.filter);
  rejects[1](new ApiError(503,'unavailable'));await saving;draw();assert.equal(f.document.activeElement,f.filter,'a second failure does not claim focus for its new error button');
  state.close();f.hooks.dispose();
});
