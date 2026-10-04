import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import type {QuotaCard as QuotaComponent,CapReset as ResetComponent} from '../components/MoneyCard';
import * as money from '../lib/money';
import * as format from '../lib/format';
import * as quota from '../lib/quota';
import {MeterBar} from '../components/Meter';
import {QUOTA_IDS} from '../../server/domain/meters';
import {t} from '../i18n';
import {readout} from '../lib/readout';
import {meterPointIn,moneyTotal} from '../lib/moneyView';
import {moneySelection,DEFAULT_MONEY} from '../lib/moneySelection';
import {setLocale} from '../i18n';
import {mapZai,decodeZai} from '../../server/connectors/zai';
import {meterCells,composeMeters} from '../../server/domain/meterHistory';
import type {Card} from '../lib/types';
import type {Line} from '../lib/lines';

Object.assign(globalThis,{React});
const now=Date.now();
const result=mapZai(decodeZai(JSON.stringify({code:200,success:true,data:{level:'lite',limits:[
  {type:'CREDIT_LIMIT',unit:3,number:5,usage:2000,currentValue:800},
  {type:'CREDIT_LIMIT',unit:6,number:1,usage:10000,currentValue:2000},
]}})),now);
const context={exports:{} as {QuotaCard:typeof QuotaComponent;CapReset:typeof ResetComponent},React,require:(name:string)=>{
  if(name==='react/jsx-runtime')return jsxRuntime;
  if(name.endsWith('/meters'))return {QUOTA_IDS};
  if(name.endsWith('/money'))return money;
  if(name.endsWith('/format'))return format;
  if(name.endsWith('/clock'))return {useClock:()=>now};
  if(name.endsWith('/i18n'))return {t};
  if(name==='./Meter')return {MeterBar};
  if(name.endsWith('/quota'))return quota;
  return {};
}};
runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
const QuotaCard=context.exports.QuotaCard;
const card:Card={id:'zai:fixture',provider:'zai',plan:'lite',windows:[],resets:null,owners:[],error:null,successAt:now,stale:false,staleAfterMs:204000,measureIntervalMs:null,meters:result.measurement!.meters,quota:result.quotaObservation!.quota};

test('card and compact show the same independent credit quotas, never a monetary balance',()=>{
  try {
    for(const language of ['en','ru'] as const) {
      setLocale(language);
      for(const compact of [false,true]) {
        const html=renderToStaticMarkup(createElement(QuotaCard,{source:card,compact}));
        for(const amount of language==='en'?['1,200','8,000']:['1 200','8 000'])assert.ok(html.includes(amount),html);
        assert.ok(!html.includes('USD')&&!html.includes('account-balance')&&!html.includes('credits:zai'));
        assert.ok(html.includes(language==='en'?'reset time unknown':'время сброса неизвестно'));
        assert.equal(html.includes(language==='en'?'>reset time unknown</span>':'>время сброса неизвестно</span>'),!compact,'compact keeps the full explanation in its tooltip');
        assert.ok(html.includes('60%')&&html.includes('80%'));
        assert.ok(html.includes(language==='en'?'credits':'кр.'));
        assert.equal((html.match(/class="meter"/g)??[]).length,2);
      }
    }
    const missing=renderToStaticMarkup(createElement(QuotaCard,{source:{...card,meters:[card.meters![0]]}}));
    assert.equal((missing.match(/class="limit money-limit/g)??[]).length,2,'absence keeps the same two quota rows');
  }finally{setLocale('en');}
});

test('an explicitly lifetime cap keeps its confirmed absence of a reset',()=>{
  const html=renderToStaticMarkup(createElement(context.exports.CapReset,{meter:{...card.meters![0],scope:'lifetime'},short:true}));
  assert.ok(!html.includes('reset time unknown')&&!html.includes('—'));
});

test('credit selection defaults to both caps without adding them or manufacturing spending',()=>{
  const selected=moneySelection([card],[],{...DEFAULT_MONEY,unit:'credits:zai'});
  assert.deepEqual(selected.selection?.ids.map(([,id])=>id),['quota:credit:5h','quota:credit:week']);
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
  assert.equal(meterPointIn({...series,points:series.points.map(p=>({...p,knownUntil:150000}))},150000,60000),undefined);
  assert.equal(meterPointIn({...series,points:series.points.map(p=>({...p,knownFrom:undefined,knownUntil:undefined}))},120000,60000),undefined,'legacy cells do not grant carry-forward');
});

test('the actual chart caps geometry starts and ends at producer bounds without a bridge',()=>{
  const source=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
  const start=source.indexOf('      if(line.capCells) {'),end=source.indexOf('} else if (incomingStrip && line.blocks)',start);
  const code=source.slice(start,end)+'}';
  const context={line:{capCells:[{at:0,from:30000,to:120000,value:60},{at:180000,from:180000,to:204001,value:50}]},incomingStrip:null,drawFrom:0,drawNow:300000,x:(at:number)=>at/1000,y:(value:number)=>value,paths:[] as {line:string}[],latest:'known'};
  const js=ts.transpileModule('function* draw(){'+code+'}\nfor(const _ of draw()){}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(js,context);
  assert.equal(context.paths[0].line,'M30.0,60.0L120.0,60.0M180.0,50.0L204.0,50.0');
});
