import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {providerOf} from '../../server/domain/providers';

test('the actual card tray adds no news container for an ordinary client or complete quota',()=>{
  const source=readFileSync(new URL('../components/SourceCard.tsx',import.meta.url),'utf8');
  const start=source.indexOf('function CardTray('),end=source.indexOf('\n/**',start);
  const context={exports:{},CardTray:null as unknown as (props:{source:object})=>{props:{news:unknown}},
    useSourcePeriodSessions:()=>[],useResetsFor:()=>undefined,useSourceAccess:()=>null,
    providerOf,
    Tray:'tray',AccessMark:'access',QuotaMark:'quota',BalanceMark:'balance',FreeResets:'reset',
    require:(name:string)=>{assert.equal(name,'react/jsx-runtime');return {jsx:(type:unknown,props:unknown)=>({type,props}),jsxs:(type:unknown,props:unknown)=>({type,props}),Fragment:'fragment'};}};
  const drawing=source.slice(start,end)+'\nglobalThis.CardTray=CardTray;';
  runInNewContext(ts.transpileModule(drawing,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  assert.equal(context.CardTray({source:{id:'claude:fixture',provider:'claude'}}).props.news,null);
  assert.equal(context.CardTray({source:{id:'zai:fixture',provider:'zai',quota:{complete:true}}}).props.news,null);
  assert.ok(context.CardTray({source:{id:'zai:fixture',provider:'zai',quota:{complete:false}}}).props.news);
  for(const provider of ['openrouter','deepseek']) {
    const tray=context.CardTray({source:{id:provider+':shared',provider,currencyUnavailable:false}});
    assert.ok(tray.props.news,'wallet readers keep balance explanations without private source access');
  }
});
