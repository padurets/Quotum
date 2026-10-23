import type {Cdp} from './cdp.js';
import type {IdleCpuDiagnostic} from './idleCpuDiagnostic.js';
import {panningProblems, type PanReading,type NativePanTarget} from './panningBudget.js';
import {panTransactionsScript, panPartialScript} from './panEvidence.js';
import {deadline} from './deadline.js';
import {panningReload,type ReloadDiagnostic} from './panningReload.js';
import {panningSettlement} from './panningFailure.js';

/** Native input against the real charts; the temporary layout brings all five into view. */
export async function panning(cdp: Pick<Cdp, 'send' | 'evaluate' | 'on'> & Partial<Pick<Cdp, 'at'|'off'|'snapshot'>>, pace: (ms: number) => Promise<unknown> = ms => new Promise(resolve => setTimeout(resolve, ms)), options?: {save(name: string, value: unknown): void; saveTrace?(name:string,value:unknown):void; selection?: 'quota24'}|ReloadDiagnostic, diagnoseReload?:ReloadDiagnostic, nativeTrace?:()=>IdleCpuDiagnostic, nativeTarget:NativePanTarget='activity/24h') {
  const evidence=typeof options==='function'?undefined:options;
  diagnoseReload??=typeof options==='function'?options:undefined;
  cdp.at?.('panning/setup');
  let stage='native/setup';
  const progress=(next:string)=>{stage='native/'+next;cdp.at?.(stage);console.log('bench: '+stage);};
  const wait = (ms: number) => cdp.evaluate(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
  const key = (down: boolean, name: string, code: number) => cdp.send('Input.dispatchKeyEvent', {type: down ? 'keyDown' : 'keyUp', key: name, code: name === 'Shift' ? 'ShiftLeft' : name, windowsVirtualKeyCode: code, modifiers: down && name === 'Shift' ? 8 : 0});
  const mouse = (type: string, x: number, y: number, modifiers = 0) => cdp.send('Input.dispatchMouseEvent', {type, x, y, modifiers, button: type === 'mouseMoved' && !modifiers ? 'none' : 'left', buttons: type === 'mousePressed' || type === 'mouseMoved' && modifiers ? 1 : 0, clickCount: type === 'mouseMoved' ? undefined : 1});
  const click = async (selector: string, index = 0) => {
    const point = await cdp.evaluate<{x: number; y: number}>(`(async () => {const until=Date.now()+5000;let element;while(!(element=document.querySelectorAll(${JSON.stringify(selector)})[${index}])){if(Date.now()>until)throw new Error('missing native input target: '+${JSON.stringify(selector)});await new Promise(r=>setTimeout(r,20));}element.scrollIntoView({block:element.closest('.popover')?'nearest':'center'});await new Promise(requestAnimationFrame);const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await mouse('mouseMoved', point.x, point.y);
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseReleased', point.x, point.y);
  };
  const settled = () => cdp.evaluate(`(async()=>{const until=Date.now()+15000,p=new URLSearchParams(location.search),wanted=p.has('from')?p.get('from')+'-'+p.get('to'):JSON.parse(localStorage.getItem('quotum.prefs')||'{}').range||'24h';
    // Live collections avoid whole-board selector scans during measured movement.
    const loading=document.getElementsByClassName('is-loading'),charts=document.getElementsByClassName('chart'),tables=['forecast','budget-table','agents-panel'].map(name=>document.getElementsByClassName(name));
    const pending=()=>{
      for(const node of loading)if(['history','activity','budget-history','subscription-funds','agents-panel'].some(name=>node.classList.contains(name)))return true;
      for(const chart of charts)for(const svg of chart.children)if(svg.localName==='svg'&&(svg.hasAttribute('data-pan-end')||svg.getAttribute('data-draw-ready')==='false'||svg.classList.contains('is-panning')))return true;
      for(const group of tables)for(const table of group)if(table.dataset.historyRange!==wanted)return true;
      return false;
    };
    while(pending()){if(Date.now()>until)throw new Error('charts and complete totals did not settle: '+JSON.stringify({wanted,period:window.__quotumPeriodState?.(),panels:[...document.querySelectorAll('.history,.activity,.budget-history,.subscription-funds,.forecast,.budget-table,.agents-panel')].map(panel=>({class:panel.className,range:panel.dataset.historyRange,error:panel.querySelector('.history-error')?.textContent,panning:panel.querySelector('.chart>svg')?.classList.contains('is-panning')??null,plot:panel.querySelector('.chart>svg')?.dataset})),flights:window.__quotumPan?[...window.__quotumPan.flights.values()]:[]}));await new Promise(r=>setTimeout(r,20));}await new Promise(r=>setTimeout(r,250));})()`);
  const reports: PanReading[] = [];
  // Count independent measured series intersecting the visible plot, never path parts.
  // These layout reads happen after settling, outside the moving-frame probe.
  const density = () => cdp.evaluate<Omit<PanReading['edgeSeries'][number],'stage'>>(`(() => {
    const count=id=>{const panel=document.querySelector('[data-widget="'+id+'"]'),svg=panel.querySelector('.chart>svg'),r=svg.getBoundingClientRect(),box=svg.viewBox.baseVal.width,left=r.left+(id.startsWith('quota')?40:76)*r.width/box,right=r.right-12*r.width/box;
      return new Set([...panel.querySelectorAll('[data-series]')].filter(group=>
        [...group.querySelectorAll('.series[d]:not([d=""])')].some(path=>{const p=path.getBoundingClientRect();return p.right>left&&p.left<right;})
      ).map(group=>group.dataset.series)).size;};
    return {series:count('quota-history'),sessionSeries:count('quota-session-history'),budgetSeries:count('budget-history'),fundsSeries:count('subscription-funds')};
  })()`);
  const originalHorizon = await cdp.evaluate<string>(`JSON.parse(localStorage.getItem('quotum.prefs')||'{}').horizon||'auto'`);
  let interception = false, failed = false;
  let scenario: {initiator: string; period?: string} | undefined;
  const at = (stage: string) => cdp.at?.(['panning', scenario?.initiator, scenario?.period, stage].filter(Boolean).join('/'));
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 2400, deviceScaleFactor: 1, mobile: false});
  try {
    for (const initiator of evidence?.selection === 'quota24' ? ['quota'] as const : ['quota', 'session', 'activity', 'budget', 'funds'] as const) {
      scenario = {initiator};
      at('load');
      // A newly opened board gives each input owner an independently unread edge.
      progress(`${initiator}/reload`);
      const familyTrace=initiator===nativeTarget.split('/')[0]?nativeTrace?.():undefined;
      await panningReload(cdp,initiator,diagnoseReload);
      progress(`${initiator}/charts-open`);
      await cdp.evaluate(`(async()=>{window.__quotumBench?.pause();const until=Date.now()+15000;while(!['quota-history','quota-session-history','activity','budget-history','subscription-funds'].every(id=>document.querySelector('[data-widget="'+id+'"] .chart>svg'))){if(Date.now()>until)throw new Error('panning charts did not open');await new Promise(r=>setTimeout(r,20));}})()`);
      // Diagnostic entry points also start with the shared filters collapsed.
      await cdp.evaluate(`(async()=>{const toggle=document.querySelector('.filter-toggle > button');if(toggle?.getAttribute('aria-expanded')==='false')toggle.click();const until=Date.now()+5000;while(document.querySelector('.analytics-head')?.hidden){if(Date.now()>until)throw new Error('shared chart controls did not open');await new Promise(requestAnimationFrame);}})()`);
      const selector = '[data-widget="'+({quota:'quota-history',session:'quota-session-history',activity:'activity',budget:'budget-history',funds:'subscription-funds'} as const)[initiator]+'"]';
      const inset = initiator === 'quota'||initiator==='session' ? 52 : initiator==='activity'?60:88;
      await cdp.evaluate(`(() => {
    const style=document.createElement('style'); style.id='quotum-pan-layout';
    // Clear inherited stretch on hidden cards too: all widgets now share this grid.
    style.textContent='.widgets{display:flex!important;flex-direction:column!important}.widget{height:auto!important;--fill:0px!important}.widget:not(:has(.history,.activity,.budget-history,.subscription-funds)){display:none!important}.widget:has(.history){order:1}.widget:has(.activity){order:2}.widget:has(.budget-history){order:3}.widget:has(.subscription-funds){order:4}.widget-body{height:auto!important}.widget-body>.panel{--fill:0px!important}.history .chart>svg{height:200px!important}.activity .chart>svg{height:140px!important}.budget-history .chart>svg,.subscription-funds .chart>svg{height:200px!important}.legend{max-height:48px;overflow:auto}.activity .legend{max-height:40px}';
    document.head.append(style); document.querySelector('.analytics-head')?.scrollIntoView();
  })()`);
    // A manual horizon keeps the 30d source's full 1.25-width path inside retention.
    await click('.filter-control[data-filter="history.horizon"] .picker > button');
    await click('.filter-control[data-filter="history.horizon"] .popover .popover-row', 1);
    await key(true, 'Escape', 27); await key(false, 'Escape', 27);
    for (const [period, index] of evidence?.selection === 'quota24' ? [['24h', 4]] as const : [['24h', 4], ['30d', 8]] as const) {
      scenario = {initiator, period};
      at('setup');
      progress(`${initiator}/${period}/select`);
      await click('.period .picker > button');
      await click('.period .popover .popover-row', index);
      await settled();
      progress(`${initiator}/${period}/prepare`);
      await cdp.evaluate(`(async () => {for(let i=0;i<3;i++){await new Promise(requestAnimationFrame);const top=Math.min(...['quota-history','quota-session-history','activity','budget-history','subscription-funds'].map(id=>document.querySelector('[data-widget="'+id+'"] .chart>svg').getBoundingClientRect().top));scrollBy(0,top-140);}})()`);
      const geometry = {...await cdp.evaluate<{x: number; y: number; width: number; charts: number}>(`(() => {
        const svg=document.querySelector('${selector} .chart>svg'), r=svg.getBoundingClientRect();
        const charts=[...document.querySelectorAll('.chart>svg')].filter(e=>{const b=e.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight;}).length;
        return {x:r.left+r.width*.5,y:r.top+80,width:r.width*(svg.viewBox.baseVal.width-${inset})/svg.viewBox.baseVal.width,charts};
      })()`),...await density()};
      evidence?.save('panning-stage', {initiator, period, stage: 'starting', viewport: [1280,2400], throttle: 4, geometry});
      const edgeSeries:PanReading['edgeSeries']=[];
      const traced=period===nativeTarget.split('/')[1]?familyTrace:undefined;
      const detailed=!!traced&&nativeTarget==='session/30d';
      const samplerSource=`(() => {
        const initiator=${JSON.stringify(initiator)},period=${JSON.stringify(period)};
        const transactions=${panTransactionsScript()};let nextRequest=0;
        const charts=['quota-history','activity','budget-history','subscription-funds','quota-session-history'].map(id=>document.querySelector('[data-widget="'+id+'"] .chart>svg')),driver=({quota:0,activity:1,budget:2,funds:3,session:4})[initiator],root=charts[driver],views=charts.map(svg=>svg.viewBox.baseVal.width),scales=charts.map((svg,i)=>svg.getBoundingClientRect().width/views[i]),size=svg=>svg.getAttribute('viewBox')+':'+svg.style.height,sizes=charts.map(size);
        // PlotLayer retains these owners while React replaces their path children.
        // Repeated selectors inside every production RAF would load the measurement itself.
        const layers=charts.map((svg,i)=>svg.parentElement.querySelector(i===1?'.plot-clip.is-band .plot-move':'.plot-move[data-plot-main]')),slides=layers.map(layer=>layer.querySelector('.slides'));
        const activityClip=charts[1].parentElement.querySelector('.plot-clip.is-band'),clips=[];let clip=activityClip;
        for(let i=0;i<4;i++,clip=clip.firstElementChild)clips.push(clip);
        const bands=[...charts[1].parentElement.querySelectorAll('.plot-move')].filter(layer=>layer.querySelector('.activity-stack'));
        const connected=()=>layers.every((layer,i)=>layer.isConnected!==false&&slides[i].isConnected!==false)&&clips.every(clip=>clip.isConnected!==false);
        const probe=window.__quotumPan={initiator,period,frames:[],latency:[],responses:[],inputs:0,updated:0,chartUpdates:Array(5).fill(0),synchronized:true,pending:[],last:0,pushesDuring:0,pushesAfter:0,forbiddenMutations:0,mutationSamples:[],undimmed:getComputedStyle(root).opacity==='1',sizeStable:true,coldReads:0,peakFlights:0,maxTiles:0,duplicateReads:0,flights:new Map(),running:true,feeding:false,segment:'wheel',samples:[],wheelGapMs:0,lastWheel:null};
        ${detailed?`// One bounded journal extends the existing probe only in the selected diagnostic cell.
        const detail={limit:4096,count:0,omitted:0,startedAt:performance.now(),stoppedAt:0,preparationAttached:false,preparationRestored:false,preparationJobsAtAttach:null,preparationPendingAtAttach:null,frames:[],inputs:[],callbacks:[],preparations:[]};
        let sampleSerial=0,activeSample=0,rafSerial=0,activeRaf=0;
        const keep=(kind,row)=>{if(detail.count>=detail.limit){detail.omitted++;return false;}detail.count++;detail[kind].push(row);return true;};
        const scheduler=window.__quotumPanPreparations,env=scheduler?.env,post=env?.post;
        const observedPost=typeof post!=='function'?null:function(run){return post.call(this,()=>{
          if(!probe.running)return run();
          const at=performance.now(),jobsBefore=scheduler.size;
          try{return run();}finally{keep('preparations',{at,to:performance.now(),jobsBefore,jobsAfter:scheduler.size});}
        });};
        if(observedPost){detail.preparationJobsAtAttach=scheduler.size;detail.preparationPendingAtAttach=typeof scheduler.pending==='boolean'?scheduler.pending:null;env.post=observedPost;detail.preparationAttached=true;}
        probe.stopDiagnostic=()=>{detail.stoppedAt=performance.now();if(observedPost&&env.post===observedPost){env.post=post;detail.preparationRestored=true;}};
        probe.readDiagnostic=()=>({status:!probe.running&&!detail.omitted&&detail.preparationAttached&&detail.preparationRestored&&detail.preparationJobsAtAttach===0&&detail.preparationPendingAtAttach===false&&detail.frames.length===probe.frames.length&&detail.inputs.length===probe.inputs?'complete':'insufficient-evidence',initiator,period,timeOrigin:performance.timeOrigin,...detail});
        `:''}const originalPush=history.pushState.bind(history);probe.originalPush=originalPush;
        history.pushState=(...args)=>{if(probe.feeding){probe.pushesDuring++;transactions.push(probe.segment,root.dataset.panToken===undefined?NaN:Number(root.dataset.panToken));}else probe.pushesAfter++;originalPush(...args);};
        probe.returnSnapshot=()=>({now:Date.now(),url:location.search,charts:charts.map((svg,i)=>{
          const left=i===1?48:i===0||i===4?40:76,box=svg.viewBox.baseVal.width,inner=box-left-12,r=svg.getBoundingClientRect(),scale=r.width/box;
          const layer=svg.parentElement.querySelector(i===1?'.plot-clip.is-band .plot-move':'.plot-move[data-plot-main]'),slides=layer.querySelector('.slides'),matrix=slides.getScreenCTM();
          const from=Number(svg.dataset.drawFrom),to=Number(svg.dataset.drawTo),span=Math.max(60000,to-from);
          const timeAt=x=>from+((x-matrix.e)/matrix.a-left)/inner*span;
          return {from,to,ready:svg.dataset.drawReady,panning:svg.classList.contains('is-panning'),visibleFrom:timeAt(r.left+left*scale),visibleTo:timeAt(r.right-12*scale),perMs:matrix.a*inner/span,panOrigin:svg.dataset.panOrigin,panScale:svg.dataset.panScale,matrix:{a:matrix.a,e:matrix.e}};
        })});
        const owner=root.parentElement,types=['wheel','pointerdown','pointermove','pointerup'];
        const transforms=new Map();
        const matrixOf=value=>{const key=value||'none';let matrix=transforms.get(key);if(!matrix){const raw=new DOMMatrix(key==='none'?undefined:key);matrix={a:raw.a,e:raw.e};transforms.set(key,matrix);if(transforms.size>64)transforms.delete(transforms.keys().next().value);}return matrix;};
        // The plot's px/scale animations expose computed matrices without used-value layout.
        const foldMatrix=owner=>{
          const value=owner.computedStyleMap?.().get('transform');
          if(value?.value==='none')return matrixOf('none');
          try{if(typeof value?.toMatrix==='function')return value.toMatrix();}catch{}
          return matrixOf(getComputedStyle(owner).transform);
        };
        let gesture=null;
        const capturedInputs=new WeakMap();
        const capture=e=>{const delivered=performance.now(),at=e.timeStamp>1e12?e.timeStamp-performance.timeOrigin:e.timeStamp;capturedInputs.set(e,{at:Math.min(delivered,at),delivered});if(probe.running&&probe.feeding&&e.type==='wheel')transactions.input(at,delivered,probe.segment);};
        const owners=()=>layers;
        // Inline frozen matrices and the committed domain are enough during input;
        // no computed style or SVG layout read belongs in this moving-frame probe.
        const presentation=(svg,layer,i,at)=>{
          const left=i===1?48:i===0||i===4?40:76,inner=views[i]-left-12,span=Number(svg.dataset.drawTo)-Number(svg.dataset.drawFrom),matrix=matrixOf(slides[i].style.transform),outer=matrixOf(layer.style.transform);
          const shown={x:scales[i]*(matrix.a*(left+(at-Number(svg.dataset.drawFrom))/span*inner)+matrix.e)+outer.e,perMs:scales[i]*matrix.a*inner/span};
          if(i===1){let a=1,b=0;if(activityClip.style.visibility==='hidden')return{x:NaN,perMs:NaN};for(const node of clips){const m=matrixOf(node.style.transform);b+=a*m.e;a*=m.a;}const origin=left*scales[i];return{x:origin+b+a*(shown.x-origin),perMs:a*shown.perMs};}
          return shown;
        };
        const begin=(token,x)=>{const origin=Number(root.dataset.panOrigin),layers=owners();gesture={token,pixels:0,requestedPixels:0,x,origin,shown:charts.map((svg,i)=>presentation(svg,layers[i],i,origin)),started:!!root.dataset.panEnd,scale:Number(root.dataset.panScale),baseline:Number(root.dataset.panBase||0),minEnd:Number(root.dataset.panMinEnd),maxEnd:Number(root.dataset.panMaxEnd)};};
        const input=e=>{
          const captured=capturedInputs.get(e);if(!captured)return;capturedInputs.delete(e);
          const token=root.dataset.panToken;
          // The native handler can finish an expired wheel transaction and
          // begin another one in this event. Observe its resulting token.
          if(e.type==='pointerdown'){if(!gesture||gesture.token!==token)begin(token,e.clientX);else gesture.x=e.clientX;return;}
          if(e.type==='pointerup')return;
          let delta;
          if(e.type==='wheel'){
            if(!e.cancelable||(!e.deltaX&&!e.shiftKey))return;
            if(probe.lastWheel?.segment===probe.segment)probe.wheelGapMs=Math.max(probe.wheelGapMs,captured.at-probe.lastWheel.at);
            probe.lastWheel={segment:probe.segment,at:captured.at};
            if(!gesture||gesture.token!==token)begin(token);
            const unit=[1,16,400][e.deltaMode]||1;
            delta=-(e.deltaX||(e.shiftKey?e.deltaY:0))*unit;
            if(probe.returnInput){const trace=probe.returnInput;trace.pixels-=(e.deltaX||(e.shiftKey?e.deltaY:0))*unit;trace.events++;if(trace.tokens.at(-1)?.token!==token)trace.tokens.push({token,origin:Number(root.dataset.panOrigin),scale:Number(root.dataset.panScale),at:e.timeStamp,delivered:captured.delivered,pixels:trace.pixels});trace.last={at:e.timeStamp,delivered:captured.delivered};}
          }else{
            if(!e.buttons||!gesture)return;
            delta=e.clientX-gesture.x;gesture.x=e.clientX;
          }
          gesture.requestedPixels+=delta;
          const wanted=gesture.pixels+delta;
          gesture.pixels=Math.max((gesture.origin-gesture.maxEnd)/gesture.scale,Math.min((gesture.origin-gesture.minEnd)/gesture.scale,wanted));
          probe.inputs++;
          const input={id:probe.inputs,...captured,segment:probe.segment,pixels:gesture.pixels,clamped:Math.abs(wanted-gesture.pixels)>1e-9,gesture};
          probe.pending.push(input);
        };
        for(const type of types){owner.addEventListener(type,capture,true);window.addEventListener(type,input);}
        const originalFetch=window.fetch.bind(window);probe.originalFetch=originalFetch;
        window.fetch=async(...args)=>{
          const url=new URL(String(args[0]),location.href),legacy=url.pathname==='/api/history';if(!legacy&&!new RegExp('^/api/boards/[^/]+/period(?:/sessions)?$').test(url.pathname))return originalFetch(...args);
          const body=legacy?null:JSON.parse(args[1]?.body||'{}');
          const sections=legacy?[Object.fromEntries(url.searchParams)]:['quota','budget','funds'].filter(scope=>body[scope]&&body[scope].cells!=='skip').map(scope=>({...body[scope],scope:scope==='funds'?'budget':scope}));
          const ranges=sections.map(q=>({scope:JSON.stringify([q.scope,q.meters,q.unit,q.currency]),cell:Number(q.cell),from:Number(q.from),to:Number(q.to)}));
          for(const q of ranges){for(const f of probe.flights.values())for(const other of f)if(other.scope===q.scope&&other.cell===q.cell&&other.from<q.to&&other.to>q.from)probe.duplicateReads++;probe.maxTiles=Math.max(probe.maxTiles,Math.floor((q.to-1)/(q.cell*60))-Math.floor(q.from/(q.cell*60))+1);}
          const id=++nextRequest,signal=args[1]?.signal,aborted=()=>{probe.flights.delete(id);};probe.flights.set(id,ranges);signal?.addEventListener('abort',aborted,{once:true});probe.peakFlights=Math.max(probe.peakFlights,probe.flights.size);probe.coldReads++;
          try {
            const response=await originalFetch(...args);
            return response;
          }finally{probe.flights.delete(id);signal?.removeEventListener('abort',aborted);}
        };
        probe.observer=new MutationObserver(records=>{
          if(!probe.running||!probe.feeding)return;
          for(const record of records){const element=record.target.nodeType===1?record.target:record.target.parentElement,panel=element?.closest('.card,.topbar,.agents-panel,.forecast,.budget-table,.activity-totals');if(!panel)continue;const clock=element.closest('[data-time]'),timeOnly=clock&&clock.getAttribute('data-time')!=='chart';if(!timeOnly){
            probe.forbiddenMutations++;
            // Keep only structural provenance, never text, values or source IDs.
            if(probe.mutationSamples.length<24)probe.mutationSamples.push({segment:probe.segment,surface:['card','topbar','agents-panel','forecast','budget-table','activity-totals'].find(name=>panel.classList.contains(name)),tag:element.tagName,type:record.type,attribute:record.attributeName??null,measurement:!!element.closest('.table-measure'),panning:!!root.dataset.panEnd});
          }}
        });probe.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
        const originalRAF=window.requestAnimationFrame||requestAnimationFrame;
        const schedule=callback=>originalRAF.call(window,callback);
        let previous=charts.map(()=>'0:1'),phase='idle',lastFrame=null,paintedToken=null;
        let sampleEntry=0,callbacksSinceMovingFrame=0,maxCallbackGapMs=0,samplerMs=0;
        const consume=(count,now,stamp,reachedGesture)=>{const reached=probe.pending.slice(0,count).filter(input=>input.gesture===reachedGesture);probe.pending=probe.pending.filter((input,i)=>i>=count||input.gesture!==reachedGesture);for(const input of reached){const ms=now-input.at;probe.latency.push(ms);probe.responses.push({ms,queued:input.delivered-input.at,processed:now-input.delivered,segment:input.segment,requests:probe.flights.size${evidence?.selection === 'quota24' ? ',at:input.at,delivered:input.delivered,reached:now,id:input.id' : ''}});${detailed?`const response=probe.responses.at(-1);if(keep('inputs',response))Object.assign(response,{id:input.id,sampleId:activeSample,rafId:activeRaf,token:Number.isFinite(Number(input.gesture.token))?Number(input.gesture.token):null,at:input.at,delivered:input.delivered,reached:now});`:''}}};
        const sample=(stamp,afterCallback=false)=>{
          if(!probe.running)return;
          const now=performance.now();${detailed?'activeSample=++sampleSerial;':''}
          try {
          const demand=probe.pending.length,layers=owners(),active=!!root.dataset.panEnd;
          // Count sample entries, including callbacks with the same RAF timestamp.
          if(probe.last){callbacksSinceMovingFrame++;maxCallbackGapMs=Math.max(maxCallbackGapMs,now-sampleEntry);}
          sampleEntry=now;
          const folds=active?[]:layers.map((layer,i)=>{
            for(const owner of [layer,slides[i]]){const animation=owner.getAnimations().find(a=>a.playState==='running');if(animation)return{owner,animation};}
            return null;
          }),folding=folds.some(Boolean);
          probe.sizeStable&&=connected()&&charts.every((svg,i)=>svg.isConnected&&size(svg)===sizes[i]);
          const actual=active?charts.map((svg,i)=>presentation(svg,layers[i],i,gesture?.origin)):null;
          const matrices=layers.map((layer,i)=>{const owner=folds[i]?.owner,matrix=active?matrixOf(layer.style.transform):owner?foldMatrix(owner):matrixOf('none');return owner&&owner!==layer?{a:matrix.a,e:matrix.e*scales[i]}:matrix;});
          const current=actual?actual.map(p=>p.x+':'+p.perMs):matrices.map(matrix=>matrix.e+':'+matrix.a);
          const nextPhase=active?'pan':folding?'fold':'idle';
          // The wheel's intentional 200 ms rest is stationary, before the fold begins.
          if(nextPhase!==phase||active&&paintedToken!==root.dataset.panToken){probe.last=0;lastFrame=null;previous=nextPhase==='pan'&&gesture?gesture.shown.map(p=>p.x+':'+p.perMs):current;phase=nextPhase;paintedToken=root.dataset.panToken;}
          const moved=current.map((value,i)=>value!==previous[i]);
          if(active){probe.synchronized&&=connected()&&charts.every((svg,i)=>{const shown=gesture?.shown[i],point=actual[i],delta=(Number(svg.dataset.panEnd)-Number(svg.dataset.panOrigin));return svg.dataset.panEnd===root.dataset.panEnd&&Math.abs(delta/Number(svg.dataset.panScale)+matrices[i].e-Number(svg.dataset.panBase||0))<.01&&shown&&Number.isFinite(point.x)&&Math.abs(point.perMs*Number(svg.dataset.panScale)-1)<1e-6&&Math.abs(point.perMs/shown.perMs-1)<1e-6&&Math.abs(point.x-(shown.x-delta*shown.perMs))<.1;})&&bands.every(layer=>layer.isConnected!==false&&Math.abs(matrixOf(layer.style.transform).e-matrices[1].e)<.01);moved.forEach((changed,i)=>{if(changed)probe.chartUpdates[i]++;});}
          // Every input reaches all five plots; their finishing animations can
          // end separately, so an idle quota plot cannot hide a moving follower.
          if(active&&probe.synchronized&&(moved.every(Boolean)||afterCallback||probe.pending.some(input=>input.gesture===gesture&&input.clamped))){
            // Coalesced input reaches its final position together. A newer event
            // cannot be credited by the artwork of an earlier event.
            let reached=-1;
            for(let i=0;i<probe.pending.length;i++){const input=probe.pending[i];if(input.gesture===gesture&&Math.abs(input.gesture.baseline+input.pixels-matrices[driver].e)<.1)reached=i;}
            if(reached>=0)consume(reached+1,now,stamp,gesture);
          }
          if(active&&moved.every(Boolean)||folding&&moved.some(Boolean)){
            if(stamp!==lastFrame){
              probe.updated++;
              if(probe.last){
                const ms=now-probe.last;probe.frames.push(ms);
                const receipt={at:now,stamp,ms,segment:folding?'fold':probe.segment,inputSegment:probe.segment,pending:demand,requests:probe.flights.size};
                if(ms>50){receipt.callbacksSinceMovingFrame=callbacksSinceMovingFrame;receipt.maxCallbackGapMs=maxCallbackGapMs;receipt.samplerMs=samplerMs;receipt.foldMask=folds.reduce((mask,fold,i)=>mask|(fold?1<<i:0),0);receipt.svgFoldMask=folds.reduce((mask,fold,i)=>mask|(fold&&fold.owner===slides[i]?1<<i:0),0);receipt.movedMask=moved.reduce((mask,changed,i)=>mask|(changed?1<<i:0),0);}
                ${detailed?`if(keep('frames',receipt))Object.assign(receipt,{index:probe.frames.length-1,sampleId:activeSample,rafId:activeRaf,token:Number.isFinite(Number(root.dataset.panToken))?Number(root.dataset.panToken):null});`:''}probe.samples.push(receipt);
              }
              probe.last=now;lastFrame=stamp;callbacksSinceMovingFrame=0;maxCallbackGapMs=0;samplerMs=0;
            }
          }
          if(!active&&!folding&&probe.pending.length&&charts.every(svg=>svg.dataset.drawReady==='true'&&!svg.classList.contains('is-panning'))){
            // Release may commit the last coalesced input before its own RAF.
            // Its effect is observable only in the committed geometry. A historical
            // handoff retains its SVG pose instead of resetting it to identity.
            const ends=charts.map(svg=>Number(svg.parentElement.dataset.axisEnd)),selected=new URLSearchParams(location.search).has('to');
            let reached=-1;
            for(let i=0;i<probe.pending.length;i++){const input=probe.pending[i],g=input.gesture;const tolerance=selected?1.1:8*g.scale+1.1;
              const landmarks=!selected||charts.every((svg,j)=>{const actual=presentation(svg,layers[j],j,g.origin),shown=g.shown[j],shift=input.pixels*g.scale;return [0,-g.scale*views[driver]*scales[driver]/2].every(offset=>Math.abs(actual.x+offset*actual.perMs-(shown.x+(offset+shift)*shown.perMs))<=1);});
              if(g===gesture&&g.started&&g.scale>0&&ends.every(end=>Math.abs(end-(g.origin-input.pixels*g.scale))<=tolerance)&&landmarks)reached=i;}
            if(reached>=0)consume(reached+1,now,stamp,gesture);
          }
          if(!active&&!folding)probe.last=0;
          previous=current;probe.undimmed&&=charts.every(svg=>!svg.closest('.is-loading')&&(!svg.style.opacity||svg.style.opacity==='1'));
          // The current body belongs to the next movement interval.
          } finally {if(probe.last)samplerMs+=performance.now()-now;}
        };
        // An unrelated preparation RAF cannot present new input. Inspect all
        // five drawings only when the initiator's real drawing has changed.
        const painted=()=>[root.dataset.panToken,root.dataset.panEnd,layers[driver].style.transform,slides[driver].style.transform,root.dataset.drawFrom,root.dataset.drawTo].join(':');
        let lastPaint=painted();
        window.requestAnimationFrame=callback=>${detailed?'((id)=>':''}schedule(stamp=>{${detailed?'const at=performance.now(),sampleFrom=sampleSerial,before=activeRaf;activeRaf=id;':''}try{callback.call(window,stamp);}finally{
          if(probe.running&&probe.pending.length){const next=painted();if(next!==lastPaint){lastPaint=next;sample(stamp,true);}}
          ${detailed?"if(probe.running)keep('callbacks',{id,stamp,at,to:performance.now(),sampleFrom,sampleTo:sampleSerial});activeRaf=before;":''}
        }})${detailed?')(++rafSerial)':''};
        const tick=stamp=>{
          if(!probe.running)return;
          // A clamped delta requests the already bounded pose and may schedule no
          // production RAF. Observe it without adding a stationary movement frame.
          if(!root.dataset.panEnd||probe.pending.some(input=>input.clamped))sample(stamp);
          // Input-free stationary frames carry no movement demand. A pending
          // event keeps the interval open, so delayed work still fails budget.
          if(root.dataset.panEnd&&!probe.pending.length&&lastFrame!==stamp)probe.last=0;
          probe.raf=schedule(tick);
        };
        probe.readTransactions=()=>transactions.read();
        probe.cleanup=()=>{probe.running=false;${detailed?'probe.stopDiagnostic();':''}cancelAnimationFrame(probe.raf);probe.observer.disconnect();for(const type of types){owner.removeEventListener(type,capture,true);window.removeEventListener(type,input);}window.requestAnimationFrame=originalRAF;window.fetch=originalFetch;history.pushState=originalPush;};
        probe.raf=schedule(tick);
      })()`;
      await cdp.evaluate(samplerSource);
      traced?.binding.rememberInjected(1,samplerSource);
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
      // A delayed cold edge is part of the moving interval, including arrivals/rebuilds.
      await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1});
      interception = true;
      if(traced)await traced.start();
      const wheel = (dx: number, shift = false) => cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX: dx, deltaY: 0, modifiers: shift ? 8 : 0});
      const sent: Promise<unknown>[] = [];
      at('wheel');
      progress(`${initiator}/${period}/wheel`);
      await cdp.evaluate('window.__quotumPan.feeding=true');
      // Chrome owns one continuous native wheel gesture, including its reversal.
      const scroll = (distance: number, reverse = 0) => cdp.send('Input.synthesizeScrollGesture', {x: geometry.x, y: geometry.y, xDistance: distance, xOverscroll: reverse, yDistance: 0, speed: 720, gestureSourceType: 'mouse', preventFling: true});
      await scroll(geometry.width * 1.25, geometry.width * 1.25 / 3);
      await cdp.evaluate('window.__quotumPan.feeding=false');
      await wait(240);
      await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
      interception = false;
      progress(`${initiator}/${period}/wheel-settle`);
      await settled();
      edgeSeries.push({stage:'wheel',...await density()});
      // Shift-drag keeps capture when the pointer leaves the SVG, without extra inertia.
      at('drag');
      progress(`${initiator}/${period}/drag`);
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
      progress(`${initiator}/${period}/drag-settle`);
      await settled();
      edgeSeries.push({stage:'drag',...await density()});
      // Native Shift deltaX returns to live, then Back/Forward restore complete gestures.
      at('return');
      progress(`${initiator}/${period}/return-live`);
      sent.length = 0;
      await cdp.evaluate(`window.__quotumPan.segment='return'`);
      const returnBefore = await cdp.evaluate<unknown>('window.__quotumPan.returnSnapshot()');
      await cdp.evaluate('window.__quotumPan.returnInput={pixels:0,events:0,tokens:[]}');
      await cdp.evaluate('window.__quotumPan.feeding=true');
      const returnPixels = await cdp.evaluate<number>(`(() => {
        const to=Number(new URLSearchParams(location.search).get('to'));
        const svg=document.querySelector('${selector} .chart>svg'),box=svg.viewBox.baseVal.width;
        const slides=svg.parentElement.querySelector('${initiator==='activity'?'.plot-clip.is-band .slides':'[data-plot-main] .slides'}');
        const perMs=slides.getScreenCTM().a*(box-${inset})/(Number(svg.dataset.drawTo)-Number(svg.dataset.drawFrom));
        return (Date.now()-to)*perMs;
      })()`);
      await scroll(-Math.max(0, returnPixels - 4));
      await cdp.evaluate('window.__quotumPan.feeding=false');
      await wait(240); await settled();
      await cdp.evaluate('window.__quotumPan.returnAfter=window.__quotumPan.returnSnapshot()');
      at('report');
      const report = await cdp.evaluate<PanReading>(`(() => {
        const p=window.__quotumPan;p.cleanup();
        const segments={};for(const segment of ['wheel','drag','return','fold']){const values=p.samples.filter(s=>s.segment===segment).map(s=>s.ms).sort((a,b)=>a-b);segments[segment]={count:values.length,p95:values[Math.ceil(values.length*.95)-1]??0,max:values.at(-1)??0};}
        return {${detailed?'nativeDiagnostic:p.readDiagnostic(),':''}frames:p.frames,latency:p.latency,inputs:p.inputs,updated:p.updated,chartUpdates:p.chartUpdates,synchronized:p.synchronized,pushesDuring:p.pushesDuring,pushesAfter:p.pushesAfter,forbiddenMutations:p.forbiddenMutations,mutationSamples:p.mutationSamples,undimmed:p.undimmed,sizeStable:p.sizeStable,coldReads:p.coldReads,peakFlights:p.peakFlights,maxTiles:p.maxTiles,duplicateReads:p.duplicateReads,wheelGapMs:p.wheelGapMs,segments,transactions:p.readTransactions(),outliers:p.samples.filter(s=>s.ms>50),responses:p.responses.filter(r=>r.ms>34)};
      })()`);
      report.initiator = initiator; report.period = period; report.series = geometry.series; report.sessionSeries=geometry.sessionSeries; report.edgeSeries=edgeSeries; report.budgetSeries = geometry.budgetSeries; report.fundsSeries = geometry.fundsSeries; report.charts = geometry.charts; report.rate = 4; report.expectedPushes = 3;
      reports.push(report);
      // Keep the bounded diagnostic separate from the ordinary one-MiB summaries.
      const diagnostic=report.nativeDiagnostic;delete report.nativeDiagnostic;
      evidence?.save('panning-'+initiator+'-'+period,report);
      if(diagnostic){
        const bytes=Buffer.byteLength(JSON.stringify(diagnostic));
        evidence?.saveTrace?.('native-panning-receipt',bytes<=4*1024*1024?diagnostic:{status:'insufficient-evidence',reason:'native panning receipt byte limit',bytes,limit:4*1024*1024});
      }
      // The frozen report ends measurement; exporting diagnostics needs no CPU throttle.
      let diagnosticFailure:{error:unknown}|undefined;
      try{
        await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
        if(traced)await traced.stop();
      }catch(error){diagnosticFailure={error};}
      if(traced)try{await traced.bindAndClose();}catch(error){diagnosticFailure??={error};}
      if(diagnosticFailure)throw diagnosticFailure.error;
      at('postconditions');
      const live = await cdp.evaluate<boolean>(`!new URLSearchParams(location.search).has('from')`);
      if (!live) {
        const returned = await cdp.evaluate<unknown>('({after:window.__quotumPan.returnAfter,input:window.__quotumPan.returnInput})');
        throw new Error(`${initiator}/${period} pan did not return to live: ${JSON.stringify({before: returnBefore, returnPixels, returned, report})}`);
      }
      await cdp.evaluate('window.__quotumPan.returnInput=null');
      // Held Shift-wheel has the same uninterrupted scale as dragging, across rests.
      progress(`${initiator}/${period}/held-shift-and-navigation`);
      at('held-shift-hover');
      await mouse('mouseMoved', geometry.x, geometry.y);
      await key(true, 'Shift', 16);
      await wait(30);
      if (await cdp.evaluate<boolean>(`!!document.querySelector('.subscription-funds .tooltip,.history .tooltip,.budget-history .tooltip,.activity .tooltip,.activity-info[data-series-context]')`)) throw new Error('holding Shift left a chart readout visible');
      at('held-shift-first-minus-12');
      await wheel(-12, true); await wait(300);
      const first = await cdp.evaluate<number>(`new DOMMatrix(document.querySelector('${selector} ${initiator==='activity'?'.plot-clip.is-band .plot-move':'.plot-move[data-plot-main]'}').style.transform).e`);
      if (!(await cdp.evaluate<boolean>(`!!document.querySelector('[data-pan-end]')&&!new URLSearchParams(location.search).has('from')`))) throw new Error('Shift-wheel committed before Shift was released');
      at('held-shift-second-minus-12');
      await wheel(-12, true); await wait(240);
      const second = await cdp.evaluate<number>(`new DOMMatrix(document.querySelector('${selector} ${initiator==='activity'?'.plot-clip.is-band .plot-move':'.plot-move[data-plot-main]'}').style.transform).e`);
      if (!Number.isFinite(first) || first <= 0 || Math.abs(second - 2 * first) > .01) throw new Error('Shift-wheel changed its scale during a pause');
      at('held-shift-return-plus-24');
      await wheel(24, true); await wait(40);
      await key(false, 'Shift', 16); await wait(240);
      if (!(await cdp.evaluate<boolean>(`!document.querySelector('[data-pan-end]')&&!new URLSearchParams(location.search).has('from')`))) throw new Error('Shift-wheel return did not preserve live');
      await cdp.evaluate(`history.back()`); await wait(300); await settled();
      if (!(await cdp.evaluate<boolean>(`new URLSearchParams(location.search).has('from')`))) throw new Error('Back did not restore the whole previous gesture');
      await cdp.evaluate(`history.forward()`); await wait(300); await settled();
      if (!(await cdp.evaluate<boolean>(`!new URLSearchParams(location.search).has('from')`))) throw new Error('Forward did not restore live');
      // A wheel does not blur a keyboard-focused legend. Its preview must stay
      // hidden through ordinary panning, a latched drag and their final fold.
      progress(`${initiator}/${period}/legend`);
      const legendVisible = () => cdp.evaluate<boolean>(`[...document.querySelectorAll('.activity-info[data-series-context]')].some(tip=>getComputedStyle(tip).display!=='none')`);
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
      await cdp.evaluate(`history.back()`);
      await settled();
      progress(`${initiator}/${period}/complete`);
    }
      await cdp.evaluate(`document.getElementById('quotum-pan-layout')?.remove()`);
    }
    return {reports, problems: reports.flatMap(panningProblems)};
  } catch (error) {
    const command = cdp.snapshot?.();
    failed = true;
    evidence?.save('panning-failure', {status: 'failed', ...scenario, completed: reports.length, command, settlement: panningSettlement(error)});
    if (evidence) try {
      const partial = await deadline(5000, signal => cdp.evaluate(panPartialScript(scenario?.initiator,scenario?.period), signal));
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
      } catch {
        evidence?.save('panning-cleanup', {status: 'incomplete'});
        console.error('bench: '+stage+' cleanup failed; retaining original failure');
      }
    } else {
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    if (interception) await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    await cdp.evaluate(`(() => {window.__quotumPan?.cleanup();document.getElementById('quotum-pan-layout')?.remove();})()`);
    try {
      if (await cdp.evaluate<boolean>(`!document.querySelector('.filter-control[data-filter="history.horizon"] .popover')`)) await click('.filter-control[data-filter="history.horizon"] .picker > button');
      await click('.filter-control[data-filter="history.horizon"] .popover .popover-row', Math.max(0, ['auto', '1d', '3d', '7d'].indexOf(originalHorizon)));
      await key(true, 'Escape', 27); await key(false, 'Escape', 27);
    } catch {
      // A failed setup retains its original error; the benchmark owns and closes its tab.
      await cdp.evaluate(`(() => {const p=JSON.parse(localStorage.getItem('quotum.prefs')||'{}');p.horizon=${JSON.stringify(originalHorizon)};localStorage.setItem('quotum.prefs',JSON.stringify(p));})()`);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    }
  }
}
