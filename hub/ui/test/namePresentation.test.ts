import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as runtime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {Name} from '../components/Kit';
import {SeriesLegendItem} from '../components/AnalyticsPanel';
import {AnalyticsTable} from '../components/AnalyticsTable';
import {windowName,seriesName,sourceLabel,level} from '../lib/quota';
import {duration,num,stamp} from '../lib/format';
import {t,setLocale} from '../i18n';
import {nameRenderer} from './nameFixture';

const source=(file:string)=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const html=(type:React.ElementType,props:any)=>renderToStaticMarkup(React.createElement(type,props));
function meter(){
  const text=source('components/Meter.tsx'),context={exports:{} as Record<string,React.ElementType>,require:()=>runtime,Name:nameRenderer(),level,num,stamp,duration,t};
  runInNewContext(ts.transpileModule(text.slice(text.indexOf('export function MeterBar(')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  return context.exports.PercentLimit;
}

test('canonical quota names preserve semantic parts and owner punctuation in both languages',()=>{
  try {for(const locale of ['en','ru'] as const){setLocale(locale);
    const source={provider:'antigravity',title:'Account · literal'};
    for(const kind of ['session','weekly','other'] as const)for(const label of [null,'Gemini · literal'])for(const minutes of [null,0,60]){
      const w={kind,label,minutes},parts=kind==='other'?[label,minutes?duration(minutes*60000):''].filter(Boolean):label?[label,t(kind==='session'?'kind.session':'kind.weekly')]:[t(kind==='session'?'kind.title.session':'kind.title.weekly')];
      assert.equal(windowName(w),parts.join('\n'));
      const scope=kind==='other'?parts:label?[label]:[];
      assert.equal(seriesName(source,w),[source.title,...scope].join('\n'));
    }
    assert.equal(sourceLabel({provider:'unregistered'}),'unregistered');
    assert.equal(sourceLabel({provider:'claude',title:''}),'');
    assert.equal(seriesName({provider:'claude',title:''},{kind:'weekly',label:null,minutes:10080}),'');
  }} finally {setLocale('en');}
});

test('actual Name emits only semantic newline boundaries, with no hidden duplicate or punctuation splitting',()=>{
  const name='Owner · literal\nGemini · literal\n1h',tree=Name({name});
  assert.equal(tree.filter(part=>part==='\n').length,2);
  assert.equal(tree.filter(React.isValidElement).length,3);
  assert.equal(html(Name,{name}),'\x3cspan>Owner · literal</span>\n<span class="name-detail">Gemini · literal</span>\n<span class="name-detail">1h</span>');
  assert.equal(html(Name,{name:'Owner · literal'}),'<span>Owner · literal</span>');
});

test('actual ordinary/status/compact meters keep numeric semantics and canonical aria/title names',()=>{
  const PercentLimit=meter(),name='Gemini\nweekly';
  for(const compact of [false,true])for(const status of [undefined,React.createElement('small',{'data-status':'unavailable'})]){
    const output=html(PercentLimit,{name,remaining:75.25,reset:'reset',compact,status});
    assert.ok(output.includes('aria-label="Gemini\nweekly"'));
    assert.ok(output.includes('aria-valuenow="75"'));assert.ok(output.includes('width:75.25%'));
    assert.equal((output.match(/name-detail/g)||[]).length,1);
    assert.ok(!output.includes(' · '));assert.ok(output.includes('weekly</span>'));
    if(compact){assert.ok(output.includes('title="Gemini\nweekly"'));assert.ok(output.includes('compact-window-name'));}
  }
  const missing=html(PercentLimit,{name,remaining:null,reset:'—',status:React.createElement('small',{'data-status':'missing'})});
  assert.ok(!missing.includes('role="progressbar"'));assert.ok(!missing.includes('aria-valuenow'));assert.ok(missing.includes('name-detail'));
});

test('actual shared legend preserves identity, description, swatch and value alongside separated scope',()=>{
  const output=html(SeriesLegendItem,{seriesKey:'source@weekly',name:'Account\nGemini',description:'evidence',color:'red',children:React.createElement('b',{},'75%')});
  assert.ok(output.includes('data-series-key="source@weekly"'));assert.ok(output.includes('aria-pressed="false"'));
  assert.ok(output.includes('<span>Account</span>\n<span class="name-detail">Gemini</span>'));assert.ok(output.includes('<b>75%</b>'));assert.ok(output.includes('evidence'));
});

test('actual analytics table uses identical name markup for live and sizing rows without changing keys or cell values',()=>{
  const props={columns:[{id:'value',title:'Value',width:120}],rows:[{key:'source@weekly',name:'Account\nGemini',color:'red',cells:{value:{content:'75%'}}}],name:'Source'};
  for(const layout of ['table','list'] as const){
    const live=html(AnalyticsTable,{...props,layout}),sizing=html(AnalyticsTable,{...props,layout,still:true});
    for(const output of [live,sizing]){assert.ok(output.includes('<span>Account</span>\n<span class="name-detail">Gemini</span>'));assert.ok(output.includes('75%'));}
    assert.equal((live.match(/name-detail/g)||[]).length,(sizing.match(/name-detail/g)||[]).length);
  }
});

test('actual resource-window filter renders semantic parts while its source/window selection references stay exact',()=>{
  const text=source('components/DataFilters.tsx'),start=text.indexOf('function Resource('),end=text.indexOf('\nfunction Resources(',start);
  let refs:unknown[]=[];
  const context={exports:{} as {Resource:React.ElementType},require:()=>runtime,Name:nameRenderer(),matchesSource:()=>true,quotaPeriods:(s:any)=>s.windows,subscriptionFundsVisible:()=>false,matchesSelection:(_filters:unknown,ref:unknown)=>{refs.push(ref);return true;},dataFilters:{toggle:()=>{throw Error('render cannot mutate filters');}},FilterGroup:({children}:any)=>React.createElement('div',{},children(true)),FilterRow:({children}:any)=>React.createElement('div',{},children),windowName,logoOf:()=>'',t};
  runInNewContext(ts.transpileModule('export '+text.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const output=html(context.exports.Resource,{source:{id:'source-exact',provider:'antigravity',windows:[{id:'weekly-exact',kind:'weekly',label:'Gemini',minutes:10080}]},filters:{windows:{}},wallets:[],visible:true,series:[]});
  assert.deepEqual(JSON.parse(JSON.stringify(refs)),[['source-exact','weekly-exact']]);assert.ok(output.includes('name-detail'));assert.ok(output.includes('Gemini'));
});


test('actual forecast descriptor keeps full canonical tooltip words while SVG receives the same flattened name and a paint boundary',()=>{
  const chart=source('components/Chart.tsx'),start=chart.indexOf('  const beyond = ['),end=chart.indexOf('  const announced = ',start);
  const context={exports:{} as {read:()=>any[]},markers:[],desiredLive:true,desiredTo:0,forecasts:[],runOutPast:()=>[{key:'exact-id',name:'Owner  ·  literal \n  Gemini · literal',at:100,color:'red'}],stamp,t};
  runInNewContext(ts.transpileModule('exports.read=()=>{'+chart.slice(start,end)+'return beyond;};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const [row]=context.exports.read();assert.equal(row.key,'forecast-exact-id');
  assert.equal(row.label,'Owner  ·  literal \n  Gemini · literal');
  assert.equal(row.name,'Owner · literal Gemini · literal');assert.equal(row.detailFrom,row.name.indexOf('Gemini'));
  const hover=chart.split('\n').find(line=>line.includes('{row.line.name}</span>'))!;
  const edge=chart.split('\n').find(line=>line.includes('className={`tooltip-marker'))!;
  const draw=(line:string,globals:object)=>{const vm={exports:{} as {draw:()=>React.ReactNode},require:()=>runtime,...globals};runInNewContext(ts.transpileModule('exports.draw=()=>('+line.trim()+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,vm);return renderToStaticMarkup(React.createElement(()=>vm.exports.draw()));};
  assert.ok(draw(hover,{row:{line:{name:row.label}}}).includes('class="tooltip-name multiline"'));
  assert.ok(edge.includes('multiline'),'full edge tooltip preserves semantic line breaks without flattening');
});
