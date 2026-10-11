import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {context,locked} from '../../tooling/dev/system.mjs';

// Fixed synthetic observations; no accounts, clients or provider transports run.
for(const name of Object.keys(process.env))if(name.startsWith('QUOTUM_'))delete process.env[name];
const day=86400000,minute=60000,from=Date.UTC(2026,8,1),to=from+30*day;
const timestamp=Date.now;Date.now=()=>to+day;
const candidate=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const controlArg=process.argv.indexOf('--control');
if(controlArg<0||!process.argv[controlArg+1])throw new Error('Usage: node --import tsx bench/month.mjs --control <archived control root>');
const control=resolve(process.argv[controlArg+1]);
async function fixture(root){
const read=name=>import(pathToFileURL(join(root,'hub',name)).href);
const {Store}=await read('server/store/store.ts');
const {Directory}=await read('server/store/directory.ts');
const {HistoryTiles}=await read('server/history.ts');
const {cellOf}=await read('server/domain/history.ts');
const store=new Store(':memory:',from),dir=new Directory(store.db);
const users=Array.from({length:10},(_,i)=>dir.createUser('fixture-'+i+'@example.com','Fixture '+i,'synthetic',from));
const devices=users.flatMap((u,i)=>Array.from({length:2},(_,j)=>({user:u.id,device:dir.saveDevice({userId:u.id,machine:{id:'fixture-device-'+i+'-'+j,name:'Fixture '+i+' '+j,os:'linux',arch:'x86_64'},agent:'quotum/0.7.0',tokenId:null},from).id,index:i*2+j})));
const sources=['claude','claude','codex','codex','antigravity','openrouter'].map((p,i)=>store.source(p,'fixture-source-'+i,from));
const board=dir.createBoard('Fixture',users[0].id,from).id;
const member=store.db.prepare('INSERT OR IGNORE INTO members VALUES (?,?,?,?)');
store.db.exec('BEGIN');
for(const u of users){member.run(board,u.id,'member',from);for(const s of sources)store.hold(s,u.id,from);}
for(const s of sources)store.share(board,s,users[0].id,from);
const session=store.db.prepare('INSERT INTO agent_sessions(id,device_id,client,source_id,origin,started_at,project,folder,ordinal,producer_id,account_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
const work=store.db.prepare('INSERT INTO agent_work VALUES(?,?,?)');
let id=0;
for(const d of devices)for(let n=0;n<30;n++)for(const [k,client] of ['claude','codex','antigravity','opencode'].entries()){
 const source=k===3?null:sources[k===0?(d.index%2):k===1?2+(d.index%2):4];
 const start=from+n*day+8*3600000,project='project-'+((d.index+k)%12);
 session.run(++id,d.device,client,source,'terminal',start,project,'',0,'fixture-'+d.index+'-'+n+'-'+k,'login');
 for(let p=0;p<36;p++){const at=start+p*10*minute;work.run(id,at,at+5*minute);}
}
const sample=store.db.prepare('INSERT INTO samples(source_id,window_id,at,used,reset_at,minutes,kind,label,stale_after_ms) VALUES(?,?,?,?,?,?,?,?,?)');
for(const s of sources.slice(0,5))for(let n=0;n<720;n++)for(const [w,h] of [['session',5],['weekly',168]]){const at=from+n*3600000;sample.run(s,w,at,(n%h)*100/h,from+(Math.floor(n/h)+1)*h*3600000,h*60,w,null,7200000);}
store.db.exec('COMMIT');

const digest=store.db.prepare('SELECT s.client,s.source_id,s.project,w.from_at,w.to_at FROM agent_work w JOIN agent_sessions s ON s.id=w.session_id ORDER BY w.session_id,w.from_at').all();
assert.equal(id,2400);assert.equal(digest.length,86400);
const sha256=createHash('sha256').update(JSON.stringify(digest)).digest('hex');
assert.equal(sha256,'2392a75bc41467b073c58bcf2bcb0af01b3a796786d5a5edbf4a75b63ec8a2f4');
assert.equal(store.db.prepare('SELECT count(*) AS n FROM samples').get().n,7200);
const personal=dir.boards(users[0].id).find(b=>b.personal).id,shown=store.shown(board,[]),cell=cellOf(to-from),cache=new HistoryTiles(store);
const wallet=sources[5],meter=(id,at,amount)=>({id,at,amount,kind:'counter',unit:'USD',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:7200000,stale:false});
for(let n=0;n<720;n++)store.record(wallet,{type:'meters',observedAt:from+n*3600000,staleAfterMs:7200000,meters:[meter('credits',from+n*3600000,'1000000000'),meter('usage',from+n*3600000,String(n*1000000))],keys:[],inventoryComplete:true,inventoryError:null});
const selection={ids:[[wallet,'balance']],unit:'USD'};
const [{buildApp},{Ingest},{Duty},{Cadence},{Pairing},{Setup},{ResetFeed},{Events},{newSecret}]=await Promise.all(['api.ts','ingest.ts','duty.ts','cadence.ts','pairing.ts','setup.ts','resets.ts','events.ts','domain/auth.ts'].map(name=>read('server/'+name)));
const hub={store,directory:dir,ingest:new Ingest(store,dir,new Duty(),new Cadence()),pairing:new Pairing(dir),setup:new Setup(false,null),resets:new ResetFeed(undefined,()=>{}),local:null};
const events=new Events(hub);hub.events=events;
const app=await buildApp(hub),secret=newSecret('qt_s');dir.createSession(secret,users[0].id,to+day,day);
const url='/api/history?'+new URLSearchParams({board,cell:String(cell),from:String(from),to:String(to),scope:'quota'});
const http=async()=>{const reply=await app.inject({url,headers:{cookie:'quotum_session='+secret}});assert.equal(reply.statusCode,200,reply.body.slice(0,200));return reply.body;};
await http();
const paths=[
 ['shared agentWork',()=>store.agentWork(from,to,[...shown.keys()])],
 ['personal agentWork',()=>store.agentWork(from,to,[...shown.keys()],users[0].id)],
 ['shared cold quota JSON',()=>new HistoryTiles(store).read(board,cell,from,to,to+day,shown,undefined,'quota')],
 ['shared warm quota JSON',()=>cache.read(board,cell,from,to,to+day,shown,undefined,'quota')],
 ['personal cold quota JSON',()=>new HistoryTiles(store).read(personal,cell,from,to,to+day,store.shown(personal,[]),undefined,'quota')],
 ['authenticated cold quota HTTP',http,()=>{for(const source of sources)events.onHistory(source,from,['quota']);}],
 ['authenticated warm quota HTTP',http],
 ['cold pure financial JSON',()=>new HistoryTiles(store).read(board,cell,from,to,to+day,shown,selection,'budget')],
 ['warm pure financial JSON',()=>cache.read(board,cell,from,to,to+day,shown,selection,'budget')]
];
return {store,dir,users,devices,sources,board,cell,shown,paths,sha256,close:async()=>{await app.close();store.close();}};
}
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
async function paired(a,b,label){
const reports=[];
for(let p=0;p<a.paths.length;p++){
 const samples=[[],[]],fixtures=[a,b];let output;
 for(let n=0;n<5;n++)for(const f of fixtures){const [,read,before]=f.paths[p];before?.();await read();}
 for(let n=0;n<25;n++)for(const index of n%2?[1,0]:[0,1]){
  const [,read,before]=fixtures[index].paths[p];before?.();const at=performance.now();const value=await read();samples[index].push(performance.now()-at);if(index===1)output=Array.isArray(value)?value.length:Buffer.byteLength(value);
 }
 const stats=samples.map(values=>({medianMs:percentile(values,.5),p95Ms:percentile(values,.95)}));
 const ratios={median:stats[1].medianMs/stats[0].medianMs,p95:stats[1].p95Ms/stats[0].p95Ms};
 const row={name:a.paths[p][0],control:stats[0],candidate:stats[1],ratios,pass:ratios.median<=1.20&&ratios.p95<=1.20,output,samples};
 reports.push(row);console.error(JSON.stringify({cohort:label,...row,samples:undefined}));
}
return {cohort:label,reports,pass:reports.every(r=>r.pass)};
}
function dense(f){
 const before=f.store.db.prepare('SELECT s.client,s.source_id,s.project,w.from_at,w.to_at FROM agent_work w JOIN agent_sessions s ON s.id=w.session_id ORDER BY w.session_id,w.from_at').all();
 for(const [i,u]of f.users.entries())for(const deviceId of [null,...f.devices.filter(d=>d.user===u.id).map(d=>d.device)])for(const [k,clientId]of ['claude','codex','antigravity','opencode'].entries())for(const route of [null,{class:'subscription',provider:null},{class:'api',provider:null},{class:'unknown',provider:null},{class:'api',provider:'openrouter'}])for(let half=0;half<2;half++){
  const sourceId=route?.class==='api'||k===3?f.sources[5]:f.sources[k===0?i%2:k===1?2+i%2:4];
  f.store.links.mutate(u.id,'create',null,{clientId,deviceId,route,sourceId,from:from+half*15*day,to:from+(half+1)*15*day,requestId:randomUUID(),expectedRevision:f.store.links.revision(u.id)},to+day);
 }
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM client_links').get().n,1200);
 assert.deepEqual(f.store.db.prepare('SELECT s.client,s.source_id,s.project,w.from_at,w.to_at FROM agent_work w JOIN agent_sessions s ON s.id=w.session_id ORDER BY w.session_id,w.from_at').all(),before);
 const spans=f.store.agentWork(from,to,[...f.shown.keys()]);
 assert.equal(spans.length,86400);assert.equal(spans.reduce((ms,s)=>ms+s.to-s.from,0),86400*5*minute);
}
function semantics(f){
 const owner=f.users[0].id,device=f.devices[0].device,at=from+15*day+8*3600000,cut=at+150000;
 const rule=f.store.links.list(owner).find(link=>link.deviceId===device&&link.clientId==='claude'&&link.route===null&&link.from===from+15*day);
 assert.ok(rule);
 f.store.links.mutate(owner,'correct',rule.id,{...rule,sourceId:f.sources[5],from:cut,expectedRevision:f.store.links.revision(owner),requestId:randomUUID()},to+day);
 const context=f.store.db.prepare('SELECT id FROM agent_sessions WHERE device_id=? AND client=? AND started_at=?').get(device,'claude',at).id;
 const parts=f.store.agentWork(at,at+5*minute,[...f.shown.keys()]).filter(span=>span.session===context);
 assert.deepEqual(parts.map(span=>[span.source,span.from,span.to]),[[f.sources[0],at,cut],[f.sources[5],cut,at+5*minute]]);
 // The same retained producer has distinct subscription and API contexts; neither
 // route nor a temporal display cut changes the ledger's account or identity.
 const codex=f.store.db.prepare('SELECT id,source_id FROM agent_sessions WHERE device_id=? AND client=? AND started_at=?').get(device,'codex',at);
 f.store.db.prepare("UPDATE agent_sessions SET route_class='api',route_by='session',route_host='openrouter.ai',route_provider='openrouter' WHERE id=?").run(codex.id);
 assert.equal(f.store.agentWork(at,at+5*minute,[...f.shown.keys()]).find(span=>span.session===codex.id).source,f.sources[5]);
 f.store.db.prepare("UPDATE agent_sessions SET route_class='subscription',route_host=NULL,route_provider=NULL WHERE id=?").run(codex.id);
 assert.equal(f.store.agentWork(at,at+5*minute,[...f.shown.keys()]).find(span=>span.session===codex.id).source,f.sources[2]);
 assert.equal(f.store.db.prepare('SELECT source_id FROM agent_sessions WHERE id=?').get(codex.id).source_id,codex.source_id);
 const digest=f.store.db.prepare('SELECT s.client,s.source_id,s.project,w.from_at,w.to_at FROM agent_work w JOIN agent_sessions s ON s.id=w.session_id ORDER BY w.session_id,w.from_at').all();
 assert.equal(createHash('sha256').update(JSON.stringify(digest)).digest('hex'),f.sha256);
 const spans=f.store.agentWork(from,to,[...f.shown.keys()]);
 assert.equal(spans.length,86401);assert.equal(spans.reduce((ms,span)=>ms+span.to-span.from,0),86400*5*minute);
 assert.equal(new Set(spans.map(span=>span.session)).size,2400);
 return {midStretchCut:true,mixedRoutes:true,rawDigestUnchanged:true,contexts:2400,fragments:86401};
}
try{
 await locked(join(context(candidate).shared,'heavy.lock'),async()=>{
  const a=await fixture(control),b=await fixture(candidate);
  try{
   assert.equal(a.sha256,b.sha256);
   const plain=await paired(a,b,'legacy');
   dense(b);const semantic=semantics(b),linked=await paired(a,b,'dense');
   console.log(JSON.stringify({dataset:{from,to,owners:10,devices:20,clients:4,contexts:2400,stretches:86400,quotaSamples:7200,cell:7200000,tiles:7,sha256:a.sha256},semantic,warmups:5,takes:25,node:process.version,cohorts:[plain,linked],pass:plain.pass&&linked.pass}));
   if(!plain.pass||!linked.pass)process.exitCode=1;
  }finally{await a.close();await b.close();}
 });
}finally{Date.now=timestamp;}
