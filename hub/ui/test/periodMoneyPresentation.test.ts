import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {observationDeadline,type CreditBalanceState} from '../../server/domain/resources';
import {capStale,capChangesAt,money} from '../lib/money';
import {moneyTotal} from '../lib/moneyView';
import {defaultCurrencyContext} from '../../server/domain/currency';
import {t,setLocale} from '../i18n';
import type {Meter} from '../../server/domain/meters';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {budgetView,historicalCurrencyContext} from '../lib/money';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {periodValues} from '../../server/periodValues';
import {displayMeter} from '../../server/domain/currencyPresentation';
import {Currencies} from '../../server/currencies/service';
import {ReadError} from '../../server/historyRead';
import {ApiError} from '../lib/http';

async function historicalFunds(t:TestContext,personal=true) {
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal});t.after(h.close);
  if(!personal)h.store.setBudget(h.board,h.source,h.alice.id,true,h.store.sources(h.board)[0].budget!.revision,NOW-20*M);
  h.store.record(h.source,{observedAt:NOW-M,staleAfterMs:H,plan:'pro',resets:null,windows:[{id:'w',kind:'weekly',minutes:10080,label:null,used:10,remaining:90,resetAt:NOW+H}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'50000',hasCredits:true}]});
  h.events.flush();await flush();h.selectRange({from:NOW-H,to:NOW});await flush();
  const shown=()=>{const value=h.period.getValue(h.source).value;if(!value)return;
    const context=historicalCurrencyContext(h.page.get().board!.currencies!,h.source,value.meters);
    return budgetView(value,[],value.meters,context).remaining.values[0]?.total;};
  const currency=()=>h.event({type:'currencies',data:h.store.currencies.context(h.alice.id)});
  return {...h,shown,currency};
}

test('cards alone reload historical values on target and path changes without reloading quota or work',async t=>{
  const h=await historicalFunds(t);
  h.event({type:'view',data:{revision:(h.page.get().board!.viewRevision??0)+1,view:{...h.page.get().board!.view,shown:['agents','quota-history'],hidden:['activity','budget-history','budget-table','subscription-funds']}}});await flush();
  assert.equal(h.shown()?.amount,'2000000000');
  const quota=h.period.tapes.get('quota'),work=h.period.get().value;
  const personal=h.store.currencies.create(h.alice.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',NOW);
  const held=h.hold();h.store.currencies.select(h.alice.id,personal.id);h.currency();
  assert.equal(h.period.getValue(h.source).value.meters.length,0,'old target is retired synchronously');
  assert.ok(h.period.getValue(h.source).value.windows.length,'native quotas keep their independent basis');
  await flush();assert.ok(h.requests.at(-1)?.values,'hidden monetary widgets cannot suppress values demand');
  assert.ok(!h.requests.at(-1)?.funds&&!h.requests.at(-1)?.budget);
  held.release();await flush();assert.equal(h.shown()?.amount,'4000000000');assert.equal(h.shown()?.unit,personal.id);
  assert.equal(h.period.tapes.get('quota'),quota);assert.equal(h.period.get().value,work);
  h.store.currencies.select(h.alice.id,'EUR');h.currency();await flush();
  assert.equal(h.shown(),undefined);assert.equal(h.period.getValue(h.source).value.currencyUnavailable,true);
  h.store.currencies.save({source:'ecb',base:'EUR',date:NOW-H,fetchedAt:NOW,rates:{EUR:'1000000',USD:'2000000'}});h.currency();await flush();
  assert.equal(h.shown()?.unit,'EUR');assert.equal(h.shown()?.amount,'1000000000','same-target path revision recovers a missing conversion');
  const count=h.requests.length;
  h.event({type:'currencies',data:{...h.page.get().board!.currencies!,registryRevision:'metadata-only',target:{...h.page.get().board!.currencies!.target,symbol:'€'}}});await flush();
  assert.equal(h.requests.length,count,'metadata edits never reload exact evidence');
});

test('financial revocation retires current and cached historical values through disable and re-enable',async t=>{
  const h=await historicalFunds(t,false);assert.equal(h.shown()?.amount,'2000000000');
  const first=h.selectedRange()!;
  h.selectRange({from:first.from-M,to:first.to-M});await flush();
  h.selectRange(first);await flush();
  let revision=h.store.sources(h.board)[0].budget!.revision;
  h.store.setBudget(h.board,h.source,h.alice.id,false,revision,NOW);
  h.events.flush();
  assert.equal(h.period.getValue(h.source).value.meters.length,0,'withheld financial fields disappear before replacement');
  await flush();revision=h.store.sources(h.board)[0].budget!.revision;
  h.store.setBudget(h.board,h.source,h.alice.id,true,revision,NOW+1);h.events.flush();await flush();
  assert.equal(h.page.get().board!.cards[h.source].budget!.anchor,null);
  assert.equal(h.period.getValue(h.source).value.meters.length,0);
  assert.equal(h.period.getValue(h.source).value.creditBalance,undefined);
  h.selectRange({from:first.from-M,to:first.to-M});await flush();h.selectRange(first);await flush();
  assert.equal(h.shown(),undefined,'an old restore closure cannot resurrect the former grant');
});

test('target generations reject delayed values and keep redaction through error, retry and cached return',async t=>{
  const h=await historicalFunds(t),first=h.selectedRange()!;
  const personal=h.store.currencies.create(h.alice.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',NOW);
  const old=h.hold();h.selectRange({from:first.from-M,to:first.to-1});await flush();
  h.store.currencies.select(h.alice.id,personal.id);h.currency();await flush();
  assert.equal(h.shown()?.amount,'4000000000');
  old.release();await flush();assert.equal(h.shown()?.unit,personal.id,'an old delivered USD reply cannot regain the new label');
  const failed=h.hold();h.store.currencies.select(h.alice.id,'EUR');h.currency();await flush();
  failed.reject(new Error('fixture transport failure'));await flush();
  assert.equal(h.period.getValue(h.source).error,'unavailable');assert.equal(h.shown(),undefined);
  h.period.retry();await flush();assert.equal(h.period.getValue(h.source).error,null);assert.equal(h.shown(),undefined);
  h.store.currencies.select(h.alice.id,'USD');h.currency();await flush();assert.equal(h.shown()?.amount,'2000000000');
  h.selectRange(first);await flush();assert.equal(h.shown()?.unit,'USD');
  const late=h.hold();h.store.currencies.select(h.alice.id,personal.id);h.currency();await flush();
  h.store.currencies.select(h.alice.id,'USD');h.currency();await flush();assert.equal(h.shown()?.unit,'USD');
  late.release();await flush();assert.equal(h.shown()?.unit,'USD','A → B → A does not admit the earlier generation');
});

test('a revoked grant cannot return from a delayed response or an error before a new admission',async t=>{
  const h=await historicalFunds(t,false),first=h.selectedRange()!,old=h.hold();
  h.selectRange({from:first.from-M,to:first.to-1});await flush();
  let revision=h.store.sources(h.board)[0].budget!.revision;
  h.store.setBudget(h.board,h.source,h.alice.id,false,revision,NOW);h.events.flush();await flush();
  old.release();await flush();assert.equal(h.shown(),undefined);
  const failed=h.hold();revision=h.store.sources(h.board)[0].budget!.revision;
  h.store.setBudget(h.board,h.source,h.alice.id,true,revision,NOW+1);h.events.flush();await flush();
  failed.reject(new Error('fixture transport failure'));await flush();
  assert.equal(h.period.getValue(h.source).value.meters.length,0);assert.equal(h.period.getValue(h.source).value.creditBalance,undefined);
  h.period.retry();await flush();h.selectRange(first);await flush();assert.equal(h.shown(),undefined);
  h.store.record(h.source,{observedAt:NOW+2,staleAfterMs:H,plan:'pro',resets:null,windows:[{id:'w',kind:'weekly',minutes:10080,label:null,used:15,remaining:85,resetAt:NOW+H}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'25000',hasCredits:true}]});
  t.mock.method(Date,'now',()=>NOW+3);h.jump(NOW+3);h.selectRange({from:first.from,to:NOW+3});await flush();
  assert.equal(h.shown()?.amount,'1000000000','only a new admitted observation opens the replacement grant');
});

test('archiving a display currency before its event arrives cannot close an authorized live board',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({personal:true}),service=new Currencies(h.store,async()=>{throw Error('synthetic rates unavailable');},()=>now);
  service.start();let release!:()=>void;
  t.after(async()=>{release?.();await service.stop();await h.close();});
  const wallet=h.store.source('openrouter','d'.repeat(24),NOW-H);h.store.hold(wallet,h.alice.id,NOW-H);
  const observe=async(at:number)=>{
    h.store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:H,meters:['credits','usage'].map(id=>({id,kind:'counter',unit:'USD',amount:id==='credits'?'90000000':'34000000',limit:null,at,staleAfterMs:H,stale:false,resetAt:null,minutes:null,scope:null,label:null})),keys:[],inventoryComplete:true,inventoryError:null});
    await service.update(wallet);h.events.flush();await flush();
  };
  await observe(NOW-M);
  h.event({type:'view',data:{revision:100,view:{...h.page.get().board!.view,shown:['agents','quota-history','budget-history']}}});await flush();
  const c=h.store.currencies,target=c.create(h.alice.id,{name:'Points',symbol:'PT',fractionDigits:2},'JPY','2000000',now);
  c.select(h.alice.id,target.id);c.setRate(h.alice.id,target.id,'USD','2000000',0,now);
  await service.update(wallet);h.events.flush();await flush();
  const shown=()=>{const board=h.page.get().board,card=board?.cards[wallet];return card?budgetView(card,[],card.meters??[],board!.currencies).remaining.values[0]?.total.amount:null;};
  assert.equal(shown(),'112000000');
  const transport=h.period.transport,send=transport.send.bind(transport),gate=new Promise<void>(resolve=>{release=resolve;});
  let paused=true;const attempts:{signal:AbortSignal;error?:string;currentOnError?:boolean}[]=[];
  // Pause the HTTP boundary before the real server reads. Its ReadError is
  // mapped exactly as fetchPeriod maps the HTTP status and JSON error code.
  transport.send=async(board:string,body:unknown,signal:AbortSignal,reserve:unknown)=>{
    const attempt={signal,error:undefined as string|undefined,currentOnError:false};
    if(paused&&(body as {budget?:{currency?:string}}).budget?.currency){attempts.push(attempt);await gate;}
    try{return await send(board,body,signal,reserve);}catch(error){if(error instanceof ReadError){attempt.error=error.code;attempt.currentOnError=!signal.aborted;throw new ApiError(error.statusCode,error.code);}throw error;}
  };
  const quote=c.rates(h.alice.id,target.id).find(row=>row.base==='USD')!;
  c.stopRate(h.alice.id,target.id,'USD',quote.id,now);h.events.flush();await flush();
  now+=1000;h.jump(now);await observe(now);assert.equal(shown(),undefined);
  assert.ok(attempts.some(attempt=>!attempt.signal.aborted),'the previous target still has a current HTTP request');
  c.archive(h.alice.id,target.id,'USD',now);
  paused=false;release();await flush();
  assert.ok(attempts.some(attempt=>attempt.currentOnError&&attempt.error==='currency_not_found'),'the real reader rejects the archived target before SSE delivery');
  assert.ok(h.directory.boards(h.alice.id).some(board=>board.id===h.board));
  assert.ok(h.page.get().board,'a currency error does not revoke board access');
  h.events.flush();await flush();
  assert.equal(h.page.get().board!.currencies!.target.id,'USD');assert.equal(shown(),'56000000');
  assert.equal(h.period.projectionState({range:'1h'},'budget').error,undefined);
  assert.equal(h.pool.activeFlights,0);
});

for(const target of ['USD','EUR','personal'])test(`historical ${target} rendering preserves dated and pinned valuation anchors`,()=>{
  const store=new Store(':memory:',1),directory=new Directory(store.db),owner=directory.createUser('dates@example.test','Dates','unused',1).id;
  const id=store.source('codex','a'.repeat(24),1);store.hold(id,owner,1);
  const currencies=store.currencies;
  const personal=currencies.create(owner,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',1);
  currencies.save({source:'ecb',base:'EUR',date:0,fetchedAt:1,validUntil:null,rates:{EUR:'1000000',USD:'2000000'}});
  currencies.select(owner,target==='personal'?personal.id:target);
  const source={id,provider:'codex',budget:{enabled:true,since:0,anchor:0,revision:'personal'}};
  const observe=(at:number,amount='50000')=>store.record(id,{observedAt:at,staleAfterMs:1000,plan:'pro',resets:null,windows:[{id:'weekly',kind:'weekly',minutes:10080,label:null,used:10,remaining:90,resetAt:null}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount,hasCredits:true}]});
  const read=(to:number)=>{const value=periodValues(store,[source],owner,to,()=>{})[0],context=historicalCurrencyContext(currencies.context(owner),id,value.meters);
    const shown=budgetView(value,[],value.meters,context).remaining.values[0]?.total;
    const native=value.meters.find(m=>m.id==='balance:credits');
    if(shown&&native)assert.equal(displayMeter(native,id,context)?.amount,shown.amount,'native and converted aliases name the same proof');
    return {value,shown,context};};
  const initial=target==='USD'?'2000000000':target==='EUR'?'1000000000':'4000000000';
  const overridden=target==='USD'?'1500000000':target==='EUR'?'750000000':'3000000000';
  try{
    observe(10);assert.equal(read(11).shown?.amount,initial);
    currencies.setRate(owner,'credits:codex','USD','30000',20,20,'basePerUnit');
    assert.equal(read(21).shown?.amount,initial,'moving the selected edge creates no new valuation');
    observe(20);assert.equal(read(20).shown?.amount,initial,'the right-edge observation is excluded');
    const updated=read(21);assert.equal(updated.shown?.amount,overridden);assert.equal(updated.shown?.conversion?.original.at,20);
    assert.equal(updated.shown?.conversion?.original.scale,0);
    currencies.setRate(owner,'credits:codex','USD','20000',5,25,'basePerUnit');
    assert.equal(read(11).shown?.amount,initial,'backdating never rewrites a successful assignment');
    assert.equal(read(21).shown?.amount,overridden);
    currencies.defaultRate(owner,'credits:codex',30);observe(30);assert.equal(read(31).shown?.amount,initial);
    observe(40,'0');assert.equal(read(41).shown?.amount,'0','a confirmed native zero retains its valid conversion');
    const proof=updated.value.meters.find(m=>m.conversion)!;
    const wrongTarget={...updated.context,target:{id:'GBP',name:'GBP',symbol:'GBP',fractionDigits:2}};
    assert.deepEqual(historicalCurrencyContext(wrongTarget,id,updated.value.meters).sources[id],[],'old target proof is never relabelled');
    for(const change of [{at:proof.conversion!.original.at+1},{unit:'credits:other'},{scale:12},{amount:'1'}]){
      const meters=updated.value.meters.map(m=>m.conversion?m:{...m,...change});
      assert.deepEqual(historicalCurrencyContext(updated.context,id,meters).sources[id],[],'mismatched native evidence receives no alias');
    }
    const onlyConverted=historicalCurrencyContext(updated.context,id,[proof]);assert.deepEqual(onlyConverted.sources[id],[]);
  }finally{store.close();}
});

test('historical presentation keeps stopped personal paths missing and recovers only permitted anchors',()=>{
  const store=new Store(':memory:',1),directory=new Directory(store.db),owner=directory.createUser('stops@example.test','Stops','unused',1).id;
  const id=store.source('codex','b'.repeat(24),1);store.hold(id,owner,1);
  const c=store.currencies,target=c.create(owner,{name:'Points',symbol:'PT',fractionDigits:2},'USD','2000000',1);c.select(owner,target.id);
  const source={id,provider:'codex',budget:{enabled:true,since:0,anchor:0,revision:'personal'}};
  const observe=(at:number)=>store.record(id,{observedAt:at,staleAfterMs:1000,plan:'pro',resets:null,windows:[],resourceStatus:{windows:'missing',resets:'missing'},balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:'50000'}]});
  const read=(to:number)=>{const value=periodValues(store,[source],owner,to,()=>{})[0],context=historicalCurrencyContext(c.context(owner),id,value.meters);return budgetView(value,[],value.meters,context).remaining.values[0]?.total;};
  try{
    observe(10);assert.equal(read(11)?.amount,'4000000000');c.stopRate(owner,target.id,'USD',c.rates(owner,target.id)[0].id,20);
    assert.equal(read(20)?.amount,'4000000000','a stopped path does not rewrite an old pinned anchor');
    for(const at of [20,21,30]){observe(at);assert.equal(read(at+1),undefined,'new anchors inside the stopped interval stay unknown');}
    c.setRate(owner,target.id,'USD','3000000',40,40);observe(40);assert.equal(read(41)?.amount,'6000000000');
    assert.equal(read(31),undefined,'resuming cannot fill the earlier hole');
    c.setRate(owner,target.id,'USD','4000000',25,50);assert.equal(read(31)?.amount,'8000000000','legal backdating recovers an actual missing anchor');
    assert.equal(read(41)?.amount,'6000000000','the successful resumed assignment stays pinned');
  }finally{store.close();}
});

/** Execute the actual footer and disclosure functions, supplying only their hook boundary. */
function funds(at:number) {
  const file=readFileSync(new URL('../components/MoneyCard.tsx',import.meta.url),'utf8');
  const body=file.slice(file.indexOf('function FundsMark('),file.indexOf('/** Safe supplier facts'));
  const jsx=(type:unknown,props:Record<string,unknown>)=>({type,props});
  const context={exports:{},result:null as unknown as {mark:(props:object)=>{props:{children:{props:{tone?:string}}}};text:(source:object,at:number)=>string|null;changes:(source:object,at:number)=>number|null},
    require:()=>({jsx,jsxs:jsx}),useMeasurementClock:()=>at,observationDeadline,money,t,stamp:String,rateText:String,StatusMark:'status',Popover:'popover'};
  runInNewContext(ts.transpileModule(body+'\nglobalThis.result={mark:FundsMark,text:creditBalanceText,changes:creditChangesAt};',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  return context.result;
}
const native:Meter={id:'balance:credits',kind:'balance',unit:'credits:codex',amount:'0',limit:null,at:100,staleAfterMs:100,validUntil:1001,stale:false,resetAt:null,minutes:null,scope:null,label:null};

test('production cap and credit presentations use historical availability without inventing a recent observation',()=>{
  const cap={...native,id:'quota:credit:5h',kind:'cap' as const,unit:'credits:zai',amount:'40',limit:'100'},at=800;
  assert.equal(capStale(cap,at),false);assert.equal(capChangesAt(cap,at),1001);
  assert.equal(capStale(cap,1001),true);assert.equal(capChangesAt(cap,1001),null);
  assert.equal(capStale({...cap,resetAt:700},at),true,'the resource reset remains authoritative');
  for(const locale of ['en','ru'] as const){setLocale(locale);
    for(const status of ['finite','unlimited'] as const){
      const creditBalance:CreditBalanceState={id:'balance:credits',unit:'credits:codex',status,at:native.at,staleAfterMs:native.staleAfterMs,validUntil:native.validUntil,hasCredits:true};
      const source={provider:'codex',creditBalance,meters:status==='finite'?[native]:[]},draw=funds(at);
      const props={source,groups:[],context:defaultCurrencyContext,native:status==='finite'?native:undefined,rateSources:'',quoteDate:'',displayUnavailable:false};
      assert.equal(draw.text(source,at),status==='finite'?null:t('money.unlimited'));
      assert.equal(draw.mark(props).props.children.props.tone,undefined);
      assert.equal(draw.changes(source,at),1001);
      const expired=funds(1001);assert.equal(expired.text(source,1001),t('money.stale'));
      assert.equal(expired.mark(props).props.children.props.tone,'warn');assert.equal(expired.changes(source,1001),null);
      assert.equal(creditBalance.at,100);
      const live={...source,creditBalance:{...creditBalance,validUntil:undefined}};
      assert.equal(draw.text(live,201),t('money.stale'),'live and compact retain the original sample TTL');
    }
  }
  setLocale('en');
});

test('the production totals distinguish an available amount from confirmed zero spending',()=>{
  const series={sourceId:'wallet',meterId:'balance',kind:'balance' as const,unit:'USD',semantics:null,start:'100000000',end:'100000000',spent:null,topup:null,unlocated:[],topupUnlocated:[],coveredMs:0,points:[]};
  assert.deepEqual(moneyTotal(series,100,1000),{amount:null,unknown:true,partial:true});
  assert.deepEqual(moneyTotal({...series,spent:'0',coveredMs:500},100,1000),{amount:'0',unknown:false,partial:true});
  assert.deepEqual(moneyTotal({...series,spent:'0',coveredMs:900},100,1000),{amount:'0',unknown:false,partial:false});
});
