import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Person} from '../../demo/client.js';
import {SETS} from '../../demo/catalogue.js';
import {cards} from '../../demo/model.js';
import {buildApp} from '../../server/api.js';
import {Cadence} from '../../server/cadence.js';
import {Duty} from '../../server/duty.js';
import {subscriptionKey} from '../../server/domain/ingest.js';
import {Ingest} from '../../server/ingest.js';
import {Pairing} from '../../server/pairing.js';
import {ResetFeed} from '../../server/resets.js';
import {Setup} from '../../server/setup.js';
import {Directory} from '../../server/store/directory.js';
import {Store} from '../../server/store/store.js';
import {ObservedWork} from '../observed.js';

test('the observed benchmark writer credits completed work once and keeps declared funding after disconnect',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'quotum-observed-bench-')),store=new Store(path.join(root,'hub.sqlite'));
  const directory=new Directory(store.db),ingest=new Ingest(store,directory,new Duty(),new Cadence());
  const app=await buildApp({store,directory,ingest,pairing:new Pairing(directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(true,'BCDF-GHJK'),local:null});
  try{
    const base=await app.listen({host:'127.0.0.1',port:0});
    const owner=await Person.signUp(base,{email:'fixture@example.com',name:'Fixture',password:'correct horse'},{setupCode:'BCDF-GHJK'});
    const source=store.source('antigravity',subscriptionKey({provider:'antigravity',account:null,accountName:null},owner.id),Date.now());
    store.hold(source,owner.id,Date.now());
    const card=SETS.flatMap(cards).find(card=>card.id==='antigravity')!;
    const before=store.workKey(owner.personalBoard);
    const actor=await ObservedWork.open(owner,card);
    const authority=store.workKey(owner.personalBoard);
    assert.notEqual(authority,before,'admitting the fixture device needs a new history baseline');
    const total=()=>Number(store.db.prepare('SELECT coalesce(sum(to_at-from_at),0) AS ms FROM agent_work').get()!.ms);
    assert.equal(total(),0);
    let at=actor.floorAt;
    for(let i=0;i<3;i++){
      await new Promise(resolve=>setTimeout(resolve,20));at=await actor.report(i<2);
      assert.equal(store.workKey(owner.personalBoard),authority,'credit after admission keeps the same history authority');
    }
    assert.equal(total(),at-actor.floorAt);
    assert.deepEqual(store.db.prepare('SELECT DISTINCT source_id FROM agent_sessions').all().map(row=>row.source_id),[source]);
    await actor.close();assert.equal(total(),at-actor.floorAt);
    assert.equal(ingest.live.devices(owner.id,Date.now()).length,0);
  }finally{await app.close();store.close();rmSync(root,{recursive:true,force:true});}
});
