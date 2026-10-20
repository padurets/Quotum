import assert from 'node:assert/strict';
import {cards,people,DAY} from '../demo/model.js';
import type {Stand} from '../demo/setup.js';
import {workSpans,type WorkTrace} from '../server/domain/periodWork.js';
import {expandPeriod} from '../server/domain/periodWire.js';
import {cellOf,cellStart} from '../server/domain/history.js';
import type {History} from '../server/domain/history.js';
import type {PeriodRequest,PeriodReply} from '../server/domain/periodRead.js';
import {ObservedWork} from './observed.js';
import {openTab,type Browser,type Cdp} from './cdp.js';
import {historyPoolReceiptScript} from './historyPoolReceipt.js';
import {probeScript,type Reading} from './probe.js';

/** Compact fixed summaries include exact neighboring-position programs, even on a one-cell read.
 * The mixed analytics reference measured 33/146 KiB cold and 28/145 KiB warm at 24h/30d.
 * The controlled browser profile measured 42/156 KiB for a selected update and 480/1185 KiB
 * combined at 24h/30d, with at most 333k preparation advances across a phase.
 * Dense canonical work measured 539k advances per coherent C/S update at 30d; held news
 * legitimately completes two updates (1.079m advances). The preparation cap is per update;
 * all attempted reads and their raw preparation counts remain in each phase's report.
 * These independent caps retain the hard 7 MiB body,
 * 76 KiB request, 15 MiB pool and two-slot ceilings. Live budgets are unchanged. */
export const FIXED_ACTIVITY_BUDGET={request:76*1024,body:7*1024*1024,pool:15*1024*1024,
  subset24h:256*1024,subset30d:1024*1024,combined24h:1024*1024,combined30d:4*1024*1024,advancesPerUpdate:1_000_000} as const;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
type Numbers={agentMs:number;activeMs:number;agents:number};
type Body={id:string;subset:boolean;requestBytes:number;decoded:number;encoded:number;cancelled:boolean;body:PeriodRequest};
type Sample={numbers:Numbers;activity:History['activity'];tiles:[number,number][];bytes:number;flights:number;subsetFlights:number;advances:number;subsetAdvances:number;preparationMs:number;failedReservations:number;preferenceWrites:number};

/** Independent endpoint sweep: no group aggregate, PeriodActivity or new selection helper. */
export function activityOracle(trace:WorkTrace,from:number,to:number):Numbers {
  const events:[number,number][]=[],identities=new Set<string>();let agentMs=0;
  for(const [id,start,end] of workSpans(trace)){
    const a=Math.max(from,trace.anchor+start),b=Math.min(to,trace.anchor+end);if(b<=a)continue;
    agentMs+=b-a;identities.add(trace.refs[id].identityRef??trace.refs[id].ref);events.push([a,1],[b,-1]);
  }
  events.sort((a,b)=>a[0]-b[0]);let activeMs=0,previous=from,count=0;
  for(const [at,delta] of events){if(count)activeMs+=at-previous;count+=delta;previous=at;}
  return {agentMs,activeMs,agents:identities.size};
}

function observationScript(period:string){return historyPoolReceiptScript()+`;(() => {
  localStorage.setItem('quotum.locale','en');localStorage.setItem('quotum.prefs',JSON.stringify({range:${JSON.stringify(period)},horizon:'1d',activityBy:'project'}));
  const original=window.__quotumInspectHistoryPool,ids=new WeakMap();let serial=0,pool,stats;
  const reset=()=>stats={bytes:0,flights:0,subsetFlights:0,advances:0,subsetAdvances:0,preparationMs:0,failedReservations:0,preferenceWrites:0};reset();
  const save=Storage.prototype.setItem;Storage.prototype.setItem=function(key,...args){if(key==='quotum.prefs')stats.preferenceWrites++;return save.call(this,key,...args);};
  const reader=()=>[...pool.members].find(m=>m.tiles instanceof Map&&typeof m.numbers==='function');
  window.__quotumInspectHistoryPool=p=>{original(p);pool=p;
    const reserve=p.reserve;p.reserve=function(...args){const result=reserve.apply(this,args);stats.bytes=Math.max(stats.bytes,this.estimatedBytes);if(!result)stats.failedReservations++;return result;};
    const request=p.request;p.request=function(owner,flight,start,cancel){return request.call(this,owner,flight,()=>{stats.flights=Math.max(stats.flights,this.active.size);stats.subsetFlights=Math.max(stats.subsetFlights,[...this.active.values()].filter(f=>typeof f.owner.numbers==='function').length);start();},cancel);};
  };
  window.__quotumInspectPreparations=scheduler=>{const replace=scheduler.replace;scheduler.replace=function(owner,work,...rest){const next=work.next;work.next=function(...args){const start=performance.now();try{stats.advances++;if(reader()?.owner===owner)stats.subsetAdvances++;return next.apply(this,args);}finally{stats.preparationMs+=performance.now()-start;}};return replace.call(this,owner,work,...rest);};};
  window.__quotumFixedActivity={reset,reader,status:()=>{const r=reader(),s=r?.get();return {registered:!!r,error:s?.error,loading:s?.loading,model:!!s?.model,flights:pool.activeFlights,bytes:pool.estimatedBytes};},holdDispatch:()=>{const r=reader(),schedule=r.schedule;r.schedule=()=>{};return window.__quotumFixedActivity.resumeDispatch=()=>{r.schedule=schedule;schedule.call(r);};},sample:()=>{const r=reader(),a=r?.numbers(Date.now());return a?{...stats,numbers:{agentMs:a.agentMs,activeMs:a.activeMs,agents:a.agents},activity:a,tiles:[...r.tiles].map(([key,tile])=>{if(!ids.has(tile))ids.set(tile,++serial);return[key,ids.get(tile)];})}:null;},ready:()=>{const r=reader();return !!r?.get().model&&!r.flight&&pool.activeFlights===0&&!document.querySelector('.chart>svg[data-draw-ready="false"],.activity.is-loading,.history.is-loading');}};
})();`;}

/** Physical requests are retained through cancellation and their final response-body accounting. */
function traffic(cdp:Cdp){
  const bodies:Body[]=[],active=new Map<string,Body>(),pending=new Set<Promise<unknown>>(),errors:unknown[]=[];
  cdp.on<{requestId:string;request:{url:string;postData?:string}}>('Network.requestWillBeSent',event=>{
    if(!/\/api\/boards\/[^/]+\/period(?:\/sessions)?$/.test(new URL(event.request.url).pathname))return;
    const body=JSON.parse(event.request.postData??'{}') as PeriodRequest;
    const subset=body.quota?.sources==='[]'&&body.quota?.meters==='[]'&&body.quota?.evidence==='skip'&&!!body.sessions&&!body.values&&!body.budget&&!body.funds&&!body.sourceWork;
    const row={id:event.requestId,subset,requestBytes:Buffer.byteLength(event.request.postData??''),decoded:0,encoded:0,cancelled:false,body};bodies.push(row);active.set(row.id,row);
  });
  cdp.on<{requestId:string;dataLength:number;encodedDataLength:number}>('Network.dataReceived',event=>{const row=active.get(event.requestId);if(row){row.decoded+=event.dataLength;row.encoded+=event.encodedDataLength;}});
  cdp.on<{requestId:string}>('Network.loadingFailed',event=>{const row=active.get(event.requestId);if(row){row.cancelled=true;active.delete(row.id);}});
  cdp.on<{requestId:string}>('Network.loadingFinished',event=>{
    const row=active.get(event.requestId);if(!row)return;active.delete(row.id);
    const work=cdp.send<{body:string;base64Encoded:boolean}>('Network.getResponseBody',{requestId:row.id}).then(result=>{row.decoded=result.base64Encoded?Buffer.from(result.body,'base64').length:Buffer.byteLength(result.body);}).catch(error=>{if(!row.cancelled)errors.push(error);});
    pending.add(work);void work.finally(()=>pending.delete(work));
  });
  return {bodies,active,pending,errors};
}

/** Actual mounted widget, production reader/HTTP parser/pool and one synthetic interval writer. */
export async function fixedActivity(browser:Browser,stand:Stand){
  const owner=stand.people.get(people(stand.set)[0].id)!,card=cards(stand.set).find(card=>card.id==='antigravity')!,reports:Record<string,unknown>[]=[];
  for(const days of [1,30]){
    const actor=await ObservedWork.open(owner,card),tab=await openTab(browser),{cdp}=tab;
    const bodies=traffic(cdp),selection={mode:'range' as const,from:actor.floorAt+1000-days*DAY+123,to:actor.floorAt+1000};
    try{
      await pause(Math.max(0,selection.to+10-Date.now()));
      await cdp.send('Network.enable');await cdp.send('Page.enable');await cdp.send('Performance.enable');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:probeScript()});
      await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      const split=owner.cookie.indexOf('=');await cdp.send('Network.setCookie',{name:owner.cookie.slice(0,split),value:owner.cookie.slice(split+1),url:owner.base,httpOnly:true,sameSite:'Lax'});
      await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:observationScript(days===1?'24h':'30d')});
      await cdp.send('Page.navigate',{url:owner.base+`/?from=${selection.from}&to=${selection.to}`});
      const waitFor=async(test:string)=>{const deadline=Date.now()+30_000;while(!await cdp.evaluate<boolean>(test)){if(Date.now()>deadline){const state=await cdp.evaluate('window.__quotumFixedActivity?.status()').catch(()=>null);throw Error(`fixed Activity ${days}d did not become coherent: ${JSON.stringify(state)}`);}await pause(30);}};
      await waitFor(`document.querySelectorAll('.activity .legend-item').length>2&&!document.querySelector('.activity.is-loading')`);
      const excluded=await cdp.evaluate<string>(`(()=>{const button=[...document.querySelectorAll('.activity .legend-item')].find(b=>!b.textContent.includes('Observed benchmark'));const key=button.dataset.seriesKey.slice('activity:project:'.length);button.click();return JSON.parse(key);})()`);
      const settled=()=>waitFor(`window.__quotumFixedActivity?.ready()===true`);
      await settled();
      const sample=()=>cdp.evaluate<Sample>('window.__quotumFixedActivity.sample()');
      const baseline=await sample();assert.ok(baseline.activity.known);assert.ok(baseline.tiles.length<=8);
      const geometry=()=>cdp.evaluate<string>(`JSON.stringify([...document.querySelectorAll('.widgets>.widget,.activity .chart,.activity .activity-stack')].map(e=>{const b=e.getBoundingClientRect();return[b.x,b.y,b.width,b.height,e.getAttribute('d')];}))`);
      const beforeHover=await geometry(),hoverStart=bodies.bodies.length;
      await cdp.evaluate('window.__quotumFixedActivity.reset();__quotumBench.reset()');
      await cdp.evaluate(`(()=>{const b=document.querySelector('.activity .legend-item[aria-pressed="true"]');b.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));})()`);
      await pause(40);
      const hovered=await sample(),paint=await cdp.evaluate<Reading>('__quotumBench.read()');
      assert.equal(bodies.bodies.length,hoverStart,'hover cannot request history');assert.equal(hovered.advances,0,'hover cannot prepare paths or accounting');assert.equal(hovered.preferenceWrites,0);assert.equal(await geometry(),beforeHover);
      assert.ok(!paint.renders.some(part=>part.widget==='activity'&&part.kind==='chart'),'hover cannot render Activity or its plot');
      await cdp.evaluate(`document.querySelector('.activity .legend-item[aria-pressed="true"]').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}))`);
      const subsetRequest=[...bodies.bodies].reverse().find(body=>body.subset)!.body;
      let referenceReceipt={requests:0,requestBytes:0,decodedBytes:0,encodedBytes:0};
      const reference=async()=>{
        const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:Date.now()-selection.from+60_000},evaluatedAt:Date.now(),workFilter:subsetRequest.workFilter,sessions:{}};
        const body=JSON.stringify(request),response=await fetch(`${owner.base}/api/boards/${owner.personalBoard}/period`,{method:'POST',headers:{cookie:owner.cookie,origin:new URL(process.env.QUOTUM_PUBLIC_URL??owner.base).origin,'content-type':'application/json','accept-encoding':'identity'},body,signal:AbortSignal.timeout(12_000)});
        assert.equal(response.status,200,'raw interval reference');assert.ok(!response.headers.get('content-encoding'));
        const text=await response.text(),bytes=Buffer.byteLength(text);assert.ok(bytes<=FIXED_ACTIVITY_BUDGET.body);
        referenceReceipt.requests++;referenceReceipt.requestBytes+=Buffer.byteLength(body);referenceReceipt.decodedBytes+=bytes;referenceReceipt.encodedBytes+=bytes;
        const reply=expandPeriod(JSON.parse(text) as PeriodReply);
        assert.equal(reply.sessions?.state,'complete');return reply.sessions!.state==='complete'?reply.sessions!.value:null!;
      };
      const check=async()=>{
        const current=await sample(),trace=await reference();assert.deepEqual(current.numbers,activityOracle(trace,selection.from,selection.to));
        for(const [at,activeMs,agentMs,agents] of current.activity.cells)assert.deepEqual({activeMs,agentMs,agents},activityOracle(trace,Math.max(selection.from,at),Math.min(selection.to,at+current.activity.barMs)));
        for(let at=cellStart(selection.from,current.activity.barMs);at<selection.to;at+=current.activity.barMs){
          const expected=activityOracle(trace,Math.max(selection.from,at),Math.min(selection.to,at+current.activity.barMs));
          if(expected.agentMs)assert.deepEqual(current.activity.cells.find(([start])=>start===at)?.slice(1),[expected.activeMs,expected.agentMs,expected.agents],'every nonempty reference bar must be present');
        }
        return current;
      };
      const phase=async(name:string,run:()=>Promise<void>,expected:number|null)=>{
        const start=bodies.bodies.length;await cdp.evaluate('window.__quotumFixedActivity.reset()');const at=Date.now();
        referenceReceipt={requests:0,requestBytes:0,decodedBytes:0,encodedBytes:0};
        const metrics=async()=>{const {metrics}=await cdp.send<{metrics:{name:string;value:number}[]}>('Performance.getMetrics');return Object.fromEntries(metrics.map(metric=>[metric.name,metric.value]));};
        const before=await metrics();
        await run();
        if(expected){const deadline=Date.now()+30_000;while(bodies.bodies.slice(start).filter(row=>row.subset).length<expected){if(Date.now()>deadline)throw Error(name+' did not dispatch its subset reads');await pause(30);}}
        await pause(350);await settled();while(bodies.active.size||bodies.pending.size){await Promise.allSettled([...bodies.pending]);await pause(20);}
        const coherentAt=Date.now();
        const current=await check(),reads=bodies.bodies.slice(start),subset=reads.filter(row=>row.subset);
        const after=await metrics();assert.deepEqual(bodies.errors,[],'every completed response must remain accounted');
        assert.ok(Number.isFinite(after.ScriptDuration-before.ScriptDuration)&&Number.isFinite(after.TaskDuration-before.TaskDuration));
        const decoded=reads.reduce((n,row)=>n+row.decoded,0),selectedBytes=subset.reduce((n,row)=>n+row.decoded,0);
        const preparationLimit=FIXED_ACTIVITY_BUDGET.advancesPerUpdate*Math.max(1,subset.length);
        const report={days,name,excluded,requests:reads.length,subset:subset.length,preparationLimit,requestBytes:reads.reduce((n,row)=>n+row.requestBytes,0),decoded,selectedBytes,encoded:reads.reduce((n,row)=>n+row.encoded,0),cancelled:reads.filter(row=>row.cancelled).length,coherentMs:coherentAt-at,verificationMs:Date.now()-coherentAt,reference:referenceReceipt,scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,taskMs:(after.TaskDuration-before.TaskDuration)*1000,...current,numbers:current.numbers,activity:undefined,tiles:undefined};
        reports.push(report);console.error('bench: fixed Activity '+JSON.stringify(report));
        if(expected!==null)assert.equal(subset.length,expected,name+' subset requests');
        assert.ok(current.flights<=2&&current.subsetFlights<=1&&current.bytes<=FIXED_ACTIVITY_BUDGET.pool&&!current.failedReservations&&current.tiles.length<=8);
        assert.ok(current.advances<=preparationLimit);
        if(expected&&expected>0)assert.ok(current.advances>0&&current.subsetAdvances>0,'real C/S preparation must be observed');
        for(const row of reads)assert.ok(row.requestBytes<=FIXED_ACTIVITY_BUDGET.request&&row.decoded<=FIXED_ACTIVITY_BUDGET.body);
        if(expected===1){assert.ok(selectedBytes<=(days===1?FIXED_ACTIVITY_BUDGET.subset24h:FIXED_ACTIVITY_BUDGET.subset30d));assert.ok(decoded<=(days===1?FIXED_ACTIVITY_BUDGET.combined24h:FIXED_ACTIVITY_BUDGET.combined30d));}
        return {current,subset};
      };
      const isolated=await phase('isolated',async()=>{await actor.through(actor.floorAt+100);},1);
      const cell=cellOf(days*DAY),dirty=cellStart(actor.floorAt,cell);
      assert.equal(Number(isolated.subset[0].body.quota!.from),dirty);
      assert.deepEqual(isolated.subset[0].body.selection,selection);
      const clean=baseline.tiles.filter(([key])=>(key+1)*cell*60<=dirty);
      assert.ok(clean.length);for(const row of clean)assert.deepEqual(isolated.current.tiles.find(([key])=>key===row[0]),row);
      assert.equal(isolated.current.activity.barMs,baseline.activity.barMs);
      await phase('burst before dispatch',async()=>{
        await cdp.evaluate('window.__quotumFixedActivity.holdDispatch()');
        await actor.through(actor.floorAt+200);await actor.through(actor.floorAt+300);await actor.through(actor.floorAt+400);await pause(350);
        await cdp.evaluate('window.__quotumFixedActivity.resumeDispatch()');
      },1);
      const intercepted=async(trigger:()=>Promise<void>,whileHeld:()=>Promise<void>)=>{
        let release!:(event:{requestId:string;networkId?:string})=>void;
        const paused=new Promise<{requestId:string;networkId?:string}>(yes=>{release=yes;}),deadline=setTimeout(()=>release({requestId:''}),10_000);
        let held=false;
        const intercept=(event:{requestId:string;networkId?:string;request:{postData?:string}})=>{
          const body=JSON.parse(event.request.postData??'{}') as PeriodRequest;
          if(!held&&body.quota?.sources==='[]'&&body.quota?.evidence==='skip'&&body.sessions){held=true;release(event);}
          else void cdp.send('Fetch.continueResponse',{requestId:event.requestId}).catch(()=>{});
        };
        cdp.on('Fetch.requestPaused',intercept);
        await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/boards/*/period',requestStage:'Response'}]});
        try{
          await trigger();const event=await paused;assert.ok(event.requestId,'a real subset response must be held');
          const payload=await cdp.send<{body:string;base64Encoded:boolean}>('Fetch.getResponseBody',{requestId:event.requestId});
          const row=bodies.bodies.find(row=>row.id===event.networkId);assert.ok(row);row.decoded=payload.base64Encoded?Buffer.from(payload.body,'base64').length:Buffer.byteLength(payload.body);
          await whileHeld();await cdp.send('Fetch.continueResponse',{requestId:event.requestId}).catch(()=>{});
        }finally{clearTimeout(deadline);await cdp.send('Fetch.disable');cdp.off('Fetch.requestPaused',intercept);}
      };
      const during=await phase('news during response',()=>intercepted(async()=>{await actor.through(actor.floorAt+500);},async()=>{
        await actor.through(actor.floorAt+600);await pause(350);
        assert.equal(await cdp.evaluate('window.__quotumFixedActivity.sample()'),null,'pending news cannot borrow the held summary');
      }),2);
      assert.ok(during.current.subsetFlights<=1);
      const generations=await phase('cancelled A to B to A',()=>intercepted(async()=>{await cdp.evaluate(`window.__quotumFixedActivity.reader().changed(${actor.floorAt})`);},async()=>{
        await cdp.evaluate(`document.querySelectorAll('.activity .legend-item')[1].click()`);
        await cdp.evaluate(`document.querySelectorAll('.activity .legend-item')[1].click()`);
        assert.equal(await cdp.evaluate('window.__quotumFixedActivity.sample()'),null);
      }),null);
      assert.ok(generations.subset.length>=2&&generations.subset.length<=3,'cancelled attempts remain counted');
      await phase('through upper bound',async()=>{await actor.through(selection.to);},1);
      await phase('outside range',async()=>{await actor.through(selection.to+100);},0);
      const receipt=await cdp.evaluate<{status:string;members:{kind:string}[]}>(`(()=>{__quotumHistoryPoolReceipt.mark(2,3);return __quotumHistoryPoolReceipt.read();})()`);
      assert.equal(receipt.status,'complete');assert.ok(receipt.members.some(member=>member.kind==='activity'));
    }finally{await tab.close();await actor.close();}
  }
  return {reports,problems:[] as string[]};
}
