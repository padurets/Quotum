import {test} from 'node:test';
import assert from 'node:assert/strict';
import {REPORT_SCENES,REPORT_KEY,reportFixture} from '../reports.js';
import {ConnectorStatus,ConnectorTransport} from '../../server/connectors/transport.js';
import {openAIPlatform,decodeOpenAI} from '../../server/connectors/openai.js';
import {Store} from '../../server/store/store.js';
import {reportAllowance} from '../../server/domain/reports.js';

test('every reported-cost demo entry holds its advertised state through the real adapter and ledger',async()=>{
  const now=Date.UTC(2026,9,8,12),store=new Store(':memory:',now);
  try{for(const [index,scene] of REPORT_SCENES.entries()) {
    const transport=new ConnectorTransport({host:'127.0.0.1',port:443,operations:{}});
    transport.send=async(op,_bytes,query={})=>{
      if(op==='limit'&&(index===4||index===5))throw new ConnectorStatus(index===4?403:404,null);
      return {organization:'org-demo-'+index,data:decodeOpenAI(JSON.stringify(reportFixture(index,op,Number(query.start_time)*1000,Number(query.end_time)*1000,now)))};
    };
    try {
      const result=await openAIPlatform(transport,()=>now).identify(Buffer.from(REPORT_KEY(index)));
      const source=store.source('openai_platform',result.account,now);store.record(source,result.measurement!);
      const state=store.state(source),calendar=store.reports.calendar(source,now),allowance=reportAllowance(calendar,state.monthlyLimit,now),codes:string[]=[];
      if(allowance){codes.push('monthly-limit',allowance.enforcement);if(allowance.remaining!==null)codes.push('allowance');if(BigInt(allowance.overspend??'0')>0n)codes.push('overspend');if(allowance.limit==='0')codes.push('zero-limit');}
      else codes.push('limit-unavailable');
      if(!calendar[0]?.month.confirmed)codes.push('incomplete-month');
      if(BigInt(calendar[0]?.month.amount??'0')<0n)codes.push('signed-report');
      for(const expected of scene.expect)assert.ok(codes.includes(expected),scene.id+': '+expected);
      assert.equal(state.windows.length,0);assert.equal(result.expiryKind,'unknown');
    }finally{transport.close();}
  }}finally{store.close();}
});
