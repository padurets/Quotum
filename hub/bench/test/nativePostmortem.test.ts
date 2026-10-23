import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeFrames,nativePostmortem,nativeProgress} from '../nativePostmortem.js';
import {safeEvidence} from '../evidence.js';

test('native receipts retain thread identity and fixed wait classes without native symbol text',()=>{
  const receipt=nativeFrames(`(lldb) process attach --pid 100
quotum-thread=1 tid=0x64
quotum-frame=0 function=private-canary-before-backtrace
(lldb) thread backtrace all -c 16
* quotum-thread=1 tid=0x64
  quotum-frame=0 function=private-canary(0x123456, /home/private-canary)
  quotum-frame=1 function=cc::CompletionEvent::Wait()
  quotum-frame=2 function=cc::LayerTreeHost::WaitForProtectedSequenceCompletion() const
  quotum-frame=3 function=cc::ProxyMain::BeginMainFrame(private-canary)
(lldb) process detach
quotum-frame=4 function=private-canary-after-detach`);
  assert.deepEqual(receipt,{threads:[{index:1,tid:100,frames:[
    {index:0,kind:'other',symbol:true},{index:1,kind:'completion-event',symbol:true},
    {index:2,kind:'protected-sequence',symbol:true},{index:3,kind:'begin-main-frame',symbol:true},
  ]}],omitted:0});
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
  const progress=nativeProgress('(lldb) settings set private-canary\n(lldb) process attach --pid 101\nprivate-canary\n');
  const saved=safeEvidence({progress,outputBytes:123,diagnosticBytes:45});
  assert.deepEqual(saved,{progress:{settingsCommandSeen:true,attachCommandSeen:true,stopAcknowledged:false,
    backtraceCommandSeen:false,detachCommandSeen:false,detachAcknowledged:false},outputBytes:123,diagnosticBytes:45});
  assert.doesNotMatch(JSON.stringify(saved),/private-canary|--pid/);
  assert.deepEqual(nativeProgress('Process 101 stopped\n(lldb) thread backtrace all -c 16\n(lldb) process detach\nProcess 101 detached'),
    {settingsCommandSeen:false,attachCommandSeen:false,stopAcknowledged:true,backtraceCommandSeen:true,detachCommandSeen:true,detachAcknowledged:true});
});
