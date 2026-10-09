import {test} from 'node:test';
import assert from 'node:assert/strict';
import {money,capPercent,capStale,capChangesAt,accessTone,accessChangesAt} from '../lib/money';
import {setLocale} from '../i18n';
import {archivedKeyGroups,moneySelection,readMoney} from '../lib/moneySelection';
import {moneyTotal,type MeterHistory} from '../lib/moneyView';
import type {Card} from '../lib/types';
import type {Meter} from '../../server/domain/meters';
import {keyShown,withKeyShown} from '../lib/view';
import {parseView,EMPTY_VIEW} from '../../server/domain/view';
import {INITIAL,reduce,type Snapshot} from '../lib/board';

const meter=(id:string,value='1'):Meter=>({id,amount:value,kind:'balance',unit:'USD',limit:null,at:1,stale:false,staleAfterMs:1000,resetAt:null,minutes:null,scope:null,label:null});
const card=(id:string):Card=>({id,provider:'openrouter',plan:'',successAt:1,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,meters:[meter('balance'),...Array.from({length:10},(_,i)=>meter('key:'+i))]});
test('unknown spending stays unknown, and a known subtotal identifies missing coverage',()=>{
  const series:MeterHistory={sourceId:'s',meterId:'balance',kind:'balance',unit:'USD',semantics:null,start:null,end:'10',spent:'0',topup:'0',unlocated:[],topupUnlocated:[],coveredMs:0,points:[]};
  assert.deepEqual(moneyTotal(series,0,86400000),{amount:null,unknown:true,partial:true});
  assert.deepEqual(moneyTotal(series,0,86400000,true),{amount:null,unknown:true,partial:true});
  assert.deepEqual(moneyTotal({...series,spent:'3000000',coveredMs:10800000},0,86400000),{amount:'3000000',unknown:false,partial:true});
  assert.deepEqual(moneyTotal({...series,coveredMs:86400000},0,86400000),{amount:'0',unknown:false,partial:false});
});
test('a selected live key on another page is not archived, and archived scales share one key group',()=>{
  const selected:[string,string][]=[['s','key:live:usage'],['s','key:gone:usage'],['s','key:gone:cap'],['other','key:else:cap']];
  assert.deepEqual(archivedKeyGroups('s',selected,new Set(['live']),[]),[{id:'gone',label:'gone',usage:'key:gone:usage',cap:'key:gone:cap'}]);
});
test('account balances, converted balances and counters cannot become archived key groups',()=>{
  const ids=['balance','balance:CNY','granted:CNY','fx:USD:balance:CNY','fx:USD:granted:CNY','usage','credits','key:gone:usage','key:gone:cap'];
  assert.deepEqual(archivedKeyGroups('s',ids.map(id=>['s',id]),new Set(),[]),[{id:'gone',label:'gone',usage:'key:gone:usage',cap:'key:gone:cap'}]);
});
test('access warnings begin exactly seven days before expiry, and expired access is critical',()=>{
  const now=Date.UTC(2026,9,4),expiry=now+8*86_400_000,warning=now+86_400_000;
  const access={expiresAt:expiry,error:null};
  assert.equal(accessTone(access,warning-1),'neutral');
  assert.equal(accessChangesAt(access,warning-1),warning);
  assert.equal(accessTone(access,warning),'warn');
  const changed=accessChangesAt(access,warning)!;
  assert.ok(changed>warning&&changed<=expiry);
  assert.equal(accessTone(access,expiry-1),'warn');
  assert.equal(accessChangesAt(access,expiry-1),expiry);
  assert.equal(accessTone(access,expiry),'crit');
  assert.equal(accessChangesAt(access,expiry),null);
});
test('working access without expiry has no news, while revoked access and temporary failures remain visible',()=>{
  const now=1000,access={expiresAt:null,error:null};
  assert.equal(accessTone(access,now),null);
  assert.equal(accessChangesAt(access,now),null);
  assert.equal(accessChangesAt(null,now),null);
  assert.equal(accessChangesAt(undefined,now),null);
  for(const error of ['credential_revoked','credential_expired','credential_permission'] as const)assert.equal(accessTone({...access,error},now),'crit');
  assert.equal(accessTone({...access,error:'connector_timeout'},now),'warn');
  assert.equal(accessChangesAt({...access,error:'connector_timeout'},now),null);
  const revoked={expiresAt:now+60_000,error:'credential_revoked' as const};
  assert.equal(accessTone(revoked,now),'crit');
  assert.equal(accessChangesAt(revoked,now),revoked.expiresAt);
});
test('a selected cap stays fresh until its own deadline or earlier reset',()=>{
  const cap={...meter('cap'),at:100,staleAfterMs:1000,resetAt:800};
  assert.equal(capChangesAt(cap,100),800);assert.equal(capStale(cap,799),false);assert.equal(capStale(cap,800),true);assert.equal(capChangesAt(cap,800),null);
  const lifetime={...cap,resetAt:null};assert.equal(capChangesAt(lifetime,1100),1101);assert.equal(capStale(lifetime,1100),false);assert.equal(capStale(lifetime,1101),true);
});
test('explicit card scales outside the bounded preview survive saving, reload and preview changes',()=>{
  const preview=[{id:'first'}],source='openrouter:fixture';
  assert.equal(keyShown(EMPTY_VIEW,source,'first',preview),true);
  assert.equal(keyShown(EMPTY_VIEW,source,'sixth',preview),false);
  const saved=parseView(withKeyShown(EMPTY_VIEW,source,'sixth',true))!;
  assert.equal(keyShown(saved,source,'sixth',preview),true);
  const enabled=withKeyShown(saved,source,'first',true);
  assert.equal(keyShown(enabled,source,'first',[]),true);
  assert.equal(keyShown(withKeyShown(enabled,source,'first',false),source,'first',preview),false);
  assert.equal(keyShown(withKeyShown(saved,source,'sixth',false),source,'sixth',preview),false);
});
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
  const snapshot:Snapshot={board:{id:'b',name:'',personal:true},view:{version: 3 as const, layout: {columns: 6, places: {}}, names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{}},historyStart:0,sources:[card('one')],sessions:{},cadence:{},refresh:{},forecast:{},mine:['one'],boards:[],resets:{resets:{},trackers:[],past:{}}};
  const before=reduce(INITIAL,{type:'hub',event:{type:'snapshot',data:snapshot}});
  const own={error:null,expiresAt:null,canRefresh:true,credentialIds:['own']};
  const next=reduce(before,{type:'hub',event:{type:'sourceAccess',data:{one:own}}});
  assert.equal(next.board?.cards,before.board?.cards);assert.equal(next.boards,before.boards);assert.equal(next.board?.sourceAccess?.one,own);
  const gone=reduce(next,{type:'hub',event:{type:'lineup',data:{sources:[]}}});assert.deepEqual(gone.board?.sourceAccess,{});
});
