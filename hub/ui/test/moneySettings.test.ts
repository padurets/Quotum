import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preparationFixture} from './preparationFixture';
import {archivedKeyGroups,moneySelection,readMoney} from '../lib/moneySelection';
import {ApiError} from '../lib/http';
import * as providers from '../../server/domain/providers';
import {balanceRoleLabel,keyName} from '../lib/money';
import type {Named} from '../lib/board';
import type {KeyPage} from '../lib/moneyKeys';
import type {Meter} from '../../server/domain/meters';

type Node={type:unknown;props:Record<string,unknown>;key?:string};
const component=(name:string)=>({name});
const pages=component('pages'),content=component('content'),switchRow=component('switch');
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const meter=(id:string,amount='1'):Meter=>({id,amount,kind:id.endsWith(':cap')?'cap':'balance',unit:'USD',at:1,staleAfterMs:1000,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null});

function fixture(selected:[string,string][]=[]) {
  const hooks=preparationFixture();
  let revision=1,prefs={money:readMoney({unit:'USD',selected:{USD:[['s','balance'],...selected]}})};
  let source:Named={id:'s',title:'Account',provider:'openrouter',plan:'',successAt:revision,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,meters:[meter('balance')],keys:[],keysCount:20};
  const reads:string[]=[];
  const call=async(_method:string,path:string):Promise<KeyPage>=>{
    reads.push(path);const query=new URL(path,'https://fixture.invalid').searchParams;
    const all=Array.from({length:20},(_,i)=>({id:String(i),name:`Key ${i} revision ${revision}`,disabled:false,expiresAt:null,includeByok:false,at:revision,staleAfterMs:1000,presence:'observed' as const,missCount:0,periods:{day:null,week:null,month:null}}));
    const ids=query.get('ids'),from=Number(query.get('after')??0),keys=ids?all.filter(k=>(JSON.parse(ids) as string[]).includes(k.id)):all.slice(from,from+10);
    return {keys,meters:keys.flatMap(k=>[meter(`key:${k.id}:usage`),...(revision===1?[meter(`key:${k.id}:cap`)]:[])]),total:20,inventory:null,next:ids||from===10?null:'10'};
  };
  const context={exports:{} as {MoneySettings:(props:{sources:Named[];hidden:string[];series:[]})=>Node},require:(name:string)=>{
    if(name==='react')return {useState:hooks.useState,useEffect:hooks.useLayoutEffect};
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'],key?:string)=>({type,props,key}),jsxs:(type:unknown,props:Node['props'],key?:string)=>({type,props,key}),Fragment:'fragment'};
    if(name.endsWith('/board'))return {useBoardId:()=> 'b'};
    if(name.endsWith('/http'))return {ApiError,call};
    if(name.endsWith('/moneySelection'))return {moneySelection,archivedKeyGroups};
    if(name.endsWith('/prefs'))return {usePrefs:()=>prefs,setPrefs:(patch:typeof prefs)=>{prefs=patch;}};
    if(name.endsWith('/money'))return {keyName,balanceRoleLabel};
    if(name.endsWith('/providers'))return providers;
    if(name.endsWith('/meterHistory'))return {MAX_METERS:32};
    if(name.endsWith('/i18n'))return {t:(key:string)=>key};
    if(name==='./Popover')return {SwitchRow:switchRow};
    if(name==='./KeyPages')return {KEYS_PER_PAGE:10,KeyPages:pages,KeyPageContent:content};
    if(name==='./Kit')return {ErrorLine:component('error')};
    throw new Error(name);
  }};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/MoneySettings.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  let tree:Node;
  const render=()=>{hooks.begin();tree=context.exports.MoneySettings({sources:[source],hidden:[],series:[]});hooks.commit();return nodes(tree);};
  const settle=async()=>{render();await flush();return render();};
  const pager=()=>nodes(tree).find(n=>n.type===pages)!.props as {page:number;pages:number;next:boolean;previous:boolean;loading:boolean;onNext:()=>void;onPrevious:()=>void};
  const slots=()=>nodes(tree).filter(n=>typeof n.props.className==='string'&&n.props.className.includes('key-slot'));
  return {settle,render,pager,slots,reads,switches:()=>nodes(tree).filter(n=>n.type===switchRow),refresh:()=>{revision++;source={...source,successAt:revision};}};
}

test('the real settings keep ten slots when a selected live key moves off page',async()=>{
  const f=fixture();await f.settle();
  const usage=f.switches().find(n=>n.key==='key:0:usage')!;
  (usage.props.onChange as (on:boolean)=>void)(true);await f.settle();
  f.pager().onNext();await f.settle();
  assert.equal(f.slots().length,10);assert.equal(f.pager().page,2);assert.equal(f.pager().pages,2);
  assert.equal(f.switches().some(n=>n.key==='key:0:usage'),false);
});

test('selected archived scales use the same pages and remain removable',async()=>{
  const f=fixture([['s','key:gone:usage'],['s','key:gone:cap']]);await f.settle();
  assert.equal(f.pager().pages,3);f.pager().onNext();await f.settle();
  assert.equal(f.slots().length,10);f.pager().onNext();await f.settle();
  assert.equal(f.slots().length,1);assert.equal(f.pager().page,3);assert.equal(f.pager().loading,false);
  for(const kind of ['usage','cap']){const row=f.switches().find(n=>n.key===`key:gone:${kind}`)!;assert.equal(row.props.disabled,false);(row.props.onChange as (on:boolean)=>void)(false);await f.settle();}
  assert.equal(f.pager().pages,2);assert.equal(f.slots().length,10);
});

test('an open settings page reloads its names and caps on a successful source update',async()=>{
  const f=fixture();await f.settle();f.pager().onNext();await f.settle();
  const before=f.reads.length;f.refresh();await f.settle();
  assert.equal(f.reads.length,before+1);assert.equal(f.pager().page,2);
  assert.ok(f.slots().every(n=>nodes(n).some(child=>child.props.children===`Key ${Number(n.key)} revision 2`)));
  assert.equal(f.switches().find(n=>n.key==='key:10:cap')?.props.disabled,true);
});
