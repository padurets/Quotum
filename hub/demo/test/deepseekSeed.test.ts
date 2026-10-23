import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {seedDeepSeek,deepSeekPayload,DEEPSEEK_KEY,DEEPSEEK_SCENES,demoRates} from '../deepseek.js';
import type {Stand} from '../setup.js';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {Currencies} from '../../server/currencies/service.js';
import {deepSeek} from '../../server/connectors/deepseek.js';
import {ConnectorTransport} from '../../server/connectors/transport.js';
import {Credentials} from '../../server/secrets/credentials.js';
import {SecretKey} from '../../server/secrets/crypto.js';
import {startSecrets} from '../../server/secrets/start.js';

test('DeepSeek demo observations and valuations commit before the hub can value their anchor',async t=>{
  const now=Date.UTC(2026,9,23,12),hour=3_600_000;
  t.mock.timers.enable({apis:['Date'],now});
  const dir=mkdtempSync(join(tmpdir(),'quotum-deepseek-seed-')),file=join(dir,'hub.sqlite');
  const demo=new Store(file,now),hub=new Store(file,now),directory=new Directory(demo.db);
  const owner=directory.createUser('seed@fixture.example','Seed','unused',now);
  const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
  transport.send=async(operation,secret)=>{
    assert.equal(operation,'balance');
    const index=DEEPSEEK_SCENES.findIndex((_,i)=>DEEPSEEK_KEY(i)===secret.toString('ascii'));
    assert.ok(index>=0);
    return deepSeekPayload(DEEPSEEK_SCENES[index].id,true);
  };
  const adapter=deepSeek(transport,()=>now-3*hour);
  const key=SecretKey.parse(Buffer.from(Buffer.alloc(32,13).toString('base64url')));
  const report=startSecrets(hub.db,{current:key,previous:null,reset:null,storageAtStart:null,wasFileAtStart:false});
  const credentials=new Credentials(hub,key,report,new Map([['deepseek',adapter]]));
  const quote=hub.currencies.save(demoRates(now));hub.currencies.markChecked(now);
  let rateReads=0;
  const service=new Currencies(hub,async()=>{rateReads++;throw Error('unexpected rate read');},()=>now);
  service.start();
  const prepare=demo.db.prepare.bind(demo.db);
  let update:Promise<void>|null=null,interleaved=false,inTransaction=false,hubAt:number|null=null;
  let concurrent:unknown=null,firstSource='';
  t.after(async()=>{
    demo.db.prepare=prepare;await update;await service.stop();transport.close();hub.close();demo.close();
    rmSync(dir,{recursive:true,force:true});
  });
  let created=0;
  const person={id:owner.id,post:async(path:string,body:{provider:'deepseek';secret:string;account:{kind:'new';name:string};allowUnknownExpiry:boolean})=>{
    assert.equal(path,'/api/credentials');assert.equal(body.provider,'deepseek');created++;
    return credentials.create(owner.id,body.provider,body.secret,{account:body.account,allowUnknownExpiry:body.allowUnknownExpiry});
  }};
  const stand={set:{id:'all'},start:now,people:new Map([['ana',person]]),boards:new Map(),agents:new Map(),sources:new Map()} as unknown as Stand;
  demo.db.prepare=sql=>{
    const statement=prepare(sql);
    if(!sql.startsWith('INSERT INTO money_valuations VALUES'))return statement;
    return new Proxy(statement,{get(target,property){
      if(property==='run')return(...values:Parameters<typeof statement.run>)=>{
        if(!interleaved){
          // Advance the real hub writer after the demo has read its previous valuation and span.
          interleaved=true;inTransaction=demo.db.isTransaction;firstSource=String(values[0]);
          hubAt=hub.state(firstSource).meters?.find(m=>m.id==='balance:CNY')?.at??null;
          update=service.update(firstSource);
          concurrent=hub.db.prepare('SELECT * FROM money_valuations WHERE source_id=? AND meter_id=? AND at=?').get(values[0],values[1],values[2])??null;
        }
        return target.run(...values);
      };
      const value=Reflect.get(target,property,target);
      return typeof value==='function'?value.bind(target):value;
    }});
  };
  await seedDeepSeek(demo,directory,stand);await update;
  assert.ok(interleaved);assert.equal(inTransaction,true);assert.equal(hubAt,now-3*hour);assert.equal(concurrent,null);
  assert.equal(created,11);
  const valuations=()=>demo.db.prepare('SELECT * FROM money_valuations ORDER BY source_id,meter_id,at').all();
  const before=valuations();assert.equal(before.length,21);
  const first=demo.db.prepare('SELECT * FROM money_valuations WHERE source_id=? AND meter_id=?').get(firstSource,'fx:USD:balance:CNY');
  assert.equal(first?.native_amount,'110000000');assert.equal(first?.quote_id,quote.id);
  await service.update(firstSource);assert.deepEqual(valuations(),before);
  assert.equal(rateReads,0);
});
