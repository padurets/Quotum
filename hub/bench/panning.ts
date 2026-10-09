import type {Cdp} from './cdp.js';
import {panningProblems, type PanReading} from './panningBudget.js';
import {panEvidenceScript} from './panEvidence.js';
import {deadline} from './deadline.js';
import {reload} from './reload.js';
import {panMetrics, panCost} from './panningMetrics.js';

/** Native input against the real charts; the temporary layout brings all four into view. */
export async function panning(cdp: Pick<Cdp, 'send' | 'evaluate' | 'on' | 'off'> & Partial<Pick<Cdp, 'at'>>, pace: (ms: number) => Promise<unknown> = ms => new Promise(resolve => setTimeout(resolve, ms)), evidence?: {timeline?: boolean; save(name: string, value: unknown): void}) {
  cdp.at?.('panning/setup');
  const wait = (ms: number) => cdp.evaluate(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
  const key = (down: boolean, name: string, code: number) => cdp.send('Input.dispatchKeyEvent', {type: down ? 'keyDown' : 'keyUp', key: name, code: name === 'Shift' ? 'ShiftLeft' : name, windowsVirtualKeyCode: code, modifiers: down && name === 'Shift' ? 8 : 0});
  const mouse = (type: string, x: number, y: number, modifiers = 0) => cdp.send('Input.dispatchMouseEvent', {type, x, y, modifiers, button: type === 'mouseMoved' && !modifiers ? 'none' : 'left', buttons: type === 'mousePressed' || type === 'mouseMoved' && modifiers ? 1 : 0, clickCount: type === 'mouseMoved' ? undefined : 1});
  const click = async (selector: string, index = 0) => {
    const point = await cdp.evaluate<{x: number; y: number}>(`(async () => {const until=Date.now()+5000;let element;while(!(element=document.querySelectorAll(${JSON.stringify(selector)})[${index}])){if(Date.now()>until)throw new Error('missing native input target: '+${JSON.stringify(selector)});await new Promise(r=>setTimeout(r,20));}if(!element.closest('.popover')){element.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);}const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await mouse('mouseMoved', point.x, point.y);
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseReleased', point.x, point.y);
  };
  const settled = () => cdp.evaluate(`(async()=>{const until=Date.now()+15000,p=new URLSearchParams(location.search),wanted=p.has('from')?p.get('from')+'-'+p.get('to'):JSON.parse(localStorage.getItem('quotum.prefs')||'{}').range||'24h';while(document.querySelector('.history.is-loading, .activity.is-loading, .budget-history.is-loading, .subscription-funds.is-loading') || document.querySelector('.chart > svg[data-pan-end], .chart > svg[data-draw-ready="false"], .chart > svg.is-panning')||[...document.querySelectorAll('.forecast,.budget-table')].some(table=>table.dataset.historyRange!==wanted)){if(Date.now()>until)throw new Error('charts and complete totals did not settle: '+JSON.stringify({wanted,panels:[...document.querySelectorAll('.history,.activity,.budget-history,.subscription-funds,.forecast,.budget-table')].map(panel=>({class:panel.className,range:panel.dataset.historyRange,error:panel.querySelector('.history-error')?.textContent,plot:panel.querySelector('.chart>svg')?.dataset})),flights:window.__quotumPan?[...window.__quotumPan.flights.values()]:[]}));await new Promise(r=>setTimeout(r,20));}await new Promise(r=>setTimeout(r,250));})()`);
  const reports: PanReading[] = [];
  const originalHorizon = await cdp.evaluate<string>(`JSON.parse(localStorage.getItem('quotum.prefs')||'{}').horizon||'auto'`);
  let interception = false, failed = false;
  let scenario: {initiator: string; period?: string} | undefined;
  const at = (stage: string) => cdp.at?.(['panning', scenario?.initiator, scenario?.period, stage].filter(Boolean).join('/'));
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false});
  try {
    for (const initiator of ['quota', 'budget', 'funds'] as const) {
      scenario = {initiator};
      at('load');
      // A newly opened board gives each input owner an independently unread edge.
      await reload(cdp);
      await cdp.evaluate(`(async()=>{window.__quotumBench?.pause();const until=Date.now()+15000;while(!['.history','.activity','.budget-history','.subscription-funds'].every(panel=>document.querySelector(panel+' .chart>svg'))){if(Date.now()>until)throw new Error('panning charts did not open');await new Promise(r=>setTimeout(r,20));}})()`);
      const selector = initiator === 'quota' ? '.history' : initiator === 'funds' ? '.subscription-funds' : '.budget-history';
      const inset = initiator === 'quota' ? 52 : 88;
      await cdp.evaluate(`(() => {
    const style=document.createElement('style'); style.id='quotum-pan-layout';
    style.textContent='.widgets{display:flex!important;flex-direction:column!important}.widget{height:auto!important}.widget:not(:has(.history,.activity,.budget-history,.subscription-funds)){display:none!important}.widget:has(.history){order:1}.widget:has(.activity){order:2}.widget:has(.budget-history){order:3}.widget:has(.subscription-funds){order:4}.widget-body{height:auto!important}.widget-body>.panel{--fill:0px!important}.history .chart>svg{height:200px!important}.activity .chart>svg{height:140px!important}.budget-history .chart>svg,.subscription-funds .chart>svg{height:200px!important}.legend{max-height:48px;overflow:auto}.activity .legend{max-height:40px}';
    document.head.append(style); document.querySelector('.analytics-head')?.scrollIntoView();
  })()`);
    // A manual horizon keeps the 30d source's full 1.25-width path inside retention.
    await click('.history .panel-head .picker > button');
    await click('.history .popover .segmented button', 1);
    await key(true, 'Escape', 27); await key(false, 'Escape', 27);
    for (const [period, index] of [['24h', 4], ['30d', 8]] as const) {
      scenario = {initiator, period};
      at('setup');
      await click('.period .picker > button');
      await click('.period .popover .popover-row', index);
      await settled();
      await cdp.evaluate(`(async () => {for(let i=0;i<3;i++){await new Promise(requestAnimationFrame);const r=document.querySelector('.history .chart>svg').getBoundingClientRect();scrollBy(0,r.top-140);}})()`);
      const geometry = await cdp.evaluate<{x: number; y: number; width: number; series: number; budgetSeries: number; fundsSeries: number; charts: number}>(`(() => {
        const svg=document.querySelector('${selector} .chart>svg'), r=svg.getBoundingClientRect();
        const charts=[...document.querySelectorAll('.chart>svg')].filter(e=>{const b=e.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight;}).length;
        return {x:r.left+r.width*.5,y:r.top+80,width:r.width*(svg.viewBox.baseVal.width-${inset})/svg.viewBox.baseVal.width,fundsSeries:document.querySelectorAll('.subscription-funds .series[d]:not([d=""])').length,budgetSeries:document.querySelectorAll('.budget-history .series[d]:not([d=""])').length,series:document.querySelectorAll('.history .series[d]:not([d=""])').length,charts};
      })()`);
      evidence?.save('panning-stage', {initiator, period, stage: 'starting', viewport: [1280,1600], throttle: 4, geometry});
      await cdp.evaluate(`(() => {
        const initiator=${JSON.stringify(initiator)};
        const timeline=${panEvidenceScript(evidence?.timeline === true)},staged=new Set();let nextRequest=0;
        const charts=[document.querySelector('.history .chart>svg'),document.querySelector('.activity .chart>svg'),document.querySelector('.budget-history .chart>svg'),document.querySelector('.subscription-funds .chart>svg')],driver=initiator==='quota'?0:initiator==='funds'?3:2,root=charts[driver],views=charts.map(svg=>svg.viewBox.baseVal.width),scales=charts.map((svg,i)=>svg.getBoundingClientRect().width/views[i]),size=svg=>svg.getAttribute('viewBox')+':'+svg.style.height,sizes=charts.map(size);
        const probe=window.__quotumPan={frames:[],latency:[],responses:[],inputs:0,updated:0,chartUpdates:[0,0,0,0],synchronized:true,pending:[],last:0,pushesDuring:0,pushesAfter:0,forbiddenMutations:0,undimmed:getComputedStyle(root).opacity==='1',sizeStable:true,coldReads:0,peakFlights:0,maxTiles:0,duplicateReads:0,flights:new Map(),running:true,feeding:false,segment:'wheel',samples:[],timeline};
        const originalPush=history.pushState.bind(history);probe.originalPush=originalPush;
        history.pushState=(...args)=>{if(probe.feeding)probe.pushesDuring++;else probe.pushesAfter++;originalPush(...args);};
        probe.returnSnapshot=()=>({now:Date.now(),url:location.search,charts:charts.map((svg,i)=>{
          const left=i===1?48:i>=2?76:40,box=svg.viewBox.baseVal.width,inner=box-left-12,r=svg.getBoundingClientRect(),scale=r.width/box;
          const layer=svg.parentElement.querySelector(i===1?'.plot-clip.is-band .plot-move':'.plot-move[data-plot-main]'),slides=layer.querySelector('.slides'),matrix=slides.getScreenCTM();
          const from=Number(svg.dataset.drawFrom),to=Number(svg.dataset.drawTo),span=Math.max(60000,to-from);
          const timeAt=x=>from+((x-matrix.e)/matrix.a-left)/inner*span;
          return {from,to,ready:svg.dataset.drawReady,panning:svg.classList.contains('is-panning'),visibleFrom:timeAt(r.left+left*scale),visibleTo:timeAt(r.right-12*scale),perMs:matrix.a*inner/span,panOrigin:svg.dataset.panOrigin,panScale:svg.dataset.panScale,matrix:{a:matrix.a,e:matrix.e}};
        })});
        const owner=root.parentElement,types=['wheel','pointerdown','pointermove','pointerup'];
        const transforms=new Map();
        const matrixOf=value=>{const key=value||'none';let matrix=transforms.get(key);if(!matrix){const raw=new DOMMatrix(key==='none'?undefined:key);matrix={a:raw.a,e:raw.e};transforms.set(key,matrix);if(transforms.size>64)transforms.delete(transforms.keys().next().value);}return matrix;};
        let gesture=null;
        const capturedInputs=new WeakMap();
        const capture=e=>{const delivered=performance.now(),at=e.timeStamp>1e12?e.timeStamp-performance.timeOrigin:e.timeStamp;capturedInputs.set(e,{at:Math.min(delivered,at),delivered});};
        const owners=()=>charts.map((svg,i)=>svg.parentElement.querySelector(i===1?'.plot-clip.is-band .plot-move':'.plot-move[data-plot-main]'));
        // Inline frozen matrices and the committed domain are enough during input;
        // no computed style or SVG layout read belongs in this moving-frame probe.
        const presentation=(svg,layer,i,at)=>{
          const left=i===1?48:i>=2?76:40,inner=views[i]-left-12,span=Number(svg.dataset.drawTo)-Number(svg.dataset.drawFrom),matrix=matrixOf(layer.querySelector('.slides').style.transform),outer=matrixOf(layer.style.transform);
          const shown={x:scales[i]*(matrix.a*(left+(at-Number(svg.dataset.drawFrom))/span*inner)+matrix.e)+outer.e,perMs:scales[i]*matrix.a*inner/span};
          if(i===1){let node=svg.parentElement.querySelector('.plot-clip.is-band'),a=1,b=0;if(node.style.visibility==='hidden')return{x:NaN,perMs:NaN};for(let n=0;n<4;n++,node=node.firstElementChild){const m=matrixOf(node.style.transform);b+=a*m.e;a*=m.a;}const origin=left*scales[i];return{x:origin+b+a*(shown.x-origin),perMs:a*shown.perMs};}
          return shown;
        };
        const begin=(token,x)=>{const origin=Number(root.dataset.panOrigin),layers=owners();gesture={token,pixels:0,x,origin,shown:charts.map((svg,i)=>presentation(svg,layers[i],i,origin)),started:!!root.dataset.panEnd,scale:Number(root.dataset.panScale),baseline:Number(root.dataset.panBase||0)};};
        const input=e=>{
          const captured=capturedInputs.get(e);if(!captured)return;capturedInputs.delete(e);
          const token=root.dataset.panToken;
          // The native handler can finish an expired wheel transaction and
          // begin another one in this event. Observe its resulting token.
          if(e.type==='pointerdown'){if(!gesture||gesture.token!==token)begin(token,e.clientX);else gesture.x=e.clientX;return;}
          if(e.type==='pointerup')return;
          if(e.type==='wheel'){
            if(!e.cancelable||(!e.deltaX&&!e.shiftKey))return;
            if(!gesture||gesture.token!==token)begin(token);
            const unit=[1,16,400][e.deltaMode]||1;
            gesture.pixels-=(e.deltaX||(e.shiftKey?e.deltaY:0))*unit;
            if(probe.returnInput){const trace=probe.returnInput;trace.pixels-=(e.deltaX||(e.shiftKey?e.deltaY:0))*unit;trace.events++;if(trace.tokens.at(-1)?.token!==token)trace.tokens.push({token,origin:Number(root.dataset.panOrigin),scale:Number(root.dataset.panScale),at:e.timeStamp,delivered:captured.delivered,pixels:trace.pixels});trace.last={at:e.timeStamp,delivered:captured.delivered};}
          }else{
            if(!e.buttons||!gesture)return;
            gesture.pixels+=e.clientX-gesture.x;gesture.x=e.clientX;
          }
          probe.inputs++;
          const input={id:probe.inputs,...captured,segment:probe.segment,pixels:gesture.pixels,gesture};
          if(timeline)timeline.add('input',{inputId:input.id,token:Number(token),stamp:captured.at,delivered:captured.delivered,segment:input.segment,pixels:input.pixels});
          probe.pending.push(input);
        };
        for(const type of types){owner.addEventListener(type,capture,true);window.addEventListener(type,input);}
        const originalFetch=window.fetch.bind(window);probe.originalFetch=originalFetch;
        window.fetch=async(...args)=>{
          const url=new URL(String(args[0]),location.href);if(url.pathname!='/api/history')return originalFetch(...args);
          const scope=JSON.stringify([url.searchParams.get('scope'),url.searchParams.get('meters'),url.searchParams.get('unit'),url.searchParams.get('currency')]),cell=Number(url.searchParams.get('cell')),from=Number(url.searchParams.get('from')),to=Number(url.searchParams.get('to')),tiles=Math.floor((to-1)/(cell*60))-Math.floor(from/(cell*60))+1;
          for(const f of probe.flights.values())if(f.scope===scope&&f.cell===cell&&f.from<to&&f.to>from)probe.duplicateReads++;
          const id=++nextRequest,signal=args[1]?.signal,aborted=()=>{if(timeline)timeline.add('history-abort',{requestId:id});probe.flights.delete(id);};probe.flights.set(id,{scope,cell,from,to});signal?.addEventListener('abort',aborted,{once:true});probe.peakFlights=Math.max(probe.peakFlights,probe.flights.size);probe.maxTiles=Math.max(probe.maxTiles,tiles);probe.coldReads++;
          if(timeline)timeline.add('history-start',{requestId:id,cell,from,to});
          try {
            const response=await originalFetch(...args);
            if(timeline){
              timeline.add('history-headers',{requestId:id,status:response.status});
              const json=response.json.bind(response);
              response.json=async()=>{timeline.add('history-body-start',{requestId:id});try{const value=await json();staged.add(id);if(staged.size>32)staged.delete(staged.values().next().value);timeline.add('history-body-ready',{requestId:id});return value;}catch(error){timeline.add('history-body-failed',{requestId:id});throw error;}};
            }
            return response;
          }finally{probe.flights.delete(id);signal?.removeEventListener('abort',aborted);}
        };
        probe.observer=new MutationObserver(records=>{
          if(timeline && probe.running)for(const record of records){const chart=charts.indexOf(record.target);if(chart>=0&&['data-draw-ready','data-draw-from','data-draw-to'].includes(record.attributeName))timeline.add('draw-commit',{chart,from:Number(record.target.dataset.drawFrom),to:Number(record.target.dataset.drawTo),ready:record.target.dataset.drawReady==='true',candidateRequests:[...staged].slice(-32)});}
          if(!probe.running||!probe.feeding)return;
          for(const record of records){const element=record.target.nodeType===1?record.target:record.target.parentElement;if(!element?.closest('.card,.topbar,.agents-panel,.forecast,.budget-table,.activity-totals'))continue;const clock=element.closest('[data-time]'),timeOnly=clock&&clock.getAttribute('data-time')!=='chart';if(!timeOnly)probe.forbiddenMutations++;}
        });probe.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
        const originalRAF=window.requestAnimationFrame||requestAnimationFrame;
        const schedule=callback=>originalRAF.call(window,callback);
        let previous=charts.map(()=>'0:1'),phase='idle',lastFrame=null,paintedToken=null,observedAnimation=null,observedPending=false;
        const consume=(count,now,stamp)=>{for(const input of probe.pending.splice(0,count)){const ms=now-input.at;probe.latency.push(ms);if(timeline)timeline.add('credit',{inputId:input.id,frameId:stamp,token:Number(input.gesture.token),stamp:input.at,delivered:input.delivered,credited:now,pixels:input.pixels,segment:input.segment});probe.responses.push({ms,queued:input.delivered-input.at,processed:now-input.delivered,segment:input.segment,requests:probe.flights.size});}};
        const sample=(stamp,afterCallback=false)=>{
          if(!probe.running)return;
          const now=performance.now(),demand=probe.pending.length,layers=owners(),active=!!root.dataset.panEnd;
          let foldAnimation=null;
          const foldOwner=active?null:[layers[0],layers[0].querySelector('.slides')].find(layer=>{foldAnimation=layer.getAnimations().find(a=>a.playState==='running');return !!foldAnimation;}),folding=!!foldOwner;
          probe.sizeStable&&=charts.every((svg,i)=>svg.isConnected&&size(svg)===sizes[i]);
          const matrices=layers.map((layer,i)=>{const transform=active?layer.style.transform:folding&&i===0?getComputedStyle(foldOwner).transform:'none',matrix=matrixOf(transform);return folding&&foldOwner!==layers[0]?{a:matrix.a,e:matrix.e*scales[i]}:matrix;}),current=matrices.map(matrix=>matrix.e+':'+matrix.a);
          const nextPhase=active?'pan':folding?'fold':'idle';
          // Keep the observed pending start as well as moving frames in opt-in
          // evidence. A smooth moving portion alone cannot prove a short fold.
          if(timeline){
            const pending=!!foldAnimation?.pending;
            if(nextPhase!==phase||foldAnimation!==observedAnimation||pending!==observedPending){
              const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
              timeline.add('presentation-phase',{phase:nextPhase,frameId:stamp,pending,htmlOwner:folding?foldOwner===layers[0]:null,currentTime:number(foldAnimation?.currentTime),startTime:number(foldAnimation?.startTime)});
              observedAnimation=foldAnimation;observedPending=pending;
            }
          }
          // The wheel's intentional 200 ms rest is stationary, before the fold begins.
          if(nextPhase!==phase||active&&paintedToken!==root.dataset.panToken){probe.last=0;lastFrame=null;previous=nextPhase==='pan'?charts.map(svg=>(Number(svg.dataset.panBase||0))+':1'):current;phase=nextPhase;paintedToken=root.dataset.panToken;}
          const moved=current.map((value,i)=>value!==previous[i]);
          if(active){probe.synchronized&&=charts.every((svg,i)=>{const shown=gesture?.shown[i],actual=presentation(svg,layers[i],i,gesture?.origin),delta=(Number(svg.dataset.panEnd)-Number(svg.dataset.panOrigin));return svg.dataset.panEnd===root.dataset.panEnd&&Math.abs(delta/Number(svg.dataset.panScale)+matrices[i].e-Number(svg.dataset.panBase||0))<.01&&shown&&Number.isFinite(actual.x)&&Math.abs(actual.perMs*Number(svg.dataset.panScale)-1)<1e-6&&Math.abs(actual.perMs/shown.perMs-1)<1e-6&&Math.abs(actual.x-(shown.x-delta*shown.perMs))<.1;})&&[...charts[1].parentElement.querySelectorAll('.plot-move')].filter(layer=>layer.querySelector('.activity-stack')).every(layer=>Math.abs(matrixOf(layer.style.transform).e-matrices[1].e)<.01);moved.forEach((changed,i)=>{if(changed)probe.chartUpdates[i]++;});}
          // Each input reaches all four plots. Activity has no future, so only the
          // remaining-share chart must move during the final future fold.
          if(active&&probe.synchronized&&(moved.every(Boolean)||afterCallback)){
            // Coalesced input reaches its final position together. A newer event
            // cannot be credited by the artwork of an earlier event.
            let reached=-1;
            for(let i=0;i<probe.pending.length;i++){const input=probe.pending[i];if(input.gesture===gesture&&Math.abs(input.gesture.baseline+input.pixels-matrices[driver].e)<.1)reached=i;}
            if(reached>=0)consume(reached+1,now,stamp);
          }
          if(active&&moved.every(Boolean)||folding&&moved[0]){
            if(stamp!==lastFrame){if(timeline)timeline.add('frame',{frameId:stamp,from:probe.last,to:now,segment:folding?'fold':probe.segment,pending:demand,pose:matrices.map(value=>[value.a,value.e]),requests:[...probe.flights.keys()]});probe.updated++;if(probe.last){const ms=now-probe.last;probe.frames.push(ms);probe.samples.push({ms,segment:folding?'fold':probe.segment,pending:demand,requests:probe.flights.size});}probe.last=now;lastFrame=stamp;}
          }
          if(!active&&!folding&&probe.pending.length&&charts.every(svg=>svg.dataset.drawReady==='true'&&!svg.classList.contains('is-panning'))){
            // Release may commit the last coalesced input before its own RAF.
            // Its effect is observable only after the final geometry and fold.
            const ends=charts.map(svg=>Number(svg.parentElement.dataset.axisEnd)),selected=new URLSearchParams(location.search).has('to');
            let reached=-1;
            for(let i=0;i<probe.pending.length;i++){const input=probe.pending[i],g=input.gesture;const tolerance=selected?1.1:8*g.scale+1.1;if(g.started&&g.scale>0&&ends.every(end=>Math.abs(end-(g.origin-input.pixels*g.scale))<=tolerance))reached=i;}
            if(reached>=0){if(timeline)timeline.add('final-geometry',{frameId:stamp,ends});consume(reached+1,now,stamp);}
          }
          if(!active&&!folding)probe.last=0;
          previous=current;probe.undimmed&&=charts.every(svg=>!svg.closest('.is-loading')&&(!svg.style.opacity||svg.style.opacity==='1'));
        };
        window.requestAnimationFrame=callback=>schedule(stamp=>{try{callback.call(window,stamp);}finally{if(probe.running&&probe.pending.length)sample(stamp,true);}});
        const tick=stamp=>{
          if(!probe.running)return;
          if(!root.dataset.panEnd)sample(stamp);
          // Input-free stationary frames carry no movement demand. A pending
          // event keeps the interval open, so delayed work still fails budget.
          if(root.dataset.panEnd&&!probe.pending.length&&lastFrame!==stamp)probe.last=0;
          probe.raf=schedule(tick);
        };
        probe.cleanup=()=>{probe.running=false;cancelAnimationFrame(probe.raf);probe.observer.disconnect();for(const type of types){owner.removeEventListener(type,capture,true);window.removeEventListener(type,input);}window.requestAnimationFrame=originalRAF;window.fetch=originalFetch;history.pushState=originalPush;};
        probe.raf=schedule(tick);
      })()`);
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
      // A delayed cold edge is part of the moving interval, including arrivals/rebuilds.
      await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1});
      interception = true;
      const wheel = (dx: number, shift = false) => cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX: dx, deltaY: 0, modifiers: shift ? 8 : 0});
      const sent: Promise<unknown>[] = [];
      const costStart = evidence?.timeline !== undefined ? await panMetrics(cdp) : undefined;
      at('wheel');
      await cdp.evaluate('window.__quotumPan.feeding=true');
      // The browser generates native wheel input without a CDP IPC per delta.
      const scroll = (distance: number, reverse = 0) => cdp.send('Input.synthesizeScrollGesture', {x: geometry.x, y: geometry.y, xDistance: distance, xOverscroll: reverse, yDistance: 0, speed: 720, gestureSourceType: 'mouse', preventFling: true});
      await scroll(geometry.width * 1.25, geometry.width * 1.25 / 3);
      await cdp.evaluate('window.__quotumPan.feeding=false');
      await wait(240);
      await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
      interception = false;
      await settled();
      // Shift-drag keeps capture when the pointer leaves the SVG, without extra inertia.
      at('drag');
      await cdp.evaluate(`window.__quotumPan.segment='drag'`);
      await key(true, 'Shift', 16);
      await mouse('mousePressed', geometry.x, geometry.y, 8);
      await cdp.evaluate(`window.__quotumPan.undimmed&&=getComputedStyle(document.querySelector('${selector} .chart>svg')).opacity==='1'`);
      await cdp.evaluate('window.__quotumPan.feeding=true');
      sent.length = 0;
      for (let i = 1; i <= 60; i++) {sent.push(mouse('mouseMoved', geometry.x + i * 12, geometry.y, 8)); await pace(16);}
      await Promise.all(sent);
      await cdp.evaluate('window.__quotumPan.feeding=false');
      await mouse('mouseReleased', geometry.x + 720, geometry.y, 8);
      await key(false, 'Shift', 16);
      await settled();
      // Native Shift deltaX returns to live, then Back/Forward restore complete gestures.
      at('return');
      sent.length = 0;
      await cdp.evaluate(`window.__quotumPan.segment='return'`);
      const returnBefore = await cdp.evaluate<unknown>('window.__quotumPan.returnSnapshot()');
      await cdp.evaluate('window.__quotumPan.returnInput={pixels:0,events:0,tokens:[]}');
      await cdp.evaluate('window.__quotumPan.feeding=true');
      const returnPixels = await cdp.evaluate<number>(`(() => {
        const p=new URLSearchParams(location.search),from=Number(p.get('from')),to=Number(p.get('to'));
        const svg=document.querySelector('${selector} .chart>svg'),width=svg.getBoundingClientRect().width,box=svg.viewBox.baseVal.width;
        return (Date.now()-to)/(to-from)*(width*(box-${inset})/box);
      })()`);
      await scroll(-Math.max(0, returnPixels - 4));
      await cdp.evaluate('window.__quotumPan.feeding=false');
      await wait(240); await settled();
      await cdp.evaluate('window.__quotumPan.returnAfter=window.__quotumPan.returnSnapshot()');
      const costEnd = costStart ? await panMetrics(cdp) : undefined;
      at('report');
      const report = await cdp.evaluate<PanReading>(`(() => {
        const p=window.__quotumPan;p.cleanup();
        const segments={};for(const segment of ['wheel','drag','return','fold']){const values=p.samples.filter(s=>s.segment===segment).map(s=>s.ms).sort((a,b)=>a-b);segments[segment]={count:values.length,p95:values[Math.ceil(values.length*.95)-1]??0,max:values.at(-1)??0};}
        return {frames:p.frames,latency:p.latency,inputs:p.inputs,updated:p.updated,chartUpdates:p.chartUpdates,synchronized:p.synchronized,pushesDuring:p.pushesDuring,pushesAfter:p.pushesAfter,forbiddenMutations:p.forbiddenMutations,undimmed:p.undimmed,sizeStable:p.sizeStable,coldReads:p.coldReads,peakFlights:p.peakFlights,maxTiles:p.maxTiles,duplicateReads:p.duplicateReads,segments,outliers:p.samples.filter(s=>s.ms>50),responses:p.responses.filter(r=>r.ms>34),timeline:p.timeline?.read()};
      })()`);
      report.initiator = initiator; report.period = period; report.series = geometry.series; report.budgetSeries = geometry.budgetSeries; report.fundsSeries = geometry.fundsSeries; report.charts = geometry.charts; report.rate = 4; report.expectedPushes = 3;
      if(costStart&&costEnd)report.cost=panCost(costStart,costEnd);
      reports.push(report);
      evidence?.save('panning-'+initiator+'-'+period,report);
      at('postconditions');
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
      const live = await cdp.evaluate<boolean>(`!new URLSearchParams(location.search).has('from')`);
      if (!live) {
        const returned = await cdp.evaluate<unknown>('({after:window.__quotumPan.returnAfter,input:window.__quotumPan.returnInput})');
        throw new Error(`${initiator}/${period} pan did not return to live: ${JSON.stringify({before: returnBefore, returnPixels, returned, report})}`);
      }
      await cdp.evaluate('window.__quotumPan.returnInput=null');
      // Held Shift-wheel has the same uninterrupted scale as dragging, across rests.
      await mouse('mouseMoved', geometry.x, geometry.y);
      await key(true, 'Shift', 16);
      await wait(30);
      if (await cdp.evaluate<boolean>(`!!document.querySelector('.subscription-funds .tooltip,.history .tooltip,.budget-history .tooltip,.activity .tooltip,.activity-legend-tip.is-open')`)) throw new Error('holding Shift left a chart readout visible');
      await wheel(-12, true); await wait(300);
      const first = await cdp.evaluate<number>(`new DOMMatrix(document.querySelector('${selector} .plot-move[data-plot-main]').style.transform).e`);
      if (!(await cdp.evaluate<boolean>(`!!document.querySelector('[data-pan-end]')&&!new URLSearchParams(location.search).has('from')`))) throw new Error('Shift-wheel committed before Shift was released');
      await wheel(-12, true); await wait(240);
      const second = await cdp.evaluate<number>(`new DOMMatrix(document.querySelector('${selector} .plot-move[data-plot-main]').style.transform).e`);
      if (!Number.isFinite(first) || first <= 0 || Math.abs(second - 2 * first) > .01) throw new Error('Shift-wheel changed its scale during a pause');
      await wheel(24, true); await wait(40);
      await key(false, 'Shift', 16); await wait(240);
      if (!(await cdp.evaluate<boolean>(`!document.querySelector('[data-pan-end]')&&!new URLSearchParams(location.search).has('from')`))) throw new Error('Shift-wheel return did not preserve live');
      await cdp.evaluate(`history.back()`); await wait(300);
      if (!(await cdp.evaluate<boolean>(`new URLSearchParams(location.search).has('from')`))) throw new Error('Back did not restore the whole previous gesture');
      await cdp.evaluate(`history.forward()`); await wait(300);
      if (!(await cdp.evaluate<boolean>(`!new URLSearchParams(location.search).has('from')`))) throw new Error('Forward did not restore live');
      // A wheel does not blur a keyboard-focused legend. Its bubble must stay
      // hidden through ordinary panning, a latched drag and their final fold.
      const legendVisible = () => cdp.evaluate<boolean>(`[...document.querySelectorAll('.activity-legend-tip.is-open')].some(tip=>getComputedStyle(tip).display!=='none')`);
      await key(true, 'Tab', 9); await key(false, 'Tab', 9);
      await cdp.evaluate(`document.querySelector('.activity .legend-item').focus()`); await wait(40);
      if (!(await legendVisible())) throw new Error('focused activity legend did not open its readout');
      await wheel(-12); await wait(40);
      if (await legendVisible()) throw new Error('horizontal wheel left a focused legend readout visible');
      await wait(190);
      if (await legendVisible()) throw new Error('a wheel fold left a focused legend readout visible');
      await wait(260);
      await cdp.evaluate(`history.back()`); await settled();
      await key(true, 'Shift', 16); await mouse('mousePressed', geometry.x, geometry.y, 8);
      await mouse('mouseMoved', geometry.x + 24, geometry.y, 8); await wait(40);
      await key(false, 'Shift', 16);
      if (await legendVisible()) throw new Error('releasing Shift reopened a readout during a latched drag');
      await mouse('mouseReleased', geometry.x + 24, geometry.y); await wait(30);
      if (await legendVisible()) throw new Error('a drag fold reopened a focused legend readout');
      await wait(260);
      await cdp.evaluate(`history.back()`); await settled();
    }
      await cdp.evaluate(`document.getElementById('quotum-pan-layout')?.remove()`);
    }
    return {reports, problems: reports.flatMap(panningProblems)};
  } catch (error) {
    failed = true;
    evidence?.save('panning-failure', {status: 'failed', ...scenario, completed: reports.length});
    if (evidence) try {
      const partial = await deadline(5000, signal => cdp.evaluate(`(() => {
        const p=window.__quotumPan;if(!p)return {status:'unavailable'};
        return {status:'partial',inputs:p.inputs,updated:p.updated,frames:p.frames,latency:p.latency,
          responses:p.responses,timeline:p.timeline?.read(),pending:p.pending.map(input=>({inputId:input.id,stamp:input.at,delivered:input.delivered,pixels:input.pixels}))};
      })()`, signal));
      evidence.save('panning-partial', {...scenario, partial});
    } catch {evidence.save('panning-partial', {status: 'unavailable', ...scenario});}
    throw error;
  } finally {
    at('cleanup');
    if (failed) {
      // A dead renderer must not replace the failed scenario with a cleanup timeout.
      try {
        await deadline(5000, async signal => {
          await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1}, signal);
          if (interception) await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1}, signal);
          await cdp.evaluate(`(() => {window.__quotumPan?.cleanup();document.getElementById('quotum-pan-layout')?.remove();const p=JSON.parse(localStorage.getItem('quotum.prefs')||'{}');p.horizon=${JSON.stringify(originalHorizon)};localStorage.setItem('quotum.prefs',JSON.stringify(p));})()`, signal);
          await cdp.send('Emulation.clearDeviceMetricsOverride', {}, signal);
        });
      } catch {evidence?.save('panning-cleanup', {status: 'incomplete'});}
    } else {
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    if (interception) await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    await cdp.evaluate(`(() => {window.__quotumPan?.cleanup();document.getElementById('quotum-pan-layout')?.remove();})()`);
    try {
      if (await cdp.evaluate<boolean>(`!document.querySelector('.history .popover')`)) await click('.history .panel-head .picker > button');
      await click('.history .popover .segmented button', Math.max(0, ['auto', '1d', '3d', '7d'].indexOf(originalHorizon)));
      await key(true, 'Escape', 27); await key(false, 'Escape', 27);
    } catch {
      // A failed setup retains its original error; the benchmark owns and closes its tab.
      await cdp.evaluate(`(() => {const p=JSON.parse(localStorage.getItem('quotum.prefs')||'{}');p.horizon=${JSON.stringify(originalHorizon)};localStorage.setItem('quotum.prefs',JSON.stringify(p));})()`);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    }
  }
}
