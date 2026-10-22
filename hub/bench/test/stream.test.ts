import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventCounts} from '../stream.js';
import {IDLE_SCRIPT_MS_PER_SECOND,idleProblems,type Idle} from '../budget.js';

const a='own-device_1',b='own-device_2';
const send=(counts:EventCounts,type:string,data:unknown)=>counts.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
function reader(){const counts=new EventCounts();send(counts,'snapshot',{deviceContacts:{[a]:100,[b]:100}});counts.reset();return counts;}
const idle=(events:Record<string,number>):Idle=>({from:0,to:120_000,cellMs:300_000,requests:{count:0,byPath:{}},events,renders:[],mutations:[],scriptMsPerSecond:0});

test('private contacts remain fully reported while the unchanged board budget sees only board events',()=>{
  const counts=reader();for(let i=0;i<5;i++)send(counts,'ping',{});
  send(counts,'deviceContacts',{devices:[{deviceId:a,lastSeenAt:101},{deviceId:b,lastSeenAt:102}]});
  assert.deepEqual(counts.counts(),{ping:5,deviceContacts:1});
  assert.deepEqual(counts.boardCounts(),{ping:5});
  assert.deepEqual({...counts.contacts(),bytes:0},{packets:1,entries:2,bytes:0,maxEntries:2,invalid:0});
  assert.ok(counts.contacts().bytes>0);
  assert.match(idleProblems(idle(counts.counts())).join('\n'),/deviceContacts/,'the original oracle rejects an undifferentiated contact frame');
  assert.deepEqual(idleProblems(idle(counts.boardCounts())),[]);
  for(const type of ['refresh','card','history','snapshot','unknown']) {
    const changed=reader();send(changed,'ping',{});send(changed,type,{});
    assert.ok(idleProblems(idle(changed.boardCounts())).some(problem=>problem.includes(type)));
  }
  assert.ok(idleProblems({...idle(counts.boardCounts()),requests:{count:1,byPath:{'/api/devices':1}}}).length,'contact refetch remains forbidden');
  assert.ok(idleProblems({...idle(counts.boardCounts()),renders:[{region:'header',node:'div',kind:null,time:false,count:1}]}).length,'contact-driven board work remains forbidden');
  assert.ok(idleProblems({...idle(counts.boardCounts()),scriptMsPerSecond:IDLE_SCRIPT_MS_PER_SECOND+0.001}).length,'private contacts do not bypass the idle script budget');
});

test('only empty owner semantic hints qualify separately; board refreshes still fail',()=>{
  const counts=reader();send(counts,'devices',{});
  assert.deepEqual(counts.counts(),{devices:1});assert.deepEqual(counts.boardCounts(),{});
  assert.deepEqual(counts.hints(),{packets:1,bytes:2,invalid:0});
  assert.match(idleProblems(idle(counts.counts())).join('\n'),/devices/,'raw traffic still fails the original undifferentiated oracle');
  send(counts,'refresh',{id:'source',refresh:{unavailable:'no_device'}});
  assert.match(idleProblems(idle(counts.boardCounts())).join('\n'),/refresh/);
  for(const data of [null,[],[{}],true,0,'',{'deviceId':a},{devices:[]},{source:'private'},{lastSeenAt:101}]) {
    const invalid=reader();send(invalid,'devices',data);
    assert.deepEqual(invalid.hints(),{packets:0,bytes:0,invalid:1});
    assert.equal(invalid.boardCounts().devices,1);
    assert.match(idleProblems(idle(invalid.boardCounts())).join('\n'),/devices/);
  }
  const malformed=reader();malformed.push('event: devices\ndata: {\n\n');
  assert.equal(malformed.hints().invalid,1);assert.equal(malformed.boardCounts().devices,1);
  counts.reset();assert.deepEqual(counts.hints(),{packets:0,bytes:0,invalid:0});
});

test('only bounded coalesced owner contact fields qualify as metadata',()=>{
  for(const data of [null,{}, {devices:[]},{devices:[{deviceId:'foreign-id_1',lastSeenAt:101}]},
    {devices:[{deviceId:a,lastSeenAt:101},{deviceId:a,lastSeenAt:102}]},
    {devices:[{deviceId:a,lastSeenAt:101,name:'private label'}]},
    {devices:[{deviceId:a,lastSeenAt:101}],source:'hidden'},
    {devices:[{deviceId:a,lastSeenAt:-1}]},{devices:[{deviceId:a,lastSeenAt:1.5}]},
    {devices:[{deviceId:a,lastSeenAt:Number.MAX_SAFE_INTEGER+1}]},{devices:[{deviceId:a,lastSeenAt:'101'}]}]) {
    const counts=reader();send(counts,'deviceContacts',data);
    assert.equal(counts.contacts().invalid,1);assert.equal(counts.contacts().packets,0);
    assert.equal(counts.boardCounts().deviceContacts,1);
    assert.match(idleProblems(idle(counts.boardCounts())).join('\n'),/deviceContacts/);
  }
});

test('a reconnect replaces the owner baseline and does not hide snapshots or unknown metadata',()=>{
  const counts=reader();send(counts,'snapshot',{deviceContacts:{[b]:200}});
  assert.equal(counts.boardCounts().snapshot,1);
  counts.reset();send(counts,'deviceContacts',{devices:[{deviceId:a,lastSeenAt:201}]});
  assert.equal(counts.contacts().invalid,1,'a removed owner device cannot qualify');
  counts.reset();send(counts,'deviceContacts',{devices:[{deviceId:b,lastSeenAt:201}]});
  assert.equal(counts.contacts().packets,1);assert.deepEqual(counts.boardCounts(),{});
});
