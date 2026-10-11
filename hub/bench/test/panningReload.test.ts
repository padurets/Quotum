import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Cdp} from '../cdp.js';
import {panningReload,reloadHubProbe} from '../panningReload.js';
import {panning} from '../panning.js';

const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(silent=false){
  const listeners=new Map<string,((event:unknown)=>void)[]>(),commands:string[]=[];
  const emit=(method:string,event:unknown={})=>{for(const listener of listeners.get(method)??[])listener(event);};
  const cdp={
    on:(method:string,listener:(event:unknown)=>void)=>{listeners.set(method,[...(listeners.get(method)??[]),listener]);},
    send:async(method:string)=>{commands.push(method);if(method==='Performance.getMetrics'){if(silent)return new Promise(()=>{});return {metrics:[{name:'TaskDuration',value:4.8},{name:'UnrequestedMetric',value:99}]};}return {};},
    evaluate:async()=>{commands.push('Runtime.evaluate');return silent?new Promise(()=>{}):{ready:'interactive',panels:[{name:'budget-history',loading:true,error:false}]};},
  } as unknown as Pick<Cdp,'send'|'evaluate'|'on'>;
  return {cdp,commands,emit};
}

test('native reload listens before sending the command and leaves a successful load uninstrumented',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),logs:string[]=[];t.mock.method(console,'error',(line:string)=>logs.push(line));
  const original=f.cdp.send;
  t.mock.method(f.cdp,'send',async<T>(method:string)=>{if(method==='Page.reload')f.emit('Page.loadEventFired');return original<T>(method);});
  let diagnosed=false;
  await panningReload(f.cdp,'quota',async()=>{diagnosed=true;});t.mock.timers.tick(5000);
  assert.equal(diagnosed,false);
  assert.deepEqual(f.commands,['Page.reload']);assert.deepEqual(logs,[]);
});

test('the five-second reload failure retains stage, lifecycle and sanitized pending network state',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),logs:string[]=[];t.mock.method(console,'error',(line:string)=>logs.push(line));
  const failed=assert.rejects(panningReload(f.cdp,'funds'),/native\/funds\/reload: panning board reload did not finish in 5 s/);
  f.emit('Page.frameStartedLoading',{frameId:'frame'});
  f.emit('Page.frameNavigated',{frame:{id:'frame',loaderId:'loader',url:'https://SECRET.test/?key=SECRET'}});
  f.emit('Page.domContentEventFired');
  f.emit('Page.lifecycleEvent',{name:'networkIdle',url:'SECRET',frameId:'SECRET'});
  f.emit('Page.lifecycleEvent',{name:'SECRET'});
  f.emit('Page.javascriptDialogOpening',{type:'beforeunload',hasBrowserHandler:true,message:'SECRET',url:'SECRET',defaultPrompt:'SECRET'});
  f.emit('Page.javascriptDialogClosed',{result:false,userInput:'SECRET'});
  f.emit('Network.requestWillBeSent',{requestId:'pending',type:'Fetch',request:{url:'https://SECRET.test/api/boards/SECRET/period?token=SECRET',method:'POST',postData:'SECRET',headers:{Cookie:'SECRET'}}});
  f.emit('Network.responseReceived',{requestId:'pending',response:{status:200,headers:{secret:'SECRET'}}});
  f.emit('Network.requestWillBeSentExtraInfo',{requestId:'pending',headers:{Cookie:'SECRET'},associatedCookies:[{cookie:{value:'SECRET'}}]});
  f.emit('Network.responseReceivedExtraInfo',{requestId:'pending',statusCode:200,headers:{secret:'SECRET'},headersText:'SECRET',blockedCookies:[{cookieLine:'SECRET'}]});
  f.emit('Network.dataReceived',{requestId:'pending',encodedDataLength:4096});
  f.emit('Network.requestWillBeSent',{requestId:'failed',type:'Document',request:{url:'https://SECRET.test/',method:'GET'}});
  f.emit('Network.loadingFailed',{requestId:'failed',canceled:true,errorText:'net::ERR_ABORTED'});
  t.mock.timers.tick(4999);await flush();assert.equal(logs.length,0);
  t.mock.timers.tick(1);await failed;
  assert.equal(logs.length,2);assert.ok(!logs.join('').includes('SECRET'));
  const network=JSON.parse(logs[0].slice('panning reload diagnostic '.length));
  assert.equal(network.initiator,'funds');assert.equal(network.stage,'reload');assert.equal(network.counts.failed,1);
  assert.deepEqual(network.pending.map((request:{endpoint:string;status:number;bytes:number})=>[request.endpoint,request.status,request.bytes]),[['period',200,4096]]);
  assert.ok(network.events.some((event:{event:string})=>event.event==='Page.domContentEventFired'));
  assert.equal(network.counts.requestExtraInfo,1);assert.equal(network.counts.responseExtraInfo,1);
  assert.ok(network.events.some((event:{name?:string})=>event.name==='networkIdle'));
  assert.ok(network.events.some((event:{type?:string;hasBrowserHandler?:boolean})=>event.type==='beforeunload'&&event.hasBrowserHandler));
  assert.ok(logs[1].includes('interactive'));assert.ok(logs[1].includes('TaskDuration'));assert.ok(!logs[1].includes('UnrequestedMetric'));
});

test('only the failed five-second reload starts its observer and an observed late load still fails',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),labels:string[]=[];t.mock.method(console,'error',()=>{});
  let signal:AbortSignal|undefined;
  const failed=assert.rejects(panningReload(f.cdp,'budget',async(label,current)=>{labels.push(label);signal=current;f.emit('Page.loadEventFired');}),/native\/budget\/reload: panning board reload did not finish in 5 s/);
  t.mock.timers.tick(4999);await flush();assert.deepEqual(labels,[]);assert.deepEqual(f.commands,['Page.reload']);
  t.mock.timers.tick(1);await failed;
  assert.deepEqual(labels,['native/budget/reload']);assert.equal(signal?.aborted,true);
});

test('a silent renderer does not delay the observer and navigation stays attributable across recovery',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const f=fixture(true),logs:string[]=[],marks:unknown[]=[];t.mock.method(console,'error',(line:string)=>logs.push(line));
  const failed=assert.rejects(panningReload(f.cdp,'budget',async(_label,_signal,origin)=>{
    marks.push({atMs:Date.now()-origin.startedAt,navigation:origin.navigation()});
    f.emit('Page.frameNavigated',{frame:{id:'frame',loaderId:'new-loader'}});
    f.emit('Page.loadEventFired');
    marks.push(origin.navigation());
  }),/native\/budget\/reload: panning board reload did not finish in 5 s/);
  f.emit('Network.requestWillBeSent',{requestId:'document',type:'Document',frameId:'frame',loaderId:'new-loader',request:{url:'http://fixture.invalid/',method:'GET'}});
  t.mock.timers.tick(4999);await flush();assert.deepEqual(marks,[]);
  t.mock.timers.tick(1);await flush();
  assert.deepEqual(marks,[{atMs:5000,navigation:{requested:{atMs:0,frame:'frame',loader:'new-loader'},committed:undefined,loadAtMs:null}},
    {requested:{atMs:0,frame:'frame',loader:'new-loader'},committed:{atMs:5000,frame:'frame',loader:'new-loader'},loadAtMs:5000}]);
  t.mock.timers.tick(2000);await failed;
  assert.ok(logs.at(-1)?.includes('"loadAtMs":5000'));
});

test('the independent health probe records only status and timing and cancels its unread body',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const logs:string[]=[],controller=new AbortController();let canceled=false,requestSignal:AbortSignal|undefined;
  t.mock.method(console,'error',(line:string)=>logs.push(line));
  t.mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{
    assert.equal(url,'http://fixture.invalid/health');assert.equal(init?.redirect,'error');requestSignal=init?.signal as AbortSignal;
    t.mock.timers.tick(25);
    return {status:200,body:{cancel:async()=>{canceled=true;}},headers:{secret:'SECRET'}} as unknown as Response;
  });
  await reloadHubProbe('http://fixture.invalid',controller.signal,{startedAt:Date.now(),navigation:()=>({loadAtMs:null})});
  assert.equal(canceled,true);assert.equal(requestSignal?.aborted,true);
  assert.deepEqual(JSON.parse(logs[0].slice('panning reload hub '.length)),{startedAt:0,startedMs:0,finishedMs:25,durationMs:25,state:'answered',status:200,originalDocumentArrival:'unknown'});
  assert.ok(!logs[0].includes('SECRET'));
});

test('a silent health request is aborted at its bound without logging a raw error',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const logs:string[]=[],controller=new AbortController();let signal:AbortSignal|undefined;
  t.mock.method(console,'error',(line:string)=>logs.push(line));
  t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{signal=init?.signal as AbortSignal;return new Promise<Response>(()=>{});});
  const probe=reloadHubProbe('http://fixture.invalid',controller.signal,{startedAt:Date.now(),navigation:()=>({loadAtMs:null})});
  t.mock.timers.tick(1999);await flush();assert.equal(signal?.aborted,false);
  t.mock.timers.tick(1);await probe;assert.equal(signal?.aborted,true);
  assert.ok(logs[0].includes('"state":"unavailable"'));assert.ok(logs[0].includes('"finishedMs":2000'));
});

test('an observer exception cannot replace the canonical reload timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),logs:string[]=[];t.mock.method(console,'error',(line:string)=>logs.push(line));
  const diagnostic=new Error('SECRET diagnostic failure');
  const failed=assert.rejects(panningReload(f.cdp,'funds',async()=>{throw diagnostic;}),error=>error!==diagnostic&&String(error)==='Error: native/funds/reload: panning board reload did not finish in 5 s');
  t.mock.timers.tick(5000);await failed;
  assert.ok(logs.at(-1)?.includes('"state":"failed"'));assert.ok(!logs.join('').includes('SECRET'));
});

test('the observer is canceled at forty seconds and a silent callback cannot exceed forty-five',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),logs:string[]=[];t.mock.method(console,'error',(line:string)=>logs.push(line));
  let signal:AbortSignal|undefined,settled=false;
  const failed=assert.rejects(panningReload(f.cdp,'budget',async(_label,current)=>{signal=current;return new Promise(()=>{});}),/native\/budget\/reload/).then(()=>{settled=true;});
  t.mock.timers.tick(5000);await flush();assert.equal(signal?.aborted,false);
  t.mock.timers.tick(39999);await flush();assert.equal(signal?.aborted,false);assert.equal(settled,false);
  t.mock.timers.tick(1);await flush();assert.equal(signal?.aborted,true);assert.equal(settled,false);
  t.mock.timers.tick(5000);await failed;
  assert.ok(logs.at(-1)?.includes('"state":"deadline"'));
});

test('a rejected reload command retains its exact error without starting a stall observer',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),error=new Error('reload command failed');let diagnosed=false;
  t.mock.method(f.cdp,'send',async()=>{throw error;});
  await assert.rejects(panningReload(f.cdp,'quota',async()=>{diagnosed=true;}),candidate=>candidate===error);
  t.mock.timers.tick(5000);await flush();assert.equal(diagnosed,false);
});

test('panning forwards the failed reload and preserves it through observer and cleanup errors',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),labels:string[]=[],logs:string[]=[];
  t.mock.method(console,'error',(line:string)=>logs.push(line));t.mock.method(console,'log',()=>{});
  const send=f.cdp.send;
  t.mock.method(f.cdp,'send',async<T>(method:string)=>{if(method==='Emulation.setCPUThrottlingRate')throw new Error('SECRET cleanup failure');return send<T>(method);});
  const failed=assert.rejects(panning(f.cdp,undefined,async label=>{labels.push(label);throw new Error('SECRET observer failure');}),/native\/quota\/reload: panning board reload did not finish in 5 s/);
  await flush();assert.ok(f.commands.includes('Page.reload'));
  t.mock.timers.tick(5000);await failed;
  assert.deepEqual(labels,['native/quota/reload']);assert.ok(logs.at(-1)?.includes('retaining original failure'));assert.ok(!logs.join('').includes('SECRET'));
});

test('a silent renderer cannot hang timeout diagnostics or turn a late load into a passing reload',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(true),logs:string[]=[];t.mock.method(console,'error',(line:string)=>logs.push(line));
  const failed=assert.rejects(panningReload(f.cdp,'budget'),/native\/budget\/reload/);
  t.mock.timers.tick(5000);await flush();assert.equal(logs.length,1,'received CDP events are printed before querying the renderer');
  f.emit('Page.loadEventFired');t.mock.timers.tick(2000);await failed;
  assert.equal(logs.length,2);assert.ok(logs[1].includes('"page":{"state":"unavailable"}'));assert.ok(logs[1].includes('"performance":{"state":"unavailable"}'));
});
