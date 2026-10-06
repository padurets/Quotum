import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {BoardAdditions} from '../additions.js';
import {DeviceOnboarding} from '../deviceOnboarding.js';
import {ConnectorTransport, type Connector, type ConnectorIdentity} from '../connectors/index.js';
import {Credentials, SecretKey, startSecrets} from '../secrets/index.js';

const KEY='PRIVATE_ADDITION_CANARY_0123456789';
const identity:ConnectorIdentity={account:'a'.repeat(24),abilities:['balance'],expiresAt:null};
function fixture() {
  const folder=mkdtempSync(path.join(os.tmpdir(),'quotum-addition-')),file=path.join(folder,'hub.sqlite'),store=new Store(file),directory=new Directory(store.db);
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,7).toString('base64url'))),report=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  const connector:Connector={id:'openrouter',transport,abilities:['balance'],secretFormat:()=>true,map:()=>null,identify:async()=>identity,measure:async()=>identity};
  const credentials=new Credentials(store,key,report,new Map([['openrouter',connector]]));
  const owner=directory.createUser('owner@fixture.example','Owner','unused',Date.now()),member=directory.createUser('member@fixture.example','Member','unused',Date.now());
  const board=directory.createBoard('Team',owner.id,Date.now());directory.addMember(board.id,member.id,Date.now());
  let now=Date.now();
  const additions=new BoardAdditions(store,directory,credentials,()=>now);
  const reserve=(item:Parameters<BoardAdditions['reserve']>[3]={kind:'connection',provider:'openrouter'},user=member.id,target:string|null=board.id)=>additions.reserve(user,randomUUID(),target,item);
  const close=()=>{transport.close();store.close();rmSync(folder,{recursive:true,force:true});};
  return {store,directory,credentials,connector,owner,member,board,additions,reserve,close,file,advance:(ms:number)=>{now+=ms;}};
}
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}

test('failed publication rolls back encrypted access, holding, source, visibility and all touches',async t=>{
  const h=fixture();t.after(h.close);
  const operation=h.reserve(),view=h.directory.view(h.board.id),revision=h.directory.viewRevision(h.board.id);
  let scheduled=0;h.credentials.onChange=()=>scheduled++;
  h.store.db.exec("CREATE TRIGGER fail_share BEFORE INSERT ON shares BEGIN SELECT RAISE(ABORT,'private fixture'); END");
  const result=await h.additions.run(h.member.id,operation.id,KEY,()=>true);
  assert.equal(result.state,'needs_input');assert.equal(result.error,'credential_failed');
  assert.deepEqual(h.credentials.list(h.member.id),[]);assert.deepEqual(h.store.held(h.member.id),[]);assert.deepEqual(h.store.sources(h.board.id),[]);
  assert.deepEqual(h.directory.view(h.board.id),view);assert.equal(h.directory.viewRevision(h.board.id),revision);assert.equal(scheduled,0);
  assert.equal((h.store.db.prepare('SELECT count(*) AS n FROM sources').get() as {n:number}).n,0);
  assert.equal(JSON.stringify(result).includes(KEY),false);
  for(const suffix of ['','-wal','-shm'])assert.equal(readFileSync(h.file+suffix).includes(Buffer.from(KEY)),false);
});

test('authority is checked after verification; logout and lost membership never fall back to personal access',async t=>{
  for(const loss of ['session','member']) {
    const h=fixture();t.after(h.close);const waiting=deferred<ConnectorIdentity>(),started=deferred<void>();
    h.connector.identify=async()=>{started.resolve();return waiting.promise;};
    const operation=h.reserve();let session=true;
    const running=h.additions.run(h.member.id,operation.id,KEY,()=>session);await started.promise;
    if(loss==='session')session=false;else h.directory.removeMember(h.board.id,h.member.id);
    waiting.resolve(identity);const result=await running;
    assert.equal(result.state,'failed');assert.equal(result.error,'addition_permission');assert.deepEqual(h.credentials.list(h.member.id),[]);assert.deepEqual(h.store.held(h.member.id),[]);
  }
});

test('durable receipts survive a new service instance, reuse access and respect later hide or removal',async t=>{
  const h=fixture();t.after(h.close);
  const operation=h.reserve(),created=await h.additions.run(h.member.id,operation.id,KEY,()=>true),source=created.result!.sourceIds[0];
  assert.equal(created.state,'complete');assert.equal(created.result!.placement,'added');
  const before=h.store.db.prepare('SELECT cipher,nonce FROM credentials').get();
  const repeat=h.reserve(),reused=await h.additions.run(h.member.id,repeat.id,'DIFFERENT_VALID_SECRET',()=>true);
  assert.equal(reused.result!.connection,'reused');assert.deepEqual(h.store.db.prepare('SELECT cipher,nonce FROM credentials').get(),before);
  h.directory.saveView(h.board.id,{...h.directory.view(h.board.id),hidden:['source:'+source]},h.owner.id,Date.now());
  const restarted=new BoardAdditions(h.store,h.directory,h.credentials),recovered=restarted.list(h.member.id).operations.find(item=>item.id===operation.id)!;
  assert.equal(recovered.current.sources![0].placement,'hidden');
  const replay=await restarted.run(h.member.id,operation.id,undefined,()=>true);
  assert.equal(replay.current.sources![0].placement,'hidden');assert.equal(h.credentials.list(h.member.id).length,1);
  h.credentials.remove(h.member.id,created.result!.credentialId!);
  const removed=await restarted.run(h.member.id,operation.id,KEY,()=>true);
  assert.equal(removed.current.credential!.exists,false);assert.equal(h.credentials.list(h.member.id).length,0);
  assert.throws(()=>restarted.get(h.owner.id,operation.id),{message:'addition_not_found'});
});

test('a stale verification lease cannot commit over a newer attempt',async t=>{
  const h=fixture();t.after(h.close);const first=deferred<ConnectorIdentity>(),started=deferred<void>();let calls=0;
  h.connector.identify=async()=>{calls++;if(calls===1){started.resolve();return first.promise;}return identity;};
  const operation=h.reserve(),late=h.additions.run(h.member.id,operation.id,KEY,()=>true);await started.promise;
  h.advance(31_000);assert.equal(h.additions.get(h.member.id,operation.id).error,'addition_interrupted');
  const other=new BoardAdditions(h.store,h.directory,h.credentials,()=>Date.now()+31_000);
  assert.equal((await other.run(h.member.id,operation.id,KEY,()=>true)).state,'complete');
  first.resolve(identity);assert.equal((await late).state,'complete');assert.equal(h.credentials.list(h.member.id).length,1);
});

test('replacement replay preserves a newer replacement and reports removed access',async t=>{
  const h=fixture();t.after(h.close);const create=h.reserve(),saved=await h.additions.run(h.member.id,create.id,KEY,()=>true),id=saved.result!.credentialId!;
  const first=h.reserve({kind:'replace',credentialId:id},h.member.id,null);
  assert.equal((await h.additions.run(h.member.id,first.id,KEY+'1',()=>true)).state,'complete');
  const second=h.reserve({kind:'replace',credentialId:id},h.member.id,null);
  assert.equal((await h.additions.run(h.member.id,second.id,KEY+'2',()=>true)).state,'complete');
  const before=h.store.db.prepare('SELECT cipher,nonce FROM credentials').get();
  const replay=await h.additions.run(h.member.id,first.id,KEY,()=>true);
  assert.equal(replay.current.credential!.revisionMatches,false);assert.deepEqual(h.store.db.prepare('SELECT cipher,nonce FROM credentials').get(),before);
  h.credentials.remove(h.member.id,id);
  assert.equal((await h.additions.run(h.member.id,first.id,KEY,()=>true)).current.credential!.exists,false);
});

test('device intents freeze an exact delivered subset and never share later accounts',async t=>{
  const h=fixture();t.after(h.close);const onboarding=new DeviceOnboarding(h.store,h.directory,h.additions);
  const device=h.directory.saveDevice({userId:h.member.id,machine:{id:'fixture-machine',name:'Laptop',os:'linux',arch:'x86_64'},agent:'0.6.0',tokenId:null},Date.now());
  const sources=['one','two'].map(account=>h.store.source('codex',account,Date.now()));
  for(const source of sources)h.store.hold(source,h.member.id,Date.now());
  h.store.seenDevice(device.id,'codex',sources[0],Date.now());
  const intent=onboarding.reserve(h.member.id,randomUUID(),h.board.id),request=randomUUID();
  assert.throws(()=>onboarding.select(h.member.id,intent.id,device.id,[sources[1]],request),{message:'addition_permission'});
  const selection=onboarding.select(h.member.id,intent.id,device.id,[sources[0]],request);
  assert.equal((await h.additions.run(h.member.id,selection.id,undefined,()=>true)).state,'complete');
  assert.equal(onboarding.get(h.member.id,intent.id).status,'complete');
  h.store.seenDevice(device.id,'codex',sources[1],Date.now());
  assert.deepEqual(h.store.sources(h.board.id).map(source=>source.id),[sources[0]]);
  assert.equal(onboarding.select(h.member.id,intent.id,device.id,[sources[0]],request).id,selection.id);
  assert.throws(()=>onboarding.select(h.member.id,intent.id,device.id,[sources[1]],randomUUID()),{message:'addition_conflict'});
});

test('verification cannot commit with a stale encryption key after concurrent rotation',async t=>{
  const h=fixture();t.after(h.close);const create=h.reserve(),saved=await h.additions.run(h.member.id,create.id,KEY,()=>true);
  const operation=h.reserve({kind:'replace',credentialId:saved.result!.credentialId!},h.member.id,null),late=deferred<ConnectorIdentity>(),started=deferred<void>();
  h.connector.identify=async()=>{started.resolve();return late.promise;};
  const running=h.additions.run(h.member.id,operation.id,KEY+'2',()=>true);await started.promise;
  const previous=SecretKey.parse(Buffer.from(Buffer.alloc(32,7).toString('base64url'))),next=SecretKey.parse(Buffer.from(Buffer.alloc(32,8).toString('base64url')));
  assert.equal(startSecrets(h.store.db,{current:next,previous,reset:null,storageAtStart:null,wasFileAtStart:false}).outcome,'rotated');
  const row=h.store.db.prepare('SELECT * FROM credentials').get() as unknown as Parameters<SecretKey['use']>[0];
  late.resolve(identity);const result=await running;assert.equal(result.state,'needs_input');assert.equal(result.error,'credential_conflict');
  assert.deepEqual(h.store.db.prepare('SELECT * FROM credentials').get(),row);
  next.use(row,bytes=>assert.equal(bytes.toString(),KEY));
});

test('ordinary maintenance removes old completed and expired addition and device receipts',async t=>{
  const h=fixture();t.after(h.close);const completed=h.reserve({kind:'widget',widgetId:'history'},h.owner.id);
  await h.additions.run(h.owner.id,completed.id,undefined,()=>true);h.reserve();
  const onboarding=new DeviceOnboarding(h.store,h.directory,h.additions);onboarding.reserve(h.owner.id,randomUUID(),h.board.id);
  h.directory.prune(Date.now()+40*86_400_000);
  assert.equal((h.store.db.prepare('SELECT count(*) AS n FROM board_additions').get() as {n:number}).n,0);
  assert.equal((h.store.db.prepare('SELECT count(*) AS n FROM device_onboarding').get() as {n:number}).n,0);
});
