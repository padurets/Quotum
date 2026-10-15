import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {observationDeadline,type CreditBalanceState} from '../../server/domain/resources';
import {capStale,capChangesAt,money} from '../lib/money';
import {moneyTotal} from '../lib/moneyView';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {t,setLocale} from '../i18n';
import type {Meter} from '../../server/domain/meters';

/** Execute the actual footer and disclosure functions, supplying only their hook boundary. */
function funds(at:number) {
  const file=readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8');
  const body=file.slice(file.indexOf('function FundsMark('),file.indexOf('/** Safe supplier facts'));
  const jsx=(type:unknown,props:Record<string,unknown>)=>({type,props});
  const context={exports:{},result:null as unknown as {mark:(props:object)=>{props:{children:{props:{tone?:string}}}};text:(source:object,at:number)=>string|null;changes:(source:object,at:number)=>number|null},
    require:()=>({jsx,jsxs:jsx}),useMeasurementClock:()=>at,observationDeadline,money,t,stamp:String,rateText:String,StatusMark:'status',Popover:'popover'};
  runInNewContext(ts.transpileModule(body+'\nglobalThis.result={mark:FundsMark,text:creditBalanceText,changes:creditChangesAt};',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  return context.result;
}
const native:Meter={id:'balance:credits',kind:'balance',unit:'credits:codex',amount:'0',limit:null,at:100,staleAfterMs:100,validUntil:1001,stale:false,resetAt:null,minutes:null,scope:null,label:null};

test('production cap and credit presentations use historical availability without inventing a recent observation',()=>{
  const cap={...native,id:'quota:credit:5h',kind:'cap' as const,unit:'credits:zai',amount:'40',limit:'100'},at=800;
  assert.equal(capStale(cap,at),false);assert.equal(capChangesAt(cap,at),1001);
  assert.equal(capStale(cap,1001),true);assert.equal(capChangesAt(cap,1001),null);
  assert.equal(capStale({...cap,resetAt:700},at),true,'the resource reset remains authoritative');
  for(const locale of ['en','ru'] as const){setLocale(locale);
    for(const status of ['finite','unlimited'] as const){
      const creditBalance:CreditBalanceState={id:'balance:credits',unit:'credits:codex',status,at:native.at,staleAfterMs:native.staleAfterMs,validUntil:native.validUntil,hasCredits:true};
      const source={provider:'codex',creditBalance,meters:status==='finite'?[native]:[]},draw=funds(at);
      const props={source,groups:[],context:defaultCurrencyContext,native:status==='finite'?native:undefined,rateSources:'',quoteDate:'',displayUnavailable:false};
      assert.equal(draw.text(source,at),status==='finite'?null:t('money.unlimited'));
      assert.equal(draw.mark(props).props.children.props.tone,undefined);
      assert.equal(draw.changes(source,at),1001);
      const expired=funds(1001);assert.equal(expired.text(source,1001),t('money.stale'));
      assert.equal(expired.mark(props).props.children.props.tone,'warn');assert.equal(expired.changes(source,1001),null);
      assert.equal(creditBalance.at,100);
      const live={...source,creditBalance:{...creditBalance,validUntil:undefined}};
      assert.equal(draw.text(live,201),t('money.stale'),'live and compact retain the original sample TTL');
    }
  }
  setLocale('en');
});

test('the production totals distinguish an available amount from confirmed zero spending',()=>{
  const series={sourceId:'wallet',meterId:'balance',kind:'balance' as const,unit:'USD',semantics:null,start:'100000000',end:'100000000',spent:null,topup:null,unlocated:[],topupUnlocated:[],coveredMs:0,points:[]};
  assert.deepEqual(moneyTotal(series,100,1000),{amount:null,unknown:true,partial:true});
  assert.deepEqual(moneyTotal({...series,spent:'0',coveredMs:500},100,1000),{amount:'0',unknown:false,partial:true});
  assert.deepEqual(moneyTotal({...series,spent:'0',coveredMs:900},100,1000),{amount:'0',unknown:false,partial:false});
});
