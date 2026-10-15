import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {panningProblems, type PanReading} from '../panningBudget';
const edgeSeries=():PanReading['edgeSeries']=>['wheel','drag'].map(stage=>({stage:stage as 'wheel'|'drag',series:12,sessionSeries:12,budgetSeries:12,fundsSeries:12}));

// Run the production browser probe with the browser's ordered RAF queue.
const source = readFileSync(new URL('../panning.ts', import.meta.url), 'utf8');
const probe = source.match(/await cdp\.evaluate\(`(\(\(\) => \{\n\s*const initiator=[\s\S]+?\}\)\(\))`\);/)![1];

function fixture(initiator: 'quota'|'session'|'activity'|'budget'|'funds' = 'quota') {
  let time = 0;
  let observe:(records:unknown[])=>void=()=>{};
  const callbacks: ((stamp: number) => void)[] = [], listeners = new Map<string, (event: object) => void>(), bubble = new Map<string, (event: object) => void>();
  const schedule = (callback: (stamp: number) => void) => {callbacks.push(callback); return callbacks.length;};
  const layer = (data = false) => {const slides = {isConnected:true,style: {transform: 'none'}, getAnimations: () => []}; return {isConnected:true,style: {transform: 'none'}, slides, querySelector: (selector: string) => selector === '.activity-stack' ? data ? {} : null : slides};};
  const fundsLayer = layer(), budgetLayer = layer(),sessionLayer=layer(),historyLayer = layer(), activityLayer = layer(true), activityTicks = layer(), activityEdge = layer(true);
  const restoreClip = {style: {transform: 'none'}, firstElementChild: activityLayer};
  const endClip = {style: {transform: 'none'}, firstElementChild: restoreClip};
  const startClip = {style: {transform: 'none'}, firstElementChild: endClip};
  const activityClip = {style: {transform: 'none', visibility: ''}, firstElementChild: startClip};
  const hiddenHistory = layer(), hiddenActivity = layer();
  const svg = (slides: ReturnType<typeof layer>) => ({
    isConnected: true, dataset: {drawReady: 'true', drawFrom: '0', drawTo: (slides === historyLayer||slides===sessionLayer) ? '424' : (slides === budgetLayer || slides === fundsLayer) ? '406' : '720'} as Record<string, string>, style: {height: '200px'},
    classList: {contains: () => false}, getAttribute: () => '0 0 900 200', closest: () => null,
    querySelector: () => (slides === historyLayer||slides===sessionLayer) ? hiddenHistory : hiddenActivity,
    getBoundingClientRect: () => ({width: 450}), viewBox: {baseVal: {width: 900}},
    parentElement: {
      dataset: {axisEnd: '0'},
      querySelector: (selector: string) => (slides === budgetLayer || slides === fundsLayer||slides===historyLayer||slides===sessionLayer) ? slides : selector === '.plot-clip.is-band' ? activityClip : selector === '.plot-clip.is-band .plot-move' ? activityLayer : activityTicks,
      querySelectorAll: () => (slides === historyLayer||slides===sessionLayer) ? [slides] : [activityTicks, activityLayer, activityEdge],
      addEventListener: (name: string, fn: (event: object) => void) => listeners.set((slides === fundsLayer ? 'funds' : slides === budgetLayer ? 'budget' : slides===sessionLayer?'session':slides===activityLayer?'activity':'quota') + ':' + name, fn), removeEventListener: () => {},
    },
  });
  const historySvg = svg(historyLayer), activitySvg = svg(activityLayer), budgetSvg = svg(budgetLayer), fundsSvg = svg(fundsLayer),sessionSvg=svg(sessionLayer);
  Object.assign(sessionSvg.dataset,{panToken:'1',panOrigin:'0',panScale:'1',panEnd:'0'});
  Object.assign(fundsSvg.dataset, {panToken: '1', panOrigin: '0', panScale: '1', panEnd: '0'});
  Object.assign(budgetSvg.dataset, {panToken: '1', panOrigin: '0', panScale: '1', panEnd: '0'});
  Object.assign(historySvg.dataset, {panToken: '1', panOrigin: '0', panScale: '1', panEnd: '0'});
  Object.assign(activitySvg.dataset, {panToken: '1', panOrigin: '0', panScale: String(12 / 7), panEnd: '0'});
  const context = {
    performance: {now: () => time, timeOrigin: 0}, URL, URLSearchParams, location: {href: 'https://example.test/', search: ''},
    document: {body: {}, querySelector: (selector: string) => selector.includes('quota-session-history')?sessionSvg:selector.includes('quota-history')?historySvg:selector.includes('budget-history')?budgetSvg:selector.includes('subscription-funds')?fundsSvg:activitySvg},
    history: {pushState: () => {}}, getComputedStyle: () => ({opacity: '1', transform: 'none'}),
    requestAnimationFrame: schedule, cancelAnimationFrame: () => {},
    MutationObserver: class {constructor(read:(records:unknown[])=>void){observe=read;}observe() {} disconnect() {}},
    DOMMatrix: class {a: number; e: number; constructor(value: string | undefined) {this.a = Number(value?.match(/scaleX\(([-.\d]+)\)/)?.[1] ?? 1);this.e = Number(value?.match(/translateX\(([-.\d]+)px\)/)?.[1] ?? 0);if(value?.startsWith('scaleX'))this.e*=this.a;}},
    window: {fetch: async () => ({}), requestAnimationFrame: schedule, addEventListener: (type: string, callback: (event: object) => void) => bubble.set(type, callback), removeEventListener: () => {}},
  };
  runInNewContext(probe.replace('${JSON.stringify(initiator)}', JSON.stringify(initiator)), context);
  const reading = (context.window as typeof context.window & {__quotumPan: PanReading & {pending: object[]}}).__quotumPan;
  const wheel = (stamp: number, delivered: number, deltaMode = 0, handled = () => {}) => {
    time = delivered;
    const event = {type: 'wheel', cancelable: true, deltaX: 12, deltaMode, shiftKey: false, timeStamp: stamp};
    listeners.get(initiator + ':wheel')!(event); handled(); bubble.get('wheel')!(event);
  };
  const update = (i: number, at: number, moves = true, synchronized = true, proportional = true, historyMoves = true, edgeMoves = true) => {
    time = at;
    sessionSvg.dataset.panEnd=String(12*i);sessionLayer.style.transform=`translateX(${-12*i}px)`;
    fundsSvg.dataset.panEnd = String(12*i);fundsLayer.style.transform = `translateX(${-12*i}px)`;
    budgetSvg.dataset.panEnd = String(12*i);budgetLayer.style.transform = `translateX(${-12*i}px)`;
    historySvg.dataset.panEnd = String(12 * i); activitySvg.dataset.panEnd = String(12 * (synchronized ? i : i - 1));
    if (historyMoves) historyLayer.style.transform = `translateX(${-12 * i}px)`;
    if (moves) activityLayer.style.transform = `translateX(${-(proportional ? 7 : 14) * i}px)`;
    activityTicks.style.transform = `translateX(${-7 * i}px)`;
    if (edgeMoves) activityEdge.style.transform = `translateX(${-(proportional ? 7 : 14) * i}px)`;
    hiddenHistory.style.transform = `translateX(${-12 * i}px)`; hiddenActivity.style.transform = `translateX(${-7 * i}px)`;
  };
  const frame = (at: number) => {time = at; return callbacks.splice(0);};
  const runFrame = (at: number) => frame(at).forEach(callback => callback(at));
  return {reading, wheel, listeners, bubble, update, frame, runFrame,observe:(records:unknown[])=>observe(records), requestFrame: context.window.requestAnimationFrame, context,sessionSvg,sessionLayer,historySvg, activitySvg, budgetSvg, fundsSvg, fundsLayer, budgetLayer, historyLayer, activityLayer, activityClip};
}

test('forbidden-mutation provenance is bounded and structural while the failure count remains complete',()=>{
  const f=fixture();Object.assign(f.reading,{feeding:true});
  const panel={classList:{contains:(name:string)=>name==='forecast'}};
  const element={nodeType:1,tagName:'TD',textContent:'private row text',closest:(selector:string)=>selector.startsWith('.card')?panel:selector==='.table-measure'?{}:null};
  f.observe(Array.from({length:40},()=>({target:element,type:'attributes',attributeName:'title',oldValue:'private exact value'})));
  assert.equal(f.reading.forbiddenMutations,40);assert.equal(f.reading.mutationSamples!.length,24);
  assert.deepEqual({...f.reading.mutationSamples![0]},{segment:'wheel',surface:'forecast',tag:'TD',type:'attributes',attribute:'title',measurement:true,panning:true});
  assert.ok(!JSON.stringify(f.reading.mutationSamples).includes('private'),'journal never copies values, text or source IDs');
  const clock={getAttribute:()=> 'work'};
  f.observe([{target:{...element,closest:(selector:string)=>selector==='[data-time]'?clock:element.closest(selector)},type:'characterData'}]);
  assert.equal(f.reading.forbiddenMutations,40,'genuine clock-only text remains outside the forbidden count');
});

test('the probe includes clipping transforms and rejects a missing inverse on the real data layer', () => {
  for (const correct of [true, false]) {
    const f = fixture(); f.wheel(0, 0);
    f.activityClip.firstElementChild.style.transform = 'translateX(5px)';
    f.activityClip.firstElementChild.firstElementChild.style.transform = 'translateX(-12px)';
    f.activityClip.firstElementChild.firstElementChild.firstElementChild.style.transform = correct ? 'translateX(7px)' : 'none';
    f.requestFrame(() => f.update(1, 16.7)); f.runFrame(16.7);
    assert.equal(f.reading.synchronized, correct);
    assert.equal(f.reading.latency.length, correct ? 1 : 0);
  }
});

test('a hidden activity band cannot be credited as moving data', () => {
  const f = fixture(); f.wheel(0, 0); f.activityClip.style.visibility = 'hidden';
  f.requestFrame(() => f.update(1, 16.7)); f.runFrame(16.7);
  assert.equal(f.reading.synchronized, false); assert.equal(f.reading.latency.length, 0);
});

test('the moving probe reads retained matrix owners without traversing the chart trees',()=>{
  const f=fixture();
  const unexpected=()=>{throw new Error('DOM traversal inside the moving probe');};
  for(const layer of [f.historyLayer,f.activityLayer,f.budgetLayer,f.fundsLayer,f.sessionLayer])layer.querySelector=unexpected;
  for(const svg of [f.historySvg,f.activitySvg,f.budgetSvg,f.fundsSvg,f.sessionSvg]){svg.parentElement.querySelector=unexpected;svg.parentElement.querySelectorAll=unexpected;}
  f.wheel(0,0);f.requestFrame(()=>f.update(1,16.7));f.runFrame(16.7);
  assert.equal(f.reading.synchronized,true);assert.equal(f.reading.latency.length,1);
});

test('a detached retained owner cannot supply a painted frame',()=>{
  const f=fixture();f.wheel(0,0);f.historyLayer.isConnected=false;
  f.requestFrame(()=>f.update(1,16.7));f.runFrame(16.7);
  assert.equal(f.reading.synchronized,false);assert.equal(f.reading.sizeStable,false);assert.equal(f.reading.latency.length,0);
});

test('the five-hour drawing has its own owner and cannot borrow the weekly transform',()=>{
  const f=fixture('session');f.wheel(0,0);f.requestFrame(()=>{f.update(1,16.7);f.sessionLayer.style.transform='none';});f.runFrame(16.7);
  assert.equal(f.reading.synchronized,false);assert.equal(f.reading.latency.length,0);
});

function run(moves: boolean, synchronized: boolean, proportional = true, historyMoves = true, edgeMoves = true): PanReading {
  const f = fixture();
  for (let i = 1; i <= 100; i++) {
    f.wheel(i * 16.7, i * 16.7);
    f.requestFrame(() => f.update(i, i * 16.7, moves, synchronized, proportional, historyMoves, edgeMoves));
    f.runFrame(i * 16.7);
  }
  return {...f.reading, initiator: 'quota', period: '24h', wheelGapMs:16.7,edgeSeries:edgeSeries(),series: 12, budgetSeries: 12, fundsSeries: 12, sessionSeries:12,charts: 5, rate: 4, expectedPushes: 0, coldReads: 1};
}

test('the actual probe measures input only after all five charts move on the same time frame', () => {
  assert.deepEqual(panningProblems(run(true, true)), []);
  const failures: [string, PanReading][] = [
    ['stationary Activity data must fail even while its ticks move', run(false, true)],
    ['different chart times must fail', run(true, false)],
    ['incorrect CSS scale must fail', run(true, true, false)],
    ['stationary History data must fail', run(true, true, true, false)],
    ['stationary Activity edges must fail while the band moves', run(true, true, true, true, false)],
  ];
  for (const [reason, reading] of failures) assert.ok(panningProblems(reading).some(problem => problem.includes('all five charts')), reason);
});

test('physical injection time keeps renderer queue stalls in the native latency budget',()=>{
  const f=fixture();f.wheel(0,600);f.requestFrame(()=>f.update(1,616.7));f.runFrame(616.7);
  assert.equal(f.reading.latency[0],616.7,'delivery time cannot replace the older native input timestamp');
  f.wheel(250,650);assert.equal(f.reading.wheelGapMs,250,'a coalesced idle gap is visible to the continuous-input gate');
});

test('stationary budget data cannot be credited by matching time metadata', () => {
  const f=fixture();f.wheel(0,0);
  f.requestFrame(()=>{f.update(1,16.7);f.budgetLayer.style.transform='none';});f.runFrame(16.7);
  assert.equal(f.reading.synchronized,false);assert.equal(f.reading.latency.length,0);
});

test('the probe observes the production update in its own RAF and credits only reached input', () => {
  const f = fixture();
  f.wheel(10, 30); f.wheel(20, 31);
  f.requestFrame(() => f.update(1, 32));
  const callbacks = f.frame(31);
  callbacks[0](31);
  assert.equal(f.reading.latency.length, 0, 'the earlier observer cannot credit input before production updates');
  callbacks[1](31);
  assert.equal(f.reading.latency.length, 1, 'new input cannot be credited by earlier artwork');
  assert.equal(f.reading.latency[0], 22, 'the updated RAF is observed now, without adding another frame');
  assert.equal(f.reading.pending.length, 1);
  f.requestFrame(() => f.update(2, 49)); f.runFrame(48);
  assert.equal(f.reading.latency[1], 29);
  assert.equal(f.reading.pending.length, 0);
});

test('unrelated RAF callbacks do not resample unchanged drawing owners',()=>{
  const f=fixture();let reads=0;
  for(const svg of [f.historySvg,f.sessionSvg,f.activitySvg,f.budgetSvg,f.fundsSvg])svg.getAttribute=()=>{reads++;return '0 0 900 200';};
  f.wheel(0,0);
  for(let i=0;i<30;i++)f.requestFrame(()=>{});
  f.requestFrame(()=>f.update(1,16.7));
  for(let i=0;i<30;i++)f.requestFrame(()=>{});
  f.runFrame(16.7);
  assert.equal(reads,5,'only the actual production movement samples all five retained drawings');
  assert.equal(f.reading.latency.length,1);assert.equal(f.reading.synchronized,true);
});

test('input-free gaps are excluded but pending input keeps delayed frames measurable', () => {
  const f = fixture();
  f.wheel(0, 0); f.requestFrame(() => f.update(1, 16.7)); f.runFrame(16.7);
  for (const at of [33.4, 50.1, 66.8, 83.5]) f.runFrame(at);
  f.wheel(100, 100); f.requestFrame(() => f.update(2, 116.7)); f.runFrame(116.7);
  assert.equal(f.reading.frames.length, 0, 'an input-free stationary pause is not a missed moving frame');
  f.wheel(120, 120);
  for (const at of [133.4, 150.1, 166.8, 183.5]) f.runFrame(at);
  f.requestFrame(() => f.update(3, 200)); f.runFrame(200);
  assert.ok(f.reading.frames[0] > 80, 'pending input cannot erase a delayed movement interval');
  assert.equal(f.reading.latency[2], 80, 'native delivery and processing delays remain in the budget');
});

test('unpainted final input is credited only after its geometry commits', () => {
  const f = fixture();
  f.wheel(0, 0);
  delete f.sessionSvg.dataset.panEnd;delete f.historySvg.dataset.panEnd; delete f.activitySvg.dataset.panEnd; delete f.budgetSvg.dataset.panEnd; delete f.fundsSvg.dataset.panEnd;
  f.context.location.search = '?from=0&to=12';
  f.runFrame(16.7);
  assert.equal(f.reading.latency.length, 0, 'the address alone cannot prove the final chart updated');
  f.historySvg.parentElement.dataset.axisEnd = '12';
  f.runFrame(33.4);
  assert.equal(f.reading.latency.length, 0, 'all five charts must publish the final geometry');
  f.sessionSvg.parentElement.dataset.axisEnd=f.activitySvg.parentElement.dataset.axisEnd = f.budgetSvg.parentElement.dataset.axisEnd = f.fundsSvg.parentElement.dataset.axisEnd = '12'; f.runFrame(50.1);
  assert.equal(f.reading.latency[0], 50.1);
  assert.equal(f.reading.updated, 0, 'final metadata cannot manufacture moving frames');
});

test('causal input positions preserve the line and page wheel units', () => {
  for (const [mode, units] of [1, 16, 400].entries()) {
    const f = fixture();
    f.wheel(0, 0, mode); f.requestFrame(() => f.update(units, 16.7)); f.runFrame(16.7);
    assert.equal(f.reading.latency.length, 1);
    assert.equal(f.reading.pending.length, 0);
  }
});

test('an implicit wheel restart receives a fresh immutable gesture anchor', () => {
  const f = fixture();
  f.wheel(0, 0); f.requestFrame(() => f.update(1, 16.7)); f.runFrame(16.7);
  f.wheel(300, 320, 0, () => {
    Object.assign(f.sessionSvg.dataset,{...f.historySvg.dataset,panToken:'2',panOrigin:'12',panEnd:'12',drawFrom:'12',drawTo:'436'});
    Object.assign(f.historySvg.dataset, {panToken: '2', panOrigin: '12', panEnd: '12', drawFrom: '12', drawTo: '436'});
    Object.assign(f.activitySvg.dataset, {panToken: '2', panOrigin: '12', panEnd: '12', drawFrom: '12', drawTo: '732'});
    for(const svg of [f.budgetSvg,f.fundsSvg])Object.assign(svg.dataset, {panToken: '2', panOrigin: '12', panEnd: '12', drawFrom: '12', drawTo: '418'});
    f.sessionLayer.style.transform=f.historyLayer.style.transform = f.activityLayer.style.transform = f.budgetLayer.style.transform = f.fundsLayer.style.transform = 'none';
  });
  f.requestFrame(() => {f.update(1, 322);f.sessionSvg.dataset.panEnd='24';f.historySvg.dataset.panEnd='24';f.activitySvg.dataset.panEnd='24';f.budgetSvg.dataset.panEnd=f.fundsSvg.dataset.panEnd='24';});
  f.runFrame(321);
  assert.equal(f.reading.pending.length, 0, 'the new wheel token must not retain the previous cumulative offset');
  assert.equal(f.reading.latency[1], 22, 'delivery and handler work stay included after a restart');
  assert.equal(f.reading.updated, 2, 'equal CSS offsets in different gesture bases are separate updated frames');
});

test('a nonzero HTML baseline is retained on restart without crediting a model swap as movement', () => {
  const f = fixture();
  f.sessionSvg.dataset.panBase='23';f.sessionLayer.style.transform='translateX(23px)';f.historySvg.dataset.panBase = '23'; f.activitySvg.dataset.panBase = '13';
  f.historyLayer.style.transform = 'translateX(23px)'; f.activityLayer.style.transform = 'translateX(13px)';
  f.wheel(0, 0);
  f.requestFrame(() => {f.update(1, 16.7); f.historySvg.dataset.panEnd = '12'; f.sessionLayer.style.transform='translateX(11px)';f.historySvg.parentElement.querySelector('').style.transform = 'translateX(11px)'; f.activitySvg.parentElement.querySelector('.plot-clip.is-band .plot-move').style.transform = 'translateX(6px)'; f.activitySvg.parentElement.querySelectorAll().forEach(layer => {layer.style.transform = 'translateX(6px)';});});
  f.runFrame(16.7);
  assert.equal(f.reading.latency.length, 1);
  assert.equal(f.reading.pending.length, 0);
});

test('a pending drawing model cannot credit the final input from the URL or axis alone', () => {
  const f = fixture(); f.wheel(0, 0);
  delete f.sessionSvg.dataset.panEnd;delete f.historySvg.dataset.panEnd; delete f.activitySvg.dataset.panEnd; delete f.budgetSvg.dataset.panEnd; delete f.fundsSvg.dataset.panEnd;
  f.context.location.search = '?from=0&to=12';
  f.historySvg.parentElement.dataset.axisEnd = f.sessionSvg.parentElement.dataset.axisEnd=f.activitySvg.parentElement.dataset.axisEnd = f.budgetSvg.parentElement.dataset.axisEnd = f.fundsSvg.parentElement.dataset.axisEnd = '12';
  f.activitySvg.dataset.drawReady = 'false'; f.runFrame(16.7);
  assert.equal(f.reading.latency.length, 0);
  f.activitySvg.dataset.drawReady = 'true'; f.runFrame(33.4);
  assert.equal(f.reading.latency[0], 33.4);
});

test('the actual probe rejects a wrong frozen SVG scale or a changed domain behind matching HTML movement', () => {
  for (const wrong of ['svg', 'domain']) {
    const f = fixture();
    for (let i = 1; i <= 100; i++) {
      f.wheel(i * 16.7, i * 16.7);
      f.requestFrame(() => {f.update(i, i * 16.7); if (wrong === 'svg') f.historyLayer.slides.style.transform = 'scaleX(2)'; else f.activitySvg.dataset.drawFrom = '40';});
      f.runFrame(i * 16.7);
    }
    const reading = {...f.reading, initiator: 'quota' as const, period: '24h', wheelGapMs:16.7,edgeSeries:edgeSeries(),series: 12, budgetSeries: 12, fundsSeries: 12, sessionSeries:12,charts: 5, rate: 4, expectedPushes: 0, coldReads: 1};
    assert.ok(panningProblems(reading).some(problem => problem.includes('all five charts')), wrong);
    assert.equal(f.reading.latency.length, 0, 'a reached HTML offset alone cannot credit the wrong composed drawing');
  }
});

test('a coherent numeric model and SVG matrix replacement preserves the shown time without manufacturing input', () => {
  const f = fixture();
  f.wheel(0, 0);
  f.requestFrame(() => {f.update(1, 16.7); f.sessionSvg.dataset.drawTo='848';f.sessionLayer.slides.style.transform='translateX(-40px) scaleX(2)';f.historySvg.dataset.drawTo = '848'; f.historyLayer.slides.style.transform = 'translateX(-40px) scaleX(2)';});
  f.runFrame(16.7);
  assert.equal(f.reading.latency.length, 1);
  const count = f.reading.updated;
  f.requestFrame(() => {}); f.runFrame(33.4);
  assert.equal(f.reading.updated, count, 'the inner projection swap itself is not a movement frame');
});


test('budget input is captured on its own chart and cannot pass without its native update', () => {
  for (const gesture of ['wheel', 'drag']) for (const handled of [true, false]) {
    const f = fixture('budget');
    assert.ok(f.listeners.has('budget:wheel'));
    assert.ok(!f.listeners.has('quota:wheel'), 'a follower cannot capture the initiator input');
    if (gesture === 'wheel') f.wheel(0, 0);
    else {
      for (const event of [{type: 'pointerdown', clientX: 100, buttons: 1, timeStamp: 0}, {type: 'pointermove', clientX: 88, buttons: 1, timeStamp: 0}]) {
        f.listeners.get('budget:' + event.type)!(event); f.bubble.get(event.type)!(event);
      }
    }
    f.requestFrame(() => {if (handled) f.update(1, 16.7);}); f.runFrame(16.7);
    assert.equal(f.reading.inputs, 1);
    assert.equal(f.reading.latency.length, handled ? 1 : 0, gesture + ' needs an actual movement');
  }
});


test('funds input requires its own data layer to move with the other charts',()=>{
  const f=fixture('funds');f.wheel(0,0);
  f.requestFrame(()=>{f.update(1,16.7);f.fundsLayer.style.transform='none';});f.runFrame(16.7);
  assert.equal(f.reading.latency.length,0);assert.equal(f.reading.synchronized,false);
  const ready=fixture('funds');ready.wheel(0,0);ready.requestFrame(()=>ready.update(1,16.7));ready.runFrame(16.7);
  assert.equal(ready.reading.latency.length,1);assert.equal(ready.reading.chartUpdates[3],1);
});
