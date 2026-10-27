import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {t,setLocale} from '../i18n';
import {num,stamp} from '../lib/format';
import {level,windowName} from '../lib/quota';
import {quotaPeriods} from '../lib/subscription';
import {providerOf} from '../../server/domain/providers';
import {hasSubscriptionCaps} from '../lib/providers';
import {selectedAllowanceIds} from '../lib/moneySelection';
import {budgetVisible} from '../lib/money';
import {EMPTY_VIEW} from '../../server/domain/view';
import {timeRangeLabel} from '../lib/timeRange';
import {nameRenderer} from './nameFixture';

const file=(name:string)=>readFileSync(new URL('../components/'+name,import.meta.url),'utf8');
const jsx=(type:any,props:any)=>({type,props}),runtime={jsx,jsxs:jsx,Fragment:'fragment'};
const nodes=(v:any):any[]=>Array.isArray(v)?v.flatMap(nodes):!v||typeof v!=='object'?[]:typeof v.type==='function'?nodes(v.type(v.props)):[v,...nodes(v.props.children)];

for(const locale of ['en','ru'] as const)test(`${locale} source settings keep controls and retry without duplicating the card scales`,()=>{
  setLocale(locale);
  try {
    const source={id:'s',provider:'antigravity',successAt:1000,windows:Array.from({length:5},(_,i)=>({id:String(i),kind:'weekly',label:'Model '+i,minutes:10080,used:25.45,remaining:74.55,resetAt:5000}))};
    let selected:{from:number;to:number}|null=null,retried=0;
    const reading={value:source,basis:{range:{from:0,to:2000}},loading:false,error:null as string|null};
    const context:any={exports:{},require:()=>runtime,t,num,stamp,level,windowName,quotaPeriods,providerOf,hasSubscriptionCaps,selectedAllowanceIds,budgetVisible,timeRangeLabel,
      Name:nameRenderer(runtime),useDataFilters:()=>({current:null}),usePref:()=>({}),usePeriodValues:()=>reading,useTimeRange:()=>selected,
      useMine:()=>false,useState:(value:any)=>[value,()=>{}],useRemovalFocus:()=>()=>{},boardPeriod:{retry:()=>{retried++;}},
      isWindowHidden:()=>false,planOf:()=>null,MeasurementClock:{Provider:'clock'},PlanNote:'note',PlanMark:'mark',ResetLine:'reset',
      Popover:'popover',SlidersIcon:'icon',CardName:'name-control',CardColor:'color-control',SwitchRow:'switch',Frequency:'frequency',RefreshAction:'refresh',HideRow:'hide',QuotaCard:'quota',AllHidden:'hidden'};
    const run=(body:string)=>runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
    run(file('Meter.tsx').slice(file('Meter.tsx').indexOf('export function MeterBar(')));
    context.PercentLimit=context.exports.PercentLimit;
    run(file('PeriodStatus.tsx').slice(file('PeriodStatus.tsx').indexOf('export function PeriodStatus('))+'\nglobalThis.PeriodStatus=PeriodStatus;');
    const sourceCode=file('SourceCard.tsx');
    for(const [start,end] of [['function Limit(','\n/**'],['function SourceSettings(','\n/**'],['function CardMeasurements(','/** Historical funds']]){
      const at=sourceCode.indexOf(start);assert.ok(at>=0);
      run(sourceCode.slice(at,sourceCode.indexOf(end,at)));
    }
    const props=(owner:boolean)=>({source,title:'Models',arrange:{owner,view:EMPTY_VIEW},boardId:'b',takeOff:false});
    for(const owner of [false,true])for(const state of ['live','pending','failed','ready']){
      selected=state==='live'?null:reading.basis.range;
      reading.loading=state==='pending';reading.error=state==='failed'?'unavailable':null;
      const menu=nodes(context.SourceSettings(props(owner))),body=nodes(context.CardMeasurements(props(owner)));
      assert.equal(body.filter(n=>n.props.className==='meter').length,5,'all selected scales remain on the card');
      assert.equal(menu.filter(n=>n.props.className==='meter').length,0,'settings never repeat visible scales');
      assert.ok(menu.some(n=>n.type==='frequency')&&menu.some(n=>n.type==='refresh'),'ordinary actions remain available');
      assert.equal(menu.some(n=>n.type==='name-control'),owner);
      const retry=menu.find(n=>n.type==='button'&&n.props.children===t('period.retry'));
      assert.equal(!!retry,state==='failed');
      if(retry){retry.props.onClick();assert.equal(retried,owner?2:1);}
      const value=body.find(n=>String(n.props.className).startsWith('limit-value '));
      assert.equal(value.props.title,[`${num(74.55,2)}%`,t('source.measured',{at:stamp(1000)})].join('\n'));
    }
  } finally {setLocale('en');}
});
