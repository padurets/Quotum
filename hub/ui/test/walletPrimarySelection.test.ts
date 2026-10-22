import {selectedAllowanceIds} from '../lib/moneySelection';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {periodValues} from '../../server/periodValues';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as money from '../lib/money';
import * as filters from '../../server/domain/dataFilters';
import {defaultCurrencyContext,currencySymbol} from '../../server/domain/currency';
import {ApiError} from '../lib/http';
import {t,setLocale} from '../i18n/index';
const source=readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8');
const jsx=(type:any,props:any)=>({type,props});
for(const compact of [false,true])for(const locale of ['en','ru'] as const)for(const missing of ['absent-meter','absent-key'] as const)test(`${locale} ${compact?'compact':'dashboard'} ${missing} primary cannot substitute another arrived selected cap`,()=>{
 setLocale(locale);
 const selected=filters.defaultFilters();selected.wallet={mode:'only',values:[{source:'s',kind:'keyCap',key:'a'},{source:'s',kind:'keyCap',key:'b'}]};
 const context:any={...money,...filters,currencySymbol,t,ApiError,exports:{},useRemovalFocus:()=>()=>{},require:()=>({jsx,jsxs:jsx}),useDataFilters:()=>({current:selected}),usePref:()=>({unit:'USD'}),Popover:'popover',CapMetrics:'missing-cap',BudgetKeyMetrics:'metric',ErrorLine:'error',CreditBalanceValue:({children}:any)=>children,day:String,stamp:String};
 runInNewContext(ts.transpileModule(source.slice(source.indexOf('export function MoneyValues('),source.indexOf('/** Subscription funds')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
 const part=(id:string)=>({id,name:`Full selected ${id}`,disabled:false,presence:'observed' as const,expiresAt:null,includeByok:false,at:100,staleAfterMs:10000,periods:{day:null,week:null,month:null},missCount:0});
 const cap=(id:string,amount='3000000')=>({id:`key:${id}:cap`,kind:'cap',unit:'USD',amount,limit:'10000000',at:100,staleAfterMs:10000,stale:false,resetAt:null,minutes:null,scope:null,label:null});
 const names=[part('a'),part('b')];
 const render=(keys:any[],meters:any[])=>context.exports.MoneyValues({source:{id:'s',provider:'openrouter',meters},keys,names,meters,allowances:['a','b'],compact,context:defaultCurrencyContext});
 const primary=(tree:any)=>tree.props.children.find((node:any)=>node?.props?.triggerClass==='money-primary-trigger')?.props.trigger;
 const complete=primary(render(names,[cap('a'),cap('b')]));assert.equal(complete.props.limit.scope.id,'a','positive control uses stable first selected key');

  const tree=render(missing==='absent-key'?[part('b')]:names,[cap('b')]),shown=primary(tree);

  assert.ok(shown,'the unavailable primary keeps its disclosure');assert.equal(shown.type,'missing-cap');assert.equal(shown.props.name,'Full selected a','the absent first cap keeps its own complete logical name');

 setLocale('en');
});

for(const missing of [false,true])test(`actual Store logical first cap when historical A ${missing?'is missing':'and B both arrived'}`,async test=>{
 test.mock.method(Date,'now',()=>NOW);
 const russian=new Intl.Collator('ru-RU');
 test.mock.method(String.prototype,'localeCompare',function(this:string,other:string){return russian.compare(String(this),other);});
 assert.ok('Alpha'.localeCompare('Бета')>0,'the control exercises a Russian runtime default, independently of the UI catalogue');
 const h=await fixture({personal:true});
 try{
 const id=h.store.source('openrouter','b'.repeat(24),NOW-H);h.store.hold(id,h.alice.id,NOW-H);
 const a='bbbbbbbbbbbb',b='aaaaaaaaaaaa';
 const key=(id:string,at:number)=>({id,name:id===a?'Alpha logical first':'Бета logical second',disabled:false,presence:'observed' as const,expiresAt:null,includeByok:false,at,staleAfterMs:H,periods:{day:null,week:null,month:null},missCount:0});
 const meter=(id:string,kind:any,at:number,amount:string,limit:string|null=null)=>({id,kind,at,amount,limit,unit:'USD',staleAfterMs:H,stale:false,resetAt:null,minutes:null,scope:null,label:null});
 const record=(at:number,keys:string[])=>h.store.record(id,{type:'meters',observedAt:at,staleAfterMs:H,meters:[meter('credits','counter',at,'20000000'),meter('usage','counter',at,'5000000'),...keys.map(id=>meter(`key:${id}:cap`,'cap',at,id===a?'1000000':'8000000','10000000'))],keys:keys.map(id=>key(id,at)),inventoryComplete:true,inventoryError:null});
 record(NOW-30*M,[b]);record(NOW-10*M,[b,a]);h.events.flush();await flush();
 const current=h.page.get().board!.cards[id];assert.deepEqual(current.keys!.map(k=>k.id),[a,b],'live source has canonical name/id order despite reversed supplier reply');
 const selected=filters.defaultFilters();selected.wallet={mode:'only',values:[{source:id,kind:'keyCap',key:a},{source:id,kind:'keyCap',key:b}]};
 const context:any={...money,...filters,currencySymbol,t,ApiError,exports:{},useRemovalFocus:()=>()=>{},require:()=>({jsx,jsxs:jsx}),useDataFilters:()=>({current:selected}),usePref:()=>({unit:'USD'}),Popover:'popover',CapMetrics:'missing-cap',BudgetKeyMetrics:'metric',ErrorLine:'error',CreditBalanceValue:({children}:any)=>children,day:String,stamp:String};
 runInNewContext(ts.transpileModule(source.slice(source.indexOf('export function MoneyValues('),source.indexOf('/** Subscription funds')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
 const render=(value:any)=>context.exports.MoneyValues({source:value,keys:value.keys,names:current.keys,meters:value.meters,allowances:selectedAllowanceIds(current,undefined,'USD',selected),context:defaultCurrencyContext});
 const primary=(tree:any)=>tree.props.children.find((node:any)=>node?.props?.triggerClass==='money-primary-trigger')?.props.trigger?.props.limit;
 assert.equal(primary(render(current)).scope.id,a,'positive live control uses logical first A');
 const to=missing?NOW-20*M:NOW,value=periodValues(h.store,h.store.sources(h.board),h.alice.id,to,()=>{},NOW).find(v=>v.id===id)!;
 const actual=primary(render(value));
 assert.ok(!actual||actual.scope.id===a,'first selected identity survives the actual historical key inventory order and missing observations');
 }finally{await h.close();}
});
