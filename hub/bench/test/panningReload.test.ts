import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Cdp} from '../cdp.js';
import {panningReload} from '../panningReload.js';

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
  await panningReload(f.cdp,'quota');t.mock.timers.tick(5000);
  assert.deepEqual(f.commands,['Page.reload']);assert.deepEqual(logs,[]);
});

test('the five-second reload failure retains stage, lifecycle and sanitized pending network state',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),logs:string[]=[];t.mock.method(console,'error',(line:string)=>logs.push(line));
  const failed=assert.rejects(panningReload(f.cdp,'funds'),/native\/funds\/reload: panning board reload did not finish in 5 s/);
  f.emit('Page.frameStartedLoading',{frameId:'frame'});
  f.emit('Page.frameNavigated',{frame:{id:'frame',loaderId:'loader',url:'https://SECRET.test/?key=SECRET'}});
  f.emit('Page.domContentEventFired');
  f.emit('Network.requestWillBeSent',{requestId:'pending',type:'Fetch',request:{url:'https://SECRET.test/api/boards/SECRET/period?token=SECRET',method:'POST',postData:'SECRET',headers:{Cookie:'SECRET'}}});
  f.emit('Network.responseReceived',{requestId:'pending',response:{status:200,headers:{secret:'SECRET'}}});
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
  assert.ok(logs[1].includes('interactive'));assert.ok(logs[1].includes('TaskDuration'));assert.ok(!logs[1].includes('UnrequestedMetric'));
});

test('a silent renderer cannot hang timeout diagnostics or turn a late load into a passing reload',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(true),logs:string[]=[];t.mock.method(console,'error',(line:string)=>logs.push(line));
  const failed=assert.rejects(panningReload(f.cdp,'budget'),/native\/budget\/reload/);
  t.mock.timers.tick(5000);await flush();assert.equal(logs.length,1,'received CDP events are printed before querying the renderer');
  f.emit('Page.loadEventFired');t.mock.timers.tick(2000);await failed;
  assert.equal(logs.length,2);assert.ok(logs[1].includes('"page":{"state":"unavailable"}'));assert.ok(logs[1].includes('"performance":{"state":"unavailable"}'));
});
