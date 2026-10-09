import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import type {QuotaCard as QuotaComponent,CapReset as ResetComponent,KeyMetrics as KeyComponent} from '../components/MoneyCard';
import * as money from '../lib/money';
import * as format from '../lib/format';
import * as quota from '../lib/quota';
import {MeterBar,PercentLimit,ResetText} from '../components/Meter';
import {QUOTA_IDS} from '../../server/domain/meters';
import {t} from '../i18n';
import {readout} from '../lib/readout';
import {meterPointIn,moneyTotal} from '../lib/moneyView';
import {subscriptionSelection} from '../lib/subscription';
import {EMPTY_VIEW} from '../../server/domain/view';
import {setLocale} from '../i18n';
import {mapZai,decodeZai} from '../../server/connectors/zai';
import {meterCells,composeMeters} from '../../server/domain/meterHistory';
import type {Card} from '../lib/types';
import {preciseReadout, type Line} from '../lib/lines';

Object.assign(globalThis,{React});
const now=Date.now();
const result=mapZai(decodeZai(JSON.stringify({code:200,success:true,data:{level:'lite',limits:[
  {type:'CREDIT_LIMIT',unit:3,number:5,usage:2000,currentValue:800},
  {type:'CREDIT_LIMIT',unit:6,number:1,usage:10000,currentValue:2000},
]}})),now);
const context={exports:{} as {QuotaCard:typeof QuotaComponent;CapReset:typeof ResetComponent;KeyMetrics:typeof KeyComponent},React,require:(name:string)=>{
  if(name==='react/jsx-runtime')return jsxRuntime;
  if(name.endsWith('/meters'))return {QUOTA_IDS};
  if(name.endsWith('/money'))return money;
  if(name.endsWith('/format'))return format;
  if(name.endsWith('/clock'))return {useClock:()=>now};
  if(name.endsWith('/i18n'))return {t};
  if(name==='./Meter')return {MeterBar,PercentLimit,ResetText};
  if(name.endsWith('/quota'))return quota;
  return {};
}};
runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
const QuotaCard=context.exports.QuotaCard;
const card:Card={id:'zai:fixture',provider:'zai',plan:'lite',windows:[],resets:null,owners:[],error:null,successAt:now,stale:false,staleAfterMs:204000,measureIntervalMs:null,meters:result.measurement!.meters,quota:result.quotaObservation!.quota};

const visibleText=(html:string)=>html.replace(/<[^>]*>/g,'');
test('card and compact use the standard percentage hierarchy and shared period names',()=>{
  try {
    for(const language of ['en','ru'] as const) {
      setLocale(language);
      for(const compact of [false,true]) {
        const html=renderToStaticMarkup(createElement(QuotaCard,{source:card,compact}));
        const visible=visibleText(html);
        for(const amount of language==='en'?['1,200','8,000']:['1 200','8 000'])assert.ok(html.includes(amount),'exact credits remain in value details');
        assert.ok(!visible.includes(t('quota.credits'))&&!visible.includes(t('money.of',{amount:''})),visible);
        assert.ok(!html.includes('USD')&&!html.includes('account-balance')&&!html.includes('credits:zai'));
        assert.ok(html.includes(language==='en'?'reset time unknown':'время сброса неизвестно'));
        assert.equal(html.includes(language==='en'?'>reset time unknown</span>':'>время сброса неизвестно</span>'),!compact,'compact keeps the full explanation in its tooltip');
        assert.ok(visible.includes('60%')&&visible.includes('80%'));
        assert.ok(visible.includes(t('kind.title.session'))&&visible.includes(t('kind.title.weekly')));
        assert.ok(!html.includes('limit-share')&&!html.includes('money-limit')&&!html.includes('is-money'));
        const values=[...html.matchAll(compact?/<strong class="v-[^"]+"[^>]*>(.*?)<\/strong>/g:/<span class="limit-value v-[^"]+"[^>]*>(.*?)<\/span>/g)].map(match=>visibleText(match[1]));
        assert.deepEqual(values,['60%','80%'],'remaining percent is the sole primary value');
        assert.equal((html.match(/class="meter"/g)??[]).length,2);
      }
    }
    const missing=renderToStaticMarkup(createElement(QuotaCard,{source:{...card,meters:[card.meters![0]]}}));
    assert.equal((missing.match(/class="limit"/g)??[]).length,2,'absence keeps the same two quota rows');
  }finally{setLocale('en');}
});

test('an explicitly lifetime cap keeps its confirmed absence of a reset',()=>{
  const html=renderToStaticMarkup(createElement(context.exports.CapReset,{meter:{...card.meters![0],scope:'lifetime'},short:true}));
  assert.ok(!html.includes('reset time unknown')&&!html.includes('—'));
});

test('each quota uses the shared cap status dot without dimming its retained value',()=>{
  try {
    for(const language of ['en','ru'] as const)for(const compact of [false,true]) {
      setLocale(language);
      for(const cap of [{...card.meters![0],stale:true},{...card.meters![0],at:now-204001},{...card.meters![0],resetAt:now}]) {
        const html=renderToStaticMarkup(createElement(QuotaCard,{source:{...card,meters:[cap,card.meters![1]]},compact}));
        const dots=[...html.matchAll(/<small data-time="key-status"[^>]*>/g)].map(m=>m[0]);
        assert.equal(dots.length,2);
        assert.ok(dots[0].includes('aria-hidden="false"')&&dots[0].includes(t('money.stale')));
        assert.ok(dots[1].includes('aria-hidden="true"'),'the fresh weekly cap keeps its own status');
        assert.ok(visibleText(html).includes('60%'),'the last confirmed remaining percentage is kept');
        assert.ok(html.includes(language==='en'?'1,200':'1 200'),'exact retained credits are available in details');
        assert.ok(!html.includes('is-stale')&&!html.includes('cap-stale'));
      }
      const missing=renderToStaticMarkup(createElement(QuotaCard,{source:{...card,meters:[card.meters![1]]},compact}));
      assert.ok(missing.includes(t('quota.unavailable')));
    }
  }finally{setLocale('en');}
});

test('OpenRouter cap dots retain missing and inactive key states without row dimming',()=>{
  const id='111111111111',cap={...card.meters![0],id:`key:${id}:cap`,unit:'USD' as const,stale:true};
  const part={id,name:'Laptop',disabled:false,expiresAt:null,includeByok:false,at:now,staleAfterMs:204000,presence:'missing' as const,missCount:1,periods:{day:null,week:null,month:null}};
  for(const compact of [false,true]) {
    const missing=renderToStaticMarkup(createElement(context.exports.KeyMetrics,{part,meters:[cap],compact}));
    assert.ok(missing.includes(t('money.missing'))&&!missing.includes('is-stale')&&!missing.includes('cap-stale'));
    const inactive=renderToStaticMarkup(createElement(context.exports.KeyMetrics,{part:{...part,disabled:true},meters:[cap],compact}));
    assert.ok(inactive.includes('is-inactive')&&inactive.includes(t('money.inactive')));
  }
});

test('a passed reset time waits for evidence instead of asserting that the window reset',()=>{
  try {
    for(const language of ['en','ru'] as const) {
      setLocale(language);
      const html=renderToStaticMarkup(createElement(context.exports.CapReset,{meter:{...card.meters![0],resetAt:now-1},short:false}));
      assert.ok(html.includes(language==='en'?'reset time passed, waiting for a measurement':'время сброса прошло, ждём замер'));
      assert.ok(!html.includes(language==='en'?'window reset':'окно сброшено'));
    }
  }finally{setLocale('en');}
});

test('ordinary subscription history selects both caps without manufacturing spending',()=>{
  const selected=subscriptionSelection([card],EMPTY_VIEW);
  assert.deepEqual(selected?.ids.map(([,id])=>id),['quota:credit:5h','quota:credit:week']);
  const row={...card.meters![0],previousAt:null};
  const series=composeMeters([{from:now,meterSeries:meterCells({source:card.id,meter:row.id,readings:[row],spans:[{from:now,to:now,staleAfterMs:204000}]},row.unit,now,now+600000,60000)}],60000,now,now+600000)[0];
  assert.equal(moneyTotal(series,now,now+600000).amount,null);
});

test('cap readout requires its own fetched cell and exclusive producer bounds',()=>{
  const series={sourceId:'zai:fixture',meterId:'quota:credit:5h',kind:'cap' as const,unit:'credits:zai',semantics:null,start:null,end:null,spent:'0',unlocated:[],topup:'0',topupUnlocated:[],coveredMs:60000,
    points:[{at:120000,value:'1200000000',spent:'0',segment:1,semantics:{limit:'2000000000',resetAt:180000,minutes:300,scope:'five_hour',label:null},steps:[],knownFrom:120000,knownUntil:180000}]};
  const line:Line={sourceId:series.sourceId,windowId:series.meterId,key:'cap',name:'quota',provider:'zai',kind:'other',label:null,minutes:300,color:'#abc',dash:'',current:1200,consumed:0,coveredMs:60000,remainingAtStart:null,remainingAtEnd:null,staleAfterMs:86400000,work:null,points:[[120000,1200,1]],capCells:[{at:120000,from:120000,to:180000,value:1200}]};
  assert.equal(meterPointIn(series,120000,60000)?.value,'1200000000');
  for(const at of [60000,180000,600000]) {
    assert.equal(meterPointIn(series,at,60000),undefined);
    assert.equal(readout([line],[],at,60000,900000,900000).rows[0].value,null);
  }
  assert.equal(readout([line],[],120000,60000,900000,900000).rows[0].value,1200);
  for(const [from,to,hover,value] of [[120000,150000,150000,null],[150000,180000,160000,1200],[150000,180000,140000,null]] as const) {
    assert.equal(readout([{...line,capCells:[{at:120000,from,to,value:1200}]}],[],120000,60000,900000,900000,[],undefined,hover).rows[0].value,value);
  }
  assert.equal(meterPointIn({...series,points:series.points.map(p=>({...p,knownUntil:150000}))},150000,60000),undefined);
  assert.equal(meterPointIn({...series,points:series.points.map(p=>({...p,knownFrom:undefined,knownUntil:undefined}))},120000,60000),undefined,'legacy cells do not grant carry-forward');
});

test('the actual chart caps geometry starts and ends at producer bounds without a bridge',()=>{
  const source=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
  const start=source.indexOf('if(line.capCells) {'),end=source.indexOf('} else if (incomingStrip && line.blocks)',start);
  const code=source.slice(start,end)+'}';
  const context={line:{capCells:[{at:0,from:30000,to:120000,value:60},{at:180000,from:180000,to:204001,value:50}]},incomingStrip:null,drawFrom:0,drawNow:300000,x:(at:number)=>at/1000,y:(value:number)=>value,paths:[] as {line:string}[],latest:'known'};
  const js=ts.transpileModule('function* draw(){'+code+'}\nfor(const _ of draw()){}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(js,context);
  assert.equal(context.paths[0].line,'M30.0,60.0L120.0,60.0M180.0,50.0L204.0,50.0');
});

test('actual pointer and chart tooltip retain time inside a cap cell through readout and formatting',()=>{
  const axisSource=readFileSync(new URL('../components/timeAxis.ts',import.meta.url),'utf8');
  const input=axisSource.slice(axisSource.indexOf('  const timeAt = '),axisSource.indexOf('  const onPointerDown = '));
  let pointed:number|null=null;
  const pointer={from:0,to:60000,width:60000,left:0,right:0,cellMs:60000,precise:true,visualGeometry:()=>({from:0,to:60000}),
    setHover:(at:number|null)=>{pointed=at;},useEffect:()=>{},pointer:{current:null},panPointer:{current:null},
    svg:{current:{getBoundingClientRect:()=>({left:0,width:60000})}},panning:null,folding:false,shifting:false,drag:null,holding:{current:null},
    move:null as unknown as (event:{clientX:number;pointerId:number;pointerType:string})=>void};
  runInNewContext(ts.transpileModule(input+'\nglobalThis.move=onPointerMove;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,pointer);
  pointer.move({clientX:55000,pointerId:1,pointerType:'mouse'});
  assert.equal(pointed,55000);
  pointer.precise=false;pointer.move({clientX:55000,pointerId:1,pointerType:'mouse'});
  assert.equal(pointed,0,'ordinary quota charts retain cell-based updates');

  const chart=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
  const head=chart.slice(chart.indexOf('  const model = '),chart.indexOf('  const columnCount = '));
  const value=chart.split('\n').find(line=>line.includes('{columns.left && <strong>'))!.trim().slice(1,-1);
  const position=chart.slice(chart.indexOf('  const observationHover='),chart.indexOf('  const narrow = '));
  for(const [from,until,expected] of [[0,45000,null],[30000,60000,1200]] as const) {
    const row={...card.meters![0],amount:'800000000',at:from,resetAt:null,previousAt:null};
    const series=composeMeters([{from:0,meterSeries:meterCells({source:card.id,meter:row.id,readings:[row],spans:[{from,to:from,staleAfterMs:204000,holdUntil:until}]},row.unit,0,60000,60000)}],60000,0,60000)[0];
    const line={key:'cap',points:[],staleAfterMs:86400000,capCells:series.points.map(p=>({at:p.at,from:p.knownFrom!,to:p.knownUntil!,value:Number(p.value)/1e6}))};
    const formatted:number[]=[];
    const fixture={React,preciseReadout,prepared:{ready:true,value:{basis:{from:0,to:60000},lines:[line],plans:[],forecasts:[],markers:[],paths:[],strip:null}},
      valueAxis:{formatValue:(_key:string,_value:number,at:number)=>{formatted.push(at);return meterPointIn(series,at,60000)?.value;}},
      currentClock:60000,desiredFrom:0,desiredNow:60000,desiredTo:60000,desiredLive:true,incomingReady:true,cellMs:60000,
      width:60000,left:0,right:0,height:220,top:12,bottom:28,axis:{hover:0,hoverAt:55000,screenX:(at:number)=>at,commitDrawing:()=>{}},
      useLayoutEffect:()=>{},niceTicks:()=>({ticks:[],daily:false}),readCell:readout,
      present:null as unknown as ()=>{value:number|null;element:React.ReactNode;x:number}};
    runInNewContext(ts.transpileModule(`function present(){${head}\n${position}\nconst row=rows[0];return {value:row.value,element:${value},x:hoverX};}\nglobalThis.present=present;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,fixture);
    const result=fixture.present();
    assert.equal(result.value,expected);assert.equal(result.x,55000);
    const html=renderToStaticMarkup(result.element);
    assert.equal(html,expected===null?'<strong></strong>':'<strong>1200000000</strong>');
    assert.deepEqual(formatted,expected===null?[]:[55000]);
  }
});
