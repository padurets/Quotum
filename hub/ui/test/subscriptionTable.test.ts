import {HistoryFailure} from '../components/HistoryFailure';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import type {Forecast as ForecastComponent} from '../components/Forecast';
import * as format from '../lib/format';
import * as quota from '../lib/quota';
import * as forecast from '../lib/forecast';
import * as plan from '../lib/plan';
import * as work from '../lib/work';
import * as view from '../lib/view';
import * as subscription from '../lib/subscription';
import * as timeRange from '../lib/timeRange';
import * as i18n from '../i18n';
import type {Card,History,Kind} from '../lib/types';
import {EMPTY_VIEW} from '../../server/domain/view';
import {mapZai,decodeZai} from '../../server/connectors/zai';
import {composeMeters,meterCells} from '../../server/domain/meterHistory';

const M=60_000;
const measured=mapZai(decodeZai(JSON.stringify({code:200,success:true,data:{limits:[{type:'CREDIT_LIMIT',unit:3,number:5,usage:2000,currentValue:800},{type:'CREDIT_LIMIT',unit:6,number:1,usage:10000,currentValue:2000}]}})),0).measurement!;
const cap:Card&{title:string}={id:'zai:fixture',provider:'zai',title:'Personal',plan:'lite',windows:[],meters:measured.meters,resets:null,owners:[],error:null,successAt:0,stale:false,staleAfterMs:10*M,measureIntervalMs:null};
const native:Card&{title:string}={...cap,id:'codex:fixture',provider:'codex',title:'Native',meters:undefined,windows:['session','weekly'].map((kind,i)=>({id:kind,kind:kind as Kind,label:null,remaining:70,used:30,resetAt:null,minutes:i?10080:300}))};
const meters=cap.meters!.flatMap(m=>meterCells({source:cap.id,meter:m.id,readings:[{...m,previousAt:null}],spans:[{from:0,to:M,staleAfterMs:10*M}]},m.unit,0,M,M));
const base:History={range:'24h',live:true,since:0,to:M,cellMs:M,historyStart:0,events:[],series:native.windows.map(w=>({sourceId:native.id,windowId:w.id,points:[[0,70,1]],consumed:2,coveredMs:M,remainingAtStart:72,remainingAtEnd:70,staleAfterMs:10*M,work:null})),meterSeries:composeMeters([{from:0,meterSeries:meters}],M,0,M),activity:{since:0,known:null,barMs:M,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
let history:History|null=base,kind:Kind='weekly',sources=[cap,native],error:'history_limit'|null=null;
const modules:Record<string,unknown>={react:React,'react/jsx-runtime':jsxRuntime,'../lib/format':format,'../lib/quota':quota,'../lib/forecast':forecast,'../lib/plan':plan,'../lib/work':work,'../lib/view':view,'../lib/subscription':subscription,'../lib/timeRange':timeRange,'../i18n':i18n,
  '../lib/prefs':{usePrefs:()=>({kind}),usePref:()=>({unit:null})},'../lib/board':{useNamed:()=>sources,useLineup:()=>sources.map(s=>s.id),useForecastsOf:()=>[{},{}],useResetNews:()=>null},'../lib/clock':{hubNow:()=>M,useClock:()=>M},'../lib/history':{quotaHistory:{retry:()=>{}},useHistory:()=>({history,loading:false,error})},'./HistoryFailure':{HistoryFailure},'./Popover':{Popover:()=>null},'./MoneyAnalytics':{MoneyTable:()=>{throw new Error('a subscription reached the money table');}}};
const context={exports:{} as {Forecast:typeof ForecastComponent},React,require:(name:string)=>modules[name]??{}};
runInNewContext(ts.transpileModule(readFileSync(new URL('../components/Forecast.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
const render=()=>renderToStaticMarkup(React.createElement(context.exports.Forecast,{arrange:{view:EMPTY_VIEW,owner:false,update:()=>{}}}));
const row=(html:string)=>[...html.matchAll(/<tr>(.*?)<\/tr>/g)].find(m=>m[1].includes('Personal'))![1];

test('the actual percentage table includes both subscription producers in both periods and languages',()=>{
  try {
    for(const locale of ['en','ru'] as const)for(const selected of ['session','weekly'] as const) {
      i18n.setLocale(locale);kind=selected;history=base;sources=[cap,native];
      const html=render(),cells=row(html);
      assert.ok(html.includes('Native')&&html.includes('70%'));
      assert.ok(cells.includes(selected==='session'?'60%':'80%'));
      assert.ok((cells.match(/>—</g)??[]).length>=5,'unsupported spending, work and forecasts remain unknown');
      assert.ok(!cells.includes('credits')&&!cells.includes('USD')&&!/>0%</.test(cells));
    }
  }finally{i18n.setLocale('en');history=base;kind='weekly';}
});

test('the actual range table retains historical percentage edges when the current cap is unavailable',()=>{
  kind='session';sources=[{...cap,meters:[]},native];history={...base,range:`0-${M}`,live:false};
  try {
    const cells=row(render());assert.equal((cells.match(/60%/g)??[]).length,2);
    assert.ok((cells.match(/>—</g)??[]).length>=3);assert.ok(!/>0%</.test(cells));
    history={...base,live:true};const current=row(render());assert.ok(!current.includes('60%'));
  }finally{history=base;sources=[cap,native];kind='weekly';}
});

test('the shared table explains a bounded-history refusal instead of leaving a loading message',()=>{
  history=null;error='history_limit';
  try {
    for(const locale of ['en','ru'] as const) {
      i18n.setLocale(locale);const html=render();
      assert.ok(html.includes(i18n.t('money.historyLimit')));
      assert.ok(!html.includes(i18n.t('history.loading')));
    }
  }finally{i18n.setLocale('en');history=base;error=null;}
});
