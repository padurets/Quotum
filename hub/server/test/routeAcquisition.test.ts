import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {HistoryTiles} from '../history.js';
import {Events} from '../events.js';
import {ResetFeed} from '../resets.js';
import {readHistory} from './historyRead.js';

test('actual agent acquisition trace preserves pending evidence and corrects retained work through the real resolver',()=>{
  // Rust proves every normalized wire row through its real cache, timeout, Runner and HTTP sink.
  const fixture=JSON.parse(readFileSync(new URL('../../../agent/crates/core/tests/fixtures/session-route-observations.json',import.meta.url),'utf8'));
  const start=Date.parse(fixture.base.startedAt),minute=60_000,hour=60*minute;
  const store=new Store(':memory:',start),directory=new Directory(store.db),ingest=new Ingest(store,directory,new Duty(),new Cadence());
  const owner=directory.createUser('owner@example.com','Owner','fixture',start),board=directory.boards(owner.id)[0].id;
  const machine={id:'route-fixture-machine',name:'Laptop',os:'linux',arch:'x86_64'};
  const device=directory.saveDevice({userId:owner.id,machine,agent:'quotum/0.7.0',tokenId:null},start);
  const source=store.source('claude',fixture.base.account,start),wallet=store.source('openrouter','fixture-wallet',start);
  store.hold(source,owner.id,start);store.hold(wallet,owner.id,start);
  const tiles=new HistoryTiles(store),events=new Events({store,directory,ingest,resets:new ResetFeed(undefined,()=>{})},undefined,{now:()=>start+10*minute,after:()=>()=>{}},null);
  events.attach();events.onClientHistory=(user,since)=>tiles.touchClient(user,since);
  const closed=(reader=tiles)=>JSON.parse(reader.read(board,minute,start,start+hour,start+3*hour,store.shown(board,[]))[0]).activity.sessions[0]?.[1]??null;
  let ledger:unknown,contexts:unknown;
  try {
    fixture.frames.forEach((frame:{phase:string;working:boolean;route?:object},i:number)=>{
      const at=start+i*minute;
      const packet={version:1,agent:'quotum/0.7.0',machine,sentAt:new Date(at).toISOString(),sessions:[{...fixture.base,working:frame.working,...frame.route?{route:frame.route}:{}}]};
      assert.equal(ingest.sessions({kind:'device',device},packet,at).accepted,1);
      const expected=i<5?source:null;
      assert.equal(ingest.live.of(source,[owner.id],at).length,expected?1:0,frame.phase);
      if(i===2){ledger=store.db.prepare('SELECT * FROM agent_work').all();contexts=store.db.prepare('SELECT id,source_id,producer_id FROM agent_sessions').all();}
      if(i>=2){
        assert.deepEqual(store.db.prepare('SELECT * FROM agent_work').all(),ledger,'idle evidence adds no credit');
        assert.deepEqual(store.db.prepare('SELECT id,source_id,producer_id FROM agent_sessions').all(),contexts);
        assert.equal(closed(),expected,frame.phase+': warm closed history');
        assert.equal(closed(new HistoryTiles(store)),expected,frame.phase+': cold history');
        assert.equal(readHistory(store,board,start,minute,{to:start+10*minute}).activity.agentMs,2*minute);
      }
    });
    store.links.mutate(owner.id,'create',null,{clientId:'claude',deviceId:device.id,route:null,sourceId:wallet,from:start,to:null,requestId:randomUUID(),expectedRevision:store.links.revision(owner.id)},start+10*minute);
    assert.equal(closed(),wallet,'a manual link overrides observed API attribution');
    assert.deepEqual(store.db.prepare('SELECT * FROM agent_work').all(),ledger);
    assert.deepEqual(store.db.prepare('SELECT id,source_id,producer_id FROM agent_sessions').all(),contexts);
  }finally{events.close();store.close();}
});
