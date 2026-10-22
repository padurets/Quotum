import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {focusReturnFixture as fixture} from './focusReturnFixture';
import {DataFilterState} from '../lib/filterState';
import {defaultFilters} from '../../server/domain/dataFilters';
import {ApiError} from '../lib/http';
import {fixture as periodRuntime,flush as periodFlush,NOW,H} from './periodRuntimeFixture';

type VNode={type:unknown;props:Record<string,any>};
const nodes=(value:any):VNode[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];

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
  const leaveScope=f.attach(scope.props.ref,f.scope),leaveAction=f.attach(retry.props.ref,f.retry);f.document.activeElement=f.retry;
  retry.props.onClick();assert.equal(state.get().saving,true);assert.equal(state.get().error,null);
  const pending=draw();assert.equal(pending.some(node=>node.type==='popover'),false);assert.equal(pending.find(node=>node.props['aria-label']==='filters.saving')?.props.disabled,true);
  leaveScope();leaveAction();f.scope.remove();assert.equal(f.document.activeElement,f.filter);
  rejects[1](new ApiError(503,'unavailable'));await saving;draw();assert.equal(f.document.activeElement,f.filter,'a second failure does not claim focus for its new error button');
  state.close();f.hooks.dispose();
});

for(const readonly of [false,true])test(`a retiring card disclosure returns to ${readonly?'its readonly heading':'the card settings'}`,()=>{
  const f=fixture(false,true);f.settings.hidden=readonly;
  f.render({error:'history_failed',retry:()=>{}});f.document.activeElement=f.retry;
  f.render({retry:()=>{}});assert.equal(f.document.activeElement,readonly?f.heading:f.settings);f.hooks.dispose();
});

for(const order of [false,true])test(`one callback keeps independently attached recovery nodes separate (reverse=${order})`,()=>{
  const f=fixture();f.hooks.begin();const ref=f.focus.useRemovalFocus();f.hooks.commit();
  const secondPicker=f.node('second picker','picker',f.panel),secondTrigger=f.node('second trigger','trigger',secondPicker),secondAction=f.node('second action','action',secondPicker);
  const first=f.attach(ref,f.retry),second=f.attach(ref,secondAction);
  if(order){f.document.activeElement=f.retry;second();secondAction.remove();assert.equal(f.document.activeElement,f.retry);first();f.retry.remove();assert.equal(f.document.activeElement,f.trigger);}
  else{f.document.activeElement=secondAction;first();f.retry.remove();assert.equal(f.document.activeElement,secondAction);second();secondAction.remove();assert.equal(f.document.activeElement,secondTrigger);}
  f.hooks.dispose();
});

for(const portal of [false,true])for(const mode of ['whole','trigger','panel','external'] as const)test(`actual Popover ${mode} retirement respects its owning card (portal=${portal})`,()=>{
  const f=fixture(false,true),useCallback=(fn:unknown,deps:readonly unknown[])=>f.hooks.useMemo(()=>fn,deps);
  const modules={react:{...f.hooks,useCallback,useEffect:()=>{},useLayoutEffect:()=>{}},'react/jsx-runtime':{jsx:f.jsx,jsxs:f.jsx},'react-dom':{createPortal:(child:unknown)=>child},'./focusReturn':f.focus,'../lib/place':{},'../lib/settle':{},'lucide-react':{},'../i18n':{t:(key:string)=>key}};
  const Popover=f.vm('../components/Popover.tsx',modules).Popover;
  f.hooks.begin();const tree=Popover({label:'Agents',open:true,children:'Retained work',portal:portal?f.outside:undefined});f.hooks.commit();
  const flat=nodes(tree),surface=flat.find(node=>String(node.props.className).startsWith('popover glass'))!,button=flat.find(node=>node.type==='button')!;
  const panel=portal?f.node('portaled surface','surface',f.outside):f.surface,action=portal?f.node('portaled retry','action',panel):f.retry;
  const leaveBox=f.attach(tree.props.ref,f.picker),leaveButton=f.attach(button.props.ref,f.trigger),leavePanel=f.attach(surface.props.ref,panel);
  f.document.activeElement=mode==='external'?f.outside:mode==='trigger'?f.trigger:action;
  if(portal&&mode!=='external'&&mode!=='trigger')assert.equal(f.picker.contains(f.document.activeElement),false,'the portal is not a DOM child of the trigger');
  if(mode==='panel'){leavePanel();panel.remove();assert.equal(f.document.activeElement,f.trigger);}
  else{leaveBox();leaveButton();leavePanel();f.picker.remove();if(portal)panel.remove();assert.equal(f.document.activeElement,mode==='external'?f.outside:f.settings);}
  assert.ok(f.calls.every(call=>call.controlled));f.hooks.dispose();
});

for(const mode of ['values','work'] as const)for(const background of [false,true])test(`actual failed period ${mode} recovery returns focus inside its surviving disclosure (background=${background})`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await periodRuntime({fixed:true});t.after(()=>h.close());
  const f=fixture(false,true);t.after(()=>f.hooks.dispose());
  const read=()=>mode==='values'?h.period.getValue(h.source):h.period.get();
  const failure=h.hold();h.selectRange({from:NOW-2*H,to:NOW-H});await periodFlush();failure.reject(new Error('unavailable'));await periodFlush();assert.ok(read().error);
  const PeriodStatus=f.vm('../components/PeriodStatus.tsx',{'react/jsx-runtime':{jsx:f.jsx,jsxs:f.jsx},'./focusReturn':f.focus,'../lib/period':{boardPeriod:h.period},'../lib/timeRange':{timeRangeLabel:()=> 'range'},'../i18n':{t:(key:string)=>key}}).PeriodStatus;
  const draw=()=>{f.hooks.begin();const tree=PeriodStatus(read());f.hooks.commit();return nodes(tree);};
  const failed=draw(),scope=failed.find(node=>node.props.className==='period-status')!,button=failed.find(node=>node.type==='button')!;
  const root=f.node('period details','status',f.surface),action=f.node('period retry','action',root);
  const leaveScope=f.attach(scope.props.ref,root),leaveAction=f.attach(button.props.ref,action);f.document.activeElement=action;
  const recovery=h.hold();if(background)h.period.retry();else button.props.onClick();
  assert.equal(read().error,null);assert.equal(read().loading,true);const pending=draw();assert.equal(pending.some(node=>node.type==='button'),false);
  leaveAction();action.remove();assert.equal(f.document.activeElement,f.trigger);await periodFlush();recovery.release();await periodFlush();
  assert.equal(read().loading,false);assert.equal(read().error,null);assert.equal(draw().length,0);leaveScope();root.remove();assert.equal(f.document.activeElement,f.trigger);
  if(mode==='work')assert.equal(h.period.get().rows.length,0,'the actual empty historical result may retire the enclosing Agents disclosure next');
});
