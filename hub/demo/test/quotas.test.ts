import {test} from 'node:test';
import assert from 'node:assert/strict';
import {QUOTA_SCENES,QUOTA_KEY,quotaFixture,seedQuotas} from '../quotas.js';
import {SETS} from '../catalogue.js';
import {Person} from '../client.js';
import type {Stand} from '../setup.js';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {Credentials,SecretKey,startSecrets} from '../../server/secrets/index.js';
import {ConnectorTransport} from '../../server/connectors/transport.js';
import {decodeZai,zai} from '../../server/connectors/zai.js';
import {publicSourceState} from '../../server/projection.js';
import {capPercent} from '../../ui/lib/money.js';

test('every durable quota catalogue entry produces its declared public and private state without supplier access',async()=>{
  const store=new Store(':memory:'),directory=new Directory(store.db),owner=directory.createUser('quotas@fixture.example','Quotas','unused',Date.now());
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,31).toString('base64url'))),report=startSecrets(store.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  transport.send=async(_operation,bytes)=>{
    const index=QUOTA_SCENES.findIndex((_,i)=>QUOTA_KEY(i)===bytes.toString());assert.ok(index>=0);
    return decodeZai(JSON.stringify(quotaFixture(index,Date.now())));
  };
  const credentials=new Credentials(store,key,report,new Map([['zai',zai(transport)]]));
  const person=new Person('https://fixture.invalid',owner.id,directory.boards(owner.id)[0].id,'unused');
  person.post=async<T>(_path:string,raw:unknown)=>{const body=raw as {secret:string};return await credentials.create(owner.id,'zai',body.secret,{allowUnknownExpiry:true}) as T;};
  const stand:Stand={set:SETS.find(s=>s.id==='quotas')!,start:Date.now(),people:new Map([['owner',person]]),boards:new Map(),agents:new Map(),sources:new Map()};
  try {
    await seedQuotas(store,directory,stand);
    const view=directory.view(person.personalBoard);
    for(const scene of QUOTA_SCENES) {
      const source=Object.entries(view.names).find(([,name])=>name===`z.ai ${scene.id}`)![0],state=store.state(source),privateAccess=credentials.list(owner.id).find(c=>c.sourceId===source)!;
      const caps=state.meters!,five=caps.find(m=>m.id==='quota:credit:5h')!,week=caps.find(m=>m.id==='quota:credit:week')!;
      const codes:string[]=[];
      if(caps.every(m=>m.amount==='0'))codes.push('credit-zero');
      if(five.resetAt===null)codes.push('reset-unknown');
      if(capPercent(five)===40&&capPercent(week)===20)codes.push('credit-40-20');
      if(caps.length===2)codes.push('independent-caps');
      if(capPercent(five)!>=90&&capPercent(five)!<100)codes.push('credit-critical');
      if(BigInt(five.amount)>BigInt(five.limit!))codes.push('credit-exhausted');
      if(five.limit==='0')codes.push('credit-closed');
      if(!state.quota!.complete)codes.push('quota-partial');
      if(state.quota!.issue)codes.push('quota-'+state.quota!.issue);
      if(privateAccess.lastError==='credential_auth_rejected')codes.push('private-auth-rejected');
      if(privateAccess.lastError==='credential_unreadable')codes.push('private-storage-unavailable');
      if(publicSourceState(state).error==='unmeasured')codes.push('public-unmeasured');
      for(const expected of scene.expect)assert.ok(codes.includes(expected),`${scene.id}: ${expected}, received ${codes}`);
      assert.equal(privateAccess.identityOrigin,'declared');assert.equal(privateAccess.expiryKind,'unknown');
      assert.ok(!JSON.stringify(publicSourceState(state)).includes(QUOTA_KEY(0)));
    }
  }finally{transport.close();store.close();}
});
