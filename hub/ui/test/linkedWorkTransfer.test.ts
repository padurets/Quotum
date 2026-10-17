import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {expandPeriod} from '../../server/domain/periodWire';
import {HISTORY_BYTES_PER_MEASUREMENT} from '../../bench/budget';

test('a dense board settles wallet evidence on link changes and keeps every ordinary work reply small',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,ownerDevice:true});
  const settle=async()=>{for(let i=0;i<8;i++){await flush();await new Promise<void>(resolve=>setImmediate(resolve));}};
  const records:{bytes:number;body:any;reply:any}[]=[],read=h.reader.read.bind(h.reader) as(...args:any[])=>string;
  t.mock.method(h.reader,'read',(...args:any[])=>{const json=read(...args);records.push({bytes:Buffer.byteLength(json),body:JSON.parse(JSON.stringify(args[2])),reply:expandPeriod(JSON.parse(json))});return json;});
  try{
    for(let i=0;i<68;i++){
      const id=h.store.source('claude',i.toString(16).padStart(24,'0'),NOW-H);h.store.hold(id,h.owner,NOW-H);
      h.store.record(id,{observedAt:NOW-M,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:17,remaining:83,resetAt:NOW+H}]});
    }
    const wallet=h.store.source('openrouter','w'.repeat(24),NOW-H);h.store.hold(wallet,h.owner,NOW-H);
    for(let i=0;i<8;i++){
      const at=NOW-50*M+i*5*M;
      const meter=(id:string,amount:string)=>({id,at,amount,kind:'counter' as const,unit:'USD',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:H,stale:false});
      h.store.record(wallet,{type:'meters',observedAt:at,staleAfterMs:H,meters:[meter('usage',String(i*100_000)),meter('credits','60000000')],keys:[],inventoryComplete:true,inventoryError:null});
    }
    h.settings.money={...h.settings.money,selected:{USD:[[wallet,'balance']]}};
    h.directory.saveView(h.board,{...h.directory.view(h.board),shown:['agents','activity','budget-table','budget-history']},h.owner,NOW);h.events.touchBoards([h.board]);h.events.flush();await settle();
    const financial=h.period.getFinancialProjectionRevision('budget');
    h.store.links.mutate(h.owner,'create',null,{clientId:'opencode',deviceId:null,route:null,sourceId:wallet,from:NOW-H,to:null,expectedRevision:h.store.links.revision(h.owner),requestId:randomUUID()},NOW);h.events.flush();await settle();
    assert.equal(h.period.get().loading,false);assert.equal(h.pool.activeFlights,0);
    assert.equal(h.period.getFinancialProjectionRevision('budget'),financial,'configuration preserves native financial indices');
    for(let i=0;i<3;i++){
      records.length=0;h.requests.length=0;
      h.store.creditWork(h.device,NOW-30_000+i*1000,NOW-29_000+i*1000,[{client:'opencode',source:null,origin:'terminal',startedAt:NOW-M,project:'Linked benchmark',folder:'',identity:{kind:'stable',sessionId:'e'.repeat(32)}}]);h.events.flush();await settle();
      assert.equal(records.length,1,'one coordinated ordinary update');
      const record=records[0];
      assert.ok(record.bytes+1024<=HISTORY_BYTES_PER_MEASUREMENT,`ordinary tick ${i}: ${record.bytes} body bytes leaves room for HTTP headers`);
      for(const scope of ['quota','budget'])if(record.reply[scope]){
        const part=record.reply[scope];assert.equal('known' in part.value,false,'warm internal evidence reuses its metadata token');
        assert.equal(part.value.tape.quota.length+part.value.tape.money.length,0,'an ordinary work tick does not repeat native readings');
      }
      assert.equal(h.period.moneyWorkAt(wallet,NOW).activeMs,(i+1)*1000);
      assert.equal(h.period.getFinancialProjectionRevision('budget'),financial);
    }
  }finally{await h.close();}
});
