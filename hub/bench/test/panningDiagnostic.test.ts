import {test} from 'node:test';
import assert from 'node:assert/strict';
import {traceInterval} from '../panningDiagnostic.js';
import type {Cdp} from '../cdp.js';

function fixture() {
  const listeners=new Map<string,(value:unknown)=>void>(),sent:string[]=[],files=new Map<string,unknown>();
  const cdp={
    on:(method:string,callback:(value:unknown)=>void)=>listeners.set(method,callback),
    off:(method:string)=>listeners.delete(method),
    send:async(method:string)=>{sent.push(method);if(method==='Tracing.end')listeners.get('Tracing.tracingComplete')?.({});return {metrics:[{name:'Timestamp',value:42}]};},
    evaluate:async()=>({now:7,timeOrigin:35}),
  } as unknown as Cdp;
  return {cdp,listeners,sent,files,evidence:{save:(name:string,value:unknown)=>files.set(name,value),saveTrace:(name:string,value:unknown)=>files.set(name,value)}};
}

test('a trace retains only allowed numeric events from its own original interval', async()=>{
  const f=fixture();
  const result=await traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},async()=>{
    f.listeners.get('Tracing.dataCollected')?.({value:[{name:'Paint',ph:'X',ts:1,dur:2,pid:3,tid:4,args:{cookie:'private-canary',url:'private-canary'}},{name:'private-canary',ph:'X',ts:5}]});
    return 17;
  },f.evidence);
  assert.equal(result,17);assert.equal(f.listeners.size,0);
  const text=JSON.stringify(f.files.get('trace'));
  assert.ok(text.includes('Paint')&&!text.includes('private-canary')&&!text.includes('cookie'));
  assert.deepEqual(f.sent,['Tracing.start','Performance.getMetrics','Performance.getMetrics','Tracing.end']);
});

test('a failing trace interval stops collection and preserves the original error', async()=>{
  const f=fixture(),error=new Error('original failure');
  await assert.rejects(traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},async()=>{throw error;},f.evidence),value=>value===error);
  assert.equal(f.sent.at(-1),'Tracing.end');assert.equal(f.listeners.size,0);
  assert.ok(f.files.has('trace'));
});

test('an attached browser never receives browser-wide tracing', async()=>{
  const f=fixture();
  await assert.rejects(traceInterval(f.cdp,{endpoint:'fixture',close:async()=>{}},async()=>{}),/owned synthetic/);
  assert.equal(f.sent.length,0);assert.equal(f.listeners.size,0);
});

test('a lost trace-start reply still stops the possibly active trace with its own cleanup', async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),original=f.cdp.send.bind(f.cdp);let cancelled=false;
  f.cdp.send=((method:string,params:object,signal?:AbortSignal)=>{
    if(method!=='Tracing.start')return original(method,params,signal);
    f.sent.push(method);
    return new Promise((_,reject)=>signal!.addEventListener('abort',()=>{cancelled=true;reject(signal!.reason);},{once:true}));
  }) as Cdp['send'];
  const outcome=assert.rejects(traceInterval(f.cdp,{owned:true,endpoint:'fixture',close:async()=>{}},async()=>{assert.fail('timed-out setup cannot run the scenario');},f.evidence),/deadline/);
  t.mock.timers.tick(5000);
  await outcome;
  assert.equal(cancelled,true);assert.equal(f.sent.at(-1),'Tracing.end');assert.equal(f.listeners.size,0);
});
