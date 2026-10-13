import {test} from 'node:test';
import assert from 'node:assert/strict';
import {centralFixture as fixture,at} from '../../server/test/centralFixture.js';
import {expandPeriod,type PeriodWireReply} from '../../server/domain/periodWire.js';
import {PeriodActivity} from '../../server/domain/periodActivity.js';
import {readHistory} from '../../server/test/historyRead.js';
import {activityEmpty} from '../lib/activity';
import {agentActivityValue} from '../lib/agents';

const M=60_000;

for(const retained of [false,true])test(`all managed devices OFF makes sessions unavailable with a disconnected ${retained?'retained':'unused'} device`,async t=>{
 const now=at+2*M;t.mock.method(Date,'now',()=>now);const h=await fixture();t.after(async()=>{await h.app.close();h.store.close();});
 const machine={id:'old-machine-0123456789',name:'Old',os:'linux',arch:'x86_64'},old=h.directory.saveDevice({userId:h.owner.id,machine,agent:'fixture',tokenId:null},at);
 if(retained)h.store.creditWork(old.id,at,at+1000,[{client:'opencode',source:null,origin:'terminal',project:'Old',folder:'',startedAt:at,identity:{kind:'stable',sessionId:'c'.repeat(32)}}]);
 h.directory.revokeDevice(h.owner.id,old.id,at+1000);
 const shares=`/api/boards/${h.board}/shares`,period=`/api/boards/${h.board}/period`,body={version:1,selection:{mode:'live',periodMs:60*M},evaluatedAt:now,sessions:{}};
 const policies=(await h.call('GET',shares)).json().sessionDevices;assert.equal(policies.length,retained?2:1);
 if(retained){
  const initial=expandPeriod((await h.call('POST',period,body)).json<PeriodWireReply>());if(initial.sessions?.state!=='complete')throw new Error('missing retained device work');
  assert.equal(new PeriodActivity(initial.sessions.value).summary(initial.basis.range,'project').agentMs,1000,'disconnected retained work stays admitted and manageable');
 }
 for(const p of policies)assert.equal((await h.call('PUT',shares+`/devices/${p.id}/sessions`,{enabled:false,expectedRevision:p.revision})).statusCode,200);
 assert.ok((await h.call('GET',shares)).json().sessionDevices.every((p:{enabled:boolean})=>!p.enabled));
 const first=expandPeriod((await h.call('POST',period,body)).json<PeriodWireReply>());if(first.sessions?.state!=='complete')throw new Error('missing unavailable baseline');
 const trace=first.sessions.value,summary=new PeriodActivity(trace).summary(first.basis.range,'project');
 assert.equal(trace.available,false,'an invisible unused revoked device cannot manufacture session coverage');assert.equal(summary.known,null);
 assert.equal(agentActivityValue(summary,'project','active'),null);assert.deepEqual(activityEmpty({since:first.basis.range.from,activity:summary},0),{key:'noSessions'});
 assert.equal(h.store.workAccess(h.board).devices.size,0);
 const key=h.store.workKey(h.board),funding=h.store.workAccess(h.board).fundingRevision,source=h.store.source('codex','9'.repeat(24),at);
 h.store.hold(source,h.owner.id,at);h.store.share(h.board,source,h.owner.id,at);
 for(const time of [at,now-1])h.store.record(source,{observedAt:time,plan:'pro',staleAfterMs:3*M,resets:null,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:10,remaining:90,resetAt:null}]});
 assert.equal(h.store.workAccess(h.board).fundingRevision,funding,'unadmitted devices create no funding dependency');assert.equal(h.store.workKey(h.board),key);
 const next=expandPeriod((await h.call('POST',period,{...body,sessions:{cursor:trace.cursor},quota:{cell:String(M),from:String(at),to:String(now)}})).json<PeriodWireReply>());
 assert.equal(next.sessions?.state,'delta','unrelated quota grants preserve the unavailable session cursor');if(next.quota?.state!=='complete')throw new Error('missing independent quota');
 assert.equal(next.quota.value.chunks[0].activity.sessions.length,0);assert.equal(next.quota.value.tape!.quota[0].workFrom,null);
 const legacy=readHistory(h.store,h.board,at,M,{to:now});assert.equal(legacy.activity.available,false);assert.equal(legacy.series[0].work,null);
 if(!retained){
  const connected=h.directory.saveDevice({userId:h.owner.id,machine,agent:'fixture',tokenId:null},now);assert.equal(connected.id,old.id);
  const on=(await h.call('GET',shares)).json().sessionDevices.find((p:{id:string})=>p.id===old.id);assert.equal(on.enabled,true,'connected unused devices inherit ON');
  const empty=expandPeriod((await h.call('POST',period,body)).json<PeriodWireReply>());if(empty.sessions?.state!=='complete')throw new Error('missing connected baseline');assert.notEqual(empty.sessions.value.available,false);
  const off=(await h.call('PUT',shares+`/devices/${old.id}/sessions`,{enabled:false,expectedRevision:on.revision})).json().device;
  h.directory.revokeDevice(h.owner.id,old.id,now);h.directory.saveDevice({userId:h.owner.id,machine,agent:'fixture',tokenId:null},now+1);
  assert.deepEqual((await h.call('GET',shares)).json().sessionDevices.find((p:{id:string})=>p.id===old.id),off,'same-ID reconnect preserves the saved OFF policy');
 }
});
