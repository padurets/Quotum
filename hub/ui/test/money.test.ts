import {test} from 'node:test';
import assert from 'node:assert/strict';
import {money,capPercent} from '../lib/money';
import {setLocale} from '../i18n';
import {moneySelection,readMoney} from '../lib/moneySelection';
import type {Card} from '../lib/types';
import type {Meter} from '../../server/domain/meters';
import {INITIAL,reduce,type Snapshot} from '../lib/board';

const meter=(id:string,value='1'):Meter=>({id,amount:value,kind:'balance',unit:'USD',limit:null,at:1,stale:false,staleAfterMs:1000,resetAt:null,minutes:null,scope:null,label:null});
const card=(id:string):Card=>({id,provider:'openrouter',plan:'',successAt:1,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,meters:[meter('balance'),...Array.from({length:10},(_,i)=>meter('key:'+i))]});
test('money display preserves micro-spending, negatives and integers beyond Number precision in both locales',()=>{
  for(const locale of ['en','ru'] as const){setLocale(locale);assert.match(money('1'),/0[.,]000001 USD/);assert.match(money('-1'),/−0[.,]000001/);assert.match(money('0'),/0[.,]00/);assert.ok(money('9007199254740993','USD',true).endsWith('740993 USD'));assert.match(money('999999'),/1[.,]00/);}
  assert.equal(capPercent({...meter('cap','1'),kind:'cap',limit:'0'}),null);setLocale('en');
});
test('money defaults select only balances, bound overflow and preserve explicit archived details on lineup growth',()=>{
  const settings=readMoney({unit:'USD'}),cards=[card('one'),card('two'),card('three')];
  assert.deepEqual(moneySelection(cards,[],settings).selection?.ids,[['one','balance'],['three','balance'],['two','balance']]);
  const large=moneySelection(Array.from({length:34},(_,i)=>card('s'+i)),[],settings);assert.equal(large.selection?.ids.length,32);assert.equal(large.omitted,2);
  const explicit=readMoney({unit:'USD',selected:{USD:[['one','archived:cap']]}});assert.deepEqual(moneySelection(cards,[],explicit).selection?.ids,[['one','archived:cap']]);
  assert.equal(moneySelection(cards,['source:one'],explicit).removed,1);
});
test('source access is an independent private slice and disappears with its lineup',()=>{
  const snapshot:Snapshot={board:{id:'b',name:'',personal:true},view:{layout:{columns:6,places:{}},names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{}},historyStart:0,sources:[card('one')],sessions:{},cadence:{},refresh:{},forecast:{},mine:['one'],boards:[],resets:{resets:{},trackers:[],past:{}}};
  const before=reduce(INITIAL,{type:'hub',event:{type:'snapshot',data:snapshot}});
  const own={error:null,expiresAt:null,canRefresh:true,credentialIds:['own']};
  const next=reduce(before,{type:'hub',event:{type:'sourceAccess',data:{one:own}}});
  assert.equal(next.board?.cards,before.board?.cards);assert.equal(next.boards,before.boards);assert.equal(next.board?.sourceAccess?.one,own);
  const gone=reduce(next,{type:'hub',event:{type:'lineup',data:{sources:[]}}});assert.deepEqual(gone.board?.sourceAccess,{});
});
