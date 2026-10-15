import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import {buildApp} from '../../server/api.js';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {Ingest} from '../../server/ingest.js';
import {Duty} from '../../server/duty.js';
import {Cadence} from '../../server/cadence.js';
import {Events,type Frame} from '../../server/events.js';
import {Pairing} from '../../server/pairing.js';
import {Setup} from '../../server/setup.js';
import {ResetFeed} from '../../server/resets.js';
import {SETS} from '../catalogue.js';
import {cards,MIN,type Card,type DemoSet} from '../model.js';
import {setUp} from '../setup.js';

test('failure seeding answers its discovery commands without starting unrelated providers',async t=>{
  const start=Date.UTC(2026,9,11);let clock=start;
  t.mock.method(Date,'now',()=>clock);
  const store=new Store(':memory:',clock),directory=new Directory(store.db),duty=new Duty(),ingest=new Ingest(store,directory,duty,new Cadence());
  const resets=new ResetFeed(undefined,()=>{}),events=new Events({store,directory,ingest,resets},undefined,{now:()=>clock,after:()=>()=>{}});
  const app=await buildApp({store,directory,ingest,resets,events,pairing:new Pairing(directory),setup:new Setup(true,'BCDF-GHJK'),local:null});
  t.after(async()=>{events.close();await app.close();store.close();});
  const requested:string[]=[],failuresAcknowledged:boolean[]=[];
  const checkin=ingest.checkin.bind(ingest);ingest.checkin=(credential,body,now)=>{
    requested.push(...(body as {subscriptions:{provider:string}[]}).subscriptions.map(subscription=>subscription.provider));
    return checkin(credential,body,now);
  };
  const acknowledges=ingest.measurementSelection.acknowledges.bind(ingest.measurementSelection);
  ingest.measurementSelection.acknowledges=(...args)=>{const result=acknowledges(...args);if(!args[5])failuresAcknowledged.push(result);return result;};
  const original=cards(SETS[0]);
  const card=(id:string,template:string):Card=>({...original.find(card=>card.id===template)!,id,machines:['seed-machine'],history:10*MIN,agents:undefined,on:undefined,expect:[{stale:false}]});
  const healthy=card('seed-healthy','claude-max');
  const failed={...card('seed-failed','codex-timeout'),until:-5*MIN,failure:{from:-4*MIN,error:'timeout' as const}};
  const set:DemoSet={id:'seed-failures',about:'Failure command lifecycle',scene:SETS[0].scene,entries:[
    {kind:'person',id:'ana',name:'Ana',expect:[{state:'widgets'}]},
    {kind:'machine',id:'seed-machine',failures:[{provider:'antigravity',error:'invalid_output'}],expect:[{os:'linux'}]},
    healthy,failed,
  ]};
  await app.listen({host:'127.0.0.1',port:0});
  const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const stand=await setUp(base,set,start,'BCDF-GHJK',()=>clock,true),owner=stand.people.get('ana')!;
  await t.test('only the verified failure provider is asked',()=>assert.deepEqual(requested,['codex']));
  await t.test('the ongoing failure answers the command at its actual capture time',()=>assert.deepEqual(failuresAcknowledged,[true]));
  const healthySource=stand.sources.get(healthy.id)!,before=store.state(healthySource).successAt;
  const sourceIds=[...stand.sources.values()];
  for(const source of sourceIds)assert.equal(duty.measuring(store.account(source)!,clock),false,'every issued command received an outcome');
  const frames:Frame[]=[];
  events.open({user:owner.id,secret:owner.cookie.slice(owner.cookie.indexOf('=')+1),board:owner.personalBoard,kind:'stream',send:batch=>frames.push(...batch),end:()=>{}});
  events.flush();frames.length=0;
  // A still demo keeps reporting sessions but never measures again. Cross the old
  // five-minute command boundary through the real projection, without a wall-clock wait.
  for(clock=start+15000;clock<=start+6*MIN;clock+=15000) {
    await stand.agents.get('seed-machine')!.sessions([],clock);
    events.touchSources(sourceIds);events.flush();
  }
  assert.deepEqual(frames.filter(frame=>frame.type==='refresh'),[]);
  assert.equal(store.state(healthySource).successAt,before,'unrelated retained measurements stay untouched');
  const devices=await owner.get<{failures:{provider:string}[]}[]>('/api/devices');
  assert.ok(devices[0].failures.some(failure=>failure.provider==='antigravity'),'generic diagnostics remain visible');
});
