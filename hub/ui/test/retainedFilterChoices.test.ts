import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {DataFilterState} from '../lib/filterState';
import {defaultFilters,matchesSelection,type FilterEnvelope,type FamilyRef} from '../../server/domain/dataFilters';
import {excludedCount,excludedResources,selectionRestricted,resourcesRestricted,RESOURCE_FILTERS} from '../lib/filterSummary';
import {clientName} from '../../server/domain/clients';
import type {WorkFacets} from '../../server/domain/periodRead';
import {fixture,flush,NOW} from './periodRuntimeFixture';
import {publishDataFilters} from '../lib/filterSelection';

type Node={type:string;props:any};
const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value,...nodes(value.props.children)]:[];

test('mounted closed controls keep include counts lazy until the user opens their choices',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const source=readFileSync(new URL('../components/DataFilters.tsx',import.meta.url),'utf8');
  for(const family of ['projects','devices','clients','sources'] as const){
    publishDataFilters(defaultFilters());const h=await fixture();let cleanups:(()=>void)[]=[];
    try{
      const filters=defaultFilters();filters[family]={mode:'include',values:[]};publishDataFilters(filters);h.period.changed();await flush();h.requests.length=0;
      let open=false,demands=0,rawReads=0;const effects:(()=>void|(()=>void))[]=[],original=h.store.agentWork.bind(h.store);
      h.store.agentWork=(...args:Parameters<typeof original>)=>{rawReads++;return original(...args);};
      const period=new Proxy(h.period,{get(target,key){return key==='demandFacets'?()=>{demands++;return target.demandFacets();}:Reflect.get(target,key);}});
      const jsx=(type:string,props:any)=>({type,props}),context={exports:{} as {Dimension:(props:unknown)=>Node;Resources:()=>Node},require:()=>({jsx,jsxs:jsx,Fragment:'fragment'}),
        useState:(initial:unknown)=>typeof initial==='boolean'||typeof initial==='function'?[open,(value:boolean)=>{open=value;}]:[initial,()=>{}],useEffect:(run:()=>void|(()=>void))=>effects.push(run),useSyncExternalStore:(_s:unknown,get:()=>unknown)=>get(),
        useDataFilters:()=>({current:filters,saved:null}),dataFilters:{reset(){},toggle(){}},boardPeriod:period,clientName,matchesSelection,excludedCount,excludedResources,selectionRestricted,resourcesRestricted,RESOURCE_FILTERS,t:(key:string)=>key,
        useNamed:()=>[],useBoardId:()=>h.board,usePref:()=>({unit:'USD'}),budgetHistory:{subscribe:()=>()=>{},get:()=>({history:null})},window:{addEventListener(){},removeEventListener(){}},
        FilterPopover:'popover',FilterOptions:'options',FilterRow:'row',FilterSearch:'search',FilterGroup:'group',Resource:'resource',Unlink:'unlink'};
      const code=family==='sources'?'export '+source.slice(source.indexOf('function Resources('),source.indexOf('export function DataFilterControls')):'export '+source.slice(source.indexOf('function Dimension('),source.indexOf('function Resource('));
      runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
      const render=()=>{effects.length=0;return family==='sources'?context.exports.Resources():context.exports.Dimension({family,label:'filters.'+family});};
      const mount=()=>{for(const run of effects){const cleanup=run();if(cleanup)cleanups.push(cleanup);}};
      let tree=render();assert.equal(tree.props.open,false);assert.equal(tree.props.count,undefined,'an unknown include universe has no invented exclusion count');mount();await flush();
      assert.equal(demands,0,family+' remains closed');assert.equal(h.requests.length,0);assert.equal(rawReads,0);assert.equal(h.period.getFacets().value,null);
      cleanups.forEach(cleanup=>cleanup());cleanups=[];tree.props.onOpenChange(true);tree=render();mount();await flush();
      assert.equal(tree.props.open,true);assert.equal(demands,1);assert.equal(h.requests.filter(request=>request.facets).length,1);assert.equal(rawReads,1);
      assert.ok(h.period.getFacets().value.projects.includes('Work project'),'opening reads the complete unfiltered authorized universe');
      assert.equal(typeof render().props.count,'number','confirmed choices supply the actual count');
    }finally{cleanups.forEach(cleanup=>cleanup());publishDataFilters(null,false);await h.close();}
  }
});

test('actual dimension rows keep authorized absent choices independently removable and hide unconfirmed dormant references',()=>{
  const source=readFileSync(new URL('../components/DataFilters.tsx',import.meta.url),'utf8'),code='export '+source.slice(source.indexOf('function Dimension('),source.indexOf('function Resource('));
  for(const family of ['projects','devices','clients'] as const){
    const [a,b,c,privateRef]=family==='devices'?['device-a','device-b','device-c','revoked-device']:family==='clients'?['codex','opencode','claude','private-client']:['A','B','C','Private revoked project'];
    const filters=defaultFilters();filters[family]={mode:'exclude',values:[a,b]};
    const envelope:FilterEnvelope={filters,revision:1,authority:'before',unavailable:{sources:0,windows:0,wallet:0,funds:0,projects:0,devices:0,clients:0}};
    const state=new DataFilterState({save:async()=>envelope});state.open('user','board');state.accept(envelope);state.toggle(family,privateRef,false);state.accept({...envelope,authority:'after-revoke'});
    assert.ok(state.get().current![family].values.includes(privateRef),'the dirty draft still owns its dormant decision');
    const value:WorkFacets={projects:[c],devices:[{id:c,name:'C laptop'}],clients:[c],funding:[],retained:{projects:[a,b],devices:[{id:a,name:'A laptop'},{id:b,name:'B laptop'}],clients:[a,b],funding:[]}};
    const jsx=(type:string,props:any)=>({type,props}),context={exports:{} as {Dimension:(props:unknown)=>Node},require:(name:string)=>{if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'fragment'};throw Error(name);},
      useState:(value:unknown)=>[value,()=>{}],useEffect:()=>{},useSyncExternalStore:(_subscribe:unknown,read:()=>unknown)=>read(),useDataFilters:state.get,dataFilters:state,boardPeriod:{subscribeFacets:()=>()=>{},getFacets:()=>({value,loading:false,error:null})},clientName,matchesSelection,excludedCount,selectionRestricted,t:(key:string)=>key,
      FilterPopover:'popover',FilterOptions:'options',FilterRow:'row',FilterSearch:'search'};
    runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
    const render=()=>context.exports.Dimension({family,label:'filters.'+family}),rows=nodes(render()).filter(node=>node.type==='row');
    assert.equal(rows.length,3);assert.equal(JSON.stringify(rows).includes(privateRef),false);
    const label=family==='devices'?'A laptop':family==='clients'?clientName(a):a,row=rows.find(row=>row.props.children===label)!;assert.ok(row);assert.equal(row.props.on,false);row.props.onChange(true);
    assert.equal(matchesSelection(state.get().current![family] as {mode:'exclude';values:FamilyRef[]},a),true);
    assert.equal(matchesSelection(state.get().current![family] as {mode:'exclude';values:FamilyRef[]},b),false,'restoring A must preserve the exclusion of B');
    assert.equal(nodes(render()).filter(node=>node.type==='row').length,2,'a restored absent choice leaves the explicit list');
    value.retained=undefined;assert.equal(nodes(render()).filter(node=>node.type==='row').length,1,'clearing authority-bound metadata never falls back to dormant labels');
  }
});
