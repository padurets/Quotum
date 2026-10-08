import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {providerOf} from '../../server/domain/providers';
import {budgetVisible,subscriptionFundsVisible} from '../lib/money';
import type {Card} from '../lib/types';
import {budgetAccess} from '../../server/domain/resources';
import {quotaPeriods} from '../lib/subscription';
import {hasSubscriptionCaps} from '../lib/providers';
import {EMPTY_VIEW} from '../../server/domain/view';

test('the actual card tray adds no news container for an ordinary client or complete quota',()=>{
  const source=readFileSync(new URL('../components/SourceCard.tsx',import.meta.url),'utf8');
  const start=source.indexOf('function CardTray('),end=source.indexOf('\n/**',start);
  const context={exports:{},CardTray:null as unknown as (props:{source:object})=>{props:{news:unknown}},
    useSessions:()=>[],useResetsFor:()=>undefined,useSourceAccess:()=>null,
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

test('subscription balances live only in the dashboard and compact footers, with financial sharing respected',()=>{
  type Node={type:unknown;props:Record<string,unknown>};
  const jsx=(type:unknown,props:Record<string,unknown>):Node=>({type,props});
  const creditBalance={id:'balance:credits' as const,unit:'credits:codex' as const,status:'finite' as const,at:1,staleAfterMs:1000};
  let source:Card={id:'fixture',provider:'codex',plan:'pro',successAt:1,error:null,stale:false,owners:[],staleAfterMs:1000,measureIntervalMs:null,windows:[],resets:{available:2,expiring:[]},budget:budgetAccess('codex',true),creditBalance};
  const context={exports:{},SourceCard:null as unknown as (props:object)=>Node,Row:null as unknown as (props:object)=>Node,
    memo:(fn:unknown)=>fn,useLocale:()=>{},useCard:()=>source,useTitle:()=>'Fixture',useMine:()=>true,
    useSessions:()=>[],useResetsFor:()=>undefined,useSourceAccess:()=>null,useBoardId:()=>'board',useServerView:()=>EMPTY_VIEW,
    providerOf,budgetVisible,subscriptionFundsVisible,quotaPeriods,hasSubscriptionCaps,isWindowHidden:()=>false,planOf:()=>null,colorOf:()=>'',
    SourceSettings:'settings',CardMark:'mark',BalanceMark:'balance-status',AccessMark:'access',QuotaMark:'quota-status',
    MoneyCard:'money',QuotaCard:'quota',Limit:'limit',PercentLimit:'limit',ResetLine:'reset',FreeResets:'free-resets',AllHidden:'hidden',
    Tray:({current,news}:{current:unknown;news:unknown})=>jsx('footer',{children:[news,current]}),
    errorText:()=>'',t:()=>'',require:()=>({jsx,jsxs:jsx,Fragment:'fragment'})};
  const card=readFileSync(new URL('../components/SourceCard.tsx',import.meta.url),'utf8');
  const compact=readFileSync(new URL('../components/Compact.tsx',import.meta.url),'utf8');
  const body=card.slice(card.indexOf('function CardTray(')).replace('export const SourceCard','const SourceCard')+
    compact.slice(compact.indexOf('const Row ='),compact.indexOf('\nexport function Compact'))+
    '\nglobalThis.SourceCard=SourceCard;globalThis.Row=Row;';
  runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const nodes=(node:unknown,parents:unknown[]=[]):{node:Node;parents:unknown[]}[]=>{
    if(Array.isArray(node))return node.flatMap(child=>nodes(child,parents));
    if(!node||typeof node!=='object')return [];
    const value=node as Node;
    if(typeof value.type==='function')return nodes(value.type(value.props),parents);
    return [{node:value,parents},...nodes(value.props.children,[...parents,value.type])];
  };
  for(const draw of [()=>context.SourceCard({id:'fixture',arrange:{view:EMPTY_VIEW},boardId:'board',personal:true}),()=>context.Row({id:'fixture'})]) {
    source={...source,provider:'codex',budget:budgetAccess('codex',true)};
    const funds=nodes(draw()).filter(row=>row.node.type==='money');
    assert.equal(funds.length,1);
    assert.ok(funds[0].parents.includes('footer'),'the actual subscription component places funds in its footer');
    assert.equal(funds[0].node.props.tray,true,'use the compact footer renderer');
    source={...source,creditBalance:undefined};
    assert.equal(nodes(draw()).filter(row=>row.node.type==='money').length,0,'legacy clients have no empty balance placeholder');
    assert.ok(nodes(draw()).some(row=>row.node.type==='free-resets'&&row.parents.includes('footer')),'free resets remain without credits');
    source={...source,creditBalance};
    source={...source,budget:budgetAccess('codex',false)};
    assert.equal(nodes(draw()).filter(row=>row.node.type==='money').length,0,'no financial value when sharing is disabled');
    source={...source,provider:'openrouter',budget:budgetAccess('codex',true)};
    const wallet=nodes(draw()).filter(row=>row.node.type==='money');
    assert.equal(wallet.length,1);
    assert.ok(!wallet[0].parents.includes('footer'),'wallets retain their main available balance');
  }
});
