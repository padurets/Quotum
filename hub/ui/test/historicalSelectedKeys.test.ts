import {windowName} from '../lib/quota';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import Fastify from 'fastify';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import * as filters from '../../server/domain/dataFilters';
import {selectedAllowanceIds} from '../lib/moneySelection';
import {periodValues} from '../../server/periodValues';
import {defaultCurrencyContext,currencySymbol} from '../../server/domain/currency';
import {providerOf} from '../../server/domain/providers';
import {EMPTY_VIEW} from '../../server/domain/view';
import * as money from '../lib/money';
import {quotaPeriods,primaryQuotaPeriods} from '../lib/subscription';
import {hasSubscriptionCaps} from '../lib/providers';
import {readKeyIds} from '../lib/keyReads';
import {sourceKeyRoutes} from '../../server/routes/sourceKeys';
import {MAX_METERS} from '../../server/domain/meterHistory';
import {ApiError} from '../lib/http';
import {t,setLocale} from '../i18n';
import type {KeyPart,Meter} from '../../server/domain/meters';

const code=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
type Node={type:any;props:Record<string,any>};
const nodes=(v:any):Node[]=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?typeof v.type==='function'?nodes(v.type(v.props)):[v,...nodes(v.props.children),...nodes(v.props.trigger)]:[];

test('a selected key beyond the preview keeps its known name across live, pending and historical cards',async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true}),app=Fastify();
  sourceKeyRoutes(app,h.hub,{user:()=>h.alice,board:()=>({user:h.alice,board:h.directory.boards(h.alice.id).find(board=>board.id===h.board)!})});
  const originalFetch=globalThis.fetch,requests:string[]=[];
  test.after(async()=>{globalThis.fetch=originalFetch;setLocale('en');await app.close();await h.close();});
  const id=h.store.source('openrouter','b'.repeat(24),NOW-H);h.store.hold(id,h.alice.id,NOW-H);
  const ids=Array.from({length:6},(_,i)=>String(i+1).repeat(12)),name=(i:number)=>`Allowance ${i+1} complete friendly name`;
  const key=(id:string,i:number,at:number):KeyPart=>({id,name:name(i),disabled:false,expiresAt:null,includeByok:false,at,staleAfterMs:H,presence:'observed',missCount:0,periods:{day:null,week:null,month:null}});
  const meter=(id:string,kind:Meter['kind'],amount:string,at:number,limit:string|null=null):Meter=>({id,kind,amount,unit:'USD',limit,at,staleAfterMs:H,stale:false,resetAt:null,minutes:null,scope:null,label:null});
  const record=(at:number,keys:string[])=>h.store.record(id,{type:'meters',observedAt:at,staleAfterMs:H,meters:[meter('credits','counter','20000000',at),meter('usage','counter','5000000',at),...keys.map(k=>meter(`key:${k}:cap`,'cap','3000000',at,'10000000'))],keys:keys.map((id,i)=>key(id,i,at)),inventoryComplete:true,inventoryError:null});
  record(NOW-30*M,ids.slice(0,5));record(NOW-10*M,ids);h.events.flush();await flush();
  const source=h.page.get().board!.cards[id];assert.equal(source.keys!.length,5);assert.ok(!source.keys!.some(k=>k.id===ids[5]));
  const range={from:NOW-H,to:NOW-20*M},value=periodValues(h.store,h.store.sources(h.board),h.alice.id,range.to,()=>{},NOW).find(v=>v.id===id)!;
  const selection=filters.defaultFilters();selection.wallet={mode:'only',values:[{source:id,kind:'balance'},{source:id,kind:'keyCap',key:ids[5]}]};
  let delivered!:Promise<Response>;
  globalThis.fetch=url=>{requests.push(String(url));delivered=app.inject({method:'GET',url:String(url)}).then(reply=>new Response(reply.body,{status:reply.statusCode,headers:{'content-type':'application/json'}}));return delivered;};

  let cursor=0,hookRenders=0,selected:typeof range|null=null,reading:{value:typeof value|null;basis:{range:typeof range};loading:boolean;error:string|null}={value,basis:{range},loading:false,error:null};
  const slots:any[]=[],effects:(()=>void)[]=[];
  const hooks={useState:(initial:any)=>{const at=cursor++;if(!(at in slots))slots[at]=initial;return [slots[at],(next:any)=>slots[at]=typeof next==='function'?next(slots[at]):next];},useEffect:(run:()=>unknown,deps:any[])=>{const at=cursor++,previous=slots[at];if(!previous||deps.some((d,i)=>d!==previous.deps[i]))effects.push(()=>{previous?.cleanup?.();slots[at]={deps,cleanup:run()};});}};
  const modules:Record<string,unknown>={react:hooks,'./moneySelection':{selectedAllowanceIds},'./dataFilters':{useDataFilters:()=>({current:selection})},'./prefs':{usePref:()=>({unit:'USD'})},'./http':{ApiError},'./keyReads':{readKeyIds},'../../server/domain/meterHistory':{MAX_METERS}};
  const hook={exports:{} as typeof import('../lib/moneyKeys'),require:(name:string)=>modules[name],AbortController};
  runInNewContext(ts.transpileModule(code('../lib/moneyKeys.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,hook);
  const jsx=(type:any,props:any)=>({type,props}),context:any={...money,...filters,selectedAllowanceIds,usePref:()=>({unit:'USD'}),useDataFilters:()=>({current:selection}),exports:{},useRemovalFocus:()=>()=>{},require:()=>({jsx,jsxs:jsx,Fragment:'fragment'}),t,currencySymbol,usePeriodValues:()=>reading,useTimeRange:()=>selected,useCurrencyContext:()=>defaultCurrencyContext,quotaPeriods,primaryQuotaPeriods,windowName,PercentLimit:'unavailable',hasSubscriptionCaps,providerOf,isWindowHidden:()=>false,planOf:()=>null,MeasurementClock:{Provider:'clock'},QuotaCard:'quota',Limit:'limit',AllHidden:'hidden',Popover:'popover',CreditBalanceValue:({children}:any)=>children,ErrorLine:'error',openDataFilters:()=>{},CapMetrics:'unavailable-cap',BudgetKeyMetrics:'key',stamp:String,day:String,ApiError,
    useShownKeys:()=>{hookRenders++;cursor=0;const result=hook.exports.useShownKeys(source,EMPTY_VIEW,h.board);effects.splice(0).forEach(run=>run());return result;}};
  const run=(body:string)=>runInNewContext('(function(){'+ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText+'})()',context);
  const mc=code('../components/MoneyCard.tsx');run(mc.slice(mc.indexOf('export function MoneyValues('),mc.indexOf('/** Subscription funds')));context.MoneyValues=context.exports.MoneyValues;
  run(mc.slice(mc.indexOf('export function MoneyCard('),mc.indexOf('type MoneySource=')));context.MoneyCard=context.exports.MoneyCard;
  const sc=code('../components/SourceCard.tsx'),start=sc.indexOf('function CardMeasurements(');run(sc.slice(start,sc.indexOf('/** Every reader',start))+'\nexports.CardMeasurements=CardMeasurements;');
  const render=()=>nodes(context.exports.CardMeasurements({source,arrange:{view:EMPTY_VIEW},boardId:h.board}));
  render();await delivered;await flush();
  for(const locale of ['en','ru'] as const){
    setLocale(locale);selected=null;reading={value,basis:{range},loading:false,error:null};
    assert.equal(render().find(n=>n.type==='key')?.props.limit.part.name,name(5));
    selected=range;reading={...reading,value:null,loading:true};const before=hookRenders;
    assert.equal(render().filter(n=>n.type==='key').length,0);
    assert.equal(hookRenders,before+1,'the same metadata owner stays mounted during the historical first read');
    reading={...reading,value,loading:false};const tree=render();
    assert.ok(tree.some(n=>n.props.children===name(5)),'the full known name survives a historical endpoint before this key existed');
    assert.ok(tree.some(n=>n.props.children===t('quota.unavailable')));
    assert.ok(String(tree.find(n=>n.type==='popover')?.props.label).includes(t('money.selectedAllowances',{count:1})));
    assert.equal(tree.filter(n=>n.type==='key').length,0,'current cap amounts never fill historical holes');
    assert.equal(tree.find(n=>n.props['data-money'])?.props['data-money'],'15000000');
    selected=null;assert.equal(render().find(n=>n.type==='key')?.props.limit.part.name,name(5));
  }
  assert.equal(requests.length,1,'time navigation and language changes reuse the bounded selected-key metadata');
  selection.wallet={mode:'only',values:[]};
  for(const locale of ['en','ru'] as const){setLocale(locale);for(const state of ['live','pre-first','pending','failed']){
    selected=state==='live'?null:range;
    reading={value:state==='pending'||state==='failed'?null:{...value,meters:[],keys:[]},basis:{range},loading:state==='pending',error:state==='failed'?'history_failed':null};
    const tree=render();
    assert.equal(tree.filter(n=>n.props.children===t('header.filters')).length,1,'an explicit empty wallet selection always keeps its existing filter action');
    assert.equal(tree.some(n=>n.props.children===t('period.noEvidence')),false,'wallet content has one semantic owner');
    assert.equal(tree.some(n=>n.props['data-money']),false,'pending history cannot borrow a live amount');
  }}
  assert.equal(requests.length,1,'an empty scope does not request key metadata');
});
