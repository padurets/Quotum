import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {brotliCompressSync, constants} from 'node:zlib';
import {HISTORY_ATTEMPT_HEADER, historyBody, historyProxy, type BodyCount, type Transfer} from '../historyProxy';
import {HistoryCutChanged, bodyBounds, bodyTotals, stableHistory, trafficProblems, transferFor} from '../historyTrafficBudget';
import {trafficReadEvidence,historyCheckpointScript} from '../historyTrafficBrowser';
import {deadline} from '../deadline';

test('history cleanup releases its owned target when the renderer cannot answer', async () => {
  const source = readFileSync(new URL('../historyTrafficBrowser.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const close = async () =>'), end = source.indexOf('\n  try {', start);
  assert.ok(start >= 0 && end > start);
  let closed = 0, evaluations = 0;
  const contexts: string[] = [];
  const fixture = {name: 'fixture', cdp: {at: (value: string) => contexts.push(value),
    evaluate() {evaluations++; return new Promise(() => {});}},
  tab: {async close() {closed++;}}, close: null as unknown as () => Promise<void>};
  runInNewContext(ts.transpileModule(`${source.slice(start, end)}\nglobalThis.close=close;`, {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText, fixture);
  const result = fixture.close();
  assert.equal(closed, 1, 'target release cannot depend on a renderer response');
  assert.equal(evaluations, 0); assert.deepEqual(contexts, ['fixture/cleanup']);
  await result;
});

test('seed failure saves cached request evidence and preserves the original error through cleanup',async()=>{
  const source=readFileSync(new URL('../historyTrafficBrowser.ts',import.meta.url),'utf8');
  const start=source.indexOf('  } catch (error) {',source.indexOf('async function historyPage'));
  const end=source.indexOf('\n}\n',start);assert.ok(start>=0&&end>start);
  for(const unavailable of [false,true]){
    const original=new Error('accounting HTTP status 413'),saved:{name:string;value:unknown}[]=[];
    let closed=0,bindings=0;
    const receipt={reads:[{endpoint:'period',httpStatus:413,errorCode:'history_limit',requestBytes:128}]};
    const fixture={original,name:'fixture',poolName:'fixture',bodies:{stage:'seed',diagnostic:(phase:string)=>{assert.equal(phase,'fixture/seed');return receipt;}},
      evidence:{save:(name:string,value:unknown)=>{if(unavailable)throw Error('unavailable');saved.push({name,value});}},
      poolBinding:{close:()=>{bindings++;}},browser:{owner:{failures:[] as string[]}},close:async()=>{closed++;},run:null as unknown as ()=>Promise<void>};
    runInNewContext(ts.transpileModule(`globalThis.run=async()=>{try{throw original;${source.slice(start+2,end)}};`,{
      compilerOptions:{target:ts.ScriptTarget.ES2022},
    }).outputText,fixture);
    await assert.rejects(fixture.run(),error=>error===original);
    assert.equal(closed,1);assert.equal(bindings,1);
    if(unavailable)assert.deepEqual(fixture.browser.owner.failures,['history seed evidence failed']);
    else{assert.equal(saved[0].name,'traffic-seed-failure-fixture');assert.deepEqual(JSON.parse(JSON.stringify(saved[0].value)),{name:'fixture',stage:'seed',...receipt});}
  }
});

test('pool diagnostics preserve an unavailable original renderer without another command', async () => {
  const source=readFileSync(new URL('../historyTrafficBrowser.ts',import.meta.url),'utf8');
  const start=source.indexOf('  const capturePool = async () =>'),end=source.indexOf('\n  // Closing this owned target',start);
  assert.ok(start>=0&&end>start);
  for(const command of [{socketState:1,terminal:null,failure:null,pending:[{id:1}]},
    {socketState:1,terminal:null,failure:{id:1},pending:[]},
    {socketState:3,terminal:null,failure:null,pending:[]}]){
    let evaluations=0,bindings=0,closed=0;const saved:{name:string;value:unknown}[]=[],raw:{file:string;value:any}[]=[];
    const fixture={poolEvidence:{save:(name:string,value:unknown)=>saved.push({name,value})},poolCaptured:false,poolName:'fixture',name:'fixture',
      bodies:{reads:[],diagnostic:()=>({reads:[]})},poolScenario:{length:30*86400000,future:86400000,cell:3600000,geometry:{series:12}},checkpoints:[{label:'cached return/before-input',pending:1}],proxy:{transfers:[]},writeFileSync:(file:string,body:string)=>raw.push({file,value:JSON.parse(body)}),trafficReadEvidence,cdp:{snapshot:()=>command,evaluate:()=>{evaluations++;return new Promise(()=>{});}},
      poolBinding:{afterFamily:()=>{bindings++;return new Promise(()=>{});},close:()=>{closed++;}},capturePool:null as unknown as ()=>Promise<void>};
    runInNewContext(ts.transpileModule(`${source.slice(start,end)}\nglobalThis.capturePool=capturePool;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,fixture);
    await fixture.capturePool();
    assert.equal(evaluations,0);assert.equal(bindings,0);assert.equal(closed,1);
    assert.equal((saved.find(entry=>entry.name.startsWith('pool-receipt'))!.value as {receipt:{status:string}}).receipt.status,'insufficient-evidence');
    assert.equal((saved[0].value as {command:unknown}).command,command);
    assert.equal(raw.length,1);assert.match(raw[0].file,/quotum-bench-history-pool-fixture\.json$/);
    assert.deepEqual(raw[0].value.checkpoints,[{label:'cached return/before-input',pending:1}]);
    assert.equal(raw[0].value.receipt.status,'insufficient-evidence');assert.equal(raw[0].value.calendar.status,'insufficient-evidence');
  }
});

test('pool capture retains exact checkpoints and stops debugger collection after a failed receipt',async()=>{
  const source=readFileSync(new URL('../historyTrafficBrowser.ts',import.meta.url),'utf8');
  const start=source.indexOf('  const capturePool = async () =>'),end=source.indexOf('\n  // Closing this owned target',start);
  for(const fail of [false,true]){
    const saved=new Map<string,any>(),raw:any[]=[];let evaluations=0,bindings=0,closed=0;
    const command={socketState:1,terminal:null,failure:null,pending:[]};
    const fixture={poolEvidence:{save:(name:string,value:unknown)=>saved.set(name,value)},poolCaptured:false,poolName:'fixture',name:'fixture',length:86400000,
      bodies:{reads:[],phase:'warm',stage:'cached repeat',diagnostic:()=>({reads:[]})},poolScenario:{length:86400000,future:0,cell:300000,geometry:{series:12}},checkpoints:[] as unknown[],proxy:{transfers:[]},
      writeFileSync:(_file:string,body:string)=>raw.push(JSON.parse(body)),trafficReadEvidence,historyCheckpointScript,deadline,
      cdp:{snapshot:()=>fail&&evaluations?{...command,failure:{id:1}}:command,evaluate:async(script:string)=>{evaluations++;assert.ok(script.includes('cohort/before-cleanup'));if(fail)throw Error('renderer unavailable');return {receipt:{status:'complete'},calendar:{status:'complete'},page:{label:'cohort/before-cleanup',pending:{preparationSize:1}}};}},
      poolBinding:{afterFamily:async()=>{bindings++;},close:()=>{closed++;}},capturePool:null as unknown as ()=>Promise<void>};
    runInNewContext(ts.transpileModule(`${source.slice(start,end)}\nglobalThis.capturePool=capturePool;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,fixture);
    await fixture.capturePool();await fixture.capturePool();
    assert.equal(evaluations,1);assert.equal(bindings,fail?0:1);assert.equal(closed,1);assert.equal(raw.length,1);
    assert.equal(raw[0].receipt.status,fail?'insufficient-evidence':'complete');
    if(!fail){assert.equal(raw[0].checkpoints[0].label,'cohort/before-cleanup');assert.equal(raw[0].checkpoints[0].page.pending.preparationSize,1);}
    assert.equal(saved.get('pool-original-fixture').command,command);
  }
});

test('traffic evidence retains attempted ranges and body uncertainty without selection text or payloads', () => {
  const read={selection:'board=private-canary',id:'1',phase:'cold',from:0,to:60,cell:1,lower:12,
    before:Promise.resolve(['private-canary']),payload:'private-canary',count:{complete:false,lower:12,coding:'br'}};
  const [saved]=trafficReadEvidence([read]);
  assert.doesNotMatch(JSON.stringify(saved),/private-canary|payload|before/);
  assert.equal(saved.from,0);assert.equal(saved.to,60);assert.equal(saved.count?.complete,false);
  assert.equal(saved.count?.lower,12);assert.equal(saved.selectionHash.length,64);
  assert.notEqual(saved.selectionHash,trafficReadEvidence([{...read,selection:'board=another'}])[0].selectionHash);
});

const transfer: Transfer = {id: '1', phase: 'cold', cell: 1, from: 0, to: 60, started: 0, sent: true, finished: true, aborted: false, decoded: 100, encoded: 40};
test('body budgets require actual matching coding and payload lengths, never transport totals', () => {
  const body = {id: '1', complete: true, decoded: 100, lower: 40, upper: 40, length: 40, coding: 'br'};
  assert.equal(bodyBounds(body, transfer).upper, 40);
  for (const bad of [{...body, coding: 'identity'}, {...body, lower: 200}, {...body, decoded: 99}, {...body, length: 39}, {...body, id: 'different'}, {...body, responseId: 'different'}]) assert.throws(() => bodyBounds(bad, transfer));
  assert.throws(() => bodyBounds(body));
  assert.deepEqual(bodyBounds({complete: false, lower: 12}, transfer), {lower: 12, upper: 40, unknown: 1, partial: 1});
  assert.equal(bodyBounds({complete: false, lower: 0}).upper, null);
  assert.deepEqual(bodyBounds({complete: false, lower: 0}, {...transfer, sent: false, finished: false, aborted: true}), {lower: 0, upper: 0, unknown: 0, partial: 1});
  const reading = {name: 'cold', attempts: 5, maxAttempts: 7, decoded: 100, encodedUpper: 40, referenceDecoded: 100, referenceEncoded: 40, ratios: true};
  assert.deepEqual(trafficProblems(reading), []);
  for (const bad of [{...reading, attempts: 8}, {...reading, decoded: 151}, {...reading, encodedUpper: 81}, {...reading, encodedUpper: null}]) assert.ok(trafficProblems(bad).length);
});

test('the owned proxy measures a real fixed-codec HTTP body without changing JSON', async () => {
  const answer = {run: 'r', known: {work: 123, sources: {s: 456}}, chunks: [{from: 0, to: 60, series: []}]};
  const upstream = createServer((_req, res) => res.setHeader('Content-Type', 'application/json').end(JSON.stringify(answer)));
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await historyProxy(`http://127.0.0.1:${(upstream.address() as {port: number}).port}`);
  try {
    let counted;
    assert.deepEqual(await historyBody(`${proxy.url}/api/history?cell=1&from=0&to=60`, '', undefined, count => {counted = count;}), answer);
    assert.equal(proxy.transfers.length, 1);
    assert.equal(bodyBounds(counted!, proxy.transfers[0]).upper, proxy.transfers[0].encoded);
    assert.equal(proxy.transfers[0].decoded, Buffer.byteLength(JSON.stringify(answer)));
    assert.equal(proxy.transfers[0].finished, true);
  } finally {await proxy.close(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});

import {HistoryBodies, hasSeededHistory, historyReadSelection, historyScroll, prepareHistoryTarget, stableHistoryReads} from '../historyTrafficBrowser';
import {readUnion} from '../historyTrafficBudget';
import {compactJSON} from '../../server/history';
import type {PeriodReply} from '../../server/domain/periodRead';

test('failed cold cohorts retain original wire sizes and section errors without changing body verdicts', async () => {
  const basis={run:'private-canary',revision:'0',evaluatedAt:3000,evidenceCut:2000,range:{from:1000,to:2000}};
  const fixed={range:basis.range,money:[],quota:[],shift:{until:2000,steps:[],window:{paths:[],slopes:[[]],pieces:[[1000,3000,0,[]]]}}};
  const history={run:'private-canary',now:3000,historyStart:0,known:{work:0,sources:{'private-canary':0}},chunks:[],tape:{from:0,cut:3000,money:[],quota:[],fixed}};
  const reply={basis,...Object.fromEntries(['quota','budget','funds'].map(scope=>[scope,{state:'complete',basis,value:history}])),
    values:{state:'complete',basis,value:Array.from({length:69},(_,i)=>({id:`private-canary-${i}`,provider:'codex',windows:[],meters:[],keys:[]}))},
    sessions:{state:'complete',basis,value:{refs:[],spans:[],fixed,cursor:'private-canary'}}} as unknown as PeriodReply;
  const request={version:1,selection:{mode:'range',from:1000,to:2000},evaluatedAt:3000,values:Array(69).fill('private-canary'),sessions:{},
    ...Object.fromEntries(['quota','budget','funds'].map(scope=>[scope,{cell:'1000',from:'1000',to:'2000',cells:'skip'}]))};
  const original=compactJSON(reply);assert.notEqual(original,JSON.stringify(reply),'the server wire uses compact numbers');
  for(const [phase,answer,post] of [
    ['browser/1d/activity/100ms/0.5/take1/cold',original,request],
    ['browser/1d/activity/400ms/0.5/take1/cold',compactJSON({...reply,funds:{state:'error',error:'history_limit'}}),request],
    ['browser/1d/activity/100ms/0.5/take1/cold',JSON.stringify(reply),request],
    ['browser/1d/activity/100ms/0.5/take1/warm',original,request],
    ['browser/1d/activity/0ms/0.5/take1/cold',original,request],
    ['browser/1d/activity/100ms/0.5/take1/cold',original,{...request,values:['private-canary']}],
  ] as const){
    const listeners=new Map<string,(event:never)=>void>();
    let sends=0;
    const cdp={on:<T>(name:string,fn:(event:T)=>void)=>listeners.set(name,fn as (event:never)=>void),send:async<T>()=>{sends++;return {body:answer,base64Encoded:false} as T;}};
    const observer=new HistoryBodies(cdp);observer.phase=phase;
    const emit=(name:string,event:object)=>listeners.get(name)?.(event as never);
    emit('Network.requestWillBeSent',{requestId:'baseline',request:{url:'http://localhost/api/boards/private-canary/period',postData:JSON.stringify(post)}});
    emit('Network.responseReceived',{requestId:'baseline',response:{status:200,headers:{'Content-Encoding':'br','Content-Length':'40'}}});
    emit('Network.loadingFinished',{requestId:'baseline'});await Promise.all([...observer.pending]);
    assert.deepEqual(observer.errors,[]);assert.equal(observer.reads[0].count?.complete,true);
    assert.equal(observer.reads[0].count?.decoded,Buffer.byteLength(answer));assert.equal(observer.reads[0].count?.lower,40);
    assert.equal(sends,1,'body accounting makes no additional renderer command');
    const diagnostic=observer.diagnostic(phase),body=diagnostic.reads[0].body;
    assert.doesNotMatch(JSON.stringify(diagnostic),/private-canary/);
    assert.equal(diagnostic.bodyOmitted,0);
    if(phase.endsWith('/cold')){
      assert.ok(body);assert.equal(body.partition,Buffer.byteLength(answer));
      assert.deepEqual(body.sectionStates.values,{state:'complete',arrays:{values:69}});
      assert.deepEqual(body.sectionStates.sessions,{state:'complete',arrays:{refs:0}});
      assert.equal(body.headerBytes,null);assert.deepEqual(observer.diagnostic(phase),diagnostic,'partition is retained after raw bytes are released');
    }else assert.equal(body,null);
  }
  assert.equal(compactJSON(reply),original,'observing the wire cannot mutate retained evidence');
  const listeners=new Map<string,(event:never)=>void>();let sends=0;
  const cdp={on:<T>(name:string,fn:(event:T)=>void)=>listeners.set(name,fn as (event:never)=>void),send:async<T>()=>{sends++;return {body:original,base64Encoded:false} as T;}};
  const observer=new HistoryBodies(cdp);observer.phase='browser/1d/activity/100ms/0.5/take1/cold';
  const emit=(name:string,event:object)=>listeners.get(name)?.(event as never);
  for(let i=0;i<65;i++)emit('Network.requestWillBeSent',{requestId:String(i),request:{url:'http://localhost/api/boards/private-canary/period',postData:JSON.stringify(request)}});
  emit('Network.responseReceived',{requestId:'64',response:{status:200,headers:{'Content-Encoding':'br','Content-Length':'40'}}});
  emit('Network.loadingFinished',{requestId:'64'});await Promise.all([...observer.pending]);
  assert.equal(observer.reads[64].count?.complete,true);
  assert.equal(observer.diagnostic(observer.phase).omitted,1);assert.equal(observer.diagnostic(observer.phase).reads.length,64);assert.equal(sends,1);
  for(let i=0;i<9;i++){
    emit('Network.requestWillBeSent',{requestId:'cap'+i,request:{url:'http://localhost/api/boards/private-canary/period',postData:JSON.stringify(request)}});
    emit('Network.responseReceived',{requestId:'cap'+i,response:{status:200,headers:{'Content-Encoding':'br','Content-Length':'40'}}});
    emit('Network.loadingFinished',{requestId:'cap'+i});await Promise.all([...observer.pending]);
  }
  assert.equal(observer.diagnostic(observer.phase).bodyOmitted,1,'raw-body cap is explicit without altering physical reads');
  assert.equal(observer.reads.filter(read=>read.count?.complete).length,10);assert.equal(sends,10);
});

test('native history setup rejects a covered point or a different chart without moving its point', async () => {
  const surface = {}, other = {}, chart = {contains: (node: unknown) => node === surface};
  const point = {x: 10.75, y: 20.75};
  const fixture = (hit: (x: number, y: number) => unknown, present = true) => ({
    async send<T>() {return {} as T;},
    async evaluate<T>(source: string) {return runInNewContext(source, {document: {
      querySelector: (selector: string) => present && selector === '.activity .chart' ? chart : null,
      elementFromPoint: hit,
    }}) as T;},
  });
  await prepareHistoryTarget(fixture(() => surface), '.activity .chart', point);
  for (const cdp of [fixture(() => other), fixture(() => surface, false), fixture(x => x === point.x ? surface : other)]) {
    await assert.rejects(prepareHistoryTarget(cdp, '.activity .chart', point), /native history gesture target is covered/);
  }
  assert.deepEqual(point, {x: 10.75, y: 20.75});
});

test('traffic references preserve each resource selection instead of merging equal time cells', () => {
  const uri = new URL('http://localhost/api/history?board=b&scope=budget&unit=USD&meters=%5B%5B%22wallet%22%2C%22balance%22%5D%5D&cell=1&from=0&to=60&meta=old');
  const selection = historyReadSelection(uri);
  uri.searchParams.set('from', '60'); uri.searchParams.set('to', '120'); uri.searchParams.set('meta', 'new');
  assert.equal(historyReadSelection(uri), selection, 'new cells borrow the same selection reference');
  const reference = new URL('http://localhost/api/history?' + selection);
  assert.equal(reference.searchParams.get('scope'), 'budget');
  assert.equal(reference.searchParams.get('meters'), '[["wallet","balance"]]');
  for (const [key, value] of [['scope', 'quota'], ['unit', 'CNY'], ['meters', '[]'], ['currency', 'EUR'], ['board', 'another']]) {
    const other = new URL(uri); other.searchParams.set(key, value);
    assert.notEqual(historyReadSelection(other), selection, `${key} is part of the reference identity`);
  }
});

test('cancelled resource cohorts keep private quota bounds separate from financial metadata', () => {
  const quota = {run: 'r', now: 0, known: {work: 0, own: 100, sources: {s: 0}}};
  const money = {run: 'r', now: 0, known: {work: 0, sources: {s: 0}}};
  const seeds = new Map([['quota', {answer: quota}], ['budget', {answer: money}], ['funds', {answer: money}]]);
  const reads = [{selection: 'quota', answer: quota, to: 60_000}, {selection: 'budget', answer: money, to: 60_000}, {selection: 'funds', answer: money, to: 60_000}, {selection: 'quota', to: 60_000}];
  stableHistoryReads(reads, seeds, 60_000);
  assert.throws(() => stableHistoryReads([{selection: 'quota', answer: money, to: 60_000}], seeds, 60_000));
  assert.throws(() => stableHistoryReads([{selection: 'budget', answer: {...money, known: {...money.known, work: 1}}, to: 60_000}], seeds, 60_000));
  assert.throws(() => stableHistoryReads([{selection: 'other', answer: money, to: 60_000}], seeds, 60_000));
});

test('the browser observer expands late metadata while counting only each actual response body', async () => {
  const listeners = new Map<string, (event: never) => void>();
  const full = {run: 'r', now: 1, historyStart: 0, meta: 'tag', known: {work: 0, sources: {s: 0}}, chunks: [{from: 0, to: 60}]};
  const compact = {run: 'r', now: 2, meta: 'tag', chunks: [{from: 60, to: 120}]};
  let finishFirst!: (value: {body: string; base64Encoded: boolean}) => void;
  const cdp = {on: <T>(name: string, fn: (event: T) => void) => listeners.set(name, fn as (event: never) => void),
    send: <T>(_method: string, params: object) => ((params as {requestId: string}).requestId === 'first' ? new Promise<{body: string; base64Encoded: boolean}>(resolve => {finishFirst = resolve;}) : Promise.resolve({body: JSON.stringify(compact), base64Encoded: false})) as Promise<T>};
  const observer = new HistoryBodies(cdp);
  const emit = (name: string, event: object) => listeners.get(name)?.(event as never);
  const start = (id: string) => {emit('Network.requestWillBeSent', {requestId: id, request: {url: 'http://localhost/api/history?cell=1&from=0&to=60'}}); emit('Network.responseReceived', {requestId: id, response: {status: 200, headers: {}}});};
  start('first'); emit('Network.loadingFinished', {requestId: 'first'});
  start('second'); emit('Network.loadingFinished', {requestId: 'second'});
  finishFirst({body: JSON.stringify(full), base64Encoded: false});
  await Promise.all([...observer.pending]);
  assert.deepEqual(observer.errors, []);
  assert.deepEqual(observer.reads[1].answer, {run: 'r', now: 2, known: full.known});
  assert.equal(observer.reads[1].count?.decoded, Buffer.byteLength(JSON.stringify(compact)));
  assert.ok(observer.reads[1].count!.decoded! < Buffer.byteLength(JSON.stringify({...compact, known: full.known, historyStart: 0})));
});

test('the reference union respects fresh holes and the eight-tile API limit', () => {
  assert.deepEqual(readUnion(new Set([0, 1, 3, 4]), 1), [[0, 2], [3, 5]]);
  assert.deepEqual(readUnion(new Set(Array.from({length: 481}, (_, i) => i)), 1), [[0, 480], [480, 481]]);
});

test('metadata-only accounting rejects HTTP errors while retaining complete body bytes', async () => {
  for (const status of [500, 200, 401, 403, 409, 413, 429, 503, undefined, 0, NaN]) for(const errorCode of ['history_limit','too_large','internal_error']) {
    const listeners = new Map<string, (event: never) => void>();
    const body = JSON.stringify(status === 200 ? {basis: {}, values: {state: 'complete', value: []}}
      : {error: errorCode, detail: 'private-canary'});
    const cdp = {on: <T>(name: string, listener: (event: T) => void) => listeners.set(name, listener as (event: never) => void),
      send: async <T>() => ({body, base64Encoded: false} as T)};
    const observer = new HistoryBodies(cdp), emit = (name: string, event: object) => listeners.get(name)?.(event as never);
    emit('Network.requestWillBeSent', {requestId: 'metadata', request: {url: 'http://localhost/api/boards/private-canary/period',
      postData: JSON.stringify({selection: {mode: 'range', from: 1000, to: 2000}, values: ['private-canary'],
        quota: {cell: '1', from: '0', to: '60', cells: 'skip'}})}});
    emit('Network.responseReceived', {requestId: 'metadata', response: {status, headers: {'Content-Encoding': 'br', 'Content-Length': '40'}}});
    emit('Network.loadingFinished', {requestId: 'metadata'});
    await Promise.all([...observer.pending]);
    const read = observer.reads[0];
    assert.equal(read.count?.complete, true, 'HTTP errors still have complete physical bodies');
    assert.equal(read.count?.decoded, Buffer.byteLength(body));
    assert.equal(read.count?.length, 40);
    assert.equal(observer.errors.length, status === 200 ? 0 : 1, 'an HTTP error cannot qualify an accounting response');
    if (status !== 200) assert.equal((observer.errors[0] as Error).message,
      Number.isInteger(status) && status! >= 100 && status! <= 599 ? `accounting HTTP status ${status}` : 'accounting HTTP status unavailable');
    const numericStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : null;
    assert.equal(trafficReadEvidence(observer.reads)[0].httpStatus, numericStatus);
    const diagnostic = observer.diagnostic('seed');
    assert.equal(diagnostic.reads[0].httpStatus, numericStatus);
    assert.equal(diagnostic.reads[0].errorCode,status===200?null:errorCode==='internal_error'?'other':errorCode);
    assert.ok(diagnostic.reads[0].requestBytes!>0);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-canary|internal_error/);
  }
});

function cdpFixture() {
  const listeners = new Map<string, (event: never) => void>();
  const answer = {run: 'r', now: 1, known: {work: 0, sources: {}}, chunks: [{from: 0, to: 60}]};
  const cdp = {on: <T>(name: string, listener: (event: T) => void) => listeners.set(name, listener as (event: never) => void), send: async <T>() => ({body: JSON.stringify(answer), base64Encoded: false} as T)};
  const observer = new HistoryBodies(cdp);
  const emit = (name: string, event: object) => listeners.get(name)?.(event as never);
  const start = (id: string) => {emit('Network.requestWillBeSent', {requestId: id, request: {url: 'http://localhost/api/history?cell=1&from=0&to=60'}}); emit('Network.responseReceived', {requestId: id, response: {status: 200, headers: {'Content-Encoding': 'br', 'Content-Length': '40', 'X-Quotum-Bench-Id': id}}});};
  return {observer, emit, start, answer};
}

test('the Chrome observer excludes headers and preserves aborted-body uncertainty', async () => {
  const f = cdpFixture(); f.start('1');
  f.emit('Network.dataReceived', {requestId: '1', encodedDataLength: 40});
  f.emit('Network.loadingFinished', {requestId: '1', encodedDataLength: 1000});
  await Promise.all([...f.observer.pending]);
  const complete = f.observer.reads[0];
  assert.equal(complete.count?.lower, 40, 'the 1000-byte transport total is not a body');
  assert.equal(bodyBounds(complete.count!, {...transfer, decoded: Buffer.byteLength(JSON.stringify(f.answer))}).upper, 40);
  f.start('2'); f.emit('Network.dataReceived', {requestId: '2', encodedDataLength: 12}); f.emit('Network.loadingFailed', {requestId: '2', canceled: true});
  assert.deepEqual(bodyBounds(f.observer.reads[1].count!, {...transfer, id: '2'}), {lower: 12, upper: 40, unknown: 1, partial: 1});
  f.emit('Network.requestWillBeSent', {requestId: '3', request: {url: 'http://localhost/api/history?cell=1&from=0&to=60'}});
  f.emit('Network.loadingFailed', {requestId: '3', canceled: true});
  assert.equal(bodyBounds(f.observer.reads[2].count!).upper, null, 'missing fixture evidence must stay unknown');
  assert.equal(f.observer.activeCount, 0);
});

test('abort before proxy delivery is proved zero body while the attempted request remains counted', async () => {
  const upstream = createServer((_req, res) => res.end(JSON.stringify({run: 'r', chunks: []})));
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await historyProxy(`http://127.0.0.1:${(upstream.address() as {port: number}).port}`);
  try {
    proxy.phase('cancel', 1000); const controller = new AbortController(); let counted;
    const read = historyBody(`${proxy.url}/api/history?cell=1&from=0&to=60`, '', controller.signal, count => {counted = count;});
    const failed = assert.rejects(read);
    for (let n = 0; n < 100 && !proxy.transfers[0]?.encoded; n++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(proxy.transfers[0]?.encoded); controller.abort(); await failed; await proxy.settled('cancel');
    assert.equal(proxy.transfers.length, 1); assert.equal(bodyBounds(counted!, proxy.transfers[0]).upper, 0);
  } finally {await proxy.close(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});

test('complete payloads and partial bounds remain separate in a bounded verdict', () => {
  const counts = bodyTotals([{count: {complete: true, decoded: 100, lower: 40, length: 40, coding: 'br'}, transfer}, {count: {id: '2', complete: false, lower: 12}, transfer: {...transfer, id: '2'}}]);
  assert.deepEqual(counts.complete, {count: 1, decoded: 100, encoded: 40});
  assert.deepEqual(counts.partial, {count: 1, encodedLower: 12, encodedUpper: 40});
  assert.equal(counts.decoded, 200); assert.equal(counts.encodedLower, 52); assert.equal(counts.encodedUpper, 80); assert.equal(counts.unknown, 1); assert.equal(counts.byteVerdict, 'bounded');
  const unknown = bodyTotals([{count: {complete: false, lower: 0}}]);
  assert.equal(unknown.decoded, null); assert.equal(unknown.encodedUpper, null); assert.equal(unknown.byteVerdict, 'unverified');
  assert.throws(() => bodyBounds({complete: false, lower: 1}, {...transfer, sent: false}));
});

test('a cutoff crossing is a retryable invalid cohort, while changed known metadata remains a failure', () => {
  const seed = {run: 'r', now: 0, known: {work: 0, sources: {s: 0}}};
  stableHistory({...seed, now: 10_000}, seed, 60_000, 120_000);
  assert.throws(() => stableHistory({...seed, now: 31_000}, seed, 60_000, 120_000), HistoryCutChanged);
  assert.throws(() => stableHistory({...seed, known: {work: 1, sources: {s: 0}}}, seed, 60_000, 120_000), error => !(error instanceof HistoryCutChanged));
});

test('past-only cancellation reads survive an unrelated live cutoff while changed coverage still fails', () => {
  // A real reversal seeded at 08:39:29.593 read yesterday at 08:39:30.840.
  const seed = {run: 'r', now: 1791535169593, known: {work: 0, sources: {s: 0}}};
  const answer = {...seed, now: 1791535170840}, cell = 300_000;
  stableHistory(answer, seed, cell, 1791448500000);
  const seeds = new Map([['quota', {answer: seed}]]);
  stableHistoryReads([{selection: 'quota', answer, to: 1791448500000}], seeds, cell);
  const boundary = 1791535200000;
  stableHistory(answer, seed, cell, boundary);
  assert.throws(() => stableHistory(answer, seed, cell, boundary + 1), HistoryCutChanged);
  assert.throws(() => stableHistoryReads([{selection: 'quota', answer, to: boundary + 1}], seeds, cell), HistoryCutChanged);
  assert.throws(() => stableHistory(answer, seed, cell, boundary + cell), HistoryCutChanged);
  assert.throws(() => stableHistory(answer, seed, cell, Infinity), HistoryCutChanged);
  assert.throws(() => stableHistory({...answer, run: 'new'}, seed, cell, 1791448500000));
  assert.throws(() => stableHistory({...answer, known: {...seed.known, work: 1}}, seed, cell, 1791448500000));
});

test('native 30d cold reads retain their own exclusive ends across the live two-hour cutoff', () => {
  // Captured cold-cohort clocks and request ends; stable metadata is synthetic.
  const quota = {run: 'r', now: 1791568768004, known: {work: 0, own: 100, sources: {s: 0}}};
  const budget = {run: 'r', now: 1791568768170, known: {work: 0, sources: {s: 0}}};
  const funds = {...budget, now: 1791568768315};
  const seeds = new Map([['quota', {answer: quota}], ['budget', {answer: budget}], ['funds', {answer: funds}]]);
  const reads = [
    {selection: 'quota', answer: {...quota, now: 1791568770357}, to: 1788530400000},
    {selection: 'budget', answer: {...budget, now: 1791568770793}, to: 1788530400000},
    {selection: 'funds', answer: {...funds, now: 1791568770835}, to: 1788530400000},
  ], cell = 7_200_000, boundary = 1791568800000;
  stableHistoryReads(reads, seeds, cell);
  for (const read of reads) {
    const seed = seeds.get(read.selection)!.answer;
    stableHistory(read.answer, seed, cell, read.to);
    stableHistory(read.answer, seed, cell, boundary);
    assert.throws(() => stableHistoryReads([{...read, to: boundary + 1}], seeds, cell), HistoryCutChanged);
    assert.throws(() => stableHistory({...read.answer, run: 'new'}, seed, cell, read.to));
    assert.throws(() => stableHistoryReads([{...read, answer: {...read.answer, known: {...read.answer.known, work: 1}}}], seeds, cell));
  }
});

test('native history gestures use CDP integer speed while retaining the requested movement and cadence', () => {
  for (const fraction of [.5, .04]) {
    const geometry = {x: 250, y: 200, width: 1001}, distance = geometry.width * fraction;
    const gesture = historyScroll(geometry, fraction, distance);
    assert.ok(Number.isInteger(gesture.speed));
    assert.ok(Math.abs(distance / gesture.speed - .75) < .01);
    assert.equal(gesture.xDistance, distance); assert.equal(gesture.gestureSourceType, 'mouse'); assert.equal(gesture.preventFling, true);
  }
  assert.throws(() => historyScroll({x: 0, y: 0, width: NaN}, .5, 10));
});

test('an actual partial Brotli delivery counts payload bytes and retains the full fixture upper bound', async () => {
  const decoded = Buffer.from(JSON.stringify({run: 'r', values: Array.from({length: 300}, (_, i) => i)}));
  const encoded = brotliCompressSync(decoded, {params: {[constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_LGWIN]: 22}});
  const controller = new AbortController(); let counted: BodyCount | undefined;
  const upstream = createServer((_req, res) => {
    res.writeHead(200, {'content-encoding': 'br', 'content-length': encoded.length}); res.write(encoded.subarray(0, 12));
    const timer = setTimeout(() => controller.abort(), 30); res.once('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(upstream.address() as {port: number}).port}/api/history`;
    await assert.rejects(historyBody(url, '', controller.signal, count => {counted = count;}));
    assert.equal(counted!.complete, false); assert.equal(counted!.lower, 12, 'only the delivered compressed prefix is known');
    const bounds = bodyBounds(counted!, {...transfer, id: counted!.id!, decoded: decoded.length, encoded: encoded.length, finished: false, aborted: true});
    assert.equal(bounds.lower, 12); assert.equal(bounds.upper, encoded.length); assert.equal(bounds.unknown, 1);
  } finally {controller.abort(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});

test('pending or unidentified attempts never borrow an earlier cancelled range’s zero-body proof', () => {
  const pending = {...transfer, sent: false, finished: false, aborted: false};
  assert.deepEqual(bodyBounds({id: pending.id, complete: false, lower: 0}, pending), {lower: 0, upper: 40, unknown: 1, partial: 1});
  assert.equal(transferFor({complete: false, lower: 0}, [{...pending, aborted: true}]), undefined);
  assert.equal(transferFor({id: '1', complete: false, lower: 0}, [pending, pending]), undefined);
  assert.throws(() => bodyBounds({id: 'other', complete: false, lower: 0}, {...pending, aborted: true}));
  assert.throws(() => bodyTotals([{count: {id: '1', complete: false, lower: 0}, transfer}, {count: {id: '1', complete: false, lower: 0}, transfer}]));
});

test('same-range aborted retries retain distinct pre-header identities and fail an excessive aggregate byte budget', async () => {
  const answer = {run: 'r', values: Array.from({length: 6000}, (_, i) => [i, `sample-${i}`, i / 19])};
  const waiting: import('node:http').ServerResponse[] = [];
  const upstream = createServer((req, res) => {assert.equal(req.headers[HISTORY_ATTEMPT_HEADER], undefined, 'fixture identity is stripped before the hub'); waiting.push(res);});
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await historyProxy(`http://127.0.0.1:${(upstream.address() as {port: number}).port}`), counts: BodyCount[] = [];
  const ready = async (index: number) => {const end = Date.now() + 2000; while (!waiting[index]) {if (Date.now() > end) throw new Error('upstream did not receive attempt'); await new Promise(resolve => setTimeout(resolve, 1));} return waiting[index];};
  try {
    proxy.phase('retry');
    const url = `${proxy.url}/api/history?cell=1&from=0&to=60`;
    for (let index = 0; index < 3; index++) {
      const controller = new AbortController(), read = historyBody(url, '', controller.signal, count => counts.push(count)), failed = assert.rejects(read);
      const response = await ready(index), record = proxy.transfers[index];
      if (index === 0) controller.abort();
      else {
        let sent = false;
        Object.defineProperty(record, 'sent', {get: () => sent, set(value: boolean) {sent = value; if (value) queueMicrotask(() => controller.abort());}});
        response.end(JSON.stringify(answer));
      }
      await failed; await proxy.settled('retry');
      assert.ok(counts[index].id, 'request identity exists even without response headers');
      assert.equal(counts[index].responseId, undefined);
      assert.equal(transferFor(counts[index], proxy.transfers), record);
    }
    const read = historyBody(url, '', undefined, count => counts.push(count));
    (await ready(3)).end(JSON.stringify(answer)); assert.deepEqual(await read, answer); await proxy.settled('retry');
    assert.equal(new Set(counts.map(count => count.id)).size, 4);
    const totals = bodyTotals(counts.map(count => ({count, transfer: transferFor(count, proxy.transfers)})));
    const reference = counts[3];
    assert.equal(totals.unknown, 2); assert.equal(totals.byteVerdict, 'bounded');
    assert.equal(totals.decoded, 3 * reference.decoded!); assert.equal(totals.encodedUpper, 3 * reference.lower);
    assert.equal(trafficProblems({name: 'retry', attempts: 4, ...totals, referenceDecoded: reference.decoded!, referenceEncoded: reference.lower, ratios: true}).length, 2);
  } finally {await proxy.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));}
});

test('Chrome request headers preserve a cancelled attempt identity before response headers', () => {
  const f = cdpFixture();
  f.emit('Network.requestWillBeSent', {requestId: 'raw1', request: {url: 'http://localhost/api/history?cell=1&from=0&to=60', headers: {[HISTORY_ATTEMPT_HEADER]: 'b1:1'}}});
  f.emit('Network.loadingFailed', {requestId: 'raw1', canceled: true});
  assert.equal(f.observer.reads[0].count?.id, 'b1:1'); assert.equal(f.observer.reads[0].canceled, true);
  f.emit('Network.requestWillBeSent', {requestId: 'raw2', request: {url: 'http://localhost/api/history?cell=1&from=0&to=60'}});
  f.emit('Network.loadingFailed', {requestId: 'raw2', canceled: true});
  f.emit('Network.requestWillBeSentExtraInfo', {requestId: 'raw2', headers: {[HISTORY_ATTEMPT_HEADER]: 'b1:2'}});
  assert.equal(f.observer.reads[1].count?.id, 'b1:2', 'late extra headers update the terminal count instead of matching a query');
});

import {historyPageScript} from '../historyTrafficBrowser';

test('the browser fixture tags each fetch before IO and keeps cancellation identity without response headers', async () => {
  const calls: {resource: unknown; init: RequestInit}[] = [];
  const window = {fetch: async (resource: unknown, init: RequestInit) => {calls.push({resource, init}); return {};}, __quotumHistoryAttempts: {} as Record<string, {aborted: boolean}>};
  runInNewContext(historyPageScript('24h'), {window, location: {href: 'http://localhost:8080/'}, localStorage: {setItem: () => {}}, URL, Headers, Request, performance});
  const headers = new Headers({Accept: 'application/json'}), controller = new AbortController();
  await window.fetch('/api/history?cell=1&from=0&to=60', {headers, signal: controller.signal, credentials: 'same-origin'});
  await window.fetch('/api/history?cell=1&from=0&to=60', {headers});
  const ids = calls.map(call => new Headers(call.init.headers).get(HISTORY_ATTEMPT_HEADER)!);
  assert.ok(ids.every(Boolean)); assert.notEqual(ids[0], ids[1]);
  assert.equal(calls[0].init.signal, controller.signal); assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(headers.has(HISTORY_ATTEMPT_HEADER), false, 'the production options are not mutated');
  controller.abort(); assert.equal(window.__quotumHistoryAttempts[ids[0]].aborted, true);
  assert.equal(window.__quotumHistoryAttempts[ids[1]].aborted, false);
});

test('composite bodies count once while both resource selections and standalone detail attempts remain visible',async()=>{
  const listeners=new Map<string,(event:never)=>void>();
  const history={run:'r',now:1,historyStart:0,known:{work:0,sources:{}},chunks:[{from:0,to:60}]};
  const raw={basis:{},quota:{state:'complete',value:history},budget:{state:'complete',value:history},funds:{state:'complete',value:history},sessions:{state:'complete',value:{refs:[]}}};
  const cdp={on:<T>(name:string,fn:(event:T)=>void)=>listeners.set(name,fn as (event:never)=>void),send:async<T>()=>({body:JSON.stringify(raw),base64Encoded:false} as T)};
  const observer=new HistoryBodies(cdp),emit=(name:string,event:object)=>listeners.get(name)?.(event as never);
  const query={cell:'1',from:'0',to:'60',evidence:'cursor'};
  emit('Network.requestWillBeSent',{requestId:'combined',request:{url:'http://localhost/api/boards/b/period',postData:JSON.stringify({quota:query,budget:{...query,meters:'[]',unit:'USD'}})}});
  emit('Network.responseReceived',{requestId:'combined',response:{status:200,headers:{}}});
  emit('Network.loadingFinished',{requestId:'combined'});await Promise.all([...observer.pending]);
  assert.deepEqual(observer.errors,[]);assert.equal(observer.reads.length,1);assert.equal(observer.resources.length,2);
  assert.equal(observer.reads[0].count?.decoded,Buffer.byteLength(JSON.stringify(raw)));
  assert.deepEqual(observer.resources.map(r=>new URLSearchParams(r.selection).get('scope')),['quota','budget']);
  assert.ok(observer.resources.every(r=>!new URLSearchParams(r.selection).has('evidence')));
  emit('Network.requestWillBeSent',{requestId:'details',request:{url:'http://localhost/api/boards/b/period/sessions',postData:'{}'}});
  emit('Network.loadingFailed',{requestId:'details',canceled:true});
  assert.equal(observer.reads.length,2);assert.equal(observer.resources.length,2);assert.equal(observer.reads[1].canceled,true);
  emit('Network.requestWillBeSent',{requestId:'evidence',request:{url:'http://localhost/api/boards/b/period',postData:JSON.stringify({quota:{...query,cells:'skip'}})}});
  emit('Network.responseReceived',{requestId:'evidence',response:{status:200,headers:{}}});
  emit('Network.loadingFinished',{requestId:'evidence'});await Promise.all([...observer.pending]);
  assert.equal(observer.reads.length,3);assert.equal(observer.resources.length,2,'evidence bytes count without pretending cached cells were reread');
  assert.equal(observer.reads[2].count?.decoded,Buffer.byteLength(JSON.stringify(raw)));assert.deepEqual(observer.errors,[]);
  assert.equal(hasSeededHistory(observer.reads,'seed'),false,'evidence and two complete families cannot stand in for the third cell seed');
  emit('Network.requestWillBeSent',{requestId:'funds',request:{url:'http://localhost/api/boards/b/period',postData:JSON.stringify({funds:query})}});
  assert.equal(hasSeededHistory(observer.reads,'seed'),false,'the queued family must finish its physical read');
  emit('Network.responseReceived',{requestId:'funds',response:{status:200,headers:{}}});
  emit('Network.loadingFinished',{requestId:'funds'});await Promise.all([...observer.pending]);
  assert.equal(hasSeededHistory(observer.reads,'seed'),true);assert.equal(hasSeededHistory(observer.reads,'different phase'),false);
});

test('composite resource classification waits for an omitted POST body even after the response arrives',async()=>{
  const listeners=new Map<string,(event:never)=>void>();
  const history={run:'r',now:1,historyStart:0,known:{work:0,sources:{}},chunks:[{from:0,to:60}]};
  const raw=JSON.stringify({basis:{},quota:{state:'complete',value:history}});
  let finish!:(value:{postData:string})=>void;
  const cdp={on:<T>(name:string,fn:(event:T)=>void)=>listeners.set(name,fn as (event:never)=>void),send:<T>(method:string)=>
    (method==='Network.getRequestPostData'?new Promise<{postData:string}>(resolve=>{finish=resolve;}):Promise.resolve({body:raw,base64Encoded:false})) as Promise<T>};
  const observer=new HistoryBodies(cdp),emit=(name:string,event:object)=>listeners.get(name)?.(event as never);
  emit('Network.requestWillBeSent',{requestId:'omitted',request:{url:'http://localhost/api/boards/b/period'}});
  assert.equal(observer.reads.length,1);assert.equal(observer.activeCount,1);assert.equal(observer.pending.size,1);
  emit('Network.responseReceived',{requestId:'omitted',response:{status:200,headers:{}}});
  emit('Network.loadingFinished',{requestId:'omitted'});await Promise.resolve();
  assert.equal(observer.reads[0].count,undefined,'a response cannot settle before its resource selection is known');
  finish({postData:JSON.stringify({quota:{cell:'1',from:'0',to:'60'}})});
  await Promise.all([...observer.pending]);
  assert.deepEqual(observer.errors,[]);assert.equal(observer.reads.length,1);assert.equal(observer.resources.length,1);
  assert.equal(new URLSearchParams(observer.resources[0].selection).get('scope'),'quota');
  assert.deepEqual(observer.resources[0].chunks,[[0,60]]);assert.equal(observer.resources[0].count?.decoded,Buffer.byteLength(raw));
});

test('a missing POST body that Chrome cannot recover fails observation and retains the canceled attempt',async()=>{
  const listeners=new Map<string,(event:never)=>void>(),missing=new Error('POST data unavailable');
  const cdp={on:<T>(name:string,fn:(event:T)=>void)=>listeners.set(name,fn as (event:never)=>void),send:<T>()=>Promise.reject<T>(missing)};
  const observer=new HistoryBodies(cdp),emit=(name:string,event:object)=>listeners.get(name)?.(event as never);
  emit('Network.requestWillBeSent',{requestId:'missing',request:{url:'http://localhost/api/boards/b/period'}});
  emit('Network.loadingFailed',{requestId:'missing',canceled:true});
  await Promise.all([...observer.pending]);
  assert.deepEqual(observer.errors,[missing]);assert.equal(observer.reads.length,1);assert.equal(observer.reads[0].canceled,true);
  assert.equal(observer.reads[0].count?.complete,false);assert.equal(observer.activeCount,0);
});

test('warm failure diagnostics distinguish exact reads and gesture stages without exposing identities or bodies',async()=>{
  const listeners=new Map<string,(event:never)=>void>();
  let finish!:(value:{postData:string})=>void;
  const cdp={on:<T>(name:string,fn:(event:T)=>void)=>listeners.set(name,fn as (event:never)=>void),send:<T>()=>new Promise<{postData:string}>(resolve=>{finish=resolve;}) as Promise<T>};
  const observer=new HistoryBodies(cdp),emit=(name:string,event:object)=>listeners.get(name)?.(event as never);
  observer.phase='warm';observer.stage='cached return';
  emit('Network.requestWillBeSent',{requestId:'private-request',request:{url:'http://localhost/api/boards/private-board/period'}});
  observer.stage='cached repeat';
  const postData=JSON.stringify({selection:{mode:'live',periodMs:30*86_400_000},evaluatedAt:900,
    quota:{cell:'1',from:'0',to:'60',cells:'skip',evidence:'private-cursor',meters:'[["private-source","private-meter"]]'},
    funds:{cell:'1',from:'0',to:'60',evidence:'skip'},values:['private-source'],sessions:{cursor:'private-work-cursor'},calendar:{zone:'private-zone',edges:[1,2],cursor:'private-calendar-cursor'}});
  finish({postData});
  await Promise.all([...observer.pending]);
  emit('Network.dataReceived',{requestId:'private-request',encodedDataLength:123});
  emit('Network.loadingFailed',{requestId:'private-request',canceled:true});
  emit('Network.requestWillBeSent',{requestId:'private-repeat',request:{url:'http://localhost/api/boards/private-board/period/sessions',postData:JSON.stringify({selection:{mode:'range',from:10,to:20},evaluatedAt:901,refs:['private-ref']})}});
  emit('Network.loadingFailed',{requestId:'private-repeat',canceled:false});
  const diagnostic=observer.diagnostic('warm');
  assert.equal(diagnostic.attempts,2);assert.equal(diagnostic.omitted,0);
  assert.deepEqual(diagnostic.reads[0],{stage:'cached return',endpoint:'period',request:{selection:{mode:'live',periodMs:30*86_400_000},evaluatedAt:900,
    sections:[{scope:'quota',cell:1,from:0,to:60,cells:'skip',evidence:'cursor'},{scope:'funds',cell:1,from:0,to:60,cells:'read',evidence:'skip'}],values:1,sessions:true,sessionsCursor:true,sourceWork:false,sourceWorkCursor:false,calendar:true,calendarCursor:true},requestBytes:Buffer.byteLength(postData),errorCode:null,httpStatus:null,canceled:true,complete:false,decoded:undefined,encodedLower:123,encodedUpper:undefined,body:null});
  assert.equal(diagnostic.reads[1].stage,'cached repeat');assert.equal(diagnostic.reads[1].endpoint,'period/sessions');
  assert.deepEqual(diagnostic.reads[1].request?.selection,{mode:'range',from:10,to:20});
  assert.equal(JSON.stringify(diagnostic).includes('private'),false);
  observer.reads[0].attemptId='b2:34';observer.reads[1].attemptId='private-attempt';
  assert.equal(observer.diagnostic('warm').reads[0].attemptId,'b2:34');
  assert.equal(JSON.stringify(observer.diagnostic('warm')).includes('private'),false);
  for(let n=0;n<70;n++)emit('Network.requestWillBeSent',{requestId:String(n),request:{url:'http://localhost/api/history?board=private-board&scope=budget&cell=1&from=0&to=60'}});
  assert.equal(observer.diagnostic('warm').reads.length,64);assert.equal(observer.diagnostic('warm').omitted,8);
});
