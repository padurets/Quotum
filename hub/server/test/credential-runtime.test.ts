import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {SecretKey} from '../secrets/index.js';

const CANARY = 'CANARY_PRIVATE_PROVIDER_0123456789';
const k = (byte:number) => Buffer.alloc(32, byte).toString('base64url');
const root = fileURLToPath(new URL('../../', import.meta.url));
const patterns = (value:string) => [value, Buffer.from(value).toString('hex'), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), JSON.stringify([...Buffer.from(value)])];
const safe = (surface:string, bytes:Buffer|string, values:string[]) => { for (const value of values) for (const pattern of patterns(value)) assert.equal(Buffer.from(bytes).includes(Buffer.from(pattern)), false, surface); };

async function start(data:string, current?:string, previous?:string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('QUOTUM_')));
  const child = spawn(process.execPath, ['--import','tsx','server/test/fixtures/credential-hub.ts'], {cwd:root, env:{...env, QUOTUM_DATA_DIR:data, QUOTUM_RESETS:'off', ...(current ? {QUOTUM_SECRET_KEY:current} : {}), ...(previous ? {QUOTUM_SECRET_KEY_PREVIOUS:previous} : {})}, stdio:['pipe','pipe','pipe']});
  let output='', errors=''; const events: {event:string; code?:string; port?:number; secretKey?:{outcome:string; credentials:number; unreadable:number}}[]=[];
  child.stdout.on('data', bytes => {output += bytes;}); child.stderr.on('data', bytes => {errors += bytes;});
  createInterface({input:child.stdout}).on('line', line => { try {events.push(JSON.parse(line));} catch { /* The scanner audits non-JSON too. */ } });
  const event = async (kind:string, after=0) => {
    for (let i=0;i<200;i++) { const found=events.slice(after).find(e=>e.event===kind || e.event==='error'); if(found) return found; if(child.exitCode!==null) throw new Error('fixture exited before its report'); await new Promise(resolve=>setTimeout(resolve,20)); }
    throw new Error('fixture report timeout');
  };
  const ready = await event('start'); assert.equal(ready.event,'start','built fixture starts without raw diagnostics');
  const origin=`http://127.0.0.1:${ready.port}`; const cookies=new Map<string,string>(); const answers:string[]=[];
  const call = async (method:'GET'|'POST'|'DELETE', url:string, body?:object|string, user='alice') => {
    const response=await fetch(origin+url,{method, headers:{origin, ...(url.startsWith('/api/events')?{'quotum-stream':'1'}:{}), ...(cookies.has(user)?{cookie:cookies.get(user)!}:{}), ...(body!==undefined?{'content-type':'application/json'}:{})}, ...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
    const cookie=response.headers.get('set-cookie'); if(cookie) cookies.set(user,cookie.split(';')[0]);
    const text=await response.text(); answers.push(text); return {status:response.status, body:text ? JSON.parse(text) : null, text};
  };
  for(const user of ['alice','bob']) assert.equal((await call('POST','/api/auth/login',{email:`${user}@fixture.example`,password:'fixture-password'},user)).status,200);
  const command = async (op:string,id?:string) => {const after=events.length; child.stdin!.write(JSON.stringify({op,...(id?{id}:{})})+'\n'); return event(op==='probe'?'probe':op,after);};
  const stop=async()=>{child.stdin!.end(); await once(child,'exit'); writeFileSync(path.join(data,'hub.log'), output+errors); return {output,errors,answers};};
  return {child, ready, origin, call, command, event, events, stop};
}
async function reset(data:string, current:string, from:string, to:string) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('QUOTUM_')));
  const child=spawn(process.execPath,['dist/server/index.js','reset-secret-key','--from',from,'--to',to],{cwd:root,env:{...env,QUOTUM_DATA_DIR:data,QUOTUM_SECRET_KEY:current,QUOTUM_RESETS:'off'},stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{error+=bytes;}); const [code]=await once(child,'exit');return {code,output,error};
}

test('built hub runtime keeps canaries out of responses, events, logs and SQLite across replace, rotation, reset and restored backup', async t=>{
  assert.ok(existsSync(path.join(root,'dist/server/index.js')), 'build the hub before its runtime canary gate');
  const data=mkdtempSync(path.join(tmpdir(),'quotum-secret-runtime-')); const values=[CANARY,k(7),k(8),k(9)];
  const children:ChildProcess[]=[]; t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');});
  const scan=(captured:{output:string;errors:string;answers:string[]})=>{
    safe('stdout',captured.output,values);safe('stderr',captured.errors,values);safe('answers',captured.answers.join('\n'),values);
    for(const name of ['quotum.sqlite','quotum.sqlite-wal','quotum.sqlite-shm','hub.log']) if(existsSync(path.join(data,name)))safe(name,readFileSync(path.join(data,name)),values);
  };
  const scanLive = () => { for (const name of ['quotum.sqlite','quotum.sqlite-wal','quotum.sqlite-shm']) if(existsSync(path.join(data,name))) safe(`live ${name}`,readFileSync(path.join(data,name)),values); };
  let hub=await start(data,k(7));children.push(hub.child);
  const created=await hub.call('POST','/api/credentials',{provider:'test',secret:CANARY});assert.equal(created.status,201);const id=created.body.id;
  scanLive();
  assert.deepEqual((await hub.call('GET','/api/credentials',undefined,'bob')).body,{credentials:[]});
  const session=(await hub.call('GET','/api/session')).body; const board=session.boards[0].id;
  const stream=await hub.call('GET',`/api/events?board=${board}&mode=poll`); assert.equal(stream.status,200); safe('events',stream.text,values);
  safe('overview',(await hub.call('GET',`/api/overview?board=${board}`)).text,values);
  for(const secret of [CANARY+'\r\n',CANARY+'\0'])assert.equal((await hub.call('POST','/api/credentials',{provider:'test',secret})).status,400);
  for(const url of [`/api/credentials/${CANARY}%zz`,`/api/credentials/${CANARY.repeat(5)}`])assert.equal((await hub.call('POST',url,{secret:CANARY})).status,400);
  const probe=await hub.command('probe',id);assert.equal(probe.code,'ok');
  scanLive();
  await hub.command('fault');assert.equal((await hub.call('POST',`/api/credentials/${id}`,{secret:CANARY+'_replace'})).status,500);await hub.command('clear_fault');
  assert.equal((await hub.call('POST',`/api/credentials/${id}`,{secret:CANARY})).status,200);
  scanLive();
  scan(await hub.stop()); const backup=path.join(data,'backup.sqlite');copyFileSync(path.join(data,'quotum.sqlite'),backup);
  hub=await start(data,k(8),k(7));children.push(hub.child);assert.equal(hub.ready.secretKey?.outcome,'rotated');
  const damaged = new DatabaseSync(path.join(data,'quotum.sqlite'));
  const ciphertext=Buffer.from(damaged.prepare('SELECT cipher FROM credentials WHERE id = ?').get(id)!.cipher as Uint8Array);ciphertext[ciphertext.length-1]^=1;
  damaged.prepare('UPDATE credentials SET cipher = ? WHERE id = ?').run(ciphertext,id);damaged.close();
  assert.equal((await hub.command('probe',id)).code,'credential_unreadable');assert.equal((await hub.call('GET','/api/credentials')).body.credentials[0].unreadable,true);
  scanLive();scan(await hub.stop());
  const fp8=SecretKey.parse(Buffer.from(k(8))).fingerprint,fp9=SecretKey.parse(Buffer.from(k(9))).fingerprint;
  const discarded=await reset(data,k(9),fp8,fp9);assert.equal(discarded.code,0);safe('reset stdout',discarded.output,values);safe('reset stderr',discarded.error,values);
  hub=await start(data,k(9));children.push(hub.child);assert.equal((await hub.call('GET','/api/credentials')).body.credentials.length,0);scan(await hub.stop());
  copyFileSync(backup,path.join(data,'quotum.sqlite'));
  hub=await start(data,k(9));children.push(hub.child);assert.equal(hub.ready.secretKey?.outcome,'mismatch');assert.equal((await hub.call('GET','/api/credentials')).body.credentials.length,1);scan(await hub.stop());
  const db=new DatabaseSync(path.join(data,'quotum.sqlite'));assert.equal((db.prepare('SELECT count(*) AS n FROM credentials').get() as {n:number}).n,1);db.close();
});
