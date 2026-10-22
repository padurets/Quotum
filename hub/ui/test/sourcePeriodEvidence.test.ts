import {windowName} from '../lib/quota';
import * as filterModel from '../../server/domain/dataFilters';
import {ApiError} from '../lib/http';
import {selectedAllowanceIds} from '../lib/moneySelection';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {periodValues} from '../../server/periodValues';
import {defaultCurrencyContext,currencySymbol} from '../../server/domain/currency';
import {observationDeadline} from '../../server/domain/resources';
import {providerOf,QUOTA_IDS} from '../../server/domain/providers';
import {EMPTY_VIEW} from '../../server/domain/view';
import * as money from '../lib/money';
import {quotaPeriods,primaryQuotaPeriods} from '../lib/subscription';
import {hasSubscriptionCaps} from '../lib/providers';
import {t,setLocale} from '../i18n';
import type {Card} from '../lib/types';

type Node={type:unknown;props:Record<string,unknown>};
const jsx=(type:unknown,props:Record<string,unknown>):Node=>({type,props});
const runtime={jsx,jsxs:jsx,Fragment:'fragment'};
const code=(file:string)=>readFileSync(new URL(file,import.meta.url),'utf8');
function nodes(value:unknown):Node[] {
  if(Array.isArray(value))return value.flatMap(nodes);
  if(!value||typeof value!=='object')return [];
  const node=value as Node;
  if(typeof node.type==='function')return nodes(node.type(node.props));
  return [node,...nodes(node.props.children),...nodes(node.props.trigger)];
}

test('a historical subscription distinguishes missing observations from hidden limits in one primary state',()=>{
  const now=1_800_000_000_000,at=now-600_000,store=new Store(':memory:',now-3_600_000);
  try{
    const directory=new Directory(store.db),user=directory.createUser('quota-evidence@example.test','Evidence','unused',now-3_600_000),board=directory.boards(user.id)[0].id;
    const id=store.source('zai','capped-evidence',now-3_600_000);store.hold(id,user.id,now-3_600_000);
    const cap={id:QUOTA_IDS[0],kind:'cap' as const,amount:'3000000',unit:'credits:zai',limit:'10000000',at,staleAfterMs:3_600_000,stale:false,resetAt:null,minutes:300,scope:null,label:null};
    assert.ok(store.record(id,{type:'meters',observedAt:at,staleAfterMs:3_600_000,meters:[cap],keys:[],inventoryComplete:true,inventoryError:null}).accepted);
    const read=(to:number)=>periodValues(store,store.sources(board),user.id,to,()=>{})[0];
    const source:Card={...read(now),windows:[],successAt:at,plan:'',error:null,stale:false,owners:[],staleAfterMs:3_600_000,measureIntervalMs:null,resets:null};
    let hidden=false;
    const reading={value:read(at),basis:{range:{from:now-3_600_000,to:at}},loading:false,error:null as string|null};
    const context={selectedAllowanceIds,usePref:()=>({unit:'USD'}),useDataFilters:()=>({current:null}),exports:{} as {draw:(props:unknown)=>Node},require:()=>runtime,t,
      usePeriodValues:()=>reading,useTimeRange:()=>reading.basis.range,quotaPeriods,primaryQuotaPeriods,windowName,PercentLimit:'unavailable',hasSubscriptionCaps,providerOf,budgetVisible:money.budgetVisible,
      isWindowHidden:()=>hidden,planOf:()=>null,MeasurementClock:{Provider:'clock'},QuotaCard:'quota',Limit:'limit',AllHidden:'hidden'};
    const card=code('../components/SourceCard.tsx'),start=card.indexOf('function CardMeasurements(');
    runInNewContext(ts.transpileModule(card.slice(start,card.indexOf('/** Every reader',start))+'\nexports.draw=CardMeasurements;',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
    const draw=()=>nodes(context.exports.draw({source,arrange:{view:EMPTY_VIEW},boardId:board}));
    assert.deepEqual(reading.value.meters,[],'the historical endpoint precedes the first observation');
    for(const locale of ['en','ru'] as const){setLocale(locale);for(hidden of [false,true]){
      const tree=draw();assert.equal(tree.filter(node=>node.props.children===t('period.noEvidence')).length,hidden?0:1);
      assert.equal(tree.filter(node=>node.type==='quota'||node.type==='limit').length,0,'no competing scales are appended to the empty state');
      assert.equal(tree.filter(node=>node.type==='hidden').length,hidden?1:0,'an explicit empty selection keeps its filter action instead of becoming missing evidence');
    }}
    hidden=false;reading.value=read(now);reading.basis.range.to=now;
    assert.equal(reading.value.meters.find(meter=>meter.id===QUOTA_IDS[0])?.amount,cap.amount);
    assert.equal(draw().filter(node=>node.type==='quota').length,2,'a partially observed subscription still shows its two supported periods');
    assert.equal(draw().some(node=>node.props.children===t('period.noEvidence')),false);
    reading.value=read(at);reading.loading=true;
    assert.equal(draw().some(node=>node.props.children===t('period.noEvidence')),false,'an unfinished read is not confirmed missing evidence');
    reading.loading=false;reading.error='history_failed';
    assert.equal(draw().some(node=>node.props.children===t('period.noEvidence')),false,'a failed read is not confirmed missing evidence');
  }finally{setLocale('en');store.close();}
});

test('retained unlimited credits and confirmed zero are measurements in the card and footer in both languages',()=>{
  const now=1_800_000_000_000,at=now-600_000,edge=now-300_000,store=new Store(':memory:',now-3_600_000);
  try {
    const directory=new Directory(store.db),user=directory.createUser('evidence@example.test','Evidence','unused',now-3_600_000),id=store.source('codex','unlimited',now-3_600_000);
    store.hold(id,user.id,now-3_600_000);
    store.record(id,{observedAt:at,staleAfterMs:3_600_000,plan:'pro',resets:null,windows:[],resourceStatus:{windows:'missing',resets:'missing'},balances:[{id:'balance:credits',unit:'credits:codex',status:'unlimited',hasCredits:true}]});
    const read=(to=edge)=>periodValues(store,store.sources(directory.boards(user.id)[0].id),user.id,to,()=>{})[0];
    const value=read();assert.equal(value.creditBalance?.status,'unlimited');assert.deepEqual(value.windows,[]);assert.deepEqual(value.meters,[]);
    const reading={value,basis:{range:{from:now-3_600_000,to:edge}},loading:false,error:null};
    const source={...value,budget:{enabled:true}};
    const context={useRemovalFocus:()=>()=>{},selectedAllowanceIds,usePref:()=>({unit:'USD'}),matchesSelection:()=>true,fundsRule:()=>({mode:'exclude',values:[]}),matchesWallet:()=>true,walletRule:()=>({mode:'auto',include:[],exclude:[]}),useDataFilters:()=>({current:null}),exports:{} as Record<string,(props:unknown)=>Node>,components:{} as Record<string,(props:unknown)=>Node>,require:()=>runtime,...money,t,observationDeadline,
      useMeasurementClock:()=>edge,stamp:String,day:String,rateText:String,currencySymbol,StatusMark:'status',Popover:'popover',MoneyCard:'money-card',ErrorLine:'error',CapMetrics:'unavailable-cap',BudgetKeyMetrics:'keys',
      usePeriodValues:()=>reading,useTimeRange:()=>reading.basis.range,useCurrencyContext:()=>defaultCurrencyContext,quotaPeriods,primaryQuotaPeriods,windowName,PercentLimit:'unavailable',hasSubscriptionCaps,providerOf,
      isWindowHidden:()=>false,planOf:()=>null,keyShown:()=>true,MeasurementClock:{Provider:'clock'},PeriodStatus:'period-status',QuotaCard:'quota',Limit:'limit',AllHidden:'hidden',
      MoneyValues:undefined as unknown,CardTray:({funds}:{funds:unknown})=>({type:'footer',props:{children:funds}}),
    };
    const run=(body:string)=>runInNewContext(ts.transpileModule(body,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
    const funds=code('../components/MoneyCard.tsx');run(funds.slice(funds.indexOf('export function MoneyValues('),funds.indexOf('/** Safe supplier facts')));context.MoneyValues=context.exports.MoneyValues;
    const card=code('../components/SourceCard.tsx');run(card.slice(card.indexOf('function CardMeasurements('))+'\nglobalThis.components={CardMeasurements,CardFooter};');
    const props={source,arrange:{view:EMPTY_VIEW},boardId:'b'};
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);
      const body=nodes(context.components.CardMeasurements(props)),footer=nodes(context.components.CardFooter(props));
      assert.equal(body.some(node=>node.props.children===t('period.noEvidence')),false);
      assert.ok(footer.some(node=>node.type==='b'&&node.props.children==='∞'),'the retained unlimited observation reaches the actual funds renderer');
      assert.equal(footer.find(node=>node.type==='status')?.props.label,[t('money.additionalFunds'),t('money.unlimited')].join('\n'));
    }
    store.record(id,{observedAt:edge-10_000,staleAfterMs:3_600_000,plan:'pro',resets:null,windows:[],resourceStatus:{windows:'missing',resets:'missing'},balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'0',hasCredits:true}]});
    reading.value=read();
    const zero=reading.value.meters.find(m=>m.id==='balance:credits')!;
    assert.equal(zero.amount,'0');
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);
      assert.equal(nodes(context.components.CardMeasurements(props)).some(node=>node.props.children===t('period.noEvidence')),false);
      const footer=nodes(context.components.CardFooter(props));
      assert.ok(footer.some(node=>node.type==='b'&&node.props.children==='≈ '+money.money('0','USD',false,defaultCurrencyContext)));
      assert.ok(footer.some(node=>node.props.className==='tray-panel-lead'&&node.props.children===money.money('0',zero.unit,true,defaultCurrencyContext,zero.scale)),'native zero remains in the disclosure');
    }
    reading.value=read(at);reading.basis.range.to=at;
    assert.deepEqual(reading.value.meters,[]);assert.equal(reading.value.creditBalance,undefined);
    for(const locale of ['en','ru'] as const) {
      setLocale(locale);
      assert.ok(nodes(context.components.CardMeasurements(props)).some(node=>node.props.children===t('period.noEvidence')),'a successful read before the first observation still discloses the missing evidence');
    }
  } finally {setLocale('en');store.close();}
});

test('historical wallet disclosures keep the current selected scope before, between and after cap observations',()=>{
  const now=1_800_000_000_000,H=3_600_000,M=60_000,at=now-2*H,store=new Store(':memory:',at-H);
  try{
    const directory=new Directory(store.db),user=directory.createUser('wallet@example.test','Wallet','unused',at-H),id=store.source('openrouter','a'.repeat(24),at-H);
    store.hold(id,user.id,at-H);
    const part=(id:string,name:string,at:number)=>({id,name,disabled:false,expiresAt:null,includeByok:false,at,staleAfterMs:H,presence:'observed' as const,missCount:0,periods:{day:null,week:null,month:null}});
    const meter=(id:string,kind:'counter'|'cap',amount:string,at:number,limit:string|null=null)=>({id,kind,amount,unit:'USD',limit,at,staleAfterMs:H,stale:false,resetAt:null,minutes:null,scope:null,label:null});
    const record=(time:number,keys:string[],caps:string[],uncapped:string[]=[])=>{
      const result=store.record(id,{type:'meters',observedAt:time,staleAfterMs:H,meters:[meter('credits','counter','20000000',time),meter('usage','counter','5000000',time),...caps.map(key=>meter(`key:${key}:cap`,'cap','3000000',time,'10000000'))],keys:keys.map(key=>part(key,key==='aaaaaaaaaaaa'?'Known allowance A':'Selected allowance B',time)),inventoryComplete:true,inventoryError:null,uncapped});
      assert.ok(result.accepted);
    };
    record(at,[],[]);record(at+10*M,['aaaaaaaaaaaa'],['aaaaaaaaaaaa']);record(at+20*M,['aaaaaaaaaaaa','bbbbbbbbbbbb'],['aaaaaaaaaaaa','bbbbbbbbbbbb']);record(at+30*M,['aaaaaaaaaaaa','bbbbbbbbbbbb'],['aaaaaaaaaaaa'],['bbbbbbbbbbbb']);
    const read=(to:number)=>periodValues(store,store.sources(directory.boards(user.id)[0].id),user.id,to,()=>{},now)[0];
    const source:Card={...read(at+31*M),windows:[],successAt:at+30*M,plan:'',error:null,stale:false,owners:[],staleAfterMs:H,measureIntervalMs:null,resets:null};
    const filters=filterModel.defaultFilters();filters.wallet={mode:'only',values:[{source:id,kind:'balance'},{source:id,kind:'keyCap',key:'aaaaaaaaaaaa'},{source:id,kind:'keyCap',key:'bbbbbbbbbbbb'}]};
    let selected={from:at-H,to:at+M},reading={value:read(selected.to),basis:{range:selected},loading:false,error:null};
    const context={useRemovalFocus:()=>()=>{},...money,...filterModel,selectedAllowanceIds,usePref:()=>({unit:'USD'}),useDataFilters:()=>({current:filters}),exports:{} as Record<string,(props:unknown)=>Node>,require:()=>runtime,t,currencySymbol,
      usePeriodValues:()=>reading,useTimeRange:()=>selected,useCurrencyContext:()=>defaultCurrencyContext,quotaPeriods,primaryQuotaPeriods,windowName,PercentLimit:'unavailable',hasSubscriptionCaps,providerOf,
      isWindowHidden:()=>false,planOf:()=>null,MeasurementClock:{Provider:'clock'},QuotaCard:'quota',Limit:'limit',AllHidden:'hidden',
      MoneyValues:undefined as unknown,MoneyCard:undefined as unknown,useShownKeys:()=>({keys:source.keys,meters:source.meters,allowances:selectedAllowanceIds(source,EMPTY_VIEW,'USD',filters)}),Popover:'popover',CreditBalanceValue:({children}:{children:unknown})=>children,ErrorLine:'error',CapMetrics:'unavailable-cap',BudgetKeyMetrics:'key',stamp:String,day:String,ApiError,
    };
    const run=(body:string)=>runInNewContext('(function(){'+ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText+'})()',context);
    const funds=code('../components/MoneyCard.tsx');run(funds.slice(funds.indexOf('export function MoneyValues('),funds.indexOf('/** Subscription funds')));context.MoneyValues=context.exports.MoneyValues;
    run(funds.slice(funds.indexOf('export function MoneyCard('),funds.indexOf('type MoneySource=')));context.MoneyCard=context.exports.MoneyCard;
    const card=code('../components/SourceCard.tsx'),start=card.indexOf('function CardMeasurements(');run(card.slice(start,card.indexOf('/** Every reader',start))+'\nexports.CardMeasurements=CardMeasurements;');
    for(const locale of ['en','ru'] as const){setLocale(locale);for(const [to,known]of [[at-1,0],[at+M,0],[at+11*M,1],[at+31*M,1]]){
      selected={from:at-H,to};reading={value:read(to),basis:{range:selected},loading:false,error:null};
      const tree=nodes(context.exports.CardMeasurements({source,arrange:{view:EMPTY_VIEW},boardId:'b'}));
      assert.ok(String(tree.find(node=>node.type==='popover')?.props.label).includes(t('money.selectedAllowances',{count:2})));
      assert.equal(tree.filter(node=>node.type==='key').length,known,'current caps cannot fill holes in historical measurements');
      assert.equal(tree.filter(node=>node.props.children===t('quota.unavailable')).length,2-known);
      for(const name of known?['Selected allowance B']:['Known allowance A','Selected allowance B'])assert.ok(tree.some(node=>node.props.children===name),'current metadata names an allowance without inventing an old reading');
      if(to>=at)assert.equal(tree.find(node=>node.props['data-money'])?.props['data-money'],'15000000');
    }}
  }finally{setLocale('en');store.close();}
});
