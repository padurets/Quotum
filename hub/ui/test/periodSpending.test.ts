import * as widgets from '../../server/domain/widgets';
import {chartSeriesMuted} from '../lib/prefs';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {memo as reactMemo,type ReactElement} from 'react';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {buildApp} from '../../server/api';
import {Ingest} from '../../server/ingest';
import {Duty} from '../../server/duty';
import {Cadence} from '../../server/cadence';
import {Pairing} from '../../server/pairing';
import {Setup} from '../../server/setup';
import {ResetFeed} from '../../server/resets';
import {newSecret} from '../../server/domain/auth';
import {expandPeriod,type PeriodWireReply} from '../../server/domain/periodWire';
import {compose,expandHistory,targetOf} from '../../server/domain/history';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {composeMetersPrepared,type MeterHistory} from '../../server/domain/meterHistory';
import type {PeriodRange} from '../../server/domain/period';
import type {Meter} from '../../server/domain/meters';
import * as providers from '../../server/domain/providers';
import * as currency from '../../server/domain/currency';
import {EMPTY_VIEW} from '../../server/domain/view';
import {HistoryStore} from '../lib/history';
import * as moneyView from '../lib/moneyView';
import * as money from '../lib/money';
import * as moneyTable from '../lib/moneyTable';
import {timeRangeKey} from '../lib/timeRange';
import type {History} from '../lib/types';
import type {PlotBuffer} from '../lib/historyPlot';
import type {Line} from '../lib/lines';
import {preparationFixture} from './preparationFixture';

const M=60_000,H=60*M,NOW=1_800_000_000_000;
const selected={from:NOW-20*M+30_000,to:NOW-20_000};
const pointSum=(series:MeterHistory)=>series.points.reduce((sum,point)=>sum+BigInt(point.spent??'0'),0n).toString();

async function fixture(t:TestContext) {
  t.mock.method(Date,'now',()=>NOW);
  const store=new Store(':memory:',NOW-3*H),directory=new Directory(store.db);
  const user=directory.createUser('spending@example.test','Spending','unused',NOW-3*H),board=directory.boards(user.id)[0].id;
  const token=newSecret('qt_s');directory.createSession(token,user.id,NOW-3*H,24*H);
  const app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null});
  t.after(async()=>{await app.close();store.close();});
  const source=store.source('openrouter','a'.repeat(24),NOW-3*H);store.hold(source,user.id,NOW-3*H);
  const record=(at:number,usage:string,ttl=H)=>{
    const meter=(id:string,amount:string):Meter=>({id,kind:'counter',unit:'USD',amount,limit:null,at,staleAfterMs:ttl,resetAt:null,minutes:null,scope:null,label:null,stale:false});
    store.record(source,{type:'meters',observedAt:at,staleAfterMs:ttl,meters:[meter('credits','20000000000000000'),meter('usage',usage)],keys:[],inventoryComplete:true,inventoryError:null});
  };
  const read=async(range:PeriodRange,from=Math.floor(range.from/M)*M,to=Math.ceil(range.to/M)*M,display?:string)=>{
    const response=await app.inject({method:'POST',url:`/api/boards/${board}/period`,headers:{origin:'http://localhost',cookie:`quotum_session=${token}`},payload:{version:1,selection:{mode:'range',...range},evaluatedAt:NOW,budget:{cell:String(M),from:String(from),to:String(to),meters:JSON.stringify([[source,'balance']]),unit:'USD',...(display?{currency:display}:{})}}});
    assert.equal(response.statusCode,200,response.body);
    const reply=expandPeriod(response.json<PeriodWireReply>());assert.ok(reply.budget?.state==='complete');
    const value=reply.budget.value;assert.ok(value.tape?.fixed);
    const answer=expandHistory(value),raw=compose(answer.chunks,answer,targetOf(range.to-range.from,NOW,timeRangeKey(range),range),new Set());
    const accounting=new PeriodAccounting(value.tape,null),exact=accounting.project(raw,range);
    return {answer,raw,exact,accounting};
  };
  return {store,user,board,source,record,read};
}

/** Execute MoneyHistory and its real preparation hook; only browser hooks are supplied. */
function consumer(sourceId:string,board:string,range:PeriodRange) {
  const hooks=preparationFixture(),Chart=()=>null;
  const sources=[{id:sourceId,title:'Wallet',provider:'openrouter'}];
  let history:History|null=null,strip:PlotBuffer|null=null;
  const prefs={money:{unit:'USD'},muted:{},range:'1h',horizon:'auto'};
  const memo=(read:()=>unknown,deps:unknown[])=>{const ref=hooks.useRef(null) as {current:{deps:unknown[];value:unknown}|null};if(!ref.current||deps.some((v,i)=>!Object.is(v,ref.current!.deps[i])))ref.current={deps,value:read()};return ref.current.value;};
  const modules:Record<string,unknown>={
    'react/jsx-runtime':jsx,react:{memo:reactMemo,useRef:hooks.useRef,useMemo:memo},
    '../../server/domain/providers':providers,'../../server/domain/currency':currency,'../../server/domain/meterHistory':{composeMetersPrepared},
    '../lib/board':{useBoardId:()=>board,useCurrencyContext:()=>currency.defaultCurrencyContext,useNamed:()=>sources},
    '../lib/history':{useBudgetFinancialHistory:()=>({history,drawing:history,loading:false,presentation:0}),useBudgetHistoryPlot:()=>strip,useHistoryBegins:()=>NOW-3*H,budgetHistory:{retry:()=>{}}},
    '../lib/prefs':{useChartMuted:()=>prefs.muted,chartSeriesMuted,usePref:(key:keyof typeof prefs)=>prefs[key]},'../lib/moneySelection':{moneySelection:()=>({selection:{unit:'USD',ids:[[sourceId,'balance']]},omitted:0,removed:0})},
    '../lib/moneyView':moneyView,'../lib/money':money,'../lib/moneyTable':moneyTable,'./seriesFocus':{useSeriesFocus:()=>{}},'../lib/view':{...widgets,colorOf:()=> '#fff'},
    '../lib/periods':{frameOf:()=>({...range,live:false}),measuredTo:()=>range.to},'../lib/timeRange':{useTimeRange:()=>range,timeRangeKey},
    '../lib/clock':{useClock:()=>NOW},'../lib/pan':{usePanning:()=>strip?1:null},'../lib/axisNavigation':{axisNavigation:()=>({context:board})},
    '../i18n':{t:(key:string)=>key,useLocale:()=> 'en'},'./prepared':{usePrepared:hooks.usePrepared},'./sizing':{usePlot:()=>({plot:{},onBase:()=>{}})},'./Chart':{Chart},
  };
  type Drawing={lines:Line[];prepared:boolean;axis:{rawValue:(key:string,at:number)=>string|undefined}};
  const context={exports:{} as {MoneyHistory:(props:unknown)=>ReactElement<{children:ReactElement[]}>},require:(name:string)=>modules[name]??{}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneyAnalytics.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{hooks.begin();const tree=context.exports.MoneyHistory({arrange:{view:EMPTY_VIEW,owner:false}});hooks.commit();return (tree.props.children.find(node=>node?.type===Chart) as ReactElement<Drawing>).props;};
  return (next:History,plot:PlotBuffer|null)=>{history=next;strip=plot;for(let i=0;i<3;i++){render();hooks.finish();}return render();};
}

for(const amount of ['3000000','9007199254740993'])test(`the balance consumer preserves the exact remaining amount after spending ${amount} through the pan fold`,async t=>{
  const h=await fixture(t);h.record(NOW-21*M,'0');h.record(NOW-70_000,'0');h.record(NOW-50_000,amount);
  let range={from:selected.from-M,to:selected.to-M};
  const initial=await h.read(range),loader=new HistoryStore({now:()=>NOW,elapsedNow:()=>0,preparations:null,setTimeout:()=>({}),clearTimeout:()=>{},dropTimeRange:()=>{throw Error('unexpected range loss');},
    read:async(_board,_cell,from,to)=>(await h.read(range,from,to)).answer},undefined,'budget');
  t.after(()=>loader.close());loader.choose('1h',range);loader.setMeters({unit:'USD',ids:[[h.source,'balance']]});loader.open(h.board);loader.hello(initial.answer.run);loader.snapshot([h.source],[],NOW-3*H);
  const settle=async(ready:()=>boolean)=>{for(let i=0;i<1000;i++){await new Promise(resolve=>setImmediate(resolve));if(ready())return;}throw Error('history did not settle');};
  await settle(()=>!!loader.get().history&&!loader.get().loading);
  loader.pan({token:1,length:selected.to-selected.from,...selected,direction:1});await settle(()=>!!loader.getPlot());
  const draw=consumer(h.source,h.board,selected),pan=draw(loader.get().history!,loader.getPlot());
  const remaining=(20000000000000000n-BigInt(amount)).toString();
  assert.equal(pan.axis.rawValue(pan.lines[0].key!,selected.to-1),remaining,'the raw strip retains exact balance after the reported usage');
  range=selected;const answer=await h.read(range);loader.choose('1h',range);loader.endPan(true);
  await settle(()=>!loader.getPlot()&&!loader.get().loading&&loader.get().history?.range===timeRangeKey(range));
  const exact=answer.accounting.project(loader.get().history!,range),series=exact.meterSeries![0];
  assert.equal(series.spent,amount);
  // This also fails on a null-to-zero or skipped-point patch, before invoking the consumer.
  assert.equal(pointSum(series),amount,'the exact boundary points retain the real spending contribution');
  const folded=draw(exact,loader.getPlot());assert.equal(folded.prepared,true);
  assert.equal(folded.axis.rawValue(folded.lines[0].key!,range.to-1),remaining,'folding preserves the exact balance readout');
  assert.equal(folded.lines[0].points.at(-1)![1],pan.lines[0].points.at(-1)![1],'the balance path has no amount jump or duplicate step');
});

test('exact spending reclassifies crossing interior steps and keeps exclusive endpoints and currency amounts',async t=>{
  const h=await fixture(t),a=NOW-20*M+10_000,b=NOW-18*M+10_000,c=NOW-50_000;
  h.record(NOW-21*M,'0');h.record(a,'0');h.record(b,'3000000');h.record(c,'7000000');
  const display=h.store.currencies.create(h.user.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',NOW-3*H);
  h.store.currencies.select(h.user.id,display.id);
  for(const unit of [undefined,display.id])for(const to of [c-1,c,c+1,selected.to]){
    const range={...selected,to},reply=await h.read(range,undefined,undefined,unit),series=reply.exact.meterSeries![0],expected=to<=c?'0':unit?'8000000':'4000000';
    assert.equal(series.spent,expected);assert.equal(pointSum(series),expected);
    assert.deepEqual(series.unlocated.map(step=>[step.from,step.to,step.amount,step.evidence]),[[a,b,unit?'6000000':'3000000','continuous']]);
    assert.ok(series.points.every(point=>point.at<to));
    assert.deepEqual(series.points.flatMap(point=>point.steps).filter(step=>step.to===b).map(step=>step.amount),[unit?'6000000':'3000000']);
    if(unit){assert.equal(series.points.at(-1)!.semantics?.conversion?.original.amount,to<=c?'19999999997000000':'19999999993000000');assert.equal(series.points.at(-1)!.semantics?.conversion?.rate.to,'2000000');}
  }
});

test('gaps stay unlocated while available boundary points retain confirmed zero spending',async t=>{
  const h=await fixture(t);h.record(NOW-21*M,'0',M);h.record(NOW-50_000,'3000000',M);h.record(NOW-30_000,'3000000',M);
  const {exact}=await h.read(selected),series=exact.meterSeries![0];
  assert.equal(series.spent,'0');assert.equal(pointSum(series),'0');assert.equal(series.coveredMs,20_000);
  assert.deepEqual(series.unlocated.map(step=>[step.amount,step.evidence]),[['3000000','gap']]);
  assert.deepEqual(series.points.flatMap(point=>point.steps).map(step=>[step.amount,step.evidence]),[['3000000','gap']]);
  const result=consumer(h.source,h.board,selected)(exact,null);assert.equal(result.prepared,true);assert.equal(result.axis.rawValue(result.lines[0].key!,selected.to-1),'19999999997000000');
});
