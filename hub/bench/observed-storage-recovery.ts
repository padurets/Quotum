// Actual CLI/Runner, native stand-ins and ENOSPC, against HTTP and SQLite.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
// Ignore preview configuration before any server module reads its environment.
for(const key of Object.keys(process.env))if(/^(QUOTUM_|DEV_|PUBLIC_DOMAIN$)/.test(key))delete process.env[key];
const [{buildApp},{Cadence},{newSecret},{Duty},{Ingest},{Pairing},{ResetFeed},{Setup},{Directory},{Store}]=await Promise.all([
  import('../server/api.js'),
  import('../server/cadence.js'),
  import('../server/domain/auth.js'),
  import('../server/duty.js'),
  import('../server/ingest.js'),
  import('../server/pairing.js'),
  import('../server/resets.js'),
  import('../server/setup.js'),
  import('../server/store/directory.js'),
  import('../server/store/store.js')
]);

const repo=path.resolve('..');
const fixed=path.resolve(process.argv[2]??'../agent/target/release/quotum');
const baseline=process.argv[3]&&path.resolve(process.argv[3]);
const probe=path.join(path.dirname(fixed),'examples/observed_probe');
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
type Status={pid:number;alive:boolean;capture:boolean;failures:number;recoveries:number;recovering:boolean;at:number;cpuMs:number;
  queue:null|{id:string;next:number;ack:number;end:null|number}};
type Frame={seq:number;captureEpoch:string;fromAt:number;toAt:number;complete:boolean};

async function scenario(mode:'baseline'|'capture'|'initial'){
  const root=mkdtempSync(path.join(tmpdir(),'quotum-storage-http-'));
  const store=new Store(path.join(root,'hub.sqlite'),Date.now()),directory=new Directory(store.db);
  const user=directory.createUser('fixture@example.com','Fixture','unused',Date.now()),secret=newSecret('qt_m');
  directory.createToken(secret,'…',user.id,'fixture',Date.now());
  const frames=new Map<number,{hash:string;frame:Frame}>();
  const checkins:number[]=[];
  const app=await buildApp({store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),pairing:new Pairing(directory),resets:new ResetFeed(undefined,()=>{}),setup:new Setup(false,''),local:null},async app=>{
  app.addHook('preHandler',async request=>{
    if(request.url==='/v1/checkin')checkins.push(Date.now());
    const body=request.body as {op?:string;frames?:Frame[]}|null;
    if(request.url==='/v1/activity'&&body?.op==='batch')for(const frame of body.frames??[]){
      const digest=createHash('sha256').update(JSON.stringify(frame)).digest('hex');
      assert.ok(!frames.has(frame.seq)||frames.get(frame.seq)!.hash===digest,'a retry changed its immutable frame');
      frames.set(frame.seq,{hash:digest,frame});
    }
  });
  });
  const url=await app.listen({host:'127.0.0.1',port:0});
  const name=`quotum-storage-${randomUUID()}`;
  const binary=mode==='baseline'?baseline!:mode==='initial'?probe:fixed;
  const child=spawn('docker',['run','--rm','-i','--name',name,'--network','host','--user','65534:65534',
    '--tmpfs','/fixture:rw,size=1048576,mode=1777','-v',`${repo}:/work:ro`,'-v',`${binary}:/tested:ro`,
    '-e',`OBSERVED_TEST_TOKEN=${secret}`,'quotum-rust','python3','/work/agent/bench/observed/storage.py','/tested',url,mode],{stdio:['pipe','pipe','inherit']});
  const pending:Array<{resolve:(value:any)=>void;reject:(error:Error)=>void}>=[];
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>pending.shift()?.resolve(JSON.parse(line)));
  const exit=new Promise<void>(resolve=>child.once('exit',()=>{for(const p of pending.splice(0))p.reject(new Error('storage controller exited'));resolve();}));
  const command=(op:string)=>new Promise<any>((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify({op})+'\n');});
  const status=()=>command('status') as Promise<Status>;
  const work=()=>Number(store.db.prepare('SELECT coalesce(sum(to_at-from_at),0) AS ms FROM agent_work').get()!.ms);
  const wait=async(test:(s:Status)=>boolean,seconds=90)=>{
    const deadline=Date.now()+seconds*1000;
    for(;;){const s=await status();assert.ok(s.alive,'main process exited');if(test(s))return s;assert.ok(Date.now()<deadline,'capture did not progress before deadline');await pause(1000);}
  };
  let receipt:object={};
  console.error(JSON.stringify({mode,phase:'start'}));
  try{
    if(mode==='initial'){
      const failed=await wait(s=>s.failures>0);
      assert.equal(failed.queue,null);
      assert.ok(checkins.length>0,'privacy initialization blocked the initial check-in');
      console.error(JSON.stringify({mode,phase:'repairing-storage'}));
      const repair=await command('repair');
      const recovered=await wait(s=>Boolean(s.queue&&s.queue.next>1));
      assert.equal(recovered.pid,failed.pid);
      assert.ok(recovered.at-repair.at<=60_000);
      await wait(()=>work()>0);
      receipt={mode,result:'pass',binary:hash(binary),samePid:true,resumeMs:recovered.at-repair.at,workMs:work()};
    }else{
      const before=await wait(s=>Boolean(s.queue)&&work()>0);
      console.error(JSON.stringify({mode,phase:'exhausting-storage'}));
      assert.equal((await command('fill')).errno,28);
      const failed=await wait(s=>s.failures>0);
      let frozen=failed.queue!.next;
      let gapFrom=Math.max(failed.queue!.end??0,...[...frames.values()].map(v=>v.frame.toAt));
      assert.ok(gapFrom>0);
      console.error(JSON.stringify({mode,phase:'storage-unavailable'}));
      const held=mode==='baseline'?35_000:180_000;
      await pause(held);
      const still=await status();
      assert.equal(still.pid,before.pid);
      if(mode==='baseline')assert.equal(still.queue!.next,frozen);
      else assert.ok(still.queue!.next>=frozen);
      const cpuPercent=(still.cpuMs-failed.cpuMs)/(still.at-failed.at)*100;
      assert.ok(cpuPercent<=0.5,`outage CPU ${cpuPercent}% exceeds ordinary allowance`);
      if(mode==='capture')assert.ok(checkins.some(at=>at>failed.at),'check-ins stopped during storage recovery');
      if(mode==='capture'){
        await command('fill');await pause(3000);
        const down=await wait(s=>s.recovering);
        frozen=down.queue!.next;
        gapFrom=Math.max(down.queue!.end??0,...[...frames.values()].map(v=>v.frame.toAt));
      }
      console.error(JSON.stringify({mode,phase:'repairing-storage'}));
      const repair=await command('repair');
      if(mode==='baseline'){
        await pause(35_000);
        const after=await status();
        assert.equal(after.pid,before.pid);assert.equal(after.queue!.next,frozen);assert.equal(after.capture,false);
        receipt={mode,result:'defect-reproduced',binary:hash(binary),samePid:true,frozenAfterRepair:true,cpuPercent};
      }else{
        const recovered=await wait(s=>Boolean(s.queue&&s.queue.next>frozen));
        assert.equal(recovered.pid,before.pid);assert.equal(recovered.queue!.id,before.queue!.id);
        assert.ok(recovered.at-repair.at<=60_000);
        await wait(()=>[...frames.values()].some(v=>v.frame.seq>=frozen&&v.frame.fromAt===v.frame.toAt));
        const first=[...frames.values()].map(v=>v.frame).filter(f=>f.seq>=frozen&&f.fromAt===f.toAt).sort((a,b)=>a.seq-b.seq)[0];
        assert.ok(first.fromAt>gapFrom);assert.equal(first.complete,false);
        for(const table of ['agent_work','work_coverage'])assert.equal(Number(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE from_at<? AND to_at>?`).get(first.fromAt,gapFrom)!.n),0,`${table} bridges the unobserved gap`);
        const postWork=(since:number)=>Number(store.db.prepare('SELECT coalesce(sum(to_at-from_at),0) AS ms FROM agent_work WHERE from_at>=?').get(since)!.ms);
        await wait(()=>postWork(first.fromAt)>0);
        const shortGaps:number[]=[];
        for(let index=0;index<3;index++){
          console.error(JSON.stringify({mode,phase:'short-outage',index}));
          await command('fill');await command('replace');await pause(3000);
          const down=await wait(s=>s.recovering);
          const from=Math.max(down.queue!.end??0,...[...frames.values()].map(v=>v.frame.toAt));
          const repaired=await command('repair');
          const resumed=await wait(s=>Boolean(s.queue&&s.queue.next>down.queue!.next));
          assert.ok(resumed.at-repaired.at<=60_000);
          await wait(()=>[...frames.values()].some(v=>v.frame.seq>=down.queue!.next&&v.frame.fromAt===v.frame.toAt));
          const zero=[...frames.values()].map(v=>v.frame).filter(f=>f.seq>=down.queue!.next&&f.fromAt===f.toAt).sort((a,b)=>a.seq-b.seq)[0];
          assert.equal(zero.complete,false);
          for(const table of ['agent_work','work_coverage'])assert.equal(Number(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE from_at<? AND to_at>?`).get(zero.fromAt,from)!.n),0,`${table} bridges a short outage`);
          shortGaps.push(zero.fromAt-from);
          await wait(()=>postWork(zero.fromAt)>0);
        }
        assert.ok(shortGaps.some(ms=>ms>0&&ms<15_000),'short gaps must exercise fresh evidence within one judgement window');
        receipt={mode,result:'pass',binary:hash(binary),samePid:true,sameQueue:true,resumeMs:recovered.at-repair.at,unknownGapMs:first.fromAt-gapFrom,workMs:work(),cpuPercent,shortGapsMs:shortGaps,immutableSequences:frames.size};
      }
    }
    const stopped=await command('stop');assert.equal(stopped.code,0);assert.ok(stopped.stopMs<6000);
    console.log(JSON.stringify({...receipt,stopMs:stopped.stopMs}));
  }finally{
    child.stdin.end();
    spawnSync('docker',['rm','-f',name],{stdio:'ignore'});
    await exit;lines.close();await app.close();store.close();rmSync(root,{recursive:true,force:true});
  }
}
if(baseline)await scenario('baseline');
await scenario('capture');
await scenario('initial');
