import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {HistoryStore,follow} from '../lib/history';
import {expandHistory,planEventsAt,planEventsDeadline,type HistoryReply} from '../../server/domain/history';
import {moneyReadSelection} from '../lib/moneySelection';
import {shallowEqual} from '../lib/store';
import {centralFixture,at as capturedAt} from '../../server/test/centralFixture';
import {expandPeriod,type PeriodWireReply} from '../../server/domain/periodWire';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {moneyTableValues} from '../lib/moneyTable';

test('a sessions-only reply updates the wallet table consumer after creating a link',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({personal:true,ownerDevice:true});
  let loader:any,stop:any; const stops:(()=>void)[]=[];
  const settle=async()=>{await flush();for(let i=0;i<6;i++){await new Promise<void>(resolve=>setImmediate(resolve));await flush();}};
  try{
    const wallet=h.store.source('openrouter','w'.repeat(24),NOW-H);h.store.hold(wallet,h.owner,NOW-H);
    for(const [at,usage] of [[NOW-50*M,'0'],[NOW-M,'6000000']] as const){const meter=(id:string,amount:string)=>({id,at,amount,kind:'counter' as const,unit:'USD',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:H,stale:false});h.store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:H,meters:[meter('usage',usage),meter('credits','60000000')],keys:[],inventoryComplete:true,inventoryError:null});}
    h.directory.saveView(h.board,{...h.directory.view(h.board),shown:['agents','activity','budget-table','budget-history']},h.owner,NOW);h.events.touchBoards([h.board]);h.events.flush();await settle();
    const selection=()=>{const b=h.page.get().board!;return moneyReadSelection(b.lineup.map((id:string)=>b.cards[id]),b.view,h.settings.money,b.currencies);};
    let loaderReads=0;
    loader=new HistoryStore({workInPresentation:false,now:()=>NOW,preparations:null,read:(_board,cell,from,to,signal,meters,meta)=>{loaderReads++;return h.period.transport.read('budget',{cell:String(cell),from:String(from),to:String(to),meta:meta?.meta??'',unit:meters!.unit,meters:JSON.stringify(meters!.ids),...(meters!.displayCurrency?{currency:meters!.displayCurrency}:{}),...(meters!.work?{work:'1'}:{})},signal).then((reply:HistoryReply)=>expandHistory(reply,meta));},setTimeout:()=>({}),clearTimeout:()=>{},dropTimeRange:()=>{}},undefined,'budget',h.pool);
    stop=follow(loader,h.page);loader.choose('1h',null);loader.setMeters(selection());loader.open(h.board);loader.hello(h.events.epoch);const b=h.page.get().board!;loader.snapshot(b.lineup,[],b.historyStart,b.workAuthority,JSON.stringify([b.lineup.map((id:string)=>{const c=b.cards[id];return [id,c.budget,c.meters,c.creditBalance,c.balanceStatus];}),b.currencies]));await settle();
    assert.ok(loader.get().history);assert.equal(loader.get().loading,false);assert.equal(selection()?.work,true);
    let dirty=false,cursor=0;const slots:any[]=[];let render:any=()=>{};let queued=false;const requestRender=()=>{if(!queued){queued=true;queueMicrotask(()=>{queued=false;if(dirty)render();});}};
    const useRef=(current:any)=>{const at=cursor++;return slots[at]??(slots[at]={current});};
    const useMemo=(read:any,deps:any[])=>{const box=useRef(null);if(!box.current||deps.some((v:any,i:number)=>!Object.is(v,box.current.deps[i])))box.current={deps,value:read()};return box.current.value;};
    const useSyncExternalStore=(subscribe:any,read:any)=>{const at=cursor++;let state=slots[at];if(!state){state=slots[at]={value:read()};stops.push(subscribe(()=>{const next=read();if(!Object.is(state.value,next)){state.value=next;dirty=true;requestRender();}}));}state.value=read();return state.value;};
    const context={useRef,useMemo,useSyncExternalStore,pan:{active:()=>null,onPhase:()=>()=>{}},hubNow:()=>NOW,planEventsAt,planEventsDeadline,shallowEqual,useClock:()=>NOW,fundsHistory:{},page:h.page,timeRange:()=>null,prefs:()=>h.settings,boardPeriod:h.period,read:null as any};
    const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');runInNewContext(ts.transpileModule(source.slice(source.indexOf('function usePeriodHistory('),source.indexOf('export function useHistory('))+'\nglobalThis.read=usePeriodHistory;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
    let renderedWork:any,renders=0;
    render=()=>{cursor=0;dirty=false;renders++;context.read(loader);renderedWork=h.period.moneyWorkAt(wallet,NOW);};
    const pump=async()=>{for(let i=0;i<10;i++){await settle();if(dirty)render();}};render();
    const financial=h.period.getFinancialProjectionRevision('budget');
    let fCursor=0,fQueued=false,fRenders=0,fDrawingChanges=0,fDrawing:any;const fSlots:any[]=[];
    const fRef=(current:any)=>{const at=fCursor++;return fSlots[at]??(fSlots[at]={current});};
    const fMemo=(read:any,deps:any[])=>{const box=fRef(null);if(!box.current||deps.some((v:any,i:number)=>!Object.is(v,box.current.deps[i])))box.current={deps,value:read()};return box.current.value;};
    let fRender:any=()=>{};
    const fSubscribe=(subscribe:any,read:any)=>{const at=fCursor++;let state=fSlots[at];if(!state){state=fSlots[at]={value:read()};stops.push(subscribe(()=>{const next=read();if(!Object.is(state.value,next)){state.value=next;if(!fQueued){fQueued=true;queueMicrotask(()=>{fQueued=false;fRender();});}}}));}state.value=read();return state.value;};
    const fContext={...context,useRef:fRef,useMemo:fMemo,useSyncExternalStore:fSubscribe,read:null as any};
    runInNewContext(ts.transpileModule(source.slice(source.indexOf('function usePeriodHistory('),source.indexOf('export function useHistory('))+'\nglobalThis.read=usePeriodHistory;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,fContext);
    fRender=()=>{fCursor=0;fRenders++;const value=fContext.read(loader,true,true);if(value.drawing!==fDrawing){fDrawingChanges++;fDrawing=value.drawing;}};fRender();
    const fRendersBefore=fRenders,fDrawingsBefore=fDrawingChanges,readsBefore=loaderReads,historyBefore=loader.get().history;
    const beforePrivate={revision:h.period.getProjectionRevision('budget'),renders,work:renderedWork};
    h.requests.length=0;
    h.store.creditWork(h.device,NOW-30_000,NOW,[{client:'claude',source:null,origin:'terminal',startedAt:NOW-M,project:'Private benchmark',folder:'',identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);h.events.flush();await pump();
    assert.deepEqual(h.period.moneyWorkAt(wallet,NOW),beforePrivate.work);
    assert.equal(h.period.getProjectionRevision('budget'),beforePrivate.revision,'unbound work does not publish an unrelated budget projection');
    assert.equal(renders,beforePrivate.renders,'unbound work does not render the actual wallet table subscriber');
    assert.equal(fRenders,fRendersBefore);assert.equal(fDrawingChanges,fDrawingsBefore);
    assert.equal(h.requests.length,1);assert.equal(h.requests[0].budget,undefined);
    now+=1000;h.jump(now);await pump();
    assert.equal(fRenders,fRendersBefore,'ordinary time preserves the financial subscriber');
    h.requests.length=0;
    h.store.links.mutate(h.owner,'create',null,{clientId:'opencode',deviceId:null,route:null,sourceId:wallet,from:NOW-H,to:null,expectedRevision:h.store.links.revision(h.owner),requestId:randomUUID()},now);h.events.flush();await pump();
    assert.ok(h.period.moneyWorkAt(wallet,NOW),'common accounting computed money work');
    assert.deepEqual(renderedWork,h.period.moneyWorkAt(wallet,NOW),'the actual history subscriber renders newly available work');
    assert.equal(h.pool.activeFlights,0);assert.equal(loader.get().loading,false);
    assert.equal(h.period.getFinancialProjectionRevision('budget'),financial,'work leaves financial indices unchanged');
    assert.equal(loaderReads,readsBefore,'creating a link reuses financial drawing tiles');assert.equal(loader.get().history,historyBefore);
    assert.equal(fRenders,fRendersBefore,'creating a link never renders the financial subscriber');assert.equal(fDrawingChanges,fDrawingsBefore);
    const readsAfter=loaderReads,historyAfter=loader.get().history;h.requests.length=0;
    h.store.creditWork(h.device,NOW-30_000,NOW,[{client:'opencode',source:null,origin:'terminal',startedAt:NOW-M,project:'Linked benchmark',folder:'',identity:{kind:'stable',sessionId:'e'.repeat(32)}}]);h.events.flush();await pump();
    assert.equal(renderedWork.activeMs,30_000);
    assert.equal(loaderReads,readsAfter,'work reuses the financial drawing tiles');assert.equal(loader.get().history,historyAfter);
    assert.equal(h.period.getFinancialProjectionRevision('budget'),financial);
    assert.equal(h.requests.length,1,'work updates share one period request');
    assert.equal(fRenders,fRendersBefore);assert.equal(fDrawingChanges,fDrawingsBefore);
  }finally{stops.forEach(stop=>stop());stop?.();loader?.close();await h.close();}
});

test('valid personal rates preserve large derived hourly estimates in the money table',async t=>{
  const from=capturedAt,to=from+30*M+1;t.mock.method(Date,'now',()=>to);
  const h=await centralFixture();t.after(async()=>{await h.app.close();h.store.close();});
  const board=h.directory.boards(h.owner.id).find(board=>board.personal)!.id;
  const wallet=h.store.source('openrouter','large-derived-rate',from);h.store.hold(wallet,h.owner.id,from);
  const unit=h.store.currencies.create(h.owner.id,{name:'Points',symbol:'PT',fractionDigits:2},'USD','1000000000000000000',from);h.store.currencies.select(h.owner.id,unit.id);
  for(const [at,usage] of [[from,'0'],[from+30*M,'8000000']] as const){
    h.store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:H,meters:[['usage',usage],['credits','8010000']].map(([id,amount])=>({id,amount,at,kind:'counter' as const,unit:'USD',stale:false,staleAfterMs:H,limit:null,resetAt:null,minutes:null,scope:null,label:null})),keys:[],inventoryComplete:true,inventoryError:null});
  }
  h.store.creditWork(h.device.id,from,from+30*M,[{client:'opencode',source:null,origin:'terminal',project:'Rates',folder:'',startedAt:from,identity:{kind:'stable',sessionId:'a'.repeat(32)}}]);
  h.store.links.mutate(h.owner.id,'create',null,{clientId:'opencode',deviceId:h.device.id,sourceId:wallet,route:null,from,to:null,expectedRevision:h.store.links.revision(h.owner.id),requestId:randomUUID()},from);
  const response=await h.call('POST',`/api/boards/${board}/period`,{version:1,selection:{mode:'range',from,to},evaluatedAt:to,sessions:{},budget:{cell:String(M),from:String(from),to:String(from+31*M),unit:'USD',currency:unit.id,meters:JSON.stringify([[wallet,'balance']]),work:'1',cells:'skip'}});
  assert.equal(response.statusCode,200,response.body);
  const reply=expandPeriod(response.json<PeriodWireReply>());assert.ok(reply.budget?.state==='complete');assert.ok(reply.sessions?.state==='complete');
  const tape=reply.budget.value.tape;assert.ok(tape?.fixed);
  const range=reply.budget.basis.range,accounting=new PeriodAccounting(tape,reply.sessions.value),financial=tape.fixed.money[0],work=accounting.moneyWorkSummary(wallet,range);
  assert.equal(financial.end,'10000000000000000');assert.equal(financial.spent,'8000000000000000000');assert.equal(work?.eligibleActiveMs,30*M);
  assert.deepEqual(moneyTableValues(financial,range.from,range.to,work),{value:'10000000000000000',topup:'0',active:String(30*M),rate:'16000000000000000000',remaining:'2250'});
});
