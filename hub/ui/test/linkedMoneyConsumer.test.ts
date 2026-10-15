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

test('a sessions-only reply updates the wallet table consumer after creating a link',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,ownerDevice:true});
  let loader:any,stop:any; const stops:(()=>void)[]=[];
  const settle=async()=>{await flush();for(let i=0;i<6;i++){await new Promise<void>(resolve=>setImmediate(resolve));await flush();}};
  try{
    const wallet=h.store.source('openrouter','w'.repeat(24),NOW-H);h.store.hold(wallet,h.owner,NOW-H);
    for(const [at,usage] of [[NOW-50*M,'0'],[NOW-M,'6000000']] as const){const meter=(id:string,amount:string)=>({id,at,amount,kind:'counter' as const,unit:'USD',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:H,stale:false});h.store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:H,meters:[meter('usage',usage),meter('credits','60000000')],keys:[],inventoryComplete:true,inventoryError:null});}
    h.directory.saveView(h.board,{...h.directory.view(h.board),shown:['agents','activity','budget-table','budget-history']},h.owner,NOW);h.events.touchBoards([h.board]);h.events.flush();await settle();
    const selection=()=>{const b=h.page.get().board!;return moneyReadSelection(b.lineup.map((id:string)=>b.cards[id]),b.view,h.settings.money,b.currencies);};
    let loaderReads=0;
    loader=new HistoryStore({now:()=>NOW,preparations:null,read:(_board,cell,from,to,signal,meters,meta)=>{loaderReads++;return h.period.transport.read('budget',{cell:String(cell),from:String(from),to:String(to),meta:meta?.meta??'',unit:meters!.unit,meters:JSON.stringify(meters!.ids),...(meters!.displayCurrency?{currency:meters!.displayCurrency}:{}),...(meters!.work?{work:'1'}:{})},signal).then((reply:HistoryReply)=>expandHistory(reply,meta));},setTimeout:()=>({}),clearTimeout:()=>{},dropTimeRange:()=>{}},undefined,'budget',h.pool);
    stop=follow(loader,h.page);loader.choose('1h',null);loader.setMeters(selection());loader.open(h.board);loader.hello(h.events.epoch);const b=h.page.get().board!;loader.snapshot(b.lineup,[],b.historyStart,b.workAuthority,JSON.stringify([b.lineup.map((id:string)=>{const c=b.cards[id];return [id,c.budget,c.meters,c.creditBalance,c.balanceStatus];}),b.currencies]));await settle();
    assert.ok(loader.get().history);assert.equal(loader.get().loading,false);assert.equal(selection()?.work,true);
    let dirty=false,cursor=0;const slots:any[]=[];let render:any=()=>{};let queued=false;const requestRender=()=>{if(!queued){queued=true;queueMicrotask(()=>{queued=false;if(dirty)render();});}};
    const useRef=(current:any)=>{const at=cursor++;return slots[at]??(slots[at]={current});};
    const useMemo=(read:any,deps:any[])=>{const box=useRef(null);if(!box.current||deps.some((v:any,i:number)=>!Object.is(v,box.current.deps[i])))box.current={deps,value:read()};return box.current.value;};
    const useSyncExternalStore=(subscribe:any,read:any)=>{const at=cursor++;let state=slots[at];if(!state){state=slots[at]={value:read()};stops.push(subscribe(()=>{const next=read();if(!Object.is(state.value,next)){state.value=next;dirty=true;requestRender();}}));}state.value=read();return state.value;};
    const context={useRef,useMemo,useSyncExternalStore,pan:{active:()=>null,onPhase:()=>()=>{}},hubNow:()=>NOW,planEventsAt,planEventsDeadline,shallowEqual,useClock:()=>NOW,fundsHistory:{},page:h.page,timeRange:()=>null,prefs:()=>h.settings,boardPeriod:h.period,read:null as any};
    const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');runInNewContext(ts.transpileModule(source.slice(source.indexOf('function usePeriodHistory('),source.indexOf('export function useHistory('))+'\nglobalThis.read=usePeriodHistory;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
    let renderedWork:any;
    render=()=>{cursor=0;dirty=false;context.read(loader);renderedWork=h.period.moneyWorkAt(wallet,NOW);};
    const pump=async()=>{for(let i=0;i<10;i++){await settle();if(dirty)render();}};render();
    const financial=h.period.getFinancialProjectionRevision('budget');
    h.requests.length=0;
    h.store.links.mutate(h.owner,'create',null,{clientId:'opencode',deviceId:null,route:null,sourceId:wallet,from:NOW-H,to:null,expectedRevision:h.store.links.revision(h.owner),requestId:randomUUID()},NOW);h.events.flush();await pump();
    assert.ok(h.period.moneyWorkAt(wallet,NOW),'common accounting computed money work');
    assert.deepEqual(renderedWork,h.period.moneyWorkAt(wallet,NOW),'the actual history subscriber renders newly available work');
    assert.equal(h.pool.activeFlights,0);assert.equal(loader.get().loading,false);
    assert.equal(h.period.getFinancialProjectionRevision('budget'),financial,'work leaves financial indices unchanged');
    const readsAfter=loaderReads,historyAfter=loader.get().history;h.requests.length=0;
    h.store.creditWork(h.device,NOW-30_000,NOW,[{client:'opencode',source:null,origin:'terminal',startedAt:NOW-M,project:'Linked benchmark',folder:'',identity:{kind:'stable',sessionId:'e'.repeat(32)}}]);h.events.flush();await pump();
    assert.equal(renderedWork.activeMs,30_000);
    assert.equal(loaderReads,readsAfter,'work reuses the financial drawing tiles');assert.equal(loader.get().history,historyAfter);
    assert.equal(h.period.getFinancialProjectionRevision('budget'),financial);
    assert.equal(h.requests.length,1,'work updates share one period request');
  }finally{stops.forEach(stop=>stop());stop?.();loader?.close();await h.close();}
});
