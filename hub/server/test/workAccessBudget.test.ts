import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {centralFixture,at} from './centralFixture.js';
import {HistoryTiles,HistoryLimit} from '../history.js';
import {Events} from '../events.js';
import {PeriodReader} from '../periodRead.js';
import {readHistory,ReadError} from '../historyRead.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {PeriodAccounting} from '../domain/periodAccounting.js';
import {createHash} from 'node:crypto';
const M=60_000,H=60*M;

test('captured holdings and route policies reserve their retained maps before allocation',()=>{
 const store=new Store(':memory:',at),directory=new Directory(store.db),owner=directory.createUser('memory@example.com','Memory','fixture',at);
 try{
  for(let i=0;i<300;i++)store.hold(store.source('codex',String(i).padStart(24,'0'),at),owner.id,at);
  const device=directory.saveDevice({userId:owner.id,machine:{id:'fixture',name:'Laptop',os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},at).id;
  store.db.prepare('INSERT INTO device_tracking_policy VALUES (?,?,0)').run(device,'*');
  const reservation=new HistoryTiles(store,8192).reservation();
  try{assert.throws(()=>store.links.batch([owner.id],reservation.add),HistoryLimit);}finally{reservation.close();}
  let bytes=0;const context=store.links.batch([owner.id],size=>bytes+=size);
  assert.equal(context(owner.id,device,'codex').held.size,300);assert.equal(context(owner.id,device,'codex').routeEnabled,false);
  assert.ok(bytes>300*256,'holdings and disabled policies belong to the same captured budget');
 }finally{store.close();}
});

test('the default history ceiling admits context rows before materializing a dense month',t=>{
 const start=Math.floor(Date.now()/(2*H))*2*H-28*24*H,store=new Store(':memory:',start),directory=new Directory(store.db);
 try{
  const owner=directory.createUser('contexts@example.com','Contexts','fixture',start),source=store.source('codex','contexts',start);
  store.hold(source,owner.id,start);
  const device=directory.saveDevice({userId:owner.id,machine:{id:'contexts',name:'Laptop',os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},start).id;
  const count=40000,project='P'.repeat(120),folder='F'.repeat(120);
  const session=store.db.prepare('INSERT INTO agent_sessions(id,device_id,client,source_id,origin,started_at,project,folder,ordinal,producer_id,account_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)'),work=store.db.prepare('INSERT INTO agent_work VALUES(?,?,?)');
  store.db.exec('BEGIN');
  for(let id=1;id<=count;id++){session.run(id,device,'codex',source,'terminal',start+(id-1)*M,project,folder,0,id.toString(16).padStart(32,'0'),'login');work.run(id,start+(id-1)*M,start+id*M);}
  store.db.exec('COMMIT');
  const tiles=new HistoryTiles(store),reservation=tiles.reservation.bind(tiles);let reserved=0,materialized=0,unadmitted=0;
  t.mock.method(tiles,'reservation',()=>{const value=reservation();let own=0;return {add:(bytes:number)=>{value.add(bytes);reserved+=bytes;own+=bytes;},remove:(bytes:number)=>{value.remove(bytes);reserved-=bytes;own-=bytes;},close:()=>{value.close();reserved-=own;own=0;}};});
  const prepare=store.db.prepare.bind(store.db),observe=(rows:number)=>{materialized+=rows;unadmitted=Math.max(unadmitted,materialized*512-reserved);};
  t.mock.method(store.db,'prepare',(sql:string)=>{
   const statement=prepare(sql);if(!sql.startsWith('SELECT s.id,s.client AS clientId'))return statement;
   const all=statement.all.bind(statement),iterate=statement.iterate.bind(statement);
   t.mock.method(statement,'all',(...args:Parameters<typeof all>)=>{const rows=all(...args);observe(rows.length);return rows;});
   t.mock.method(statement,'iterate',function*(...args:Parameters<typeof iterate>){for(const row of iterate(...args)){observe(1);yield row;}});
   return statement;
  });
  const board=directory.boards(owner.id).find(board=>board.personal)!.id;
  assert.throws(()=>tiles.read(board,2*H,start,start+40080*M,Date.now(),store.shown(board,[]),undefined,'quota'),HistoryLimit);
  assert.ok(materialized<count,'over-budget contexts are refused before full native materialization');
  assert.ok(unadmitted<=4096,'a native context batch cannot allocate ahead of its reservation');assert.equal(reserved,0);
 }finally{store.close();}
});

for(const links of [64,128])test(`the default history ceiling bounds ${links} temporal cuts and releases a refused read`,t=>{
 const start=Math.floor(Date.now()/(12*H))*12*H-28*24*H,end=start+28*24*H,store=new Store(':memory:',start),directory=new Directory(store.db);
 try{
  const owner=directory.createUser('fragments@example.com','Fragments','fixture',start),board=directory.boards(owner.id).find(board=>board.personal)!.id;
  const devices=Array.from({length:20},(_,i)=>directory.saveDevice({userId:owner.id,machine:{id:'fragments-'+i,name:'Laptop '+i,os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},start).id);
  const sources=['a','b'].map(account=>store.source('openrouter',account,start));for(const source of sources)store.hold(source,owner.id,start);
  const session=store.db.prepare('INSERT INTO agent_sessions(id,device_id,client,source_id,origin,started_at,project,folder,ordinal,producer_id,account_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)'),work=store.db.prepare('INSERT INTO agent_work VALUES(?,?,?)'),link=store.db.prepare('INSERT INTO client_links VALUES(?,?,?,?,?,?,?,?,?,?)');
  store.db.exec('BEGIN');
  for(let n=0;n<links;n++)link.run('link-'+n,owner.id,'opencode',null,null,null,sources[n%2],start+(end-start)*n/links,start+(end-start)*(n+1)/links,start);
  for(let id=1;id<=2400;id++){session.run(id,devices[(id-1)%20],'opencode',null,'terminal',start,'Project','Folder',0,id.toString(16).padStart(32,'0'),null);work.run(id,start,end);}
  store.db.exec('COMMIT');
  const tiles=new HistoryTiles(store),reservation=tiles.reservation.bind(tiles);let reserved=0;
  t.mock.method(tiles,'reservation',()=>{const value=reservation();let own=0;return {add:(bytes:number)=>{value.add(bytes);reserved+=bytes;own+=bytes;},remove:(bytes:number)=>{value.remove(bytes);reserved-=bytes;own-=bytes;},close:()=>{value.close();reserved-=own;own=0;}};});
  assert.throws(()=>tiles.read(board,12*H,start,end,Date.now(),store.shown(board,[]),undefined,'quota'),HistoryLimit,'small raw input must not admit an unbounded temporal projection');
  assert.equal(reserved,0,'a refused projection releases all request reservations');
  store.db.prepare('DELETE FROM client_links WHERE id NOT IN (?,?)').run('link-0','link-1');
  assert.equal(tiles.read(board,12*H,start,end,Date.now(),store.shown(board,[]),undefined,'quota').length,2,'a smaller projection still succeeds on the same tiles');
  assert.equal(reserved,0);
 }finally{store.close();}
});

async function fixture(t:TestContext,ceiling?:number,devices=1){
 t.mock.method(Date,'now',()=>at+2*H);const h=await centralFixture(),events=new Events(h.hub,undefined,{now:()=>at+2*H,after:()=>()=>{}},null),tiles=new HistoryTiles(h.store,ceiling),period=new PeriodReader(h.hub,tiles,events);
 t.after(async()=>{events.close();await h.app.close();h.store.close();});
 const source=h.store.source('codex','a'.repeat(24),at-M);h.store.hold(source,h.owner.id,at-M);h.store.share(h.board,source,h.owner.id,at-M);
 h.store.record(source,{observedAt:at+15*M,plan:'',staleAfterMs:H,resets:null,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:10,remaining:90,resetAt:at+3*H}]});
 h.store.creditWork(h.device.id,at+10*M,at+20*M,[{source,client:'codex',origin:'terminal',project:'P',folder:'',startedAt:at,identity:{kind:'stable',sessionId:'b'.repeat(32)}}]);
 for(let i=1;i<devices;i++)h.directory.saveDevice({userId:h.owner.id,machine:{id:'extra-machine-'+i,name:'Saved '+i,os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},at-M);
 const calls:boolean[]=[],capture=h.store.workAccess.bind(h.store);t.mock.method(h.store,'workAccess',(...args:Parameters<Store['workAccess']>)=>{calls.push(!!args[2]);return capture(...args);});
 const quota={cell:String(M),from:String(at),to:String(at+H)},body={version:1,selection:{mode:'live',periodMs:2*H},evaluatedAt:at+2*H,sessions:{},quota};
 return {...h,events,tiles,period,source,calls,quota,body};
}

for(const ceiling of [5000,50_000])test(`retained authority names share the ${ceiling} byte read ceiling without a bulk allocation`,async t=>{
 const h=await fixture(t,ceiling),names:{user_id:string;reported:string;name:string}[]=[];
 for(let i=0;i<200;i++){
  const reported='project-'+String(i).padStart(4,'0')+'x'.repeat(100),name='name-'+String(i).padStart(4,'0')+'n'.repeat(105);
  h.store.creditWork(h.device.id,at,at+1000,[{client:'opencode',source:null,origin:'terminal',project:reported,folder:'',startedAt:at,identity:{kind:'stable',sessionId:String(i).padStart(32,'0')}}]);
  h.store.db.prepare('INSERT INTO project_names VALUES (?,?,?)').run(h.owner.id,reported,name);names.push({user_id:h.owner.id,reported,name});
 }
 assert.ok(Buffer.byteLength(JSON.stringify(names))>ceiling,'authority metadata exceeds the requested ceiling although the selected ledger is empty');
 const access=h.store.workAccess(h.board),expected=createHash('sha256').update(JSON.stringify([access.knownFrom,[...access.devices],access.fundingRevision??'',access.attributionRevision??'',[[h.source,at-M,[h.owner.id]]],names,[{id:h.device.id,name:'Laptop'}]])).digest('base64url').slice(0,16);
 assert.equal(h.store.workKey(h.board,undefined,access),expected,'incremental hashing preserves the existing JSON authority namespace');
 const prepare=h.store.db.prepare.bind(h.store.db);
 t.mock.method(h.store.db,'prepare',(sql:string)=>{
  const statement=prepare(sql);
  if(sql.startsWith('SELECT user_id,reported,name FROM project_names')){
   const all=statement.all.bind(statement);
   t.mock.method(statement,'all',(...args:Parameters<typeof all>)=>{const rows=all(...args);assert.ok(Buffer.byteLength(JSON.stringify(rows))<=ceiling,'a native bulk authority allocation must fit the read ceiling');return rows;});
  }
  return statement;
 });
 const body={...h.body,selection:{mode:'live',periodMs:H},quota:undefined,budget:{...h.quota,unit:'USD',meters:'[]'}};
 const reply=JSON.parse(h.period.read(h.board,h.owner.id,body));
 if(ceiling===5000)assert.deepEqual(reply.sessions,{state:'error',error:'history_limit'},'authority overflow is a normal dependent-section error');
 else {assert.equal(reply.sessions.state,'complete');assert.deepEqual(reply.sessions.value.refs,[],'streaming all retained names does not enlarge the selected cohort');}
 assert.equal(reply.budget.state,'complete','independent financial sections survive authority failure');
 const reservation=h.tiles.reservation();try{reservation.add(ceiling);}finally{reservation.close();}
 if(ceiling===5000){assert.throws(()=>readHistory(h.hub,h.tiles,h.events,h.board,h.owner.id,h.quota),(error:unknown)=>error instanceof ReadError&&error.statusCode===413&&error.code==='history_limit');}
});

test('composite quota, closed tile keys, metadata and tape share one reserved access snapshot',async t=>{
 const h=await fixture(t);let cells=0;const read=h.store.cells.bind(h.store);t.mock.method(h.store,'cells',(...args:Parameters<Store['cells']>)=>{cells++;return read(...args);});
 for(let i=0;i<2;i++){h.calls.length=0;const reply=JSON.parse(h.period.read(h.board,h.owner.id,h.body));assert.equal(reply.sessions.state,'complete');assert.equal(reply.quota.state,'complete');assert.deepEqual(h.calls,[true],'closed cache hits and misses reuse exactly the captured reserved map');}
 assert.equal(cells,1,'the second read remains a closed tile hit');
 h.calls.length=0;const standalone=JSON.parse(readHistory(h.hub,h.tiles,h.events,h.board,h.owner.id,h.quota));assert.ok(standalone.known.sessions!==null);assert.deepEqual(h.calls,[true],'standalone metadata and cells share their bounded capture');
});

test('a failed work capture errors every dependent section without fallback allocation and releases independent siblings',async t=>{
 const h=await fixture(t,5000,101),budget={...h.quota,unit:'USD',meters:'[]'};
 const reply=JSON.parse(h.period.read(h.board,h.owner.id,{...h.body,quota:{...h.quota,cells:'skip'},budget}));assert.deepEqual(h.calls,[true],'failure cannot rebuild an unreserved snapshot');
 for(const scope of ['sessions','quota'])assert.deepEqual(reply[scope],{state:'error',error:'history_limit'},scope);
 assert.equal(reply.budget.state,'complete');assert.equal(JSON.parse(h.period.read(h.board,h.owner.id,{...h.body,sessions:undefined,quota:undefined,budget})).budget.state,'complete','all failed reservations release on exit');
 h.calls.length=0;assert.throws(()=>readHistory(h.hub,h.tiles,h.events,h.board,h.owner.id,h.quota),(e:unknown)=>e instanceof ReadError&&e.statusCode===413&&e.code==='history_limit');assert.deepEqual(h.calls,[true]);
 h.calls.length=0;assert.throws(()=>h.tiles.read(h.board,M,at,at+H,at+2*H,h.store.shown(h.board,[])),HistoryLimit);assert.deepEqual(h.calls,[true],'direct closed-tile reads also honor the request ceiling');
 const reservation=h.tiles.reservation();try{reservation.add(5000);}finally{reservation.close();}
});

for(const overflow of [false,true])test(`actual database changes revalidate work through a reserved current snapshot ${overflow?'and fail bounded':'before retrying a revoke'}`,async t=>{
 const ceiling=overflow?10_000:32*1024*1024,h=await fixture(t,ceiling),original=PeriodAccounting.prepare;let changes=0;
 t.mock.method(PeriodAccounting,'prepare',function*(...args:Parameters<typeof original>){
   if(changes++===0)setImmediate(()=>{
     const policy=h.store.sessionDevices(h.board,h.owner.id)[0];h.store.setDeviceSessions(h.board,h.device.id,h.owner.id,false,policy.revision,at+2*H);
     if(overflow)for(let i=0;i<100;i++)h.directory.saveDevice({userId:h.owner.id,machine:{id:'late-machine-'+i,name:'Late '+i,os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},at+2*H);
   });
   const until=performance.now()+12;do{yield;}while(performance.now()<until);return yield*original(...args);
 });
 const body={...h.body,selection:{mode:'range',from:at,to:at+H},quota:{...h.quota,cells:'skip'}};
 if(overflow)await assert.rejects(h.period.readAsync(h.board,h.owner.id,body),(e:unknown)=>e instanceof ReadError&&e.statusCode===413&&e.code==='history_limit');
 else{const result=JSON.parse(await h.period.readAsync(h.board,h.owner.id,body));assert.equal(result.sessions.state,'complete');assert.deepEqual(result.sessions.value.refs,[],'revoked captured access is never reused by the current guard');}
 assert.ok(h.calls.length>=2);assert.ok(h.calls.every(Boolean),'each actual-change revalidation is bounded');const reservation=h.tiles.reservation();try{reservation.add(ceiling);}finally{reservation.close();}
});
