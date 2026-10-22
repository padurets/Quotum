import assert from 'node:assert/strict';
import {cards,people,DAY} from '../demo/model.js';
import type {Stand} from '../demo/setup.js';
import {workSpans,type WorkTrace} from '../server/domain/periodWork.js';
import {expandPeriod} from '../server/domain/periodWire.js';
import {cellOf,cellStart,MAX_READ_TILES,TILE_CELLS} from '../server/domain/history.js';
import type {History} from '../server/domain/history.js';
import type {PeriodRequest,PeriodReply} from '../server/domain/periodRead.js';
import {defaultFilters} from '../server/domain/dataFilters.js';
import {ObservedWork} from './observed.js';
import {openTab,type Browser,type Cdp} from './cdp.js';
import {historyPoolReceiptScript} from './historyPoolReceipt.js';
import {historyIdentityScript} from './historyTrafficBrowser.js';
import {probeScript,type Reading} from './probe.js';

/** The supported shared-filter path keeps the existing combined transport/preparation
 * ceilings. Emphasis owns no reader and receives no extra-read allowance. */
export const FIXED_ACTIVITY_BUDGET={request:76*1024,body:7*1024*1024,pool:15*1024*1024,
  combined24h:1024*1024,combined30d:4*1024*1024,advancesPerUpdate:1_000_000} as const;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
type Numbers={agentMs:number;activeMs:number;agents:number};
type Body={id:string;requestBytes:number;decoded:number;encoded:number;cancelled:boolean;body:PeriodRequest};
type Sample={numbers:Numbers;activity:History['activity'];tiles:[number,number,number][];bytes:number;flights:number;advances:number;jobsStarted:number;fetches:number;preparationMs:number;failedReservations:number;preferenceWrites:number};

/** Each update owns one shared work attempt; only a cells-only drawing follow-up may overlap it. */
export function assertActivityOverlap(requests:readonly PeriodRequest[],updates:number) {
  const work=requests.filter(body=>body.sessions),drawing=requests.filter(body=>!body.sessions);
  assert.equal(work.length,updates,'overlapping updates cannot add another work reader');
  assert.ok(drawing.length<=1,'overlapping updates allow at most one drawing follow-up');
  for(const body of drawing)assertDrawing(body,work[0].selection);
}

function assertDrawing(body:PeriodRequest,selection:PeriodRequest['selection']) {
  assert.equal(body.quota?.evidence,'skip','the follow-up reads drawing cells only');
  assert.notEqual(body.quota?.cells,'skip');
  assert.notEqual(body.quota?.work,'1');
  assert.ok(!body.budget&&!body.funds&&!body.values&&!body.facets&&!body.calendar&&!body.sourceWork);
  assert.deepEqual(body.selection,selection);
}

/** Fixed fine grids batch missing tiles; coarse grids decode one tile at a time. */
export function assertActivityCancellation(requests:readonly PeriodRequest[],selection:PeriodRequest['selection']) {
  const work=requests.filter(body=>body.sessions),drawing=requests.filter(body=>!body.sessions);
  assert.ok(work.length>=2&&work.length<=3,'cancelled shared-work attempts remain counted');
  assert.ok(drawing.length<=MAX_READ_TILES,'replacement drawing stays within the existing tile window');
  assert.ok(selection.mode==='range');
  const cell=cellOf(selection.to-selection.from),span=cell*TILE_CELLS;
  for(const body of work)assert.deepEqual(body.selection,selection);
  for(const body of drawing){
    assertDrawing(body,selection);
    assert.equal(Number(body.quota!.cell),cell);
    const from=Number(body.quota!.from),to=Number(body.quota!.to);
    assert.ok(Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&to>from);
    assert.ok(from%cell===0&&to%cell===0,'drawing endpoints align with their cells');
    const tiles=Math.floor((to-1)/span)-Math.floor(from/span)+1;
    assert.ok(tiles<=(cell>=3_600_000?1:MAX_READ_TILES),'a drawing read stays within its fine or coarse tile batch');
    assert.ok(from>=Math.floor(selection.from/span)*span-span&&to<=Math.ceil(selection.to/span)*span+span,'only the selected strip and its buffer are read');
  }
}

/** Work outside the fixed interval can refresh the calendar, but never its session ledger. */
export function assertActivityOutside(requests:readonly PeriodRequest[],intent:Pick<PeriodRequest,'selection'|'workFilter'>) {
  assert.ok(requests.length<=1,'outside work allows at most one shared calendar refresh');
  for(const body of requests){
    assert.ok(body.calendar,'outside work must not start an independent chart read');
    assert.ok(!body.sessions&&!body.budget&&!body.funds&&!body.values&&!body.facets&&!body.sourceWork);
    assert.notEqual(body.quota?.work,'1');
    assert.deepEqual(body.selection,intent.selection);
    assert.deepEqual(body.workFilter,intent.workFilter);
  }
}

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

export function fixedActivityScript(period:string){return historyPoolReceiptScript()+';'+historyIdentityScript()+`;(() => {
  localStorage.setItem('quotum.locale','en');localStorage.setItem('quotum.prefs',JSON.stringify({range:${JSON.stringify(period)},horizon:'1d',activityBy:'project',filtersVisible:true}));
  const original=window.__quotumInspectHistoryPool,ids=new WeakMap(),news=new Set();let serial=0,pool,scheduler,stats;
  const reset=()=>stats={bytes:0,flights:0,advances:0,jobsStarted:0,fetches:0,preparationMs:0,failedReservations:0,preferenceWrites:0};reset();
  const fetch=window.fetch;window.fetch=function(...args){stats.fetches++;return fetch.apply(this,args);};
  const save=Storage.prototype.setItem;Storage.prototype.setItem=function(key,...args){if(key==='quotum.prefs')stats.preferenceWrites++;return save.call(this,key,...args);};
  const reader=()=>[...pool.members].find(m=>m.transport&&typeof m.activityAt==='function');
  const chart=()=>[...pool.members].find(m=>m.scope==='quota'&&m.grids instanceof Map);
  window.__quotumInspectHistoryPool=p=>{original(p);pool=p;
    const reserve=p.reserve;p.reserve=function(...args){const result=reserve.apply(this,args);stats.bytes=Math.max(stats.bytes,this.estimatedBytes);if(!result)stats.failedReservations++;return result;};
    const request=p.request;p.request=function(owner,flight,start,cancel){return request.call(this,owner,flight,()=>{stats.flights=Math.max(stats.flights,this.active.size);start();},cancel);};
  };
  window.__quotumInspectPreparations=value=>{scheduler=value;const replace=scheduler.replace;scheduler.replace=function(owner,work,...rest){stats.jobsStarted++;const next=work.next;work.next=function(...args){const start=performance.now();try{stats.advances++;return next.apply(this,args);}finally{stats.preparationMs+=performance.now()-start;}};return replace.call(this,owner,work,...rest);};};
  const status=()=>{const p=reader(),h=chart()?.get().history,s=p?.activityProjectionState(h),t=p?.transport;return {registered:!!p,error:s?.error,loading:p?.get().loading,ready:s?.ready,calendarPending:!!p?.calendar.demand(),transportPending:!!(t?.scheduled||t?.queue.length||t?.flights.size),preparing:scheduler?.size,flights:pool.activeFlights,bytes:pool.estimatedBytes,members:pool.members.size};};
  window.__quotumFixedActivity={reset,reader,status,observeNews:()=>{const p=reader(),changed=p.changed;p.changed=function(event,...args){if(event?.type==='hub'&&event.event.type==='history')news.add(event.event.data.workSince);return changed.call(this,event,...args);};},heardSince:at=>news.has(at),holdDispatch:()=>{const t=reader().transport,schedule=t.schedule;t.schedule=()=>{};return window.__quotumFixedActivity.resumeDispatch=()=>{t.schedule=schedule;schedule.call(t);};},sample:()=>{
    const p=reader(),c=chart(),h=c?.get().history;if(!h||!p.activityProjectionState(h).ready)return null;
    const a=p.project(h,'quota',Date.now()).activity;
    return {...stats,numbers:{agentMs:a.agentMs,activeMs:a.activeMs,agents:a.agents},activity:a,tiles:[...c.grids.values()].flatMap(grid=>[...grid.values()].map(tile=>{if(!ids.has(tile))ids.set(tile,++serial);return[tile.from,tile.to,ids.get(tile)];}))};
  },ready:()=>{const s=status();return !!s.ready&&!s.calendarPending&&!s.transportPending&&s.flights===0&&s.preparing===0&&!document.querySelector('.chart>svg[data-draw-ready="false"],.activity.is-loading,.history.is-loading,.budget-history.is-loading,.subscription-funds.is-loading');}};
})();`;}

/** Physical requests are retained through cancellation and their final response-body accounting. */
function traffic(cdp:Cdp){
  const bodies:Body[]=[],active=new Map<string,Body>(),pending=new Set<Promise<unknown>>(),errors:unknown[]=[];
  cdp.on<{requestId:string;request:{url:string;postData?:string}}>('Network.requestWillBeSent',event=>{
    if(!/\/api\/boards\/[^/]+\/period(?:\/sessions)?$/.test(new URL(event.request.url).pathname))return;
    const body=JSON.parse(event.request.postData??'{}') as PeriodRequest;
    const row={id:event.requestId,requestBytes:Buffer.byteLength(event.request.postData??''),decoded:0,encoded:0,cancelled:false,body};bodies.push(row);active.set(row.id,row);
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

/** Actual mounted widget and shared work filters, including late work and retired responses. */
export async function fixedActivity(browser:Browser,stand:Stand){
  const owner=stand.people.get(people(stand.set)[0].id)!,card=cards(stand.set).find(card=>card.id==='antigravity')!,reports:Record<string,unknown>[]=[];
  // Earlier money scenarios save a one-account selection. This scenario needs
  // the stand's full resource cohort before applying its own project filter.
  await owner.saveFilters(owner.personalBoard,defaultFilters());
  for(const days of [1,30]){
    const actor=await ObservedWork.open(owner,card),tab=await openTab(browser),{cdp}=tab;
    const bodies=traffic(cdp),selection={mode:'range' as const,from:actor.floorAt+1000-days*DAY+123,to:actor.floorAt+1000};
    try{
      await pause(Math.max(0,selection.to+10-Date.now()));
      await cdp.send('Network.enable');await cdp.send('Page.enable');await cdp.send('Performance.enable');
      await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
      await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:probeScript()});
      await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      const split=owner.cookie.indexOf('=');await cdp.send('Network.setCookie',{name:owner.cookie.slice(0,split),value:owner.cookie.slice(split+1),url:owner.base,httpOnly:true,sameSite:'Lax'});
      await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:fixedActivityScript(days===1?'24h':'30d')});
      await cdp.send('Page.navigate',{url:owner.base+`/?from=${selection.from}&to=${selection.to}`});
      const waitFor=async(test:string,deadline=Date.now()+30_000)=>{while(!await cdp.evaluate<boolean>(test)){if(Date.now()>deadline){const state=await cdp.evaluate('window.__quotumFixedActivity?.status()').catch(()=>null);throw Error(`fixed Activity ${days}d did not become coherent: ${JSON.stringify(state)}`);}await pause(30);}};
      await waitFor(`document.querySelectorAll('.activity .legend-item').length>2&&!document.querySelector('.activity.is-loading')`);
      const filterRoot=`document.querySelector('[data-filter="filters.projects"]')`;
      await cdp.evaluate(`${filterRoot}.querySelector('button').click()`);
      await waitFor(`${filterRoot}.querySelectorAll('[role="switch"]').length>2`);
      const excluded=await cdp.evaluate<string>(`(()=>{const button=[...${filterRoot}.querySelectorAll('[role="switch"]')].find(b=>!b.textContent.includes('Observed benchmark'));const name=button.querySelector('span').textContent;button.click();return name;})()`);
      await cdp.evaluate(`${filterRoot}.querySelector('button').click()`);
      const settled=async(deadline=Date.now()+30_000)=>{
        await waitFor(`window.__quotumFixedActivity?.ready()===true`,deadline);
        await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await waitFor(`window.__quotumFixedActivity?.ready()===true`,deadline);
      };
      await settled();
      console.error('bench: fixed Activity settled '+JSON.stringify(await cdp.evaluate('window.__quotumFixedActivity.status()')));
      const sample=()=>cdp.evaluate<Sample>('window.__quotumFixedActivity.sample()');
      const baseline=await sample();assert.ok(baseline.activity.known);assert.ok(baseline.tiles.length<=8);
      await cdp.evaluate('window.__quotumFixedActivity.observeNews()');
      const selectedFilter=[...bodies.bodies].reverse().find(row=>row.body.workFilter)!.body.workFilter;assert.ok(selectedFilter);
      assert.equal(await cdp.evaluate('window.__quotumFixedActivity.status().members'),4,'emphasis adds no history reader');
      // SVG viewport bounds lose float precision after native focus scrolls the page.
      // Its own bounds and matrix stay exact; CSS boxes use document coordinates.
      const geometry=()=>cdp.evaluate<string>(`JSON.stringify([...document.querySelectorAll('.widgets>.widget,.panel[data-time="chart"] .chart,.panel[data-time="chart"]>.legend,.activity-info,.panel[data-time="chart"] .plot-layer,.panel[data-time="chart"] .plot-move,.panel[data-time="chart"] .slides,.activity-stack,[data-series] path,.plan-line,.forecast-line')].map(e=>{
        const svg=e instanceof SVGGraphicsElement,b=svg?e.getBBox():e.getBoundingClientRect(),m=svg?e.getCTM():null;
        return[svg?'svg':'box',b.x+(svg?0:scrollX),b.y+(svg?0:scrollY),b.width,b.height,e.getAttribute('d'),e.getAttribute('transform'),e.style.transform,m&&[m.a,m.b,m.c,m.d,m.e,m.f]];
      }))`);
      const beforeHover=await geometry(),hoverStart=bodies.bodies.length;
      await cdp.evaluate('window.__quotumFixedActivity.reset();__quotumBench.reset()');
      console.error(`bench: ${days}d emphasis matrix and native keys`);
      const emphasis=await cdp.evaluate<{name:string;matrix:number[][]}[]>(`(async()=>{
        const reports=[];
        for(const panel of document.querySelectorAll('.panel[data-time="chart"]')){
          const buttons=[...panel.querySelectorAll('.legend-item')];if(buttons.length<3)throw Error('emphasis fixture needs three series in '+panel.querySelector('h2').textContent+': '+buttons.length);
          const pause=async()=>{
            const deadline=performance.now()+1000;
            do{
              await new Promise(requestAnimationFrame);
              if(!buttons.some(button=>button.getAnimations().some(animation=>animation.pending||animation.playState==='running')))return;
            }while(performance.now()<deadline);
            throw Error('legend opacity transition did not settle');
          };
          const matrix=[],read=()=>buttons.slice(0,3).map(button=>Number(getComputedStyle(button).opacity));
          const assert=(expected)=>{const got=read();if(got.some((value,i)=>Math.abs(value-expected[i])>.001))throw Error('emphasis matrix '+JSON.stringify({got,expected}));matrix.push(got);};
          const hover=button=>button.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
          const leave=button=>button.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}));
          buttons[0].click();buttons[1].click();await pause();assert([1,1,.4]);
          hover(buttons[2]);await pause();assert([.65,.65,1]);if(buttons[2].getAttribute('aria-pressed')!=='false')throw Error('preview changed membership');
          leave(buttons[2]);await pause();assert([1,1,.4]);hover(buttons[0]);await pause();assert([1,.65,.4]);
          buttons[0].click();await pause();assert([1,.65,.4]);leave(buttons[0]);await pause();assert([.4,1,.4]);
          buttons[1].click();await pause();assert([1,1,1]);reports.push({name:panel.querySelector('h2').textContent,matrix});
        }return reports;
      })()`);
      assert.equal(emphasis.length,5);
      const key=async(key:string,code:string,windowsVirtualKeyCode:number)=>{
        const text=key==='Enter'?'\r':key===' '?' ':undefined;
        for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode,text:type==='keyDown'?text:undefined});
      };
      for(let index=0;index<5;index++){
        await cdp.evaluate(`document.querySelectorAll('.panel[data-time="chart"]')[${index}].querySelector('.legend-item').focus()`);
        await key('Enter','Enter',13);await key('Tab','Tab',9);await key(' ','Space',32);
        const pressed=await cdp.evaluate<string[]>(`[...document.querySelectorAll('.panel[data-time="chart"]')[${index}].querySelectorAll('.legend-item')].slice(0,3).map(button=>button.getAttribute('aria-pressed'))`);
        assert.deepEqual(pressed,['true','true','false'],'native Enter and Space independently choose two series');
        await key('Escape','Escape',27);
        await cdp.evaluate(`(()=>{document.activeElement.blur();const panel=document.querySelectorAll('.panel[data-time="chart"]')[${index}];for(const button of panel.querySelectorAll('.legend-item[aria-pressed="true"]'))button.click();})()`);
      }
      const hovered=await sample(),paint=await cdp.evaluate<Reading>('__quotumBench.read()');
      assert.equal(hovered.fetches,0,'emphasis cannot send HTTP requests');assert.equal(bodies.bodies.length,hoverStart,'emphasis cannot request history');assert.equal(hovered.jobsStarted,0,'emphasis cannot schedule paths or accounting');assert.equal(hovered.advances,0,'emphasis cannot prepare paths or accounting');assert.equal(hovered.preferenceWrites,0);assert.equal(await geometry(),beforeHover);assert.deepEqual(hovered.numbers,baseline.numbers);
      assert.ok(!paint.renders.some(part=>part.kind==='chart'),'emphasis cannot render chart consumers');
      reports.push({days,name:'emphasis',charts:emphasis,requests:0,httpRequests:hovered.fetches,scheduledPreparations:hovered.jobsStarted,preparationAdvances:hovered.advances,preferenceWrites:hovered.preferenceWrites});
      console.error('bench: emphasis '+JSON.stringify(reports.at(-1)));
      let referenceReceipt={requests:0,requestBytes:0,decodedBytes:0,encodedBytes:0};
      const reference=async()=>{
        const request:PeriodRequest={version:1,selection:{mode:'live',periodMs:Date.now()-selection.from+60_000},evaluatedAt:Date.now(),workFilter:selectedFilter,sessions:{}};
        const body=JSON.stringify(request),response=await fetch(`${owner.base}/api/boards/${owner.personalBoard}/period`,{method:'POST',headers:{cookie:owner.cookie,origin:new URL(process.env.QUOTUM_PUBLIC_URL??owner.base).origin,'content-type':'application/json','accept-encoding':'identity'},body,signal:AbortSignal.timeout(12_000)});
        assert.equal(response.status,200,'raw interval reference');assert.ok(!response.headers.get('content-encoding'));
        const text=await response.text(),bytes=Buffer.byteLength(text);assert.ok(bytes<=FIXED_ACTIVITY_BUDGET.body);
        referenceReceipt.requests++;referenceReceipt.requestBytes+=Buffer.byteLength(body);referenceReceipt.decodedBytes+=bytes;referenceReceipt.encodedBytes+=bytes;
        const reply=expandPeriod(JSON.parse(text) as PeriodReply);
        assert.equal(reply.sessions?.state,'complete');return reply.sessions!.state==='complete'?reply.sessions!.value:null!;
      };
      const check=async()=>{
        const current=await sample(),trace=await reference();assert.deepEqual(current.numbers,activityOracle(trace,selection.from,selection.to));
        assert.equal(await cdp.evaluate('Number(document.querySelector(\'.activity-totals\').dataset.agentMs)'),current.numbers.agentMs,'the mounted summary reads that same cohort');
        for(const [at,activeMs,agentMs,agents] of current.activity.cells)assert.deepEqual({activeMs,agentMs,agents},activityOracle(trace,Math.max(selection.from,at),Math.min(selection.to,at+current.activity.barMs)));
        for(let at=cellStart(selection.from,current.activity.barMs);at<selection.to;at+=current.activity.barMs){
          const expected=activityOracle(trace,Math.max(selection.from,at),Math.min(selection.to,at+current.activity.barMs));
          if(expected.agentMs)assert.deepEqual(current.activity.cells.find(([start])=>start===at)?.slice(1),[expected.activeMs,expected.agentMs,expected.agents],'every nonempty reference bar must be present');
        }
        return current;
      };
      const phase=async(name:string,run:()=>Promise<void>,expected:number|null)=>{
        const start=bodies.bodies.length;await cdp.evaluate('window.__quotumFixedActivity.reset()');const at=Date.now();
        const deadline=at+30_000;
        referenceReceipt={requests:0,requestBytes:0,decodedBytes:0,encodedBytes:0};
        const metrics=async()=>{const {metrics}=await cdp.send<{metrics:{name:string;value:number}[]}>('Performance.getMetrics');return Object.fromEntries(metrics.map(metric=>[metric.name,metric.value]));};
        const before=await metrics();
        await run();
        if(expected){while(bodies.bodies.slice(start).filter(row=>row.body.sessions).length<expected){if(Date.now()>deadline)throw Error(name+' did not dispatch its shared reads');await pause(30);}}
        await pause(350);await settled(deadline);while(bodies.active.size||bodies.pending.size){await Promise.allSettled([...bodies.pending]);await pause(20);}
        const coherentAt=Date.now();
        const verified=await check();
        // Verification can overlap a calendar response. Account its complete body
        // and preparation before taking the phase's final traffic and CPU snapshot.
        await settled(deadline);while(bodies.active.size||bodies.pending.size){await Promise.allSettled([...bodies.pending]);await pause(20);}
        const current=await sample(),reads=bodies.bodies.slice(start);
        assert.deepEqual(current.numbers,verified.numbers,'verification cannot outlive the cohort it checked');
        const after=await metrics();assert.deepEqual(bodies.errors,[],'every completed response must remain accounted');
        assert.ok(Number.isFinite(after.ScriptDuration-before.ScriptDuration)&&Number.isFinite(after.TaskDuration-before.TaskDuration));
        const decoded=reads.reduce((n,row)=>n+row.decoded,0);
        const cancelled=reads.filter(row=>row.cancelled).length;
        const workRequests=reads.filter(row=>row.body.sessions).length;
        const preparationLimit=FIXED_ACTIVITY_BUDGET.advancesPerUpdate*Math.max(1,expected??workRequests);
        const attempts=reads.map(row=>({sections:(['quota','budget','funds','sessions','values','facets','calendar','sourceWork'] as const).filter(section=>row.body[section]),cancelled:row.cancelled,decoded:row.decoded,...(row.body.quota?{quota:{cell:row.body.quota.cell,from:row.body.quota.from,to:row.body.quota.to,evidenceSkip:row.body.quota.evidence==='skip'}}:{})}));
        const report={days,name,excluded,requests:reads.length,workRequests,otherRequests:reads.length-workRequests,preparationLimit,requestBytes:reads.reduce((n,row)=>n+row.requestBytes,0),decoded,encoded:reads.reduce((n,row)=>n+row.encoded,0),cancelled,attempts,coherentMs:coherentAt-at,verificationMs:Date.now()-coherentAt,reference:referenceReceipt,scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,taskMs:(after.TaskDuration-before.TaskDuration)*1000,...current,numbers:current.numbers,activity:undefined,tiles:undefined};
        reports.push(report);console.error('bench: fixed Activity '+JSON.stringify(report));
        if(expected===null)assertActivityCancellation(reads.map(row=>row.body),selection);
        else if(expected===0)assertActivityOutside(reads.map(row=>row.body),{selection,workFilter:selectedFilter});
        else assertActivityOverlap(reads.map(row=>row.body),expected);
        assert.ok(current.flights<=2&&current.bytes<=FIXED_ACTIVITY_BUDGET.pool&&!current.failedReservations&&current.tiles.length<=8);
        assert.ok(current.advances<=preparationLimit);
        if(expected&&expected>0)assert.ok(current.advances>0,'real shared preparation must be observed');
        for(const row of reads)assert.ok(row.requestBytes<=FIXED_ACTIVITY_BUDGET.request&&row.decoded<=FIXED_ACTIVITY_BUDGET.body);
        if(expected===1)assert.ok(decoded<=(days===1?FIXED_ACTIVITY_BUDGET.combined24h:FIXED_ACTIVITY_BUDGET.combined30d));
        return {current,reads};
      };
      const isolated=await phase('isolated',async()=>{await actor.through(actor.floorAt+100);},1);
      const cell=cellOf(days*DAY),dirty=cellStart(actor.floorAt,cell);
      const request=isolated.reads.find(row=>row.body.sessions)!.body,query=request.quota!;
      if(query.cells!=='skip')assert.equal(Number(query.from),dirty,'a combined drawing read fetches only dirty native cells');
      assert.deepEqual(request.selection,selection);
      const clean=baseline.tiles.filter(([,to])=>to<=dirty);
      assert.ok(clean.length);for(const row of clean)assert.deepEqual(isolated.current.tiles.find(([from,to])=>from===row[0]&&to===row[1]),row);
      assert.equal(isolated.current.activity.barMs,baseline.activity.barMs);
      await phase('burst before dispatch',async()=>{
        await cdp.evaluate('window.__quotumFixedActivity.holdDispatch()');
        await actor.through(actor.floorAt+200);await actor.through(actor.floorAt+300);await actor.through(actor.floorAt+400);await pause(350);
        await cdp.evaluate('window.__quotumFixedActivity.resumeDispatch()');
      },1);
      const intercepted=async(trigger:()=>Promise<void>,whileHeld:()=>Promise<void>,holdFollowing=false)=>{
        type Paused={requestId:string;networkId?:string};
        let release!:(event:{requestId:string;networkId?:string})=>void;
        const paused=new Promise<{requestId:string;networkId?:string}>(yes=>{release=yes;}),deadline=setTimeout(()=>release({requestId:''}),10_000);
        let held=false,holding=true;
        const following:Paused[]=[],captures:Promise<void>[]=[],errors:unknown[]=[];
        const account=async(event:Paused)=>{
          const payload=await cdp.send<{body:string;base64Encoded:boolean}>('Fetch.getResponseBody',{requestId:event.requestId});
          const row=bodies.bodies.find(row=>row.id===event.networkId);assert.ok(row);row.decoded=payload.base64Encoded?Buffer.from(payload.body,'base64').length:Buffer.byteLength(payload.body);
        };
        const intercept=(event:{requestId:string;networkId?:string;request:{postData?:string}})=>{
          const body=JSON.parse(event.request.postData??'{}') as PeriodRequest;
          if(!held&&body.sessions){held=true;release(event);}
          else if(holding&&holdFollowing&&body.sessions){following.push(event);captures.push(account(event).catch(error=>{errors.push(error);}));}
          else void cdp.send('Fetch.continueResponse',{requestId:event.requestId}).catch(()=>{});
        };
        cdp.on('Fetch.requestPaused',intercept);
        await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/boards/*/period',requestStage:'Response'}]});
        try{
          await trigger();const event=await paused;assert.ok(event.requestId,'a real shared-work response must be held');
          await account(event);await whileHeld();holding=false;
          await Promise.all(captures);
          for(const response of [event,...following])await cdp.send('Fetch.continueResponse',{requestId:response.requestId}).catch(()=>{});
        }finally{holding=false;clearTimeout(deadline);await Promise.all(captures);await cdp.send('Fetch.disable');cdp.off('Fetch.requestPaused',intercept);}
        assert.deepEqual(errors,[],'all held response bodies must remain accounted');
      };
      const retainedSummary=await cdp.evaluate('document.querySelector(".activity-totals").outerHTML');
      const during=await phase('news during response',()=>intercepted(async()=>{await actor.through(actor.floorAt+500);},async()=>{
        await actor.through(actor.floorAt+600);await pause(350);
        assert.equal(await cdp.evaluate('document.querySelector(".activity-totals").outerHTML'),retainedSummary,'held work answers preserve the complete previous cohort, including all four metrics');
      },true),2);
      assert.ok(during.current.flights<=2);
      await phase('cancelled A to B to A',()=>intercepted(async()=>{await actor.through(actor.floorAt+700);},async()=>{
        const before=await cdp.evaluate('JSON.stringify(window.__quotumFixedActivity.reader().intent().request.workFilter)');
        const clients=`document.querySelector('[data-filter="filters.clients"]')`;
        await cdp.evaluate(`${clients}.querySelector('button').click()`);
        const option=`[...${clients}.querySelectorAll('[role="switch"]')].find(button=>button.querySelector('span').textContent==='Codex')`;
        await waitFor(`!!(${option})`);
        await cdp.evaluate(`(${option}).click()`);
        // Reset remains available while B's facet rows are being replaced.
        // It restores the original client rule without changing A's project subset.
        await waitFor(`!!${clients}.querySelector('.filter-reset')`);
        await cdp.evaluate(`${clients}.querySelector('.filter-reset').click()`);
        await cdp.evaluate(`${clients}.querySelector('button').click()`);
        assert.equal(await cdp.evaluate('JSON.stringify(window.__quotumFixedActivity.reader().intent().request.workFilter)'),before,'A to B to A restores the exact shared cohort');
        assert.equal(await cdp.evaluate('window.__quotumFixedActivity.sample()'),null);
      }),null);
      await phase('through upper bound',async()=>{await actor.through(selection.to);},1);
      await phase('outside range',async()=>{await actor.through(selection.to+100);await waitFor(`window.__quotumFixedActivity.heardSince(${selection.to})`);},0);
      const receipt=await cdp.evaluate<{status:string;members:{kind:string}[];[key:string]:unknown}>(`(()=>{__quotumHistoryPoolReceipt.mark(2,3);return __quotumHistoryPoolReceipt.read();})()`);
      assert.equal(receipt.status,'complete',JSON.stringify(Object.fromEntries(['status','attached','registrationOrderQualified','omitted','errors','snapshotOmitted','summaryOmitted','nearOmitted','sendingUnknown','lastCheckpoint'].map(key=>[key,receipt[key]]))));assert.equal(receipt.members.length,4);assert.ok(!receipt.members.some(member=>member.kind==='activity'));
    }finally{await tab.close();await actor.close();}
  }
  return {reports,problems:[] as string[]};
}
