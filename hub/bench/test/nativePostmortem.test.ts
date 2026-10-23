import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeFrames,nativePostmortem,nativeProgress} from '../nativePostmortem.js';
import {safeEvidence} from '../evidence.js';

test('native receipts retain thread identity and fixed wait classes without native symbol text',()=>{
  const receipt=nativeFrames(`QGDB_ATTACHED
Thread 1 (Thread 0x123 (LWP 100)):
#0 private-canary-before-backtrace
QGDB_BT_BEGIN
Thread 1 (Thread 0x123 (LWP 100)):
#0 private-canary(0x123456, /home/private-canary)
#1 cc::CompletionEvent::Wait()
#2 cc::LayerTreeHost::WaitForProtectedSequenceCompletion() const
#3 cc::ProxyMain::BeginMainFrame(private-canary)
QGDB_BT_DONE
QGDB_DETACHED
#4 private-canary-after-detach`);
  assert.deepEqual(receipt,{threads:[{index:1,tid:100,frames:[
    {index:0,kind:'other',symbol:true},{index:1,kind:'completion-event',symbol:true},
    {index:2,kind:'protected-sequence',symbol:true},{index:3,kind:'begin-main-frame',symbol:true},
  ]}],omitted:0,partial:false});
  const saved=JSON.stringify(safeEvidence(receipt));
  assert.match(saved,/protected-sequence/);assert.doesNotMatch(saved,/private-canary|0x123456|CompletionEvent/);
});

test('a missing run owner or a terminated browser cannot grant native attach authority',async()=>{
  const scope={root:100,live:()=>true,observe:async()=>{throw Error('must not inspect processes');}};
  for(const value of [scope,{...scope,live:()=>false,resource:()=>async()=>{}}]){
    const report=await nativePostmortem(value,[{pid:101,cpuTime:1}],new AbortController().signal);
    assert.equal(report.status,'unavailable');assert.equal(report.intervened,false);
  }
});

test('native command progress and byte counts survive evidence filtering without treating an echo as completion',()=>{
  const progress=nativeProgress('QGDB_SETTINGS\nQGDB_ATTACH\nprivate-canary\n');
  const saved=safeEvidence({progress,outputBytes:123,diagnosticBytes:45});
  assert.deepEqual(saved,{progress:{ordered:false,settingsCommandSeen:true,attachCommandSeen:true,stopAcknowledged:false,
    backtraceCommandSeen:false,detachCommandSeen:false,detachAcknowledged:false},outputBytes:123,diagnosticBytes:45});
  assert.doesNotMatch(JSON.stringify(saved),/private-canary|--pid/);
  assert.deepEqual(nativeProgress('QGDB_ATTACHED\nQGDB_BT_BEGIN\nQGDB_BT_DONE\nQGDB_DETACHED'),
    {ordered:false,settingsCommandSeen:false,attachCommandSeen:false,stopAcknowledged:true,backtraceCommandSeen:true,detachCommandSeen:true,detachAcknowledged:true});
});

test('a native capture needs each command boundary exactly once in order',()=>{
  const full='QGDB_SETTINGS\nQGDB_ATTACH\nQGDB_ATTACHED\nQGDB_BT_BEGIN\nQGDB_BT_DONE\nQGDB_DETACHED\n';
  assert.ok(Object.values(nativeProgress(full)).every(Boolean));
  for(const bad of [full.replace('QGDB_ATTACH\n',''),full.replace('QGDB_ATTACH\n','QGDB_ATTACH\nQGDB_ATTACH\n'),
    full.replace('QGDB_SETTINGS\nQGDB_ATTACH\n','QGDB_ATTACH\nQGDB_SETTINGS\n')])assert.equal(nativeProgress(bad).ordered,false);
});

test('missing, malformed, duplicate and capped native threads remain partial',()=>{
  const thread='Thread 1 (Thread 0x123 (LWP 100)):\n#0 pthread_cond_wait ()\n';
  const read=(body:string)=>nativeFrames('QGDB_BT_BEGIN\n'+body+'QGDB_BT_DONE\n');
  for(const body of [thread+thread,thread.replace('#0','#2'),'Thread 1 (LWP 100):\n',thread+"Couldn't get registers\n",thread+'Failed to unwind\n',
    thread+'Backtrace stopped: previous frame identical\n','Thread 1 (unknown):\n#0 func ()\n'])assert.equal(read(body).partial,true);
  assert.equal(nativeFrames('QGDB_BT_BEGIN\n'+thread).partial,true);
  assert.equal(nativeFrames('QGDB_ATTACHED\n'+thread+'QGDB_DETACHED\n').partial,true);
  const many=read(Array.from({length:33},(_,i)=>`Thread ${i+1} (LWP ${100+i}):\n#0 pthread_cond_wait ()\n`).join(''));
  assert.equal(many.threads.length,32);assert.equal(many.omitted,1);assert.equal(many.partial,true);
  const frames=read('Thread 1 (LWP 100):\n'+Array.from({length:17},(_,i)=>`#${i} pthread_cond_wait ()\n`).join(''));
  assert.equal(frames.threads[0].frames.length,16);assert.equal(frames.omitted,1);assert.equal(frames.partial,true);
});
