import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../config.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {fundingOf,admitted,sessionsKnownFrom} from '../domain/workAccess.js';

const at=Date.UTC(2026,9,12),machine={id:'machine-0123456789',name:'Laptop',os:'linux',arch:'x86_64'};
function setup(){const store=new Store(':memory:',at),directory=new Directory(store.db);const owner=directory.createUser('one@example.com','One','x',at),other=directory.createUser('two@example.com','Two','x',at),board=directory.createBoard('Team',owner.id,at).id;store.db.prepare('INSERT INTO members VALUES (?,?,?,?)').run(board,other.id,'member',at+100);const device=directory.saveDevice({userId:other.id,machine,agent:'fixture',tokenId:null},at+200);return {store,directory,owner,other,board,device};}

test('device policy inherits membership ON, uses CAS and fresh epochs, and survives reconnect',t=>{
 const h=setup();t.after(()=>h.store.close());const get=()=>h.store.sessionDevices(h.board,h.other.id)[0];
 const initial=get();assert.equal(initial.enabled,true);assert.equal(initial.since,at+100);assert.equal(h.store.db.prepare('SELECT count(*) n FROM board_device_sessions').get()?.n,0);
 assert.deepEqual(h.store.setDeviceSessions(h.board,h.device.id,h.other.id,true,initial.revision,at+300),initial);
 const off=h.store.setDeviceSessions(h.board,h.device.id,h.other.id,false,initial.revision,at+300);assert.equal(off.since,null);assert.notEqual(off.revision,initial.revision);
 assert.throws(()=>h.store.setDeviceSessions(h.board,h.device.id,h.other.id,true,initial.revision,at+300),/share_conflict/);
 assert.throws(()=>h.store.setDeviceSessions(h.board,h.device.id,h.owner.id,true,off.revision,at+300),/not_found/);
 h.directory.revokeDevice(h.other.id,h.device.id,at+400);h.directory.saveDevice({userId:h.other.id,machine,agent:'fixture',tokenId:null},at+500);assert.equal(get().revision,off.revision);assert.equal(get().enabled,false);
 const on=h.store.setDeviceSessions(h.board,h.device.id,h.other.id,true,off.revision,at+300);assert.equal(on.since,at+300);assert.notEqual(on.revision,off.revision);
 assert.deepEqual(h.store.setDeviceSessions(h.board,h.device.id,h.other.id,true,on.revision,at+900),on);
 h.directory.removeMember(h.board,h.other.id);assert.equal(h.store.db.prepare('SELECT count(*) n FROM board_device_sessions').get()?.n,0);assert.deepEqual(h.store.sessionDevices(h.board,h.other.id),[]);
 h.store.db.prepare('INSERT INTO members VALUES (?,?,?,?)').run(h.board,h.other.id,'member',at+1000);assert.equal(get().since,at+1000);assert.notEqual(get().revision,initial.revision);
});

test('one snapshot admits saved devices and discloses only held provided sources, independently of hidden cards',t=>{
 const h=setup();t.after(()=>h.store.close());const held=h.store.source('codex','a'.repeat(24),at),foreign=h.store.source('codex','b'.repeat(24),at);h.store.hold(held,h.other.id,at);h.store.hold(foreign,h.owner.id,at);h.store.share(h.board,foreign,h.owner.id,at);
 let access=h.store.workAccess(h.board,at+1000);assert.equal(admitted(access,h.device.id,h.other.id)?.from,at+100);assert.equal(admitted(access,h.device.id,h.owner.id),undefined);
 assert.deepEqual(fundingOf(access,h.other.id,null),{source:null});assert.deepEqual(fundingOf(access,h.other.id,foreign),{source:null});assert.deepEqual(fundingOf(access,h.other.id,held),{source:null,sourceStatus:'notProvided'});
 h.store.share(h.board,held,h.other.id,at+800);access=h.store.workAccess(h.board,at+1000);assert.deepEqual(fundingOf(access,h.other.id,held),{source:held});assert.equal(access.devices.get(h.device.id)?.from,at+100);assert.equal(access.sources.get(held)?.since,at+800);
 const policy=h.store.sessionDevices(h.board,h.other.id)[0];h.store.setDeviceSessions(h.board,h.device.id,h.other.id,false,policy.revision,at+900);assert.equal(sessionsKnownFrom(h.store.workAccess(h.board,at+1000)),null);
 const personal=h.directory.boards(h.other.id).find(b=>b.personal)!.id;assert.equal(sessionsKnownFrom(h.store.workAccess(personal,at+1000)),at);
});

test('disconnected retained devices remain manageable without erasing history',t=>{
 const h=setup();t.after(()=>h.store.close());h.store.creditWork(h.device.id,at+200,at+300,[{client:'opencode',source:null,origin:'terminal',project:'P',folder:'',startedAt:at,identity:{kind:'stable',sessionId:'c'.repeat(32)}}]);h.directory.revokeDevice(h.other.id,h.device.id,at+400);
 const policy=h.store.sessionDevices(h.board,h.other.id)[0];assert.equal(policy.disconnected,true);assert.ok(h.store.workAccess(h.board,at+500).devices.has(h.device.id));h.store.setDeviceSessions(h.board,h.device.id,h.other.id,false,policy.revision,at+500);assert.equal(h.store.agentWork(at,at+1000).length,1);
 h.directory.deleteBoard(h.board);assert.equal(h.store.db.prepare('SELECT count(*) n FROM board_device_sessions').get()?.n,0);assert.equal(h.store.agentWork(at,at+1000).length,1);
});

test('physical retirement removes disconnected devices from management, admission and funding together',t=>{
 const h=setup();t.after(()=>h.store.close());t.mock.method(Date,'now',()=>at+1000);
 h.store.creditWork(h.device.id,at+200,at+300,[{client:'opencode',source:null,origin:'terminal',project:'P',folder:'',startedAt:at,identity:{kind:'stable',sessionId:'c'.repeat(32)}}]);h.directory.revokeDevice(h.other.id,h.device.id,at+400);
 assert.equal(h.store.sessionDevices(h.board,h.other.id).length,1);assert.equal(h.store.workAccess(h.board).devices.size,1);
 h.store.prune(at+config.retention.sampleDays*86_400_000+1000);
 assert.deepEqual(h.store.sessionDevices(h.board,h.other.id),[]);assert.equal(h.store.workAccess(h.board).devices.size,0);assert.equal(sessionsKnownFrom(h.store.workAccess(h.board)),null);
 const key=h.store.workKey(h.board),funding=h.store.workAccess(h.board).fundingRevision,source=h.store.source('codex','e'.repeat(24),at+1000);
 h.store.hold(source,h.other.id,at+1000);h.store.share(h.board,source,h.other.id,at+1000);assert.equal(h.store.workAccess(h.board).fundingRevision,funding);assert.equal(h.store.workKey(h.board),key);
});

test('work authority ignores advancing clocks and unrelated sample capture but records physical work retirement',t=>{
 const h=setup();t.after(()=>h.store.close());const before=h.store.workKey(h.board);
 assert.equal(h.store.workAccess(h.board,at+100*86_400_000).knownFrom,at);assert.equal(h.store.workKey(h.board),before);
 const source=h.store.source('codex','d'.repeat(24),at);h.store.db.prepare("INSERT INTO samples VALUES (?,?,?,'weekly',NULL,20,NULL,10080,60000)").run(source,at-1000,'weekly');assert.equal(h.store.workKey(h.board),before);
 h.store.creditWork(h.device.id,at+200,at+300,[{client:'opencode',source:null,origin:'terminal',project:'P',folder:'',startedAt:at,identity:{kind:'stable',sessionId:'c'.repeat(32)}}]);assert.equal(h.store.workKey(h.board),before);
 h.store.prune(at+100*86_400_000);assert.notEqual(h.store.workKey(h.board),before);
});


test('physical work retirement stays monotonic after a backward clock and deleted late pre-cutoff credit',t=>{
 const h=setup();t.after(()=>h.store.close());const key={client:'opencode',source:null,origin:'terminal' as const,project:'P',folder:'',startedAt:at,identity:{kind:'stable' as const,sessionId:'c'.repeat(32)}},retention=config.retention.sampleDays*86_400_000;
 h.store.creditWork(h.device.id,at+200,at+300,[key]);h.store.prune(at+retention+1000);const authority=h.store.workKey(h.board),known=h.store.workAccess(h.board).knownFrom;assert.equal(known,at+1000);
 h.store.creditWork(h.device.id,at+400,at+500,[key]);assert.equal(h.store.agentWork(at,at+1000).length,1,'a late span behind the retired prefix is physically captured');h.store.prune(at+retention+600);assert.equal(h.store.agentWork(at,at+1000).length,0);
 assert.equal(h.store.workAccess(h.board).knownFrom,known,'the SQL TEXT metadata affinity cannot lower the integer watermark');assert.equal(h.store.workKey(h.board),authority,'deleted old evidence cannot widen or revive a retired authority');
});
