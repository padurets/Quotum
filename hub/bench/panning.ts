import type {Cdp} from './cdp.js';
import {panningProblems, type PanReading} from './panningBudget.js';

/** Native input against the real charts; the temporary layout brings both into view. */
export async function panning(cdp: Pick<Cdp, 'send' | 'evaluate'>, pace: (ms: number) => Promise<unknown> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const wait = (ms: number) => cdp.evaluate(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
  const key = (down: boolean, name: string, code: number) => cdp.send('Input.dispatchKeyEvent', {type: down ? 'keyDown' : 'keyUp', key: name, code: name === 'Shift' ? 'ShiftLeft' : name, windowsVirtualKeyCode: code, modifiers: down && name === 'Shift' ? 8 : 0});
  const mouse = (type: string, x: number, y: number, modifiers = 0) => cdp.send('Input.dispatchMouseEvent', {type, x, y, modifiers, button: type === 'mouseMoved' && !modifiers ? 'none' : 'left', buttons: type === 'mousePressed' || type === 'mouseMoved' && modifiers ? 1 : 0, clickCount: type === 'mouseMoved' ? undefined : 1});
  const click = async (selector: string, index = 0) => {
    const point = await cdp.evaluate<{x: number; y: number}>(`(async () => {const until=Date.now()+5000;let element;while(!(element=document.querySelectorAll(${JSON.stringify(selector)})[${index}])){if(Date.now()>until)throw new Error('missing native input target: '+${JSON.stringify(selector)});await new Promise(r=>setTimeout(r,20));}if(!element.closest('.popover')){element.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);}const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await mouse('mouseMoved', point.x, point.y);
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseReleased', point.x, point.y);
  };
  const settled = () => cdp.evaluate(`(async()=>{const until=Date.now()+15000;while(document.querySelector('.history.is-loading, .activity.is-loading') || document.querySelector('.chart > svg[data-pan-end]')){if(Date.now()>until)throw new Error('charts did not settle');await new Promise(r=>setTimeout(r,20));}await new Promise(r=>setTimeout(r,250));})()`);
  const reports: PanReading[] = [];
  const originalHorizon = await cdp.evaluate<string>(`JSON.parse(localStorage.getItem('quotum.prefs')||'{}').horizon||'auto'`);
  let interception = false;
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
  await cdp.evaluate(`(() => {
    const style=document.createElement('style'); style.id='quotum-pan-layout';
    style.textContent='.widgets{display:flex!important;flex-direction:column!important}.widget{height:auto!important}.widget:not(:has(.history,.activity)){display:none!important}.widget:has(.history){order:1}.widget:has(.activity){order:2}.widget-body{height:auto!important}.widget-body>.panel{--fill:0px!important}.history .chart>svg{height:260px!important}.activity .chart>svg{height:180px!important}.legend{max-height:72px;overflow:auto}.activity .legend{max-height:40px}';
    document.head.append(style); document.querySelector('.analytics-head')?.scrollIntoView();
  })()`);
  try {
    // A manual horizon keeps the 30d source's full 1.25-width path inside retention.
    await click('.history .panel-head .picker > button');
    await click('.history .popover .segmented button', 1);
    await key(true, 'Escape', 27); await key(false, 'Escape', 27);
    for (const [period, index] of [['24h', 4], ['30d', 8]] as const) {
      await click('.period .picker > button');
      await click('.period .popover .popover-row', index);
      await settled();
      const geometry = await cdp.evaluate<{x: number; y: number; width: number; series: number; charts: number}>(`(() => {
        const svg=document.querySelector('.history .chart>svg'), r=svg.getBoundingClientRect();
        const charts=[...document.querySelectorAll('.chart>svg')].filter(e=>{const b=e.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight;}).length;
        return {x:r.left+r.width*.5,y:r.top+80,width:r.width*(svg.viewBox.baseVal.width-52)/svg.viewBox.baseVal.width,series:svg.querySelectorAll('.series[d]:not([d=""])').length,charts};
      })()`);
      await cdp.evaluate(`(() => {
        const root=document.querySelector('.history .chart>svg');
        const probe=window.__quotumPan={frames:[],latency:[],inputs:0,updated:0,pending:[],last:0,pushesDuring:0,pushesAfter:0,forbiddenMutations:0,undimmed:getComputedStyle(root).opacity==='1',coldReads:0,peakFlights:0,maxTiles:0,duplicateReads:0,flights:new Map(),running:true,feeding:false,segment:'wheel',samples:[]};
        const originalPush=history.pushState.bind(history);probe.originalPush=originalPush;
        history.pushState=(...args)=>{if(probe.feeding)probe.pushesDuring++;else probe.pushesAfter++;originalPush(...args);};
        const input=e=>{if(e.type==='wheel'&&(!e.cancelable||(!e.deltaX&&!e.shiftKey)))return;if(e.type==='pointermove'&&!e.buttons)return;probe.inputs++;probe.pending.push(performance.now());};
        root.addEventListener('wheel',input,true);root.addEventListener('pointermove',input,true);probe.input=input;
        const originalFetch=window.fetch.bind(window);probe.originalFetch=originalFetch;
        window.fetch=async(...args)=>{
          const url=new URL(String(args[0]),location.href);if(url.pathname!='/api/history')return originalFetch(...args);
          const cell=Number(url.searchParams.get('cell')),from=Number(url.searchParams.get('from')),to=Number(url.searchParams.get('to')),tiles=Math.floor((to-1)/(cell*60))-Math.floor(from/(cell*60))+1;
          for(const f of probe.flights.values())if(f.cell===cell&&f.from<to&&f.to>from)probe.duplicateReads++;
          const id={};probe.flights.set(id,{cell,from,to});probe.peakFlights=Math.max(probe.peakFlights,probe.flights.size);probe.maxTiles=Math.max(probe.maxTiles,tiles);probe.coldReads++;
          try {return await originalFetch(...args);}finally{probe.flights.delete(id);}
        };
        probe.observer=new MutationObserver(records=>{
          if(!probe.running||!probe.feeding)return;
          for(const record of records){const element=record.target.nodeType===1?record.target:record.target.parentElement,clock=element?.closest('[data-time]'),timeOnly=clock&&clock.getAttribute('data-time')!=='chart';if(element?.closest('.card,.topbar,.agents-panel,.forecast,.activity-totals')&&!timeOnly)probe.forbiddenMutations++;}
        });probe.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
        let previous='0:1',phase='idle';
        const tick=()=>{
          if(!probe.running)return;
          const now=performance.now(),layer=root.querySelector('.slides'),active=!!root.dataset.panEnd,folding=!active&&layer.getAnimations().some(a=>a.playState==='running');
          const transform=active?layer.style.transform:folding?getComputedStyle(layer).transform:'none',matrix=new DOMMatrix(transform&&transform!=='none'?transform:undefined),current=matrix.e+':'+matrix.a;
          const nextPhase=active?'pan':folding?'fold':'idle';
          // The wheel's intentional 200 ms rest is stationary, before the fold begins.
          if(nextPhase!==phase){probe.last=0;previous=current;phase=nextPhase;}
          if((active||folding)&&current!==previous){probe.updated++;if(probe.last){const ms=now-probe.last;probe.frames.push(ms);probe.samples.push({ms,segment:folding?'fold':probe.segment,pending:probe.pending.length,requests:probe.flights.size});}probe.last=now;probe.latency.push(...probe.pending.splice(0).map(at=>now-at));}
          if(!active&&!folding)probe.last=0;
          previous=current;probe.undimmed&&=!root.closest('.is-loading')&&(!root.style.opacity||root.style.opacity==='1');probe.raf=requestAnimationFrame(tick);
        };probe.raf=requestAnimationFrame(tick);
      })()`);
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
      // A delayed cold edge is part of the moving interval, including arrivals/rebuilds.
      await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1});
      interception = true;
      const wheel = (dx: number, shift = false) => cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX: dx, deltaY: 0, modifiers: shift ? 8 : 0});
      const sent: Promise<unknown>[] = [];
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
      await cdp.evaluate(`window.__quotumPan.segment='drag'`);
      await key(true, 'Shift', 16);
      await mouse('mousePressed', geometry.x, geometry.y, 8);
      await cdp.evaluate(`window.__quotumPan.undimmed&&=getComputedStyle(document.querySelector('.history .chart>svg')).opacity==='1'`);
      await cdp.evaluate('window.__quotumPan.feeding=true');
      sent.length = 0;
      for (let i = 1; i <= 60; i++) {sent.push(mouse('mouseMoved', geometry.x + i * 12, geometry.y, 8)); await pace(16);}
      await Promise.all(sent);
      await cdp.evaluate('window.__quotumPan.feeding=false');
      await mouse('mouseReleased', geometry.x + 720, geometry.y, 8);
      await key(false, 'Shift', 16);
      await settled();
      // Native Shift deltaX returns to live, then Back/Forward restore complete gestures.
      sent.length = 0;
      await cdp.evaluate(`window.__quotumPan.segment='return'`);
      await cdp.evaluate('window.__quotumPan.feeding=true');
      const returnPixels = await cdp.evaluate<number>(`(() => {
        const p=new URLSearchParams(location.search),from=Number(p.get('from')),to=Number(p.get('to'));
        const svg=document.querySelector('.history .chart>svg'),width=svg.getBoundingClientRect().width,box=svg.viewBox.baseVal.width;
        return (Date.now()-to)/(to-from)*(width*(box-52)/box);
      })()`);
      await scroll(-Math.max(0, returnPixels - 4));
      await cdp.evaluate('window.__quotumPan.feeding=false');
      await wait(240); await settled();
      const report = await cdp.evaluate<PanReading>(`(() => {
        const p=window.__quotumPan;p.running=false;cancelAnimationFrame(p.raf);p.observer.disconnect();
        document.querySelector('.history .chart>svg').removeEventListener('wheel',p.input,true);document.querySelector('.history .chart>svg').removeEventListener('pointermove',p.input,true);
        window.fetch=p.originalFetch;history.pushState=p.originalPush;
        const segments={};for(const segment of ['wheel','drag','return','fold']){const values=p.samples.filter(s=>s.segment===segment).map(s=>s.ms).sort((a,b)=>a-b);segments[segment]={count:values.length,p95:values[Math.ceil(values.length*.95)-1]??0,max:values.at(-1)??0};}
        return {frames:p.frames,latency:p.latency,inputs:p.inputs,updated:p.updated,pushesDuring:p.pushesDuring,pushesAfter:p.pushesAfter,forbiddenMutations:p.forbiddenMutations,undimmed:p.undimmed,coldReads:p.coldReads,peakFlights:p.peakFlights,maxTiles:p.maxTiles,duplicateReads:p.duplicateReads,segments,outliers:p.samples.filter(s=>s.ms>50)};
      })()`);
      report.period = period; report.series = geometry.series; report.charts = geometry.charts; report.rate = 4; report.expectedPushes = 3;
      reports.push(report);
      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
      const live = await cdp.evaluate<boolean>(`!new URLSearchParams(location.search).has('from')`);
      if (!live) throw new Error(`${period} pan did not return to live`);
      // Native Shift deltaX at the live bound is owned but remains a no-op.
      await wheel(12, true); await wait(240);
      await cdp.evaluate(`history.back()`); await wait(300);
      if (!(await cdp.evaluate<boolean>(`new URLSearchParams(location.search).has('from')`))) throw new Error('Back did not restore the whole previous gesture');
      await cdp.evaluate(`history.forward()`); await wait(300);
      if (!(await cdp.evaluate<boolean>(`!new URLSearchParams(location.search).has('from')`))) throw new Error('Forward did not restore live');
    }
    return {reports, problems: reports.flatMap(panningProblems)};
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    if (interception) await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    await cdp.evaluate(`(() => {const p=window.__quotumPan;if(p){p.running=false;cancelAnimationFrame(p.raf);p.observer?.disconnect();window.fetch=p.originalFetch;history.pushState=p.originalPush;}document.getElementById('quotum-pan-layout')?.remove();})()`);
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
