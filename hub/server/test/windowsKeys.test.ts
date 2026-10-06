import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store/store.js';
import {managedRegistry, reserveManagedId} from '../secrets/windows.js';
import {readInputs, startSecrets} from '../secrets/index.js';

const windows={skip:process.platform!=='win32'};
function cleanup(id:string) {
  const executable=path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe');
  // Only this fixture's random namespace is disposable; never enumerate another instance.
  spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',"Remove-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Quotum\\HubKeys\\v1\\"+id+"' -Recurse -Force -ErrorAction SilentlyContinue"],{stdio:'ignore',timeout:10_000,windowsHide:true});
}
test('Windows registry bootstrap is private, durable and never replaces a missing established store',windows,t=>{
  const root=mkdtempSync(path.join(tmpdir(),'quotum-registry-')),data=path.join(root,'data');mkdirSync(data);
  const store=new Store(path.join(data,'hub.sqlite')),id=reserveManagedId(store.db);
  t.after(()=>{cleanup(id);store.close();rmSync(root,{recursive:true,force:true});});
  const first=readInputs({},data,false),report=startSecrets(store.db,first);
  assert.equal(report.outcome,'created');assert.ok(first.current);assert.equal(reserveManagedId(store.db),id);
  assert.equal(startSecrets(store.db,readInputs({},data,false)).current,report.current);
  assert.equal(managedRegistry(id,false).fingerprint,report.current);
  cleanup(id);
  const lost=startSecrets(store.db,readInputs({},data,false));assert.equal(lost.reason,'secret_key_storage_missing');
  assert.throws(()=>managedRegistry(id,false),/secret_key_storage_missing/);
  assert.equal(startSecrets(store.db,readInputs({QUOTUM_SECRET_DIR:data},data,false)).reason,'secret_key_storage_unavailable');
});

test('concurrent Windows helpers share one native mutex and one published key',windows,async t=>{
  const id=randomUUID();t.after(()=>cleanup(id));
  const module=new URL('../secrets/windows.ts',import.meta.url).href;
  const run=()=>new Promise<string>((resolve,reject)=>{
    const script="import {managedRegistry} from "+JSON.stringify(module)+";console.log(managedRegistry('"+id+"',true).fingerprint);";
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
    let result='';child.stdout.on('data',bytes=>result+=String(bytes));
    child.stderr.resume();child.on('error',reject);child.on('close',code=>code===0?resolve(result.trim()):reject(new Error('Registry fixture failed')));
  });
  const values=await Promise.all([run(),run()]);assert.match(values[0],/^[a-f0-9]{16}$/);assert.equal(values[0],values[1]);
  assert.equal(managedRegistry(id,false).fingerprint,values[0]);
});
