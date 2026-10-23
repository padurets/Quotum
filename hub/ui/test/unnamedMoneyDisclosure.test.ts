import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {composeMeters} from '../../server/domain/meterHistory';
import {moneyIdentity} from '../lib/moneyView';
import {moneySeriesName,moneySeriesDetail} from '../lib/moneyTable';
import {money} from '../lib/money';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {setLocale} from '../i18n/index';
const root=new URL('../../',import.meta.url);
const compile=(s:string)=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type:any,props:any)=>({type,props});
const text=(n:any):string=>Array.isArray(n)?n.map(text).join(''):typeof n==='string'?n:!n||typeof n!=='object'?'':text(n.props?.children);
for(const language of ['en','ru'] as const)test(`${language} actual unnamed key cap legend detail retains exact amount`,()=>{
 setLocale(language);const H=3600000,M=60000,now=1800000000000,from=now-30*M,to=now-5*M,at=now-20*M;
 const store=new Store(':memory:',from-H);
 try{
  const directory=new Directory(store.db),owner=directory.createUser('unnamed-cap@example.test','Unnamed cap','unused',from-H),board=directory.boards(owner.id)[0].id,id=store.source('openrouter','unnamed-key',from-H);store.hold(id,owner.id,from-H);
  const key='aaaaaaaaaaaa',meter=`key:${key}:cap`,part={id:key,name:null,disabled:false,expiresAt:null,includeByok:false,at,staleAfterMs:H,presence:'observed' as const,missCount:0,periods:{day:null,week:null,month:null}};
  const cap={id:meter,kind:'cap' as const,amount:'1234567',unit:'USD',limit:'100000000',at,staleAfterMs:H,stale:false,resetAt:null,minutes:null,scope:'lifetime',label:null};
  assert.ok(store.record(id,{type:'meters',observedAt:at,staleAfterMs:H,meters:[cap],keys:[part],inventoryComplete:true,inventoryError:null}).accepted);
  const chunks=store.cells(board,M,from,to,{now,meters:{unit:'USD',ids:[[id,meter]]},scope:'budget'}),series=composeMeters(chunks,M,from,to)[0];
  assert.equal(series.end,'98765433');assert.equal(series.semantics?.label,null);assert.equal(series.role,undefined);
  const source=readFileSync(new URL('ui/components/MoneyAnalytics.tsx',root),'utf8'),start=source.indexOf('  const descriptions=useMemo'),end=source.indexOf('  const noSelection=',start);
  let descriptions=source.slice(start,end)+'\nexports.entries=descriptions;';
  const context:any={exports:{},useMemo:(f:any)=>f(),amounts:{current:new Map()},original:[series],sources:[{id,title:'Wallet account'}],moneyIdentity,moneySeriesDetail,nameOf:moneySeriesName,money,context:defaultCurrencyContext,family:'budget',legendValues:'fixture',authority:0,board,settings:{},widget:'budget-history',locale:language};
  runInNewContext(compile(descriptions),context);const entries=context.exports.entries,keyId=entries[0].key;
  const panel={current:{querySelectorAll:()=>[]}},react={useRef:(current:any)=>({current}),useLayoutEffect:(f:any)=>f(),useSyncExternalStore:(_subscribe:any,get:any)=>get()};
  const ui:any={exports:{},require:(name:string)=>name==='react'?react:name==='react-dom'?{createPortal:(n:any)=>n}:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:{useBubble:()=>({current:null})}};
  runInNewContext(compile(readFileSync(new URL('ui/components/SeriesDetails.tsx',root),'utf8')),ui);
  const tooltip=ui.exports.SeriesDetails({focus:{subscribe:()=>()=>{},get:()=>keyId},entries,panel});
  const exact=money(series.end,series.unit,true,defaultCurrencyContext),compact=money(series.end,series.unit,false,defaultCurrencyContext),shown=text(tooltip);
  assert.notEqual(exact,compact);assert.ok(shown.includes(exact),'the shared legend tooltip must retain exact money even without a name/provenance suffix');
 }finally{store.close();setLocale('en');}
});
