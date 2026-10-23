import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {periodValues} from '../../server/periodValues';
import {quotaPeriods,primaryQuotaPeriods} from '../lib/subscription';
import {providerOf} from '../../server/domain/providers';
import {hasSubscriptionCaps} from '../lib/providers';
import {selectedAllowanceIds} from '../lib/moneySelection';
import {budgetVisible} from '../lib/money';
import {planMark,planNote,planMarkChangesAt,planNoteChangesAt,DEFAULT_PLAN} from '../lib/plan';
import {windowName} from '../lib/quota';
import {stamp,num} from '../lib/format';
import {EMPTY_VIEW} from '../../server/domain/view';
import {t,setLocale} from '../i18n/index';
const file=new URL('../components/SourceCard.tsx',import.meta.url);
const code=readFileSync(file,'utf8'),jsx=(type:any,props:any)=>({type,props});
const nodes=(n:any):any[]=>Array.isArray(n)?n.flatMap(nodes):!n||typeof n!=='object'?[]:typeof n.type==='function'?nodes(n.type(n.props)):[n,...nodes(n.props.children)];
const compile=(s:string)=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
for(const language of ['en','ru'] as const)test(`${language} historical idle window primary and disclosure share plan evidence`,()=>{
 const H=3600000,M=60000,now=1800000000000,at=now-2*H,selected={from:at-M,to:at+30*M};
 const store=new Store(':memory:',at-H);setLocale(language);
 try{
  const directory=new Directory(store.db),owner=directory.createUser('history-plan@example.test','History plan','unused',at-H),board=directory.boards(owner.id)[0].id,id=store.source('claude','historical-idle',at-H);store.hold(id,owner.id,at-H);
  const win=(resetAt:number,used:number)=>({id:'session',kind:'session' as const,label:null,minutes:300,used,remaining:100-used,resetAt});
  assert.ok(store.record(id,{observedAt:at,staleAfterMs:H,plan:'pro',resets:null,windows:[win(at+5*H,0)]}).accepted);
  assert.ok(store.record(id,{observedAt:now,staleAfterMs:H,plan:'pro',resets:null,windows:[win(now+5*H,20)]}).accepted);
  const historical=periodValues(store,store.sources(board),owner.id,selected.to,()=>{},now)[0];
  const current=periodValues(store,store.sources(board),owner.id,now+1,()=>{},now+1)[0];
  assert.equal(historical.windows[0].observedAt,at);assert.equal(historical.windows[0].remaining,100);
  const context:any={exports:{},require:()=>({jsx,jsxs:jsx,Fragment:'fragment'}),t,stamp,windowName,quotaPeriods,primaryQuotaPeriods,selectedAllowanceIds,providerOf,hasSubscriptionCaps,budgetVisible,
   useDataFilters:()=>({current:null}),usePref:()=>({}),usePeriodValues:()=>({value:historical,basis:{range:selected},loading:false,error:null}),useTimeRange:()=>selected,
   isWindowHidden:()=>false,planOf:()=>DEFAULT_PLAN,MeasurementClock:{Provider:'clock'},PercentLimit:'limit',ResetLine:'reset',PeriodStatus:'status',QuotaCard:'quota',AllHidden:'hidden',
   planMark,planNote,planMarkChangesAt,planNoteChangesAt,num,useMeasurementClock:()=>selected.to};
  const start=code.indexOf('function Limit('),end=code.indexOf('\n/**',start),bodyStart=code.indexOf('function CardMeasurements('),bodyEnd=code.indexOf('/** Historical funds',bodyStart);
  let body=code.slice(code.indexOf('function PlanMark('),code.indexOf('/** When the limit resets'))+'\n'+code.slice(start,end)+'\n'+code.slice(bodyStart,bodyEnd)+'\nexports.body=CardMeasurements;exports.details=MeasurementDetails;';
  runInNewContext(compile(body),context);
  const props={source:{...current,successAt:now},arrange:{view:EMPTY_VIEW},boardId:board};
  const primary=nodes(context.exports.body(props)),disclosure=nodes(context.exports.details(props));
  const primaryMark=primary.find(n=>n.props.className==='pace'),detailMark=disclosure.find(n=>n.props.className==='pace');
  // Resolve the actual Limit children/note through the same renderer slots.
  assert.ok(primaryMark&&detailMark);
  assert.equal(primaryMark.props.hidden,true,'the actual primary correctly recognizes an idle measurement');
  assert.equal(detailMark.props.hidden,primaryMark.props.hidden,'the same idle historical limit cannot acquire a started-window plan only in its disclosure');
 }finally{store.close();setLocale('en');}
});
