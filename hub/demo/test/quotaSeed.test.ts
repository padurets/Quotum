import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {Credentials,SecretKey,startSecrets} from '../../server/secrets/index.js';
import {ConnectorTransport} from '../../server/connectors/transport.js';
import {decodeZai,mapZai,zai} from '../../server/connectors/zai.js';
import {QUOTA_IDS} from '../../server/domain/meters.js';
import {Person} from '../client.js';
import {SETS} from '../catalogue.js';
import {seedQuotas,quotaFixture,QUOTA_KEY,QUOTA_SCENES} from '../quotas.js';
import type {Stand} from '../setup.js';

test('quota demo seeding replaces initial anchors before backfilling its history',async t=>{
  const now=Date.UTC(2026,9,23,12),hour=3600000;
  t.mock.timers.enable({apis:['Date'],now});
  const store=new Store(':memory:',now-hour),directory=new Directory(store.db);
  const ownerUser=directory.createUser('owner@example.test','Owner','unused',now-hour);
  const other=directory.createUser('other@example.test','Other','unused',now-hour);
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,31).toString('base64url')));
  const report=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  t.after(()=>{transport.close();store.close();});
  transport.send=async(_operation,secret)=>{
    const index=QUOTA_SCENES.findIndex((_,i)=>QUOTA_KEY(i)===secret.toString('ascii'));
    assert.ok(index>=0,'only explicit synthetic quota credentials are accepted');
    return decodeZai(JSON.stringify(quotaFixture(index,now)));
  };
  const credentials=new Credentials(store,key,report,new Map([['zai',zai(transport)]]));
  const personal=directory.boards(ownerUser.id).find(board=>board.personal)!.id;
  const owner=new Person('http://unused.invalid',ownerUser.id,personal,'');
  let publicCreates=0;
  owner.post=async<T>(path:string,body:unknown={})=>{
    assert.equal(path,'/api/credentials','the fixture never sends other owner requests');
    const input=body as {provider:string;secret:string;allowUnknownExpiry:boolean};
    assert.equal(input.provider,'zai');publicCreates++;
    return await credentials.create(owner.id,'zai',input.secret,{allowUnknownExpiry:input.allowUnknownExpiry}) as T;
  };
  const untouched=store.source('zai','f'.repeat(24),now-hour);store.hold(untouched,other.id,now-hour);
  const sample=mapZai(decodeZai(JSON.stringify(quotaFixture(1,now))),now-hour);
  store.quotaObservation(untouched,sample.quotaObservation!,sample.measurement);
  const otherRows=()=>['state','readings','meter_spans','quota_anchors'].map(table=>store.db.prepare('SELECT * FROM '+table+' WHERE source_id=?').all(untouched));
  const before=JSON.stringify(otherRows());
  const stand:Stand={set:SETS.find(set=>set.id==='quotas')!,start:now,people:new Map([['owner',owner]]),boards:new Map(),agents:new Map(),sources:new Map()};
  await seedQuotas(store,directory,stand);
  assert.equal(publicCreates,2,'the two interactive scenes use actual Credentials.create');
  const view=directory.view(personal),sources=store.sources(personal);
  const byScene=new Map(sources.map(source=>[view.names[source.id]?.replace(/^z.ai /,''),source.id]));
  assert.deepEqual([...byScene.keys()].sort(),QUOTA_SCENES.map(scene=>scene.id).sort(),'all twelve actual scene sources finish');
  for(const id of byScene.values()){
    const anchors=store.db.prepare('SELECT at FROM quota_anchors WHERE source_id=?').all(id) as {at:number}[];
    assert.ok(anchors.every(row=>row.at<=now),'no initial connection anchor remains after the final seed time');
  }
  for(const scene of ['zero','used']){
    const id=byScene.get(scene)!;
    for(const window of QUOTA_IDS){
      const anchors=store.db.prepare('SELECT at,payload FROM quota_anchors WHERE source_id=? AND window_id=? ORDER BY at').all(id,window) as {at:number;payload:string}[];
      assert.deepEqual(anchors.map(row=>row.at),[now-3*hour,now-2*hour,now-hour,now],scene+' '+window+': four historical/current observations');
      const last=JSON.parse(anchors.at(-1)!.payload);
      assert.equal(last.staleAfterMs,3*hour,'the final anchor belongs to the seeded presentation, not the initial short-lived connection');
      assert.equal(last.amount,scene==='zero'?'0':window===QUOTA_IDS[0]?'800000000':'2000000000');
    }
  }
  assert.equal(JSON.stringify(otherRows()),before,'seeding preserves another owner’s quota state and every ledger row');
  t.diagnostic('All '+byScene.size+' quota scenes completed; zero and used each retain four anchors per window; unrelated source unchanged.');
});
