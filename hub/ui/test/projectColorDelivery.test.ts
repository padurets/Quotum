import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {centralFixture,at} from '../../server/test/centralFixture.js';
import {Events,polled,sse,type Frame,type PollAnswer} from '../../server/events.js';
import {config} from '../../server/config.js';
import {KEEP_MS} from '../../server/sessions.js';
import {newSecret} from '../../server/domain/auth.js';
import {saveProjectColors} from '../../server/store/projectColors.js';
import {projectColorsOf} from '../../server/projectColors.js';
import {tileEnd,tileOf,type Chunk} from '../../server/domain/history.js';
import {CATEGORY_COLORS,type CategoryColor} from '../../server/domain/categoryColors.js';
import {HistoryStore,follow} from '../lib/history';
import {createStore} from '../lib/store';
import {INITIAL,reduce,type HubEvent} from '../lib/board';

const M=60_000;
const settle=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const bytes=(frames:Frame[])=>Math.max(Buffer.byteLength(sse(frames)),Buffer.byteLength(polled(frames)));
const wireBytes=(answer:PollAnswer)=>Math.max(Buffer.byteLength(sse(answer.frames)),Buffer.byteLength(JSON.stringify({lease:answer.lease,now:answer.now,events:JSON.parse(polled(answer.frames))})));
async function fixture(t:TestContext,bufferBytes=config.events.bufferBytes){
  let now=at+M;t.mock.method(Date,'now',()=>now);
  const f=await centralFixture();await f.app.close();
  const options={...config.events,recheckMs:0,bufferBytes},events=new Events(f.hub,options,{now:()=>now,after:()=>()=>{}},null);events.attach();
  const secret=newSecret('qt_s');f.directory.createSession(secret,f.owner.id,now,86_400_000);
  const reader={user:f.owner.id,secret,board:f.board};
  t.after(()=>{events.close();f.store.close();});
  const credit=(from:number,to:number,projects=['Work'])=>f.store.creditWork(f.device.id,from,to,projects.map((project,i)=>({source:null,client:'opencode',origin:'terminal' as const,startedAt:at,project,folder:'',identity:{kind:'legacy' as const,ordinal:i}})));
  const live=(count=1)=>f.hub.ingest.live.report(f.device.id,f.owner.id,Array.from({length:count},(_,i)=>({clientId:'opencode',sessionId:null,source:null,origin:'terminal' as const,project:'Expiring live',folder:'😀'.repeat(120),startedAt:at+i,sentStartedAt:at+i,lastWorkedAt:null,working:false,device:{id:f.device.id,name:'Laptop'},accountBy:null,route:null})),now);
  const pins=(names:string[],color:CategoryColor=CATEGORY_COLORS[0])=>{saveProjectColors(f.store.db,f.board,names.map(name=>[name,color]),f.owner.id,now);f.store.projectColorsChanged(f.board);};
  const poll=async(lease?:string)=>{const answer=await events.poll(reader,lease);assert.ok(answer&&answer!=='limit');return answer;};
  return {...f,events,options,reader,credit,live,pins,poll,advance:()=>{now+=KEEP_MS+1;}};
}

function cache(t:TestContext,f:Awaited<ReturnType<typeof fixture>>){
  const clientNow=Date.now(),queries:{from:number;to:number}[]=[],page=createStore(reduce,INITIAL);
  const loader=new HistoryStore({now:()=>clientNow,read:async(_board,cell,from,to)=>{
    queries.push({from,to});const chunks:Chunk[]=[];
    for(let start=from;start<to;){const end=Math.min(to,tileEnd(tileOf(start,cell),cell));chunks.push({from:start,to:end,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[]});start=end;}
    return {run:f.events.epoch,now:clientNow,historyStart:at-M,known:{work:at-M,sources:{}},chunks};
  },setTimeout:()=>null,clearTimeout:()=>{},dropTimeRange:()=>{}},undefined,'quota');
  loader.choose('1h',{from:at-60*M,to:at+M});const stop=follow(loader,page);t.after(()=>{stop();loader.close();});
  page.dispatch({type:'board-open',id:f.board});
  const feed=(frames:Frame[])=>{for(const packet of frames)if(packet.type!=='ping'&&packet.type!=='bye')page.dispatch({type:'hub',event:{type:packet.type,data:JSON.parse(packet.data)} as HubEvent});};
  return {loader,page,queries,feed};
}

for(const mode of ['before-take','after-preparation','later-queued-history'] as const)test(`replacement preserves actual cached work invalidation ${mode}`,async t=>{
  const f=await fixture(t);f.credit(at,at+M/2);const c=cache(t,f),first=await f.poll();
  c.feed(f.events.deliverPoll(first).frames);await settle();assert.equal(c.queries.length,1);assert.ok(c.loader.estimatedBytes>0);
  const baseline=c.page.get().board!;f.live();
  if(mode!=='later-queued-history')f.credit(at+M/2,at+M);
  f.events.flush();if(mode==='before-take')f.advance();
  const prepared=await f.poll(first.lease);
  if(mode==='later-queued-history'){
    assert.equal(prepared.frames.some(packet=>packet.type==='history'),false);
    f.credit(at+M/2,at+M);f.events.flush();
  }
  if(mode!=='before-take')f.advance();
  const answer=f.events.deliverPoll(prepared);c.feed(answer.frames);await settle();
  assert.equal(JSON.stringify(answer.frames).includes('Expiring live'),false);
  assert.equal(c.page.get().board!.workAuthority,baseline.workAuthority);assert.equal(c.page.get().board!.cards,baseline.cards);
  assert.equal(c.queries.length,2,'the real HistoryStore refills dirty cached cells after the replacement');
  assert.ok(c.queries[1].from>=at,'clean earlier cells remain cached');
  assert.ok(c.queries[1].to<=c.queries[0].to);
  const history=JSON.parse(answer.frames.find(packet=>packet.type==='history')!.data);
  assert.equal(history.workSince,at+M/2);assert.equal(history.workAuthority,baseline.workAuthority);
});

test('ordinary colour changes leave the actual history cache clean',async t=>{
  const f=await fixture(t);f.credit(at,at+M/2);const c=cache(t,f),first=await f.poll();c.feed(f.events.deliverPoll(first).frames);await settle();
  f.pins(['Work']);f.events.flush();const answer=f.events.deliverPoll(await f.poll(first.lease));c.feed(answer.frames);await settle();
  assert.equal(c.queries.length,1);assert.equal(answer.frames.some(packet=>packet.type==='snapshot'||packet.type==='history'),false);
});

test('replacement keeps admitted source data while revoking independent financial and work news',async t=>{
  const f=await fixture(t),now=Date.now();
  const kept=f.store.source('codex','a'.repeat(24),now),removed=f.store.source('codex','b'.repeat(24),now);
  for(const source of [kept,removed]){f.store.hold(source,f.owner.id,now);f.store.share(f.board,source,f.owner.id,now,true);}
  const first=await f.poll();f.live();
  for(const source of [kept,removed])f.events.history(source,at,['quota','budget']);
  f.events.clientHistory(f.owner.id,at);f.events.flush();const prepared=await f.poll(first.lease);
  f.store.unshare(f.board,removed);const budget=f.store.sources(f.board).find(source=>source.id===kept)!.budget!;
  f.store.setBudget(f.board,kept,f.owner.id,false,budget.revision,now);
  const device=f.store.sessionDevices(f.board,f.owner.id)[0];f.store.setDeviceSessions(f.board,f.device.id,f.owner.id,false,device.revision,now);
  const answer=f.events.deliverPoll(prepared),packet=answer.frames.find(packet=>packet.type==='history');
  assert.ok(packet,'authorized quota invalidation survives replacement');const history=JSON.parse(packet.data);
  assert.deepEqual(history.sources,[kept]);assert.deepEqual(history.changes,[{source:kept,scope:'quota',since:at}]);
  assert.equal(history.workSince,undefined);assert.equal(history.workAuthority,f.store.workKey(f.board));
  assert.equal(JSON.stringify(answer.frames).includes(removed),false);assert.equal(JSON.stringify(answer.frames).includes('Expiring live'),false);
});

test('incremental palettes compact before expansion and preserve independent history below the wire budget',async t=>{
  const f=await fixture(t,70*1024),names=['Work',...Array.from({length:88},(_,i)=>String.fromCharCode(i+1)+'\u0001'.repeat(119))];f.credit(at,at+M,names);
  const first=await f.poll();
  for(let i=0;i<20;i++){f.pins(['Work'],CATEGORY_COLORS[i%2]);f.events.flush();}
  f.events.clientHistory(f.owner.id,at+M/2);f.pins(names);f.events.flush();
  const answer=f.events.deliverPoll(await f.poll(first.lease));
  assert.equal(answer.frames.filter(packet=>packet.type==='projectColors').length,1);
  assert.equal(answer.frames.filter(packet=>packet.type==='board').length,1);
  const colors=JSON.parse(answer.frames.find(packet=>packet.type==='projectColors')!.data),board=JSON.parse(answer.frames.find(packet=>packet.type==='board')!.data);
  assert.equal(colors.pins.length,89);assert.deepEqual(colors,projectColorsOf(f.hub).context(f.board).envelope);
  assert.equal(board.projectColorsRevision,colors.revision);assert.equal(board.projectColorsAuthority,colors.authority);
  assert.ok(wireBytes(answer)<=f.options.bufferBytes);assert.equal(answer.frames.some(packet=>packet.type==='bye'),false);
  assert.equal(JSON.parse(answer.frames.find(packet=>packet.type==='history')!.data).workSince,at+M/2);
});

test('late palette expansion respects actual encoded frames and releases an overflowing lease',async t=>{
  const f=await fixture(t,80*1024),names=['Work',...Array.from({length:88},(_,i)=>String.fromCharCode(i+1)+'\u0001'.repeat(119))];f.credit(at,at+M,names);
  const first=await f.poll();f.live(80);f.events.flush();const prepared=await f.poll(first.lease);
  assert.ok(bytes(prepared.frames)<f.options.bufferBytes);f.pins(names);
  const answer=f.events.deliverPoll(prepared);
  assert.deepEqual(answer.frames,[{type:'bye',data:'{"reason":"limit"}'}]);assert.equal(f.events.readers,0);
});

test('unchanged-authority final answers are byte checked while the initial browser baseline keeps its exception',async t=>{
  const f=await fixture(t,2048),first=await f.poll();
  assert.ok(bytes(first.frames)>f.options.bufferBytes,'only the initial browser baseline has the established exception');
  assert.equal(f.events.deliverPoll(first),first);
  f.live();f.events.flush();const prepared=await f.poll(first.lease);assert.ok(bytes(prepared.frames)<f.options.bufferBytes);
  f.options.bufferBytes=bytes(prepared.frames)-1;
  assert.deepEqual(f.events.deliverPoll(prepared).frames,[{type:'bye',data:'{"reason":"limit"}'}]);
});

test('a replacement snapshot cannot borrow the initial-answer byte exception',async t=>{
  const f=await fixture(t,2048),first=await f.poll();f.live();f.events.flush();
  const prepared=await f.poll(first.lease);assert.ok(bytes(prepared.frames)<f.options.bufferBytes);f.advance();
  assert.deepEqual(f.events.deliverPoll(prepared).frames,[{type:'bye',data:'{"reason":"limit"}'}]);
});

test('the final poll budget includes the lease and timestamp JSON envelope',async t=>{
  const f=await fixture(t),first=await f.poll();f.live();f.events.flush();const prepared=await f.poll(first.lease);
  assert.ok(wireBytes(prepared)>bytes(prepared.frames));f.options.bufferBytes=wireBytes(prepared)-1;
  assert.ok(bytes(prepared.frames)<=f.options.bufferBytes,'the events array alone still fits');
  assert.deepEqual(f.events.deliverPoll(prepared).frames,[{type:'bye',data:'{"reason":"limit"}'}]);
});
