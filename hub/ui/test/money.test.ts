import {test} from 'node:test';
import assert from 'node:assert/strict';
import {money,capPercent,capStale,capChangesAt,accessTone,accessChangesAt} from '../lib/money';
import {setLocale} from '../i18n';
import {archivedKeyGroups,moneySelection,readMoney,moneyReadSelection,DEFAULT_MONEY} from '../lib/moneySelection';
import {moneyTotal,type MeterHistory} from '../lib/moneyView';
import type {Card} from '../lib/types';
import type {Meter} from '../../server/domain/meters';
import {keyShown} from '../lib/view';
import {defaultFilters,parseDataFilters} from '../../server/domain/dataFilters';
import {setWallet} from '../../server/domain/dataFilterMerge';
import {publishDataFilters} from '../lib/filterSelection';
import {EMPTY_VIEW} from '../../server/domain/view';
import {INITIAL,reduce,type Snapshot} from '../lib/board';

const meter=(id:string,value='1'):Meter=>({id,amount:value,kind:'balance',unit:'USD',limit:null,at:1,stale:false,staleAfterMs:1000,resetAt:null,minutes:null,scope:null,label:null});
const card=(id:string):Card=>({id,provider:'openrouter',plan:'',successAt:1,error:null,stale:false,windows:[],resets:null,owners:[],staleAfterMs:1000,measureIntervalMs:null,meters:[meter('balance'),...Array.from({length:10},(_,i)=>meter('key:'+i))]});

test('key-only work demand stays unsupported through conversion while mixed account selections opt in',()=>{
  const source=card('wallet'),view={...EMPTY_VIEW,shown:['budget-table']};
  for(const key of ['key:k:cap','fx:EUR:key:k:cap']){
    const unit=key.startsWith('fx:')?'EUR':'USD',account=unit==='EUR'?'fx:EUR:balance':'balance';
    const settings={...DEFAULT_MONEY,unit,selected:{[unit]:[[source.id,key] as [string,string]]}};
    assert.equal(moneyReadSelection([source],view,settings)?.work,undefined,key);
    settings.selected[unit].push([source.id,account]);assert.equal(moneyReadSelection([source],view,settings)?.work,true,'the account selection has its own source-wide work demand');
  }
});
test('unknown spending stays unknown, and a known subtotal identifies missing coverage',()=>{
  const series:MeterHistory={sourceId:'s',meterId:'balance',kind:'balance',unit:'USD',semantics:null,start:null,end:'10',spent:'0',topup:'0',unlocated:[],topupUnlocated:[],coveredMs:0,points:[]};
  assert.deepEqual(moneyTotal(series,0,86400000),{amount:null,unknown:true,partial:true});
  assert.deepEqual(moneyTotal(series,0,86400000,true),{amount:null,unknown:true,partial:true});
  assert.deepEqual(moneyTotal({...series,spent:'3000000',coveredMs:10800000},0,86400000),{amount:'3000000',unknown:false,partial:true});
  assert.deepEqual(moneyTotal({...series,coveredMs:86400000},0,86400000),{amount:'0',unknown:false,partial:false});
});
test('a selected live key on another page is not archived, and archived scales share one key group',()=>{
  const selected:[string,string][]=[['s','key:live:usage'],['s','key:gone:usage'],['s','key:gone:cap'],['other','key:else:cap']];
  assert.deepEqual(archivedKeyGroups('s',selected,new Set(['live']),[]),[{id:'gone',label:'gone',cap:'key:gone:cap'}]);
});
test('account balances, converted balances and counters cannot become archived key groups',()=>{
  const ids=['balance','balance:CNY','granted:CNY','fx:USD:balance:CNY','fx:USD:granted:CNY','usage','credits','key:gone:usage','key:gone:cap'];
  assert.deepEqual(archivedKeyGroups('s',ids.map(id=>['s',id]),new Set(),[]),[{id:'gone',label:'gone',cap:'key:gone:cap'}]);
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
test('explicit key filters outside the bounded preview survive saving, reload and preview changes',()=>{
  const preview=[{id:'first'}],source='openrouter:fixture',filters=defaultFilters();
  publishDataFilters(filters);
  assert.equal(keyShown(EMPTY_VIEW,source,'first',preview),true);
  assert.equal(keyShown(EMPTY_VIEW,source,'sixth',preview),false);
  filters.wallet=setWallet(filters.wallet,{source,kind:'keyCap',key:'sixth'},true,false);
  const saved=parseDataFilters(JSON.parse(JSON.stringify(filters)))!;
  publishDataFilters(saved);assert.equal(keyShown(EMPTY_VIEW,source,'sixth',preview),true);
  saved.wallet=setWallet(saved.wallet,{source,kind:'keyCap',key:'first'},true,false);
  publishDataFilters({...saved});assert.equal(keyShown(EMPTY_VIEW,source,'first',[]),true);
  saved.wallet=setWallet(saved.wallet,{source,kind:'keyCap',key:'first'},false,true);
  publishDataFilters({...saved});assert.equal(keyShown(EMPTY_VIEW,source,'first',preview),false);
  publishDataFilters(null,false);
});
test('money display preserves micro-spending, negatives and integers beyond Number precision in both locales',()=>{
  for(const locale of ['en','ru','en'] as const){setLocale(locale);const separator=locale==='en'?'.':',';assert.equal(money('1'),`0${separator}000001 USD`);assert.match(money('-1'),/−0[.,]000001/);assert.match(money('0'),/0[.,]00/);assert.ok(money('9007199254740993','USD',true).endsWith('740993 USD'));assert.match(money('999999'),/1[.,]00/);}
  assert.equal(capPercent({...meter('cap','1'),kind:'cap',limit:'0'}),null);setLocale('en');
});
test('money defaults select only balances, bound overflow and preserve explicit archived details on lineup growth',()=>{
  const settings=readMoney({unit:'USD'}),cards=[card('one'),card('two'),card('three')];
  assert.deepEqual(moneySelection(cards,[],settings).selection?.ids,[['one','balance'],['three','balance'],['two','balance']]);
  const large=moneySelection(Array.from({length:34},(_,i)=>card('s'+i)),[],settings);assert.equal(large.selection?.ids.length,32);assert.equal(large.omitted,2);
  const explicit=readMoney({unit:'USD',selected:{USD:[['one','archived:cap']]}});assert.deepEqual(moneySelection(cards,[],explicit).selection?.ids,[['one','archived:cap']]);
  assert.equal(moneySelection(cards,['source:one'],explicit).removed,0);
});
test('source access is an independent private slice and disappears with its lineup',()=>{
  const snapshot:Snapshot={board:{id:'b',name:'',personal:true},view:{version:5 as const, layout: {columns: 6, places: {}}, names:{},hidden:[],shown:[],windows:[],plans:{},unplanned:[],colors:{},columns:{},shownColumns:{}},historyStart:0,sources:[card('one')],sessions:{},cadence:{},refresh:{},forecast:{},mine:['one'],boards:[],resets:{resets:{},trackers:[],past:{}}};
  const before=reduce(INITIAL,{type:'hub',event:{type:'snapshot',data:snapshot}});
  const own={error:null,expiresAt:null,canRefresh:true,credentialIds:['own']};
  const next=reduce(before,{type:'hub',event:{type:'sourceAccess',data:{one:own}}});
  assert.equal(next.board?.cards,before.board?.cards);assert.equal(next.boards,before.boards);assert.equal(next.board?.sourceAccess?.one,own);
  const gone=reduce(next,{type:'hub',event:{type:'lineup',data:{sources:[]}}});assert.deepEqual(gone.board?.sourceAccess,{});
});


test('mixed credits select one native meter through USD context and grant metadata changes selection identity',()=>{
  const source:Card={...card('codex'),provider:'codex',meters:[{...meter('balance:credits','12345678912'),unit:'credits:codex',scale:7}],budget:{enabled:true,since:10,anchor:20,revision:'first'}};
  const selection=moneySelection([source],[],readMoney({}),undefined,'funds').selection!;
  assert.deepEqual(selection.ids,[['codex','balance:credits']]);assert.equal(selection.displayCurrency,'USD');
  assert.notEqual(JSON.stringify(moneySelection([{...source,budget:{...source.budget!,anchor:30}}],[],readMoney({}),undefined,'funds').selection),JSON.stringify(selection));
  assert.deepEqual(moneySelection([{...source,budget:{...source.budget!,enabled:false}}],[],readMoney({}),undefined,'funds').selection?.ids,[]);
  assert.deepEqual(moneySelection([source],['source:codex'],readMoney({}),undefined,'funds').selection?.ids,[['codex','balance:credits']]);
  for(const locale of ['en','ru'] as const){setLocale(locale);const exact=money('12345678912','credits:codex',true,undefined,7);assert.match(exact,/5678912/);assert.ok(!exact.includes('12345678'));}
  setLocale('en');
});


test('wallet and subscription fund selections stay disjoint even with explicit saved meters',()=>{
  const wallet=card('wallet'),funds:Card={...card('subscription'),provider:'codex',meters:[{...meter('balance:credits','2500000000'),unit:'credits:codex'}]};
  const cards=[wallet,funds],settings=readMoney({selected:{USD:[['wallet','balance'],['subscription','balance:credits']]}});
  assert.deepEqual(moneySelection(cards,[],settings).selection?.ids,[['wallet','balance']]);
  assert.deepEqual(moneySelection(cards,[],settings,undefined,'funds').selection?.ids,[['subscription','balance:credits']]);
  assert.deepEqual(moneySelection(cards,[],readMoney({selected:{USD:[]}}),undefined,'funds').selection?.ids,[]);
  assert.deepEqual(moneySelection(cards,[],readMoney({})).selection?.ids,[['wallet','balance']]);
});
