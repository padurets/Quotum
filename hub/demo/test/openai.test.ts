import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OPENAI_SCENES,openAIFixture} from '../openai.js';
import {openAIPlatform,decodeOpenAI} from '../../server/connectors/openai.js';
import {ConnectorStatus,ConnectorTransport} from '../../server/connectors/transport.js';
import {Store} from '../../server/store/store.js';

test('every durable OpenAI catalogue code has a real current sample or honest unknown state',async()=>{
  const now=Date.UTC(2026,9,11),codes=new Set<string>();
  for(const [index,scene] of OPENAI_SCENES.entries()) {
    const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}}),store=new Store(':memory:',now);
    transport.send=async(op,_secret,query={})=>{
      if(op==='limit'&&(index===4||index===5))throw new ConnectorStatus(index===4?403:404,null);
      return {organization:'org-demo-openai-'+index,data:decodeOpenAI(JSON.stringify(openAIFixture(index,op,Number(query.start_time)*1000,Number(query.end_time)*1000,now)))};
    };
    try {
      const result=await openAIPlatform(transport,()=>now).identify(Buffer.from('synthetic-key'));
      const source=store.source('openai_platform',result.account,now);store.record(source,result.measurement!);
      const state=store.state(source),seen=new Set<string>();
      if(state.meters?.length)seen.add('month-costs');else seen.add('unknown-costs');
      if(state.meters?.some(m=>BigInt(m.amount)<0n))seen.add('signed-costs');
      if(state.monthlyLimit?.value){seen.add('configured-limit');seen.add(state.monthlyLimit.value.enforcement);if(state.monthlyLimit.value.amount==='0')seen.add('zero-limit');}
      else seen.add('limit-unavailable');
      assert.equal(state.meters?.some(m=>m.kind==='balance'||m.kind==='cap'),false);
      for(const code of scene.expect){assert.ok(seen.has(code),scene.id+': '+code);codes.add(code);}
    }finally{transport.close();store.close();}
  }
  assert.ok(codes.size>=8);
});
