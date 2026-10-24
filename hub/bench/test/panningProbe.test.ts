import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {panTransactionsScript, panPartialScript, type PanTransactions} from '../panEvidence.js';
import {deadline} from '../deadline.js';
import {panningSettlement} from '../panningFailure.js';
import {safeEvidence} from '../evidence.js';
import {panningProblems, type PanReading,type NativePanReceipt,type PanSettlements} from '../panningBudget';
import {Preparations} from '../../ui/lib/prepare';
const edgeSeries=():PanReading['edgeSeries']=>['wheel','drag'].map(stage=>({stage:stage as 'wheel'|'drag',series:12,sessionSeries:12,budgetSeries:12,fundsSeries:12}));

// Run the production browser probe with the browser's ordered RAF queue.
const source = readFileSync(new URL('../panning.ts', import.meta.url), 'utf8');
const probe = source.match(/const samplerSource=`(\(\(\) => \{\n\s*const initiator=[\s\S]+?\}\)\(\))`;/)![1];

test('native diagnostics restore CPU after the frozen report and bind even when stopping fails', async t => {
  const finish = source.split('reports.push(report);')[1].split("at('postconditions');")[0];
  const script = ts.transpileModule(`(async()=>{${finish}})()`, {compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
  for (const failing of ['none','restore','stop','bind','undefined'] as const) await t.test(failing,async()=>{
    const events:string[]=[],first=failing==='undefined'?undefined:new Error(failing),report={frames:[67],latency:[39]};
    let rejected=false,reason:unknown;
    try {
      await runInNewContext(script,{
        report,initiator:'budget',period:'24h',
        evidence:{save:()=>events.push('frozen')},
        cdp:{send:async(method:string,params:{rate:number})=>{assert.equal(method,'Emulation.setCPUThrottlingRate');assert.equal(params.rate,1);events.push('restore');if(failing==='restore')throw first;}},
        traced:{stop:async()=>{events.push('stop');if(failing==='stop'||failing==='undefined')throw first;},bindAndClose:async()=>{events.push('bind');if(failing==='bind'||failing==='stop'||failing==='undefined')throw new Error('binding failed');}},
      });
    } catch(error) {rejected=true;reason=error;}
    assert.deepEqual(events,failing==='restore'?['frozen','restore','bind']:['frozen','restore','stop','bind']);
    assert.equal(rejected,failing!=='none');
    if(failing==='bind')assert.equal((reason as Error).message,'binding failed');
    else if(rejected)assert.equal(reason,first,'a secondary binding error cannot replace the original failure');
    assert.deepEqual(report,{frames:[67],latency:[39]},'diagnostic cleanup never changes recorded gaps');
  });
});

function fixture(initiator: 'quota'|'session'|'activity'|'budget'|'funds' = 'quota', typed = false, diagnostic = false,detailed=false,scheduler?:unknown) {
  let time = 0;const reads={rect:0,style:0,fetch:0};
  let observe:(records:unknown[])=>void=()=>{};
  const callbacks: ((stamp: number) => void)[] = [], listeners = new Map<string, (event: object) => void>(), bubble = new Map<string, (event: object) => void>();
  let nextHandle=0;
  const schedule = (callback: (stamp: number) => void) => {callbacks.push(callback); return ++nextHandle;};
  const layer = (data = false) => {const slides = {isConnected:true,style: {transform: 'none'}, getAnimations: (): {playState: string}[] => []}; return {isConnected:true,style: {transform: 'none'}, getAnimations: (): {playState: string}[] => [], slides, querySelector: (selector: string) => selector === '.activity-stack' ? data ? {} : null : slides};};
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
    getBoundingClientRect: () => {reads.rect++;return {width:450};}, viewBox: {baseVal: {width: 900}},
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
    history: {pushState: (..._args: unknown[]) => {}}, getComputedStyle: (node: {style: {transform: string}}) => {
      reads.style++;if (typed && 'getAnimations' in node) throw new Error('used-value transform read');
      return {opacity: '1', transform: node.style.transform};
    },
    requestAnimationFrame: schedule, cancelAnimationFrame: () => {},
    MutationObserver: class {constructor(read:(records:unknown[])=>void){observe=read;}observe() {} disconnect() {}},
    DOMMatrix: class {a: number; e: number; constructor(value: string | undefined) {this.a = Number(value?.match(/scaleX\(([-.\d]+)\)/)?.[1] ?? 1);this.e = Number(value?.match(/translateX\(([-.\d]+)px\)/)?.[1] ?? 0);if(value?.startsWith('scaleX'))this.e*=this.a;}},
    window: {__quotumPanPreparations:scheduler,fetch: async () => {reads.fetch++;return{};}, requestAnimationFrame: schedule, addEventListener: (type: string, callback: (event: object) => void) => bubble.set(type, callback), removeEventListener: (type:string,callback:(event:object)=>void) => {if(bubble.get(type)===callback)bubble.delete(type);}},
  };
  const computed = new Map<object,string>();
  if (typed) for (const layer of [historyLayer,activityLayer,budgetLayer,fundsLayer,sessionLayer]) for (const owner of [layer,layer.slides]) {
    computed.set(owner,'none');
    Object.assign(owner,{computedStyleMap:()=>new Map([['transform',computed.get(owner)==='none'?{value:'none'}:{toMatrix:()=>new context.DOMMatrix(computed.get(owner))}]])});
  }
  const paintFold = (owner:{style:{transform:string}},transform:string) => {if (typed) computed.set(owner,transform);else owner.style.transform=transform;};
  const script = runInNewContext('`' + probe + '`', {initiator, period: detailed?'30d':'24h', panTransactionsScript, detailed, evidence: diagnostic ? {selection: 'quota24'} : undefined});
  runInNewContext(script, context);
  const reading = (context.window as typeof context.window & {__quotumPan: PanReading & {running:boolean; feeding: boolean; cleanup(): void; readTransactions(): PanTransactions; pending: object[]; readDiagnostic?():NativePanReceipt;readSettlements?():PanSettlements;markSettlement?:unknown;samples: NonNullable<PanReading['outliers']>}}).__quotumPan;
  for (const svg of [historySvg, activitySvg, budgetSvg, fundsSvg, sessionSvg]) Object.assign(svg.dataset, {panMinEnd: '-1000000000', panMaxEnd: '1000000000'});
  const limits = (min: number, max: number) => {for (const svg of [historySvg, activitySvg, budgetSvg, fundsSvg, sessionSvg]) Object.assign(svg.dataset, {panMinEnd: String(min), panMaxEnd: String(max)});};
  const wheel = (stamp: number, delivered: number, deltaMode = 0, handled = () => {}, deltaX = initiator==='activity'?7:12) => {
    time = delivered;
    const event = {type: 'wheel', cancelable: true, deltaX, deltaMode, shiftKey: false, timeStamp: stamp};
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
  const commit=(end:number)=>{
    for(const svg of [historySvg,activitySvg,budgetSvg,fundsSvg,sessionSvg]){
      const shift=end-Number(svg.dataset.drawFrom);
      svg.dataset.drawFrom=String(Number(svg.dataset.drawFrom)+shift);svg.dataset.drawTo=String(Number(svg.dataset.drawTo)+shift);
      svg.parentElement.dataset.axisEnd=String(end);
    }
    for(const layer of [historyLayer,activityLayer,budgetLayer,fundsLayer,sessionLayer]){layer.style.transform='none';layer.slides.style.transform='none';}
  };
  const frame = (at: number) => {time = at; return callbacks.splice(0);};
  const runFrame = (at: number) => frame(at).forEach(callback => callback(at));
  const freeze=():PanReading=>{const template=source.match(/const report = await cdp.evaluate<PanReading>\(`([\s\S]+?)`\);/)![1];return runInNewContext(runInNewContext('`'+template+'`',{detailed}),context);};
  return {reading,freeze,reads,now:()=>time,setTime:(at:number)=>{time=at;}, wheel, limits, commit, listeners, bubble, update, frame, runFrame,paintFold,observe:(records:unknown[])=>observe(records), requestFrame: context.window.requestAnimationFrame, context,sessionSvg,sessionLayer,historySvg, activitySvg, budgetSvg, fundsSvg, fundsLayer, budgetLayer, historyLayer, activityLayer, activityClip};
}

test('caption diagnostics retain exact input clocks without adding fields to the canonical probe', () => {
  for (const diagnostic of [false, true]) {
    const f = fixture('quota', false, diagnostic); f.reading.feeding = true;
    f.runFrame(80); f.wheel(100, 110); f.requestFrame(() => f.update(1, 125)); f.runFrame(125);
    const responses = f.reading.responses; assert.ok(responses); assert.equal(responses.length, 1);
    const response = responses[0] as typeof responses[number] & {at?: number; delivered?: number; reached?: number; id?: number};
    if (diagnostic) {
      assert.equal(response.id, 1); assert.equal(response.at, 100); assert.equal(response.delivered, 110);
      assert.equal(response.ms, response.reached! - response.at!);
      assert.equal(response.queued, response.delivered! - response.at!);
      assert.equal(response.processed, response.reached! - response.delivered!);
    } else assert.deepEqual(Object.keys(response).sort(), ['ms', 'processed', 'queued', 'requests', 'segment']);
  }
});

test('the original probe records a native generation pause before a handler writes the address', () => {
  const f=fixture();f.reading.feeding=true;
  f.wheel(100,114.2);
  f.wheel(432.5,432.5,0,()=>{f.context.history.pushState({private:'not retained'},'', '/private');f.historySvg.dataset.panToken='2';});
  const evidence=f.reading.readTransactions();
  assert.equal(f.reading.pushesDuring,1,'the original failure count remains');
  assert.equal(evidence.wheelEvents,2);assert.equal(evidence.maxStampGap,332.5);
  assert.ok(Math.abs(evidence.maxDeliveryGap!-318.3)<1e-9);
  assert.equal(evidence.writes[0].token,1,'capture runs before the production handler ends its old gesture');
  assert.equal(evidence.writes[0].stampGap,332.5);assert.equal(evidence.writes[0].idleMs,0);
  assert.ok(!JSON.stringify(safeEvidence(evidence)).includes('private'));
});

test('a failed scenario retains its original wheel receipts and pending inputs', () => {
  const f=fixture();f.reading.feeding=true;
  f.wheel(100,114.2);f.wheel(432.5,432.5,0,()=>f.context.history.pushState());
  const partial=runInNewContext(panPartialScript('quota','24h'),f.context);
  assert.equal(partial.status,'partial');assert.equal(partial.inputs,2);
  assert.equal(partial.transactions.maxStampGap,332.5);assert.equal(partial.transactions.pushesDuring,1);
  assert.equal(partial.pushesDuring,1);assert.equal(partial.pending.length,2);
  assert.equal(partial.pending[1].inputId,2);assert.equal(partial.pending[1].stamp,432.5);
});

test('failure evidence cannot credit an earlier or retired scenario probe', () => {
  const f=fixture();f.wheel(100,100);
  assert.equal(runInNewContext(panPartialScript('quota','30d'),f.context).status,'unavailable');
  assert.equal(runInNewContext(panPartialScript('budget','24h'),f.context).status,'unavailable');
  f.reading.cleanup();
  assert.equal(runInNewContext(panPartialScript('quota','24h'),f.context).status,'unavailable');
});

test('actual postconditions preserve failure and cleanup after motion sampling stops',async()=>{
  const ast=ts.createSourceFile('panning.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const fn=ast.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='panning')!;
  const outer=fn.body!.statements.find(ts.isTryStatement)!;
  let periodLoop:ts.ForOfStatement|undefined;
  const visit=(node:ts.Node)=>{if(ts.isForOfStatement(node)&&node.initializer.getText(ast).includes('[period, index]'))periodLoop=node;ts.forEachChild(node,visit);};visit(outer);
  const statements=(periodLoop!.statement as ts.Block).statements;
  const declared=(node:ts.Statement,name:string)=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(ast)===name);
  const helpers=fn.body!.statements.filter(node=>['wait','key','mouse','settled'].some(name=>declared(node,name)));
  const wheel=statements.find(node=>declared(node,'wheel'))!;
  const tail=statements.slice(statements.findIndex(node=>declared(node,'report')));
  // Execute exact integration statements and their original catch/finally. Native
  // geometry assertions are controlled at CDP; this is not a browser performance run.
  const script=`globalThis.run=async()=>{${[...helpers,wheel].map(node=>node.getText(ast)).join('\n')}try{${tail.map(node=>node.getText(ast)).join('\n')}}${outer.catchClause!.getText(ast)}finally${outer.finallyBlock!.getText(ast)}};`;
  for(const fail of [false,true])for(const native of [false,true]){
    const f=fixture(),files=new Map<string,any>(),original=new Error('controlled held-Shift failure');
    let cleanupCalls=0;const cleanup=f.reading.cleanup;
    f.reading.cleanup=()=>{cleanupCalls++;cleanup();};
    let context='',held=false,complete=false,matrices=0,legends=0;
    const cleanDocument={querySelector:()=>null,querySelectorAll:()=>[],getElementsByClassName:()=>[],getElementById:()=>null};
    const globals={...f.context,document:cleanDocument,setTimeout:(run:()=>void)=>{run();},localStorage:{getItem:()=>null,setItem:()=>{}}};
    const read=(code:string)=>runInNewContext(code,globals);
    const cdp={
      snapshot:()=>({context,failure:{method:'Input.dispatchMouseEvent'}}),
      send:async(method:string,args?:{type?:string})=>{
        if(method==='Input.dispatchMouseEvent'&&args?.type==='mouseWheel'&&context==='held-shift-first-minus-12'){
          held=true;assert.equal(f.reading.running,false);
          if(fail)throw original;
        }
      },
      evaluate:async(code:string)=>{
        if(code.includes('const p=window.__quotumPan;p.cleanup()')||code.includes("const until=Date.now()+15000,p=new URLSearchParams")||code.includes("status:'partial'")||code.includes("window.__quotumPan?.cleanup()")||code.startsWith('new Promise(')||code==='window.__quotumPan.returnInput=null')return read(code);
        if(code.startsWith('new DOMMatrix('))return ++matrices*12;
        if(code.startsWith("[...document.querySelectorAll('.activity-info[data-series-context]"))return ++legends===1;
        if(code.includes('.tooltip,')||code===`!document.querySelector('.filter-control[data-filter="history.horizon"] .popover')`)return false;
        if(code.startsWith('new URLSearchParams(')||code.startsWith('!new URLSearchParams(')||code.startsWith("!!document.querySelector('[data-pan-end]')")||code.startsWith("!document.querySelector('[data-pan-end]')"))return true;
        if(code==='history.back()'||code==='history.forward()'||code==="document.querySelector('.activity .legend-item').focus()")return;
        assert.fail('Unexpected integration boundary: '+code.slice(0,80));
      },
    };
    const evidence=fail?{save:(name:string,value:unknown)=>files.set(name,value)}:undefined;
    const reports:PanReading[]=[],traceCalls:string[]=[];
    const traced=native?{stop:async()=>{assert.equal(reports.length,1);assert.equal(f.reading.running,false);traceCalls.push('stop');},bindAndClose:async()=>{assert.deepEqual(traceCalls,['stop']);traceCalls.push('bind');}}:undefined;
    const sandbox={...globals,cdp,evidence,traced,detailed:false,deadline,panPartialScript,panningSettlement,selector:'[data-widget="quota-history"]',initiator:'quota',period:'24h',geometry:{x:0,y:0,series:12,sessionSeries:12,budgetSeries:12,fundsSeries:12,charts:5},edgeSeries:[],costStart:undefined,costEnd:undefined,reports,scenario:{initiator:'quota',period:'24h'},failed:false,stage:'controlled',interception:false,originalHorizon:'auto',click:async()=>{},at:(value:string)=>{context=value;},progress:(value:string)=>{
      if(value.endsWith('/complete'))complete=true;
    }};
    runInNewContext(ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,sandbox);
    const run=(sandbox as typeof sandbox&{run():Promise<void>}).run;
    if(fail){
      await assert.rejects(run(),error=>error===original);
      const partial=files.get('panning-partial').partial;
      assert.equal(partial.status,'unavailable');assert.equal(partial.frames,undefined);assert.equal(complete,false);
    }else{await run();assert.equal(complete,true);}
    assert.equal(held,true);assert.equal(f.reading.running,false);assert.equal(sandbox.reports.length,1);
    assert.deepEqual(traceCalls,native?['stop','bind']:[]);
    assert.equal(cleanupCalls,2,'both the report and outer finally must run the actual cleanup');
  }
});

test('the probe retains clamped input and credits its reached boundary without inventing movement', () => {
  for (const initiator of ['quota', 'session', 'activity', 'budget', 'funds'] as const) {
    const f = fixture(initiator); f.limits(0, 18);
    f.wheel(0, 0); f.requestFrame(() => f.update(1, 16)); f.runFrame(16);
    f.wheel(20, 20); f.runFrame(24);
    assert.equal(f.reading.latency.length, 1, 'the boundary cannot be credited before its data layers reach it');
    f.requestFrame(() => f.update(1.5, 32)); f.runFrame(32);
    assert.equal(f.reading.latency.length, 2, 'the accepted delta ends at the production boundary');
    const updated = f.reading.updated;
    f.wheel(40, 40); f.runFrame(48);
    assert.equal(f.reading.inputs, 3); assert.equal(f.reading.latency.length, 3, 'the stationary clamped input is retained');
    assert.equal(f.reading.updated, updated, 'the boundary creates no moving frame');
    f.wheel(50, 50, 0, () => {}, initiator==='activity'?-7:-12); f.requestFrame(() => f.update(.5, 64)); f.runFrame(64);
    assert.equal(f.reading.latency.length, 4, 'reversal begins at the accepted boundary, without accumulated overscroll');
    assert.equal(f.reading.pending.length, 0);
  }
});

test('a released clamped input still waits for every final drawing and animation', () => {
  const f = fixture(); f.limits(0, 18); f.wheel(0, 0); f.wheel(1, 1);
  for (const svg of [f.historySvg, f.activitySvg, f.budgetSvg, f.fundsSvg, f.sessionSvg]) delete svg.dataset.panEnd;
  f.context.location.search = '?from=0&to=18'; f.runFrame(10);
  assert.equal(f.reading.latency.length, 0, 'the address cannot establish the clamped geometry');
  for (const svg of [f.historySvg, f.activitySvg, f.budgetSvg, f.fundsSvg, f.sessionSvg]) svg.parentElement.dataset.axisEnd = '18';
  f.fundsSvg.dataset.drawReady = 'false'; f.runFrame(20); assert.equal(f.reading.latency.length, 0);
  f.fundsSvg.dataset.drawReady = 'true'; f.fundsLayer.getAnimations = () => [{playState: 'running'}]; f.runFrame(30);
  assert.equal(f.reading.latency.length, 0, 'a retained boundary input cannot bypass a running follower fold');
  f.fundsLayer.getAnimations = () => []; f.commit(18); f.runFrame(40);
  assert.deepEqual(Array.from(f.reading.latency), [40, 39]); assert.equal(f.reading.inputs, 2);
  assert.equal(f.reading.updated, 0, 'final metadata creates no moving samples');
});

test('clamped inputs cannot make a stationary scenario pass the movement budget', () => {
  const f = fixture(); f.limits(0, 0);
  for (let i = 0; i < 100; i++) {f.wheel(i * 16, i * 16); f.runFrame(i * 16 + 8);}
  assert.equal(f.reading.inputs, 100); assert.equal(f.reading.latency.length, 100);
  assert.equal(f.reading.updated, 0); assert.equal(f.reading.frames.length, 0);
  const reading = {...f.reading, initiator: 'quota' as const, period: '24h', wheelGapMs:16.7,edgeSeries:edgeSeries(),series: 12, budgetSeries: 12, fundsSeries: 12, sessionSeries:12,charts: 5, rate: 4, expectedPushes: 0, coldReads: 1};
  assert.ok(panningProblems(reading).some(problem => problem.includes('all five charts')));
  assert.ok(panningProblems(reading).some(problem => problem.includes('every input')));
});

test('a new gesture cannot credit an unpainted input from the previous gesture', () => {
  const f = fixture(); f.wheel(0, 0);
  f.wheel(20, 20, 0, () => {
    for (const svg of [f.historySvg, f.activitySvg, f.budgetSvg, f.fundsSvg, f.sessionSvg]) {
      Object.assign(svg.dataset, {panToken: '2', panOrigin: '100', panEnd: '100'});
      svg.dataset.drawFrom = '100'; svg.dataset.drawTo = String(Number(svg.dataset.drawTo) + 100);
    }
  });
  f.requestFrame(() => {f.update(1, 32);for (const svg of [f.historySvg, f.activitySvg, f.budgetSvg, f.fundsSvg, f.sessionSvg]) svg.dataset.panEnd = '112';}); f.runFrame(32);
  assert.deepEqual(Array.from(f.reading.latency), [12], 'the new data position proves only the new gesture');
  assert.equal(f.reading.pending.length, 1); assert.equal(f.reading.inputs, 2, 'the old input remains visible as missing evidence');
  for (const svg of [f.historySvg, f.activitySvg, f.budgetSvg, f.fundsSvg, f.sessionSvg]) {delete svg.dataset.panEnd;svg.parentElement.dataset.axisEnd = '12';}
  f.runFrame(48);
  assert.deepEqual(Array.from(f.reading.latency), [12], 'later final geometry cannot borrow the earlier gesture either');
  assert.equal(f.reading.pending.length, 1);
});

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
  assert.equal(f.reading.samples[0].callbacksSinceMovingFrame,1,'ordinary RAF ticks without a sample are not counted');
  assert.equal(f.reading.samples[0].maxCallbackGapMs,f.reading.frames[0],'the stationary reset starts a fresh diagnostic interval');
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
  assert.equal(f.reading.latency.length,0,'matching endpoints without painted data still cannot credit input');
  f.sessionLayer.slides.style.transform=f.historyLayer.slides.style.transform=f.budgetLayer.slides.style.transform=f.fundsLayer.slides.style.transform='translateX(-24px)';
  f.activityLayer.slides.style.transform='translateX(-14px)';f.runFrame(50.1);
  assert.equal(f.reading.latency[0], 50.1);
  assert.equal(f.reading.updated, 0, 'final metadata cannot manufacture moving frames');
});

test('the probe measures a delayed HTML or SVG fold and cannot credit final input while it is moving', () => {
  for(const inputSegment of ['wheel','drag','return'])for (const typed of [false,true]) for (const html of [true, false]) for(const cost of [0,72]) {
    const f = fixture('quota',typed); f.wheel(0, 0);
    Object.assign(f.reading,{segment:inputSegment});
    for (const svg of [f.historySvg, f.activitySvg, f.budgetSvg, f.fundsSvg, f.sessionSvg]) {
      delete svg.dataset.panEnd;
      svg.parentElement.dataset.axisEnd = '12';
    }
    f.context.location.search = '?from=0&to=12';
    const moving = html ? f.historyLayer : f.historyLayer.slides;
    const now=f.context.performance.now;let elapsed=0,delay=0;
    f.context.performance.now=()=>now()+elapsed;
    moving.getAnimations = () => {elapsed+=delay;return [{playState: 'running'}];};
    f.paintFold(moving,'translateX(40px) scaleX(.6)'); f.runFrame(10);
    f.runFrame(20);
    assert.equal(f.reading.updated, 0, 'an animation without actual movement creates no frames');
    delay=cost;f.paintFold(moving,'translateX(30px) scaleX(.7)'); f.runFrame(30);
    elapsed=0;delay=0;
    f.paintFold(moving,'translateX(10px) scaleX(.9)'); f.runFrame(110);
    assert.equal(f.reading.updated, 2);
    assert.deepEqual(Array.from(f.reading.frames), [80], 'a slow fold remains in the original moving-frame budget');
    assert.equal(f.reading.samples[0].callbacksSinceMovingFrame,1);
    assert.equal(f.reading.samples[0].maxCallbackGapMs,80);
    assert.equal(f.reading.samples[0].samplerMs,cost,'observer work is identified without subtracting it from the failing gap');
    const partial=runInNewContext(panPartialScript('quota','24h'),f.context);
    assert.equal(partial.outliersOmitted,0);
    const saved=safeEvidence(partial.outliers[0]) as NonNullable<PanReading['outliers']>[number];
    assert.equal(saved.at,110);assert.equal(saved.stamp,110);assert.equal(saved.inputSegment,inputSegment);
    assert.equal(saved.foldMask,1);assert.equal(saved.svgFoldMask,html?0:1);assert.equal(saved.movedMask,1);
    assert.equal(f.reading.latency.length, 0, 'final geometry alone cannot credit an unfinished animation');
    moving.getAnimations = () => []; f.paintFold(moving,'none'); f.commit(12); f.runFrame(120);
    assert.deepEqual(Array.from(f.reading.latency), [120]);
  }
});

test('outliers sum prior sampler bodies across repeated RAF timestamps and discard closed intervals',()=>{
  const f=fixture();
  for(const svg of [f.historySvg,f.activitySvg,f.budgetSvg,f.fundsSvg,f.sessionSvg])delete svg.dataset.panEnd;
  const now=f.context.performance.now;let elapsed=0,delay=0;
  f.context.performance.now=()=>now()+elapsed;
  const animate=()=>{elapsed+=delay;return [{playState:'running'}];};
  f.historyLayer.getAnimations=animate;
  const run=(at:number,pixels:number,cost=0,stamp=at)=>{
    elapsed=0;delay=cost;f.historyLayer.style.transform=`translateX(${pixels}px)`;
    f.frame(at).forEach(callback=>callback(stamp));
  };
  run(10,40);run(20,30,5);run(40,25,7,20);run(100,10,11);run(180,5);
  assert.deepEqual(Array.from(f.reading.frames),[80,80]);
  assert.deepEqual(Array.from(f.reading.samples,sample=>sample.samplerMs),[12,11]);
  assert.equal(f.reading.samples[0].callbacksSinceMovingFrame,2);
  f.historyLayer.getAnimations=()=>[];f.runFrame(200);
  f.historyLayer.getAnimations=animate;
  run(300,40);run(320,30);run(400,10);
  assert.equal(f.reading.samples.at(-1)!.samplerMs,0,'a new fold starts with no earlier observer work');
});

test('fold outliers retain sample-entry gaps after a phase change, including repeated RAF timestamps',()=>{
  for(const [entries,end,count,gap] of [[[40,60,80],100,4,20],[[100,100],110,3,80]] as const){
    const f=fixture();
    f.wheel(0,0);f.requestFrame(()=>f.update(1,5));f.runFrame(5);
    for(const svg of [f.historySvg,f.activitySvg,f.budgetSvg,f.fundsSvg,f.sessionSvg])delete svg.dataset.panEnd;
    f.historyLayer.getAnimations=()=>[{playState:'running'}];
    f.historyLayer.style.transform='translateX(40px)';f.runFrame(10);
    f.historyLayer.style.transform='translateX(30px)';f.runFrame(20);
    for(const at of entries)f.runFrame(at);
    f.historyLayer.style.transform='translateX(10px)';f.runFrame(end);
    assert.deepEqual(Array.from(f.reading.frames),[end-20]);
    assert.equal(f.reading.samples[0].callbacksSinceMovingFrame,count);
    assert.equal(f.reading.samples[0].maxCallbackGapMs,gap);
    assert.deepEqual(Array.from(f.reading.latency),[5]);
  }
});

test('movement with the same RAF timestamp cannot reset the next outlier receipt',()=>{
  const f=fixture();
  for(const svg of [f.historySvg,f.activitySvg,f.budgetSvg,f.fundsSvg,f.sessionSvg])delete svg.dataset.panEnd;
  f.historyLayer.getAnimations=()=>[{playState:'running'}];
  f.historyLayer.style.transform='translateX(40px)';f.runFrame(10);
  f.historyLayer.style.transform='translateX(30px)';f.runFrame(20);
  f.historyLayer.style.transform='translateX(20px)';f.runFrame(100);
  f.historyLayer.style.transform='translateX(15px)';f.runFrame(100);
  f.historyLayer.style.transform='translateX(10px)';f.runFrame(180);
  assert.deepEqual(Array.from(f.reading.frames),[80,80]);
  assert.deepEqual(Array.from(f.reading.samples,sample=>[sample.callbacksSinceMovingFrame,sample.maxCallbackGapMs]),[[1,80],[2,80]]);
});

test('each follower fold cannot be skipped or credited early by an idle initiator', () => {
  for (const typed of [false,true]) for (const initiator of ['quota', 'session', 'activity', 'budget', 'funds'] as const) for (const family of ['quota', 'session', 'activity', 'budget', 'funds'] as const) for (const html of [true, false]) {
    const f = fixture(initiator,typed); f.wheel(0, 0);
    for (const svg of [f.historySvg, f.activitySvg, f.budgetSvg, f.fundsSvg, f.sessionSvg]) {
      delete svg.dataset.panEnd; svg.parentElement.dataset.axisEnd = '12';
    }
    f.context.location.search = '?from=0&to=12';
    const layer = ({quota:f.historyLayer,session:f.sessionLayer,activity:f.activityLayer,budget:f.budgetLayer,funds:f.fundsLayer})[family];
    const moving = html ? layer : layer.slides;
    moving.getAnimations = () => [{playState: 'running'}];
    f.paintFold(moving,'translateX(40px) scaleX(.6)'); f.runFrame(10); f.runFrame(20);
    assert.equal(f.reading.latency.length, 0, 'quota metadata cannot credit another plot that is still moving');
    assert.equal(f.reading.updated, 0, 'a running but stationary animation creates no frames');
    f.paintFold(moving,'translateX(30px) scaleX(.7)'); f.runFrame(30);
    f.paintFold(moving,'translateX(10px) scaleX(.9)'); f.runFrame(110);
    assert.deepEqual(Array.from(f.reading.frames), [80], 'the resource fold keeps its full delayed movement interval');
    assert.equal(f.reading.latency.length, 0);
    moving.getAnimations = () => []; f.paintFold(moving,'none'); f.commit(12); f.runFrame(120);
    assert.deepEqual(Array.from(f.reading.latency), [120]);
  }
});

test('a computed none transform does not finish a running fold or credit final input',()=>{
  const f=fixture('quota',true);f.wheel(0,0);
  for(const svg of [f.historySvg,f.activitySvg,f.budgetSvg,f.fundsSvg,f.sessionSvg]){delete svg.dataset.panEnd;svg.parentElement.dataset.axisEnd='12';}
  f.context.location.search='?from=0&to=12';
  f.historyLayer.style.transform='translateX(40px)';
  f.historyLayer.getAnimations=()=>[{playState:'running'}];
  f.runFrame(10);f.runFrame(30);
  assert.equal(f.reading.updated,0);assert.equal(f.reading.latency.length,0);
  f.historyLayer.getAnimations=()=>[];f.commit(12);f.runFrame(120);
  assert.deepEqual(Array.from(f.reading.latency),[120]);
});

test('unavailable or unconvertible computed transforms retain the used-value fallback',()=>{
  for(const value of [undefined,{}, {toMatrix:()=>{throw new TypeError('unresolved units');}}]){
    const f=fixture();f.wheel(0,0);
    for(const svg of [f.historySvg,f.activitySvg,f.budgetSvg,f.fundsSvg,f.sessionSvg])delete svg.dataset.panEnd;
    Object.assign(f.historyLayer,{computedStyleMap:()=>new Map([['transform',value]])});
    const original=f.context.getComputedStyle;let reads=0;
    f.context.getComputedStyle=node=>{if(node===f.historyLayer)reads++;return original(node);};
    f.historyLayer.getAnimations=()=>[{playState:'running'}];
    f.historyLayer.style.transform='translateX(40px)';f.runFrame(10);
    f.historyLayer.style.transform='translateX(30px)';f.runFrame(30);
    f.historyLayer.style.transform='translateX(10px)';f.runFrame(110);
    assert.equal(reads,3);assert.deepEqual(Array.from(f.reading.frames),[80]);
  }
});

test('active input reads inline transforms without touching computed transforms',()=>{
  const f=fixture();
  for(const layer of [f.historyLayer,f.activityLayer,f.budgetLayer,f.fundsLayer,f.sessionLayer])for(const owner of [layer,layer.slides])
    Object.defineProperty(owner,'computedStyleMap',{get:()=>{throw new Error('computed transform during input');}});
  f.wheel(0,0);f.requestFrame(()=>f.update(1,16.7));f.runFrame(16.7);
  assert.equal(f.reading.synchronized,true);assert.deepEqual(Array.from(f.reading.latency),[16.7]);
});

test('the fold interval remains open until the last data plot finishes its animation', () => {
  const f = fixture(); f.wheel(0, 0);
  for (const svg of [f.historySvg, f.activitySvg, f.budgetSvg, f.fundsSvg, f.sessionSvg]) {
    delete svg.dataset.panEnd; svg.parentElement.dataset.axisEnd = '12';
  }
  f.context.location.search = '?from=0&to=12';
  f.historyLayer.getAnimations = f.fundsLayer.getAnimations = () => [{playState: 'running'}];
  f.historyLayer.style.transform = f.fundsLayer.style.transform = 'translateX(40px)'; f.runFrame(10);
  f.historyLayer.style.transform = f.fundsLayer.style.transform = 'translateX(30px)'; f.runFrame(30);
  f.historyLayer.getAnimations = () => []; f.historyLayer.style.transform = 'none'; f.runFrame(40);
  assert.equal(f.reading.latency.length, 0, 'finishing quota cannot hide the unfinished funds layer');
  f.fundsLayer.style.transform = 'translateX(20px)'; f.runFrame(60);
  f.fundsLayer.style.transform = 'translateX(10px)'; f.runFrame(140);
  assert.ok(f.reading.frames.includes(80), 'the delayed tail belongs to the moving-frame budget');
  f.fundsLayer.getAnimations = () => []; f.fundsLayer.style.transform = 'none'; f.commit(12); f.runFrame(150);
  assert.deepEqual(Array.from(f.reading.latency), [150]);
});

test('a pending animation does not manufacture moving frames', () => {
  const f = fixture('quota');
  for (const svg of [f.historySvg, f.activitySvg, f.budgetSvg, f.fundsSvg, f.sessionSvg]) delete svg.dataset.panEnd;
  const animation = {playState: 'running', pending: true, currentTime: 0, startTime: null as number | null};
  f.historyLayer.getAnimations = () => [animation];
  f.historyLayer.style.transform = 'translateX(40px) scaleX(.6)';
  f.runFrame(10); f.runFrame(40); f.runFrame(70);
  assert.equal(f.reading.updated, 0, 'a pending animation is observed, not counted as movement');
  animation.pending = false; animation.startTime = 70; animation.currentTime = 10;
  f.historyLayer.style.transform = 'translateX(30px) scaleX(.7)'; f.runFrame(80);
  animation.currentTime = 30;
  f.historyLayer.style.transform = 'translateX(20px) scaleX(.8)'; f.runFrame(100);
  animation.playState = 'finished'; f.historyLayer.style.transform = 'none'; f.runFrame(230);
  assert.deepEqual(Array.from(f.reading.frames), [20], 'only actual movement contributes to the frame budget');
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
  f.sessionLayer.slides.style.transform=f.historyLayer.slides.style.transform=f.budgetLayer.slides.style.transform=f.fundsLayer.slides.style.transform='translateX(-24px)';
  f.activityLayer.slides.style.transform='translateX(-14px)';
  f.activitySvg.dataset.drawReady = 'true'; f.runFrame(33.4);
  assert.equal(f.reading.latency[0], 33.4);
});

test('final credit rejects a ready zoom around a matching endpoint until both time landmarks match',()=>{
  const f=fixture();f.wheel(0,0);f.context.location.search='?from=0&to=12';
  for(const svg of [f.historySvg,f.sessionSvg,f.activitySvg,f.budgetSvg,f.fundsSvg]){delete svg.dataset.panEnd;svg.parentElement.dataset.axisEnd='12';}
  for(const layer of [f.historyLayer,f.sessionLayer,f.budgetLayer,f.fundsLayer])layer.slides.style.transform='translateX(-24px)';
  f.activityLayer.slides.style.transform='translateX(-14px)';
  f.historyLayer.slides.style.transform='translateX(-16px) scaleX(0.8)';
  f.runFrame(16.7);assert.equal(f.reading.latency.length,0,'the origin agrees, but a second timestamp exposes the zoom');
  f.historyLayer.slides.style.transform='translateX(-24px)';f.runFrame(33.4);assert.equal(f.reading.latency[0],33.4);
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


test('coalesced input is credited only when its own position has reached the data layers', () => {
  const f=fixture('quota');
  f.wheel(10,30);f.wheel(20,31);
  f.requestFrame(()=>f.update(1,32));f.runFrame(31);
  assert.equal(f.reading.latency.length,1);
  assert.equal(f.reading.pending.length,1);
  f.requestFrame(()=>f.update(2,60));f.runFrame(59);
  assert.equal(f.reading.latency.length,2);
  assert.equal(f.reading.pending.length,0);
  assert.equal(f.reading.latency[1],40);
});


/** These tests execute the shipped sampler, report export and preparation queue. */
const nativeFixture=()=>fixture('session',true,false,true,new Preparations({now:()=>0,post:()=>{}}));
const receipt=(f:ReturnType<typeof fixture>)=>{assert.equal(typeof f.reading.readDiagnostic,'function','selected native receipt is installed');return f.reading.readDiagnostic!();};
const canonical=(f:ReturnType<typeof fixture>)=>JSON.parse(JSON.stringify({frames:f.reading.frames,latency:f.reading.latency,inputs:f.reading.inputs,updated:f.reading.updated,chartUpdates:f.reading.chartUpdates,pending:f.reading.pending.length,reads:f.reads,geometry:[f.historySvg,f.sessionSvg,f.activitySvg,f.budgetSvg,f.fundsSvg].map(svg=>({...svg.dataset,height:svg.style.height})),poses:[f.historyLayer,f.sessionLayer,f.activityLayer,f.budgetLayer,f.fundsLayer].map(layer=>[layer.style.transform,layer.slides.style.transform]),clip:f.activityClip.style}));

test('selected native receipt keeps sub-50ms frames and exact input/RAF joins without changing the probe',()=>{
  const off=fixture('session',true),on=nativeFixture();
  for(const f of [off,on]){f.wheel(10,15);f.requestFrame(()=>f.update(1,30));f.runFrame(30);f.wheel(40,44);f.requestFrame(()=>f.update(2,64.2));f.runFrame(64.2);}
  assert.deepEqual(canonical(on),canonical(off));assert.equal(off.reading.readDiagnostic,undefined);
  assert.equal(receipt(on).status,'insufficient-evidence','sampling is still active');
  const report=on.freeze(),d=report.nativeDiagnostic;assert.ok(d);assert.equal(d.status,'complete');
  assert.equal(d.initiator,'session');assert.equal(d.period,'30d');assert.equal(d.frames.length,1);assert.ok(Math.abs(d.frames[0].ms-34.2)<1e-10);
  const frame=d.frames[0],input=d.inputs.find(row=>row.id===2)!;assert.equal(frame.at,64.2);assert.equal(frame.stamp,64.2);assert.equal(frame.index,0);
  assert.equal(input.sampleId,frame.sampleId);assert.equal(input.rafId,frame.rafId);assert.equal(input.token,frame.token);assert.equal(input.reached,frame.at);
  assert.deepEqual([input.at,input.delivered,input.reached,input.ms,input.queued,input.processed],[40,44,64.2,24.200000000000003,4,20.200000000000003]);
  const callback=d.callbacks.find(row=>row.id===frame.rafId)!;assert.ok(callback.at<=frame.at&&callback.to>=frame.at);assert.ok(callback.sampleFrom<frame.sampleId&&callback.sampleTo>=frame.sampleId);
  assert.equal(report.outliers?.length,0,'the original >50ms outlier view is unchanged');assert.deepEqual(Array.from(report.frames),Array.from(off.reading.frames));
});

test('selected native receipt retains stationary clamps, reversal and the final unpainted input',()=>{
  const f=nativeFixture();f.limits(0,18);
  f.wheel(0,0);f.requestFrame(()=>f.update(1,16));f.runFrame(16);f.wheel(20,20);f.requestFrame(()=>f.update(1.5,32));f.runFrame(32);
  const frames=f.reading.frames.length;f.wheel(40,40);f.runFrame(48);assert.equal(f.reading.frames.length,frames);
  f.wheel(50,50,0,()=>{},-12);f.requestFrame(()=>f.update(.5,64));f.runFrame(64);
  const d=f.freeze().nativeDiagnostic!;assert.equal(d.status,'complete');assert.equal(d.inputs.length,4);assert.equal(d.inputs[2].id,3);assert.equal(d.inputs[2].reached,48);assert.equal(d.inputs[2].rafId,0);
  assert.ok(!d.frames.some(row=>row.sampleId===d.inputs[2].sampleId),'a stationary clamp has no manufactured movement');
  const final=nativeFixture();final.limits(0,18);final.wheel(0,0);final.wheel(1,1);
  for(const svg of [final.historySvg,final.activitySvg,final.budgetSvg,final.fundsSvg,final.sessionSvg])delete svg.dataset.panEnd;
  final.context.location.search='?from=0&to=18';final.runFrame(10);assert.equal(receipt(final).inputs.length,0);
  final.fundsSvg.dataset.drawReady='false';final.commit(18);final.runFrame(20);assert.equal(receipt(final).inputs.length,0);
  final.fundsSvg.dataset.drawReady='true';final.runFrame(40);const frozen=final.freeze().nativeDiagnostic!;
  assert.equal(frozen.status,'complete');assert.deepEqual(Array.from(frozen.inputs,row=>row.reached),[40,40]);assert.equal(frozen.frames.length,0);
});

test('selected native receipt retains a sub-50ms compositor fold with its actual phase',()=>{
  const f=nativeFixture();
  for(const svg of [f.historySvg,f.activitySvg,f.budgetSvg,f.fundsSvg,f.sessionSvg])delete svg.dataset.panEnd;
  f.historyLayer.getAnimations=()=>[{playState:'running'}];
  f.paintFold(f.historyLayer,'translateX(40px) scaleX(.6)');f.runFrame(10);
  f.paintFold(f.historyLayer,'translateX(30px) scaleX(.7)');f.runFrame(20);
  f.paintFold(f.historyLayer,'translateX(10px) scaleX(.9)');f.runFrame(54.2);
  const d=f.freeze().nativeDiagnostic!;assert.ok(d);assert.equal(d.status,'complete');assert.equal(d.frames.length,1);
  assert.ok(Math.abs(d.frames[0].ms-34.2)<1e-10);assert.equal(d.frames[0].segment,'fold');assert.equal(d.frames[0].inputSegment,'wheel');assert.equal(d.frames[0].rafId,0);assert.equal(d.frames[0].token,1);assert.equal(d.inputs.length,0);
});

test('selected native receipt observes actual preparation slices and preserves post this/return/errors and restoration',()=>{
  let f!:ReturnType<typeof fixture>;const tasks:(()=>unknown)[]=[],env={now:()=>f.now(),post(this:unknown,run:()=>unknown){assert.equal(this,env);tasks.push(run);return tasks.length;}};
  const post=env.post,scheduler=new Preparations(env);f=fixture('session',true,false,true,scheduler);let advances=0,ready=0;
  scheduler.replace({},(function*(){for(let i=0;i<20;i++){advances++;f.setTime(f.now()+2);yield;}return 7;})(),()=>true,value=>{ready=value;});
  assert.equal(tasks.length,1);tasks.shift()!();assert.equal(advances,16);assert.equal(tasks.length,1);tasks.shift()!();assert.equal(ready,7);
  assert.equal(receipt(f).preparations.length,2,'one observation per actual slice, not generator advance');
  assert.equal(env.post(()=>41),1);assert.equal(tasks.shift()!(),41);const error=new Error('original callback');env.post(()=>{throw error;});assert.throws(()=>tasks.shift()!(),value=>value===error);
  env.post(()=>99);f.reading.cleanup();assert.equal(env.post,post);assert.equal(tasks.shift()!(),99,'a queued wrapper still calls the original callback after cleanup');
  const d=receipt(f);assert.equal(d.status,'complete');assert.equal(d.preparationAttached,true);assert.equal(d.preparationRestored,true);assert.equal(d.preparations.length,4);assert.deepEqual(Array.from(d.preparations.slice(0,2),row=>[row.jobsBefore,row.jobsAfter]),[[1,1],[1,0]]);
});

test('selected native receipt caps retained observations while preserving canonical arrays and refusal counts',async()=>{
  const tasks:(()=>unknown)[]=[],env={now:()=>0,post:(run:()=>unknown)=>{tasks.push(run);}},scheduler=new Preparations(env),f=fixture('session',true,false,true,scheduler);
  for(let i=0;i<4093;i++){env.post(()=>{});tasks.shift()!();}let d=receipt(f);assert.equal(d.count,4096);assert.equal(d.omitted,0);assert.equal(d.preparations.length,4093);assert.equal(d.settlements.rows.length,3);
  const ready=readinessFixture(true,f);for(const segment of ['wheel','drag','return'] as const){ready.reset();await ready.settled(segment);if(segment!=='return')await ready.density(segment);}
  d=receipt(f);assert.equal(d.count,4096);assert.equal(d.omitted,0);assert.equal(d.settlements.status,'complete');
  env.post(()=>{});tasks.shift()!();d=f.freeze().nativeDiagnostic!;assert.equal(d.count,4096);assert.equal(d.omitted,1);assert.equal(d.status,'insufficient-evidence');assert.equal(d.preparations.length,4093);
  assert.equal(d.settlements.status,'complete','a complete channel cannot upgrade an omitted journal');
  assert.equal(f.reading.frames.length,0);assert.equal(f.reading.latency.length,0);assert.equal(f.reading.inputs,0);
});

// Execute the existing settlement and density helpers against the same ordered DOM reads.
function readinessFixture(detailed=true,f=detailed?nativeFixture():fixture('session',true)) {
  let phase=0,hold=false,clocks=0,original:Error|undefined,densityError:Error|undefined,onWait:((ms:number)=>void)|undefined;
  const reads:string[]=[],waits:number[]=[],wanted='30d';
  const svg={localName:'svg',hasAttribute:()=>{reads.push('panEnd');if(original)throw original;return phase<=1;},getAttribute:()=>{reads.push('drawReady');return phase<=2?'false':'true';},classList:{contains:()=>{reads.push('isPanning');return phase<=3;}}};
  const groups=['forecast','budget-table','agents-panel'].map((name,index)=>[{dataset:{get historyRange(){reads.push(name);return phase<=index+4?'pending':wanted;}}}]);
  const rect=()=>{reads.push('rect');if(densityError)throw densityError;f.setTime(f.now()+1);return{left:100,right:200,width:900};};
  const densitySvg={getBoundingClientRect:rect,viewBox:{baseVal:{width:900}}},densityPanel={querySelector:()=>densitySvg,querySelectorAll:()=>[{dataset:{series:'one'},querySelectorAll:()=>[{getBoundingClientRect:rect}]}]};
  const document={getElementsByClassName:(name:string)=>{reads.push('collection:'+name);return name==='is-loading'?{*[Symbol.iterator](){if(phase===0)yield{classList:{contains:(name:string)=>{reads.push('loading:'+name);return name==='history';}}};}}:name==='chart'?[{children:[svg]}]:groups[['forecast','budget-table','agents-panel'].indexOf(name)];},querySelectorAll:()=>[],querySelector:()=>densityPanel};
  f.context.performance.now=()=>{clocks++;return f.now();};
  const globals={...f.context,document,Date:{now:()=>f.now()},localStorage:{getItem:()=>JSON.stringify({range:wanted})},setTimeout:(run:()=>void,ms:number)=>{waits.push(ms);f.setTime(f.now()+ms);if(ms===20&&!hold)phase++;onWait?.(ms);run();}};
  const ast=ts.createSourceFile('panning.ts',source,ts.ScriptTarget.Latest,true),fn=ast.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='panning')!;
  const helpers=fn.body!.statements.filter(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>['settled','density'].includes(d.name.getText(ast))));
  const sandbox={cdp:{evaluate:(expression:string)=>runInNewContext(expression,globals)}};
  runInNewContext(ts.transpileModule(`${helpers.map(node=>node.getText(ast)).join('\n')}globalThis.settled=settled;globalThis.density=density;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
  const api=sandbox as typeof sandbox&{settled(segment?:'wheel'|'drag'|'return'):Promise<void>;density(segment?:'wheel'|'drag'):Promise<object>};
  return{f,reads,waits,settled:api.settled,density:api.density,clocks:()=>clocks,reset:()=>{phase=0;},clear:()=>{phase=7;},hold:()=>{hold=true;},fail:(error:Error)=>{original=error;},failDensity:(error:Error)=>{densityError=error;},onWait:(run:(ms:number)=>void)=>{onWait=run;}};
}

test('selected readiness observes all first blockers and density on the same three rows without extra DOM reads',async()=>{
  const on=readinessFixture(),off=readinessFixture(false);
  for(const f of [on,off])for(const segment of ['wheel','drag','return'] as const){f.reset();await f.settled(f===on?segment:undefined);if(segment!=='return')assert.deepEqual(JSON.parse(JSON.stringify(await f.density(f===on?segment:undefined))),{series:1,sessionSeries:1,budgetSeries:1,fundsSeries:1});}
  assert.deepEqual(on.reads,off.reads,'every original selector and short-circuit getter remains in the same order');assert.deepEqual(on.waits,off.waits);assert.equal(off.clocks(),0);assert.equal(off.f.reading.readSettlements,undefined);assert.equal(off.f.reading.markSettlement,undefined);
  const d=on.f.freeze().nativeDiagnostic!,rows=d.settlements.rows;assert.equal(d.status,'complete');assert.equal(d.settlements.status,'complete');assert.equal(rows.length,3);assert.equal(on.clocks(),14,'thirteen bookends plus the existing diagnostic stop');
  for(const row of rows){assert.equal(row.polls,8);assert.deepEqual(Object.values(row.blockers),[1,1,1,1,1,1,1]);assert.equal(row.ready!-row.begin!,140);assert.equal(row.end!-row.ready!,250);if(row.segment==='return'){assert.equal(row.densityBegin,null);assert.equal(row.densityEnd,null);}else{assert.equal(row.densityBegin,row.end);assert.equal(row.densityEnd!-row.densityBegin!,8);}}
  assert.deepEqual(JSON.parse(JSON.stringify(safeEvidence(d.settlements))),JSON.parse(JSON.stringify(d.settlements)));
  const untagged=readinessFixture();await untagged.settled();assert.equal(untagged.clocks(),0);assert.ok(untagged.f.reading.readSettlements!().rows.every(row=>row.begin===null));
});

test('readiness retains the original strict timeout and thrown error without false completion',async()=>{
  const on=readinessFixture(),off=readinessFixture(false);on.hold();off.hold();
  let message='';for(const f of [on,off])await assert.rejects(f.settled(f===on?'wheel':undefined),(error:Error)=>{assert.ok(error.message.startsWith('charts and complete totals did not settle: '));if(message)assert.equal(error.message,message);message=error.message;return true;});
  assert.deepEqual(on.waits,off.waits);assert.equal(on.waits.length,751);assert.ok(on.waits.every(ms=>ms===20));assert.equal(on.f.now(),15020);
  const partial=runInNewContext(panPartialScript('session','30d'),on.f.context);assert.equal(partial.settlements.status,'insufficient-evidence');assert.equal(partial.settlements.rows[0].polls,752);assert.equal(partial.settlements.rows[0].ready,null);assert.equal(partial.settlements.rows[0].end,null);
  const f=readinessFixture(),original=new Error('original DOM failure');f.fail(original);await assert.rejects(f.settled('drag'),error=>error===original);assert.equal(f.f.reading.readSettlements!().rows[1].end,null);
  const density=readinessFixture(),error=new Error('original layout failure');await density.settled('wheel');density.failDensity(error);await assert.rejects(async()=>density.density('wheel'),value=>value===error);const row=density.f.reading.readSettlements!().rows[0];assert.equal(row.densityBegin,row.end);assert.equal(row.densityEnd,null);assert.equal(density.f.reading.readSettlements!().status,'insufficient-evidence');
});

test('immediate readiness and repeated settlement keep exactly three fixed rows',async()=>{
  const f=readinessFixture();f.clear();await f.settled('wheel');const first=f.f.reading.readSettlements!();assert.equal(first.rows[0].begin,first.rows[0].ready);assert.equal(first.rows[0].polls,1);assert.ok(Object.values(first.rows[0].blockers).every(value=>value===0));
  f.reset();await f.settled('wheel');assert.deepEqual(f.f.reading.readSettlements!(),first);assert.equal(receipt(f.f).count,3);assert.equal(receipt(f.f).settlements.rows.length,3);
});

test('partial readiness copies only fixed rows and cleanup prevents late asynchronous upgrades',async()=>{
  const f=readinessFixture();f.onWait(ms=>{if(ms===20&&f.f.reading.running)f.f.reading.cleanup();});
  const before=f.f.reading.readSettlements!();await f.settled('wheel');const stopped=f.f.reading.readSettlements!();assert.equal(before.rows[0].begin,null);assert.equal(stopped.rows[0].begin,0);assert.equal(stopped.rows[0].polls,1);assert.equal(stopped.rows[0].ready,null);assert.equal(stopped.rows[0].end,null);assert.equal(stopped.status,'insufficient-evidence');assert.equal(f.waits.at(-1),250,'the original settling wait still completes');
  await f.density('wheel');assert.deepEqual(f.f.reading.readSettlements!(),stopped);assert.equal(runInNewContext(panPartialScript('session','30d'),f.f.context).status,'unavailable');
  const live=readinessFixture();await live.settled('wheel');live.f.reading.readDiagnostic=()=>{throw new Error('whole journal must not be copied');};
  const partial=runInNewContext(panPartialScript('session','30d'),live.f.context);assert.equal(partial.settlements.rows.length,3);assert.equal(partial.nativeDiagnostic,undefined);assert.ok(JSON.stringify(partial.settlements).length<4096);assert.deepEqual(JSON.parse(JSON.stringify(partial.settlements)),JSON.parse(JSON.stringify(live.f.reading.readSettlements!())));
});

test('only the three measured settlement calls and two density calls receive explicit diagnostic stages',()=>{
  const ast=ts.createSourceFile('panning.ts',source,ts.ScriptTarget.Latest,true),calls=new Map<string,string[]>();
  const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&['settled','density'].includes(node.expression.getText(ast))){const name=node.expression.getText(ast),rows=calls.get(name)??[];rows.push(node.arguments.map(arg=>arg.getText(ast)).join(','));calls.set(name,rows);}ts.forEachChild(node,visit);};visit(ast);
  assert.deepEqual(calls.get('settled')!.filter(Boolean),["detailed?'wheel':undefined","detailed?'drag':undefined","detailed?'return':undefined"]);assert.equal(calls.get('settled')!.filter(row=>!row).length,5);
  assert.deepEqual(calls.get('density')!.filter(Boolean),["detailed?'wheel':undefined","detailed?'drag':undefined"]);assert.equal(calls.get('density')!.filter(row=>!row).length,1);
});

test('selected native receipt leaves busy/missing scheduler coverage explicit and never overwrites a newer post',()=>{
  const tasks:(()=>unknown)[]=[],env={now:()=>0,post:(run:()=>unknown)=>{tasks.push(run);}},scheduler=new Preparations(env),owner={};
  scheduler.replace(owner,(function*(){yield;})(),()=>true,()=>{});const busy=fixture('session',true,false,true,scheduler);assert.equal(tasks.length,1);
  const d=busy.freeze().nativeDiagnostic!;assert.equal(d.status,'insufficient-evidence');assert.equal(d.preparationJobsAtAttach,1);assert.equal(d.preparationPendingAtAttach,true);assert.equal(tasks.length,1,'the observer never drains pending preparation');scheduler.dispose();
  for(const missing of [undefined,{size:0,pending:false,env:{}},{size:0,env:{post:()=>{}}}]){const f=fixture('session',true,false,true,missing);assert.equal(f.freeze().nativeDiagnostic!.status,'insufficient-evidence');}
  const empty=new Preparations({now:()=>0,post:()=>{}}),f=fixture('session',true,false,true,empty);assert.equal(f.freeze().nativeDiagnostic!.status,'complete');
  const nextEnv={now:()=>0,post:(_run:()=>void)=>{}},next=new Preparations(nextEnv),changed=fixture('session',true,false,true,next),newer=()=>{};nextEnv.post=newer;
  const lost=changed.freeze().nativeDiagnostic!;assert.equal(lost.status,'insufficient-evidence');assert.equal(lost.preparationRestored,false);assert.equal(nextEnv.post,newer);
});

test('selected native receipt exports after freeze separately from ordinary reports before trace cleanup',async()=>{
  const f=nativeFixture();f.wheel(0,0);f.requestFrame(()=>f.update(1,16));f.runFrame(16);const report=f.freeze();assert.ok(report.nativeDiagnostic);
  const finish=source.split('reports.push(report);')[1].split("at('postconditions');")[0],calls:string[]=[],ordinary:unknown[]=[],detailed:unknown[]=[];
  await runInNewContext(ts.transpileModule(`(async()=>{${finish}})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
    report,initiator:'session',period:'30d',Buffer,
    evidence:{save:(_name:string,value:unknown)=>{assert.equal(f.reading.running,false);assert.equal((value as PanReading).nativeDiagnostic,undefined);calls.push('ordinary');ordinary.push(JSON.parse(JSON.stringify(value)));},saveTrace:(name:string,value:NativePanReceipt)=>{assert.equal(name,'native-panning-receipt');assert.equal(f.reading.running,false);assert.equal(value.status,'complete');calls.push('diagnostic');detailed.push(value);}},
    cdp:{send:async()=>{calls.push('restore');}},traced:{stop:async()=>{calls.push('stop');},bindAndClose:async()=>{calls.push('bind');}},
  });
  assert.deepEqual(calls,['ordinary','diagnostic','restore','stop','bind']);assert.equal(detailed.length,1);assert.equal(ordinary.length,1);assert.equal(report.nativeDiagnostic,undefined);
});

// Execute the actual selector statements rather than reproducing their branch formula.
test('selected native trace targets exactly its original cell and keeps the default cell',()=>{
  const ast=ts.createSourceFile('panning.ts',source,ts.ScriptTarget.Latest,true),selected=new Map<string,string>();
  const loops=new Map<string,string>();
  const walk=(node:ts.Node)=>{if(ts.isForOfStatement(node)&&['const initiator','const [period, index]'].includes(node.initializer.getText(ast)))loops.set(node.initializer.getText(ast),node.expression.getText(ast));if(ts.isVariableDeclaration(node)&&['familyTrace','traced','detailed'].includes(node.name.getText(ast)))selected.set(node.name.getText(ast),node.getText(ast));ts.forEachChild(node,walk);};walk(ast);
  const evaluateLoop=(name:string)=>runInNewContext(ts.transpileModule('('+loops.get(name)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{evidence:undefined});
  const initiators=Array.from(evaluateLoop('const initiator') as string[]),periods=Array.from(evaluateLoop('const [period, index]') as [string,number][]);
  assert.equal(initiators.length*periods.length,10,'the actual loop expressions retain the full original workload');
  assert.deepEqual(initiators,['quota','session','activity','budget','funds']);assert.deepEqual(periods.map(row=>row[0]),['24h','30d']);
  assert.ok(selected.get('familyTrace'));assert.ok(selected.get('traced'));
  assert.ok(source.indexOf('const familyTrace=')<source.indexOf('await panningReload('),'source binding begins before the selected family reload');
  for(const target of ['activity/24h','session/30d']){
    const observed:string[]=[],created:string[]=[];
    for(const initiator of initiators){
      const context={initiator,nativeTarget:target,nativeTrace:()=>{created.push(initiator);return{};}};
      runInNewContext(`const ${selected.get('familyTrace')};globalThis.family=familyTrace;`,context);
      for(const [period] of periods){const cell={period,nativeTarget:target,familyTrace:(context as typeof context&{family:unknown}).family};runInNewContext(`const ${selected.get('traced')};globalThis.active=!!traced;`,cell);if((cell as typeof cell&{active:boolean}).active)observed.push(initiator+'/'+period);}
    }
    assert.deepEqual(created,[target.split('/')[0]]);assert.deepEqual(observed,[target]);
  }
});
