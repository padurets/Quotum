import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {periodValues} from '../../server/periodValues';
import {EMPTY_VIEW} from '../../server/domain/view';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {providerOf} from '../../server/domain/providers';
import {quotaPeriods,primaryQuotaPeriods} from '../lib/subscription';
import {hasSubscriptionCaps} from '../lib/providers';
import {selectedAllowanceIds} from '../lib/moneySelection';
import {budgetVisible,historicalCurrencyContext} from '../lib/money';
import {level,windowName} from '../lib/quota';
import {num,stamp} from '../lib/format';
import {t,setLocale} from '../i18n';
import type {Win} from '../lib/types';
import {nameRenderer} from './nameFixture';

type Node={type:unknown;props:Record<string,unknown>};
const jsx=(type:unknown,props:Record<string,unknown>):Node=>({type,props});
const runtime={jsx,jsxs:jsx,Fragment:'fragment'};
const Name=nameRenderer(runtime);
const code=(file:string)=>readFileSync(new URL(file,import.meta.url),'utf8');
function nodes(value:unknown):Node[] {
  if(Array.isArray(value))return value.flatMap(nodes);
  if(!value||typeof value!=='object')return [];
  const node=value as Node;
  if(typeof node.type==='function')return nodes(node.type(node.props));
  return [node,...nodes(node.props.children)];
}

test('the source menu names the selected measurement count without an extra read',()=>{
  const card=code('../components/SourceCard.tsx'),start=card.indexOf('function SourceSettings('),end=card.indexOf('\n/**',start);
  let historical=false,missing=false;const hidden=new Set<string>();
  const windows=Array.from({length:5},(_,i)=>({id:String(i),kind:'weekly',label:'Model '+i,minutes:10080}));
  const source={id:'s',provider:'antigravity',windows};
  const context={exports:{} as {draw:(props:unknown)=>Node},require:()=>runtime,t,num,quotaPeriods,isWindowHidden:(_view:unknown,_source:string,id:string)=>hidden.has(id),
    useDataFilters:()=>{},usePeriodValues:()=>({value:missing?null:source,loading:false,error:null}),useTimeRange:()=>historical?{from:0,to:1}:null,useMine:()=>false,useState:(initial:unknown)=>[initial,()=>{}],planOf:()=>null,Popover:'popover',SlidersIcon:'icon',MeasurementDetails:'details',Frequency:'frequency',RefreshAction:'refresh'};
  runInNewContext(ts.transpileModule(card.slice(start,end)+'\nexports.draw=SourceSettings;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const label=()=>String(context.exports.draw({source,title:'Account',arrange:{owner:false,view:EMPTY_VIEW},boardId:'b',takeOff:false}).props.label);
  for(const locale of ['en','ru'] as const){setLocale(locale);assert.ok(label().includes(t('source.selectedMeasurements',{count:5})));hidden.add('1');assert.ok(label().includes(t('source.selectedMeasurements',{count:4})));historical=true;missing=true;assert.ok(!label().includes(t('source.selectedMeasurements',{count:0})),'unknown evidence is never a zero selection');historical=false;missing=false;hidden.clear();}
  setLocale('en');
});

test('multi-model cards keep the reported session and weekly pair visible through fine measurements',()=>{
  const window=(id:string,kind:Win['kind'],label:string|null):Win=>({id,kind,label,minutes:kind==='weekly'?10080:300,used:25,remaining:75,resetAt:null});
  const source={id:'native',provider:'antigravity',successAt:1,windows:[window('gemini:session','session','Gemini Pro'),window('gemini:weekly','weekly','Gemini'),window('claude:weekly','weekly','Claude')]};
  const hidden=new Set<string>();
  const context={exports:{} as Record<string,(props:unknown)=>Node>,draw:undefined as unknown as (props:unknown)=>Node,require:()=>runtime,
    Name,t,stamp,num,level,windowName,providerOf,quotaPeriods,primaryQuotaPeriods,hasSubscriptionCaps,budgetVisible,historicalCurrencyContext,
    useDataFilters:()=>({current:null}),usePref:()=>({}),selectedAllowanceIds,usePeriodValues:()=>({value:null}),useTimeRange:()=>null,useCurrencyContext:()=>defaultCurrencyContext,
    isWindowHidden:(_view:unknown,_source:string,id:string)=>hidden.has(id),planOf:()=>null,MeasurementClock:{Provider:'clock'},PercentLimit:undefined as unknown,
    ResetLine:'reset',PlanNote:'plan-note',PlanMark:'plan-mark',Limit:undefined as unknown,
  };
  const run=(body:string)=>runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const meter=code('../components/Meter.tsx');run(meter.slice(meter.indexOf('export function MeterBar(')));context.PercentLimit=context.exports.PercentLimit;
  const card=code('../components/SourceCard.tsx'),limit=card.indexOf('function Limit('),measurements=card.indexOf('function CardMeasurements(');
  run(card.slice(limit,card.indexOf('\n/**',limit))+'\nglobalThis.Limit=Limit;');
  run(card.slice(measurements,card.indexOf('/** Historical funds',measurements))+'\nglobalThis.draw=CardMeasurements;');
  const render=()=>nodes(context.draw({source,arrange:{view:EMPTY_VIEW},boardId:'b'}));
  const text=(value:unknown):string=>Array.isArray(value)?value.map(text).join(''):typeof value==='string'||typeof value==='number'?String(value):value&&typeof value==='object'?text(typeof (value as Node).type==='function'?(value as any).type((value as Node).props):(value as Node).props.children):'';
  const labels=(tree:Node[])=>tree.filter(node=>node.props.className==='limit-name').map(node=>text(node.props.children));
  const pair=[windowName(source.windows[0]),windowName(source.windows[1])];
  assert.deepEqual(labels(render()),pair,'a second model must not displace the first reported weekly limit');
  for(let i=1;i<=20;i++){
    const remaining=75-i/10;source.windows[1]={...source.windows[1],used:100-remaining,remaining};
    const tree=render(),fills=tree.filter(node=>String(node.props.className).startsWith('fill fill-'));
    assert.deepEqual(labels(tree),pair);assert.equal(fills.length,2);
    assert.equal((fills[1].props.style as {width:string}).width,`${remaining}%`,'every fine measurement reaches the visible weekly meter');
  }
  source.windows.push(window('claude:session','session','Claude'));
  assert.deepEqual(labels(render()),pair,'a second session family does not displace the weekly slot');
  source.windows.reverse();
  assert.deepEqual(labels(render()),pair,'identical facts keep the same pair regardless of reply order');
  source.windows.reverse();
  hidden.add('gemini:weekly');
  assert.deepEqual(labels(render()),[pair[0],windowName(source.windows[2])],'a selected replacement weekly limit keeps the session slot');
  source.windows.push(window('session','session',null),window('weekly','weekly',null));
  assert.deepEqual(labels(render()),source.windows.slice(-2).map(windowName),'general subscription windows lead over model windows');
});

test('native historical values disclose their actual sample time while live values retain their existing presentation',()=>{
  const now=1_800_000_000_000,at=now-3_600_000,store=new Store(':memory:',at-3_600_000);
  try {
    const directory=new Directory(store.db),user=directory.createUser('stamp@example.test','Stamp','unused',at-3_600_000),id=store.source('claude','native',at-3_600_000);
    store.hold(id,user.id,at-3_600_000);
    const window=(used:number):Win=>({id:'session',kind:'session',label:null,minutes:300,used,remaining:100-used,resetAt:now+3_600_000});
    for(const [observedAt,used] of [[at,5.4],[now,77]])store.record(id,{observedAt,staleAfterMs:600_000,plan:'pro',resets:null,windows:[window(used)]});
    const read=(to:number)=>periodValues(store,store.sources(directory.boards(user.id)[0].id),user.id,to,()=>{})[0];
    let selected:{from:number;to:number}|null={from:at-60_000,to:at+180_000};
    const reading={value:read(selected.to),basis:{range:selected},loading:false,error:null};
    assert.equal(reading.value.windows[0].observedAt,at);assert.equal(reading.value.windows[0].stale,false);
    const context={useDataFilters:()=>({current:null}),usePref:()=>({}),selectedAllowanceIds,exports:{} as Record<string,(props:unknown)=>Node>,draw:undefined as unknown as (props:unknown)=>Node,require:()=>runtime,
      Name,t,stamp,num,level,windowName,providerOf,quotaPeriods,primaryQuotaPeriods,hasSubscriptionCaps,budgetVisible,historicalCurrencyContext,
      usePeriodValues:()=>reading,useTimeRange:()=>selected,useCurrencyContext:()=>defaultCurrencyContext,
      isWindowHidden:()=>false,planOf:()=>null,MeasurementClock:{Provider:'clock'},PercentLimit:undefined as unknown,
      ResetLine:'reset',PlanNote:'plan-note',PlanMark:'plan-mark',PeriodStatus:'period-status',QuotaCard:'quota',Limit:undefined as unknown,AllHidden:'hidden',
    };
    const run=(body:string)=>runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
    const meter=code('../components/Meter.tsx');run(meter.slice(meter.indexOf('export function MeterBar(')));context.PercentLimit=context.exports.PercentLimit;
    const card=code('../components/SourceCard.tsx'),limit=card.indexOf('function Limit('),measurements=card.indexOf('function CardMeasurements(');
    run(card.slice(limit,card.indexOf('\n/**',limit))+'\nglobalThis.Limit=Limit;');
    run(card.slice(measurements,card.indexOf('/** Historical funds',measurements))+'\nglobalThis.draw=CardMeasurements;');
    const render=()=>nodes(context.draw({source:{id,provider:'claude',successAt:now,windows:[window(77)]},arrange:{view:EMPTY_VIEW},boardId:'b'}));
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);selected={from:at-60_000,to:at+180_000};reading.value=read(selected.to);reading.basis.range=selected;
      let tree=render(),value=tree.find(node=>String(node.props.className).startsWith('limit-value '))!;
      assert.equal(value.props.title,t('source.measured',{at:stamp(at)}));
      assert.equal((value.props.children as unknown[])[0],num(94.6));
      assert.equal(String(value.props.title).includes(stamp(selected.to)),false,'the period edge is not an observation');
      assert.equal(String(value.props.title).includes(stamp(now)),false,'current operational success is not the historical sample');
      assert.equal(tree.find(node=>node.props.className==='key-status')?.props['aria-hidden'],true);
      selected={from:at-60_000,to:at+660_000};reading.value=read(selected.to);reading.basis.range=selected;
      assert.equal(reading.value.windows[0].stale,true);
      tree=render();value=tree.find(node=>String(node.props.className).startsWith('limit-value '))!;
      assert.equal(value.props.title,[t('source.measured',{at:stamp(at)}),t('money.stale')].join('\n'));
      assert.equal(tree.find(node=>node.props.className==='key-status')?.props['aria-hidden'],false);
      selected=null;tree=render();value=tree.find(node=>String(node.props.className).startsWith('limit-value '))!;
      assert.equal(value.props.title,undefined);assert.equal((value.props.children as unknown[])[0],num(23));
      assert.equal(tree.some(node=>node.props.className==='key-status'),false);
    }
  } finally {setLocale('en');store.close();}
});
