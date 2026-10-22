import {windowName} from '../lib/quota';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {periodValues} from '../../server/periodValues';
import {defaultFilters} from '../../server/domain/dataFilters';
import {EMPTY_VIEW} from '../../server/domain/view';
import {providerOf} from '../../server/domain/providers';
import {publishDataFilters} from '../lib/filterSelection';
import {isWindowHidden} from '../lib/view';
import {selectedAllowanceIds} from '../lib/moneySelection';
import {quotaPeriods,primaryQuotaPeriods} from '../lib/subscription';
import {hasSubscriptionCaps} from '../lib/providers';
import {budgetVisible} from '../lib/money';
import {t,setLocale} from '../i18n/index';
const jsx=(type:any,props:any)=>({type,props});
const nodes=(v:any):any[]=>Array.isArray(v)?v.flatMap(nodes):!v||typeof v!=='object'?[]:typeof v.type==='function'?nodes(v.type(v.props)):[v,...nodes(v.props.children)];
for(const locale of ['en','ru'] as const)test(`native ${locale} logical selected A with only historical B`,()=>{
 const now=1800000000000,H=3600000,M=60000,at=now-2*H,store=new Store(':memory:',at-H);setLocale(locale);
 try{
  const directory=new Directory(store.db),owner=directory.createUser('logical@example.test','Logical','unused',at-H),board=directory.boards(owner.id)[0].id,id=store.source('antigravity','native-logical',at-H);store.hold(id,owner.id,at-H);
  const win=(id:string,label:string)=>({id,kind:'weekly' as const,label,minutes:10080,used:25,remaining:75,resetAt:now+H});
  const a=win('model-a','Alpha'),b=win('model-b','Beta');
  for(const [observedAt,windows] of [[at,[b]],[now,[a]]] as const)assert.ok(store.record(id,{observedAt,staleAfterMs:3*H,plan:'',resets:null,windows:[...windows]}).accepted);
  const read=(to:number)=>periodValues(store,store.sources(board),owner.id,to,()=>{})[0];
  const current=read(now+1),historical=read(at+M);assert.deepEqual(current.windows.map(w=>w.id),[a.id]);assert.deepEqual(historical.windows.map(w=>w.id),[b.id]);
  let filters=defaultFilters();
  const select=(ids:string[])=>{filters={...filters,windows:{mode:'include',values:ids.map(key=>[id,key])}};publishDataFilters(filters);};
  select([a.id]);
  const selected={from:at-H,to:at+M},reading:{value:typeof historical|null;basis:{range:typeof selected};loading:boolean;error:string|null}={value:historical,basis:{range:selected},loading:false,error:null};
  const context:any={exports:{},require:()=>({jsx,jsxs:jsx,Fragment:'fragment'}),t,providerOf,isWindowHidden,selectedAllowanceIds,quotaPeriods,primaryQuotaPeriods,hasSubscriptionCaps,budgetVisible,planOf:()=>null,
   useDataFilters:()=>({current:filters}),usePref:()=>({unit:'USD'}),usePeriodValues:()=>reading,useTimeRange:()=>selected,MeasurementClock:{Provider:'clock'},PercentLimit:'missing',windowName,AllHidden:'allHidden',Limit:'limit',QuotaCard:'quota',PeriodStatus:'period'};
  const file=readFileSync(new URL('../components/SourceCard.tsx',import.meta.url),'utf8'),start=file.indexOf('function CardMeasurements('),end=file.indexOf('/** Historical funds',start);
  runInNewContext(ts.transpileModule(file.slice(start,end)+'\nexports.draw=CardMeasurements;exports.details=MeasurementDetails;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const source={...current,successAt:now},props={source,arrange:{view:EMPTY_VIEW},boardId:board};
  select([b.id]);
  const evidenced=nodes(context.exports.draw(props));assert.deepEqual(evidenced.filter(n=>n.type==='limit').map(n=>n.props.w.id),[b.id],'an explicitly selected historical-only metric still renders its own evidence');
  assert.ok(nodes(context.exports.details(props)).some(n=>n.type==='limit'&&n.props.w.id===b.id),'historical-only evidence remains disclosed');
  select([]);assert.equal(nodes(context.exports.draw(props)).filter(n=>n.type==='allHidden').length,1,'a truly empty selection has its filter action');
  select([a.id]);
  const body=nodes(context.exports.draw(props)),detail=nodes(context.exports.details(props));
  const hidden=body.filter(n=>n.type==='allHidden').length;

  // An actually selected but unobserved metric is distinct from an empty selection.
  assert.equal(hidden,0,'selected Alpha cannot be described as all metrics hidden because the old endpoint only knows Beta');
  for(const tree of [body,detail])assert.ok(tree.some(n=>n.type==='missing'&&n.props.name.includes('Alpha')&&n.props.remaining===null),'selected missing Alpha remains named without borrowing live remaining');
  for(const state of ['pending','failed','before-first']){
    reading.value=state==='before-first'?read(at-H+1):null;reading.loading=state==='pending';reading.error=state==='failed'?'history_failed':null;
    select([]);assert.equal(nodes(context.exports.draw(props)).filter(n=>n.type==='allHidden').length,1,'logical all-off survives every historical read state');
    select([a.id]);assert.equal(nodes(context.exports.draw(props)).filter(n=>n.type==='allHidden').length,0,'unobserved selected Alpha is distinct from all-off');
  }
  select([]);assert.equal(nodes(context.exports.draw({...props,source:{...source,windows:[]}})).filter(n=>n.type==='allHidden').length,1,'an explicit empty scope needs no arrived catalogue');
 }finally{publishDataFilters(null,false);setLocale('en');store.close();}
});
