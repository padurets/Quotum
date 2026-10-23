import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeFrames,nativeMainLocations,nativePostmortem,nativeProgress} from '../nativePostmortem.js';
import {safeEvidence} from '../evidence.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

test('a remembered renderer birth cannot authorize capture of a reused PID',async()=>{
  const source=ts.createSourceFile('native.ts',readFileSync(new URL('../nativePostmortem.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
  const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='nativePostmortem')!;
  const code=ts.transpileModule(declaration.getText(source).replace('import.meta.url',JSON.stringify('file:///fixture/native.js'))+'\nglobalThis.capture=nativePostmortem;',{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  for(const birth of ['199','200',undefined]){
    let scriptReads=0;
    const renderer={pid:101,parent:100,group:100,session:100,birth:'200',state:'S',uid:1000,tracer:0,
      minorFaults:null,majorFaults:null,userTicks:null,systemTicks:null,blockIoTicks:null};
    const root={...renderer,pid:100,birth:'100'};
    const context={exports:{},performance,URL,process:{platform:'linux',getuid:()=>1000},
      nativeProgress:()=>({}),nativeDebugger:async()=>'/usr/bin/gdb',current:async()=>renderer,
      readFile:async()=>{scriptReads++;throw Error('stop before helper creation');}};
    runInNewContext(code,context);
    const capture=(context as unknown as {capture:typeof nativePostmortem}).capture;
    const report=await capture({root:100,live:()=>true,observe:async()=>[root,renderer],resource:()=>async()=>{}},
      [{pid:101,cpuTime:1,...(birth===undefined?{}:{birth})}],new AbortController().signal);
    assert.equal(scriptReads,birth==='199'?0:1);
    assert.equal(report.intervened,false);
  }
});

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

const locationReceipt=(value:unknown)=>'QGDB_BT_DONE\nQGDB_MAIN '+JSON.stringify(value)+'\nQGDB_DETACHED\n';
const fileLocation={index:0,status:'file-location',buildId:'a123456789abcdef',fileOffset:123456};
const mainLocations={status:'observed',tid:100,frames:[fileLocation]};

test('main locations retain exact file offsets without claiming symbols or saving native text',()=>{
  const parsed=nativeMainLocations(locationReceipt({...mainLocations,path:'/private-canary',frames:[{...fileLocation,pc:'0x1234',symbol:'private-canary'}]}),100,1);
  assert.deepEqual(parsed,mainLocations);
  assert.deepEqual(safeEvidence(parsed),mainLocations);
  assert.doesNotMatch(JSON.stringify(parsed),/private-canary|0x1234|symbol|path/);
  const unknown={status:'observed',tid:100,frames:[{index:0,status:'unknown',reason:'anonymous-executable'}]};
  assert.deepEqual(nativeMainLocations(locationReceipt(unknown),100,1),unknown);
});

test('missing or ambiguous main locations never manufacture a native position',()=>{
  const unavailable={status:'unavailable',tid:100,frames:[]};
  const cases=[
    '',locationReceipt(mainLocations).replace('QGDB_BT_DONE\n',''),
    locationReceipt(mainLocations).replace('QGDB_DETACHED\n',''),
    locationReceipt(mainLocations)+'QGDB_MAIN '+JSON.stringify(mainLocations)+'\n',
    'QGDB_MAIN '+JSON.stringify(mainLocations)+'\nQGDB_BT_DONE\nQGDB_DETACHED\n',
    'QGDB_BT_DONE\nQGDB_MAIN {\nQGDB_DETACHED\n',
    ...[null,{...mainLocations,tid:101},{...mainLocations,status:'other'},
      {...mainLocations,frames:[]},{...mainLocations,frames:Array(17).fill(fileLocation)},
      ...[{...fileLocation,index:1},{...fileLocation,buildId:'abc'},{...fileLocation,buildId:'a'.repeat(130)},
        {...fileLocation,buildId:'0x123456'},{...fileLocation,fileOffset:-1},{...fileLocation,fileOffset:1.5},
        {...fileLocation,fileOffset:Number.MAX_SAFE_INTEGER+1},{...fileLocation,fileOffset:'123'},
        {index:0,status:'unknown',reason:'/private-canary'}].map(frame=>({...mainLocations,frames:[frame]})),
    ].map(locationReceipt),
  ];
  for(const text of cases)assert.deepEqual(nativeMainLocations(text,100,1),unavailable);
  for(const count of [0,2,17,1.5])assert.deepEqual(nativeMainLocations(locationReceipt(mainLocations),100,count),unavailable);
});
