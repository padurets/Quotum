import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {defaultFilters,matchesSource,matchesSelection,fundsRule} from '../../server/domain/dataFilters';
import {moneyFamily,providerOf} from '../../server/domain/providers';
import {archivedKeyGroups} from '../lib/moneySelection';
import type {MeterHistory} from '../lib/moneyView';

test('the Resources control forwards already loaded history labels to its inline archived keys without reading history',()=>{
  type Node={type:((props:any)=>Node)|string;props:any};
  const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value,...nodes(value.props.children)]:[];
  const code=readFileSync(new URL('../components/DataFilters.tsx',import.meta.url),'utf8');
  const filters=defaultFilters();filters.wallet={mode:'only',values:[{source:'s',kind:'keyCap',key:'gone'}]};
  const series=[{sourceId:'s',meterId:'key:gone:cap',semantics:{label:'Archived deployment key'}}] as MeterHistory[];
  let reads=0;
  const source={id:'s',provider:'openrouter',title:'Account',windows:[],meters:[{id:'balance',kind:'balance',unit:'USD'}]};
  const jsx=(type:Node['type'],props:any)=>({type,props}),options='options',keySettings='keys';
  const context={exports:{} as {DataFilterControls:()=>Node},require:(name:string)=>{if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'};throw new Error(name);},
    requested:false,useState:(value:any)=>[typeof value==='function'?value():value,()=>{}],useEffect:()=>{},useSyncExternalStore:(_subscribe:any,get:any)=>get(),useDataFilters:()=>({current:filters,saved:null}),useNamed:()=>[source],useBoardId:()=> 'b',usePref:()=>({unit:'USD'}),
    budgetHistory:{subscribe:()=>()=>{},get:()=>({history:{meterSeries:series}}),read:()=>{reads++;}},boardPeriod:{subscribeFacets:()=>()=>{},getFacets:()=>({value:null,error:null})},
    moneyFamily,providerOf,matchesSource,matchesSelection,fundsRule,quotaPeriods:()=>[],subscriptionFundsVisible:()=>false,logoOf:()=>'',t:(key:string)=>key,
    excludedResources:()=>0,resourcesRestricted:()=>false,RESOURCE_FILTERS:[],Dimension:'dimension',FilterPopover:'popover',FilterOptions:options,FilterGroup:'group',FilterRow:'row',FilterSearch:'search',KeyMoneySettings:keySettings,Unlink:'unlink'};
  runInNewContext(ts.transpileModule(code.slice(code.indexOf('function Resource('),code.indexOf('export function FilterSaveActions')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const controls=context.exports.DataFilterControls(),resources=controls.props.children[0],tree=resources.type(resources.props);
  const resource=nodes(tree).find(node=>typeof node.type==='function'&&node.type.name==='Resource')!;
  const group=(resource.type as (props:any)=>Node)(resource.props),children=group.props.children(true),keys=nodes(children).find(node=>node.type===keySettings)!;
  assert.equal(keys.props.series,series);
  assert.equal(archivedKeyGroups('s',[['s','key:gone:cap']],new Set(),keys.props.series)[0].label,'Archived deployment key');assert.equal(reads,0);
});
