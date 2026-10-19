import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {defaultFilters} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../lib/filterSelection';
import * as realStore from '../lib/store';

const noop=()=>{};
const jsx=(type:unknown,props:unknown)=>({type,props});
function compile(file:URL,mocks:Record<string,unknown>){
  const local=createRequire(file),context={exports:{} as any,require:(name:string)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:local(name)};
  runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{fileName:file.pathname,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);return context.exports;
}
function render(value:any):any[]{
  if(Array.isArray(value))return value.flatMap(render);if(!value||typeof value!=='object')return [];
  if(typeof value.type==='function')return render(value.type(value.props));return [value,...render(value.props?.children)];
}

for(const native of [false,true])test(`compact saved window exclusions show recovery and filter actions open the ${native?'native':'browser'} main board`,()=>{
  const effects:(()=>void|(()=>void))[]=[],react={memo:(fn:unknown)=>fn,useEffect:(run:()=>void|(()=>void))=>effects.push(run),useLayoutEffect:noop,useRef:(current:unknown)=>({current}),useMemo:(make:()=>unknown)=>make()};
  let state:any,filters=defaultFilters(),opened=0,destination='';
  const board=compile(new URL('../lib/board.ts',import.meta.url),{'./store':{...realStore,useSelect:(_store:unknown,pick:(value:unknown)=>unknown)=>pick(state)},react});
  const card={id:'one',provider:'claude',plan:'pro',successAt:1,error:null,stale:false,windows:[{id:'week',kind:'weekly',label:null,minutes:10080,remaining:60,resetAt:null}],resets:null,owners:[],staleAfterMs:10000,measureIntervalMs:null};
  const view={version:5,layout:{columns:6,places:{}},hidden:[],windows:[],shown:[],names:{},plans:{},colors:{},columns:{},shownColumns:{},unplanned:[]};
  state={...board.INITIAL,board:{id:'b',lineup:['one'],cards:{one:card},view,sessions:{one:[]}},connection:{status:'live'}};
  const listeners=new Set<()=>void>(),window={addEventListener:(name:string,run:()=>void)=>{if(name==='quotum:open-filters')listeners.add(run);},removeEventListener:(_name:string,run:()=>void)=>{listeners.delete(run);},dispatchEvent:()=>{for(const run of listeners)run();}};
  const componentSource=readFileSync(new URL('../components/Compact.tsx',import.meta.url),'utf8'),local=createRequire(new URL('../components/Compact.tsx',import.meta.url));
  const mocks:Record<string,unknown>={react,'react/jsx-runtime':{jsx,jsxs:jsx},'../lib/board':board,'../lib/dataFilters':{useDataFilters:()=>({current:filters})},'../lib/filterSession':{followDataFilters:noop},'../lib/session':{useBoard:()=>[{id:'b'}]},'../lib/app':{inApp:()=>native,app:{openMain:()=>{opened++;}}},'../i18n':{t:(key:string)=>key,useLocale:noop},'./SourceCard':{CardMark:noop,ResetLine:noop},'./MoneyCard':{MoneyCard:noop,QuotaCard:noop,BalanceMark:noop},'./Meter':{PercentLimit:noop},'./ResetMarks':{FreeResets:noop}};
  const context={exports:{} as any,window,location:{assign:(url:string)=>{destination=url;}},require:(name:string)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:local(name)};
  runInNewContext(ts.transpileModule(componentSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const draw=()=>render(context.exports.Compact({live:{open:noop,close:noop},user:'u'}));
  try{
    publishDataFilters(filters);assert.equal(draw().filter(node=>node.type==='section').length,1);
    const stops=effects.splice(0).map(run=>run());
    filters={...defaultFilters(),windows:{mode:'include',values:[]}};publishDataFilters(filters);
    const empty=draw();assert.equal(empty.filter(node=>node.type==='section').length,0);assert.ok(empty.some(node=>node.type==='p'&&node.props.children==='desktop.empty'));
    // Use the actual shared opener used by empty budget cards.
    const source=readFileSync(new URL('../components/DataFilters.tsx',import.meta.url),'utf8'),opener={exports:{} as any,window,Event:class {},setPrefs:(value:unknown)=>assert.equal(JSON.stringify(value),'{"filtersVisible":true}')};
    runInNewContext(ts.transpileModule(source.slice(source.indexOf('let requested='),source.indexOf('\nfunction Dimension')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,opener);
    opener.exports.openDataFilters();assert.equal(opened,native?1:0);assert.equal(destination,native?'':'/');
    stops.forEach(stop=>stop?.());assert.equal(listeners.size,0);
  }finally{publishDataFilters(null,false);}
});
