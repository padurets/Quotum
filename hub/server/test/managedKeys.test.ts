import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {Store} from '../store/store.js';
import {readInputs, SecretKey, startSecrets} from '../secrets/index.js';
import {mountsOf, separateMount} from '../secrets/managed.js';

const posix={skip:process.platform==='win32'};
function fixture() {
  const root=mkdtempSync(path.join(tmpdir(),'quotum-managed-')),data=path.join(root,'data');mkdirSync(data,{mode:0o700});
  const store=new Store(path.join(data,'hub.sqlite')),keys=data+'.keys',file=path.join(keys,'current.key');
  const start=(directory?:string)=>{const input=readInputs(directory?{QUOTUM_SECRET_DIR:directory}:{},data,false);return {input,report:startSecrets(store.db,input)};};
  return {root,data,keys,file,store,start,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}

test('clean automatic startup publishes one private key outside data and admits it again after restart',posix,t=>{
  const h=fixture();t.after(h.close);const first=h.start();
  assert.equal(first.report.outcome,'created');assert.ok(first.input.current);
  assert.equal(fs.statSync(h.keys).mode&0o777,0o700);assert.equal(fs.statSync(h.file).mode&0o777,0o600);
  const material=readFileSync(h.file);assert.equal(material.length,43);
  assert.equal(readFileSync(path.join(h.data,'hub.sqlite')).includes(material),false);
  assert.equal(h.start().report.current,first.report.current);assert.deepEqual(readFileSync(h.file),material);
  assert.equal(fs.readdirSync(h.keys).length,1);
});

test('missing, malformed and mismatched stores preserve established metadata even without credentials',posix,t=>{
  const h=fixture();t.after(h.close);h.start();const meta=h.store.db.prepare("SELECT * FROM meta WHERE key LIKE 'secretKey%'").all();
  const original=readFileSync(h.file);fs.unlinkSync(h.file);
  assert.equal(h.start().report.reason,'secret_key_storage_missing');assert.equal(existsSync(h.file),false);
  writeFileSync(h.file,'corrupt',{mode:0o600});assert.equal(h.start().report.outcome,'missing');assert.equal(readFileSync(h.file,'utf8'),'corrupt');
  writeFileSync(h.file,Buffer.alloc(32,9).toString('base64url'));assert.equal(h.start().report.outcome,'mismatch');
  assert.deepEqual(h.store.db.prepare("SELECT * FROM meta WHERE key LIKE 'secretKey%'").all(),meta);
  writeFileSync(h.file,original);assert.equal(h.start().report.outcome,'ok');
});

test('explicit key authority never copies or reads automatic storage; local mode never bootstraps it',posix,t=>{
  const h=fixture();t.after(h.close);const input=readInputs({QUOTUM_SECRET_KEY:Buffer.alloc(32,5).toString('base64url'),QUOTUM_SECRET_DIR:h.data},h.data,false);
  assert.equal(startSecrets(h.store.db,input).outcome,'created');assert.equal(existsSync(h.keys),false);
  const local=readInputs({},h.data,true);assert.equal(local.managed,undefined);assert.equal(startSecrets(h.store.db,local).outcome,'missing');assert.equal(existsSync(h.keys),false);
});

test('automatic storage rejects symlinks, public permissions, in-data locations and ephemeral containers',posix,t=>{
  for(const kind of ['symlink','mode','in-data','container']) {
    const h=fixture();t.after(h.close);
    if(kind==='symlink'){mkdirSync(h.keys,{mode:0o700});const outside=path.join(h.root,'outside');writeFileSync(outside,Buffer.alloc(32,5).toString('base64url'),{mode:0o600});symlinkSync(outside,h.file);}
    if(kind==='mode'){mkdirSync(h.keys,{mode:0o755});chmodSync(h.keys,0o755);}
    const input=readInputs(kind==='in-data'?{QUOTUM_SECRET_DIR:path.join(h.data,'keys')}:kind==='container'?{QUOTUM_SECRET_DIR:h.keys,QUOTUM_MANAGED_CONTAINER:'1'}:{},h.data,false);
    assert.equal(startSecrets(h.store.db,input).outcome,'missing');assert.equal(h.store.db.prepare("SELECT 1 FROM meta WHERE key='secretKeyKcv'").get(),undefined);
  }
});

test('an existing key repeats durability barriers before committing metadata',posix,t=>{
  const h=fixture();t.after(h.close);mkdirSync(h.keys,{mode:0o700});writeFileSync(h.file,Buffer.alloc(32,5).toString('base64url'),{mode:0o600});
  const original=readFileSync(h.file);
  t.mock.method(fs,'fsyncSync',()=>{throw new Error('private filesystem detail');});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const result=h.start();assert.equal(result.report.reason,'secret_key_storage_unavailable');
  assert.equal(h.store.db.prepare("SELECT 1 FROM meta WHERE key='secretKeyKcv'").get(),undefined);assert.deepEqual(readFileSync(h.file),original);
});

test('mount admission rejects same-volume and nested bind aliases, but accepts distinct volume roots on one device',()=>{
  const common='1 0 0:1 / / rw - overlay overlay rw\n';
  const volumes=mountsOf(common+'2 1 8:1 /volumes/data /data rw - ext4 disk rw\n3 1 8:1 /volumes/keys /keys rw - ext4 disk rw');
  separateMount('/data/db','/keys',volumes);
  for(const root of ['/volumes/data','/volumes/data/keys']) {
    const aliases=mountsOf(common+'2 1 8:1 /volumes/data /data rw - ext4 disk rw\n3 1 8:1 '+root+' /keys rw - ext4 disk rw');
    assert.throws(()=>separateMount('/data/db','/keys',aliases),/secret_key_storage_unavailable/);
  }
  assert.throws(()=>separateMount('/data','/keys',mountsOf(common)),/secret_key_storage_unavailable/);
  const stacked=mountsOf(common+'2 1 8:1 /volumes/data /data rw - ext4 disk rw\n3 1 8:1 /volumes/keys /keys rw - ext4 disk rw\n4 3 8:1 /volumes/data /keys rw - ext4 disk rw');
  assert.throws(()=>separateMount('/data/db','/keys',stacked),/secret_key_storage_unavailable/);
  assert.throws(()=>separateMount('/data/db','/keys',[...stacked].reverse()),/secret_key_storage_unavailable/);
  assert.equal(mountsOf('2 1 8:1 /volume\\040one /keys rw - ext4 disk rw')[0].root,'/volume one');
});

test('a data-only restore cannot generate a replacement for a lost encryption key',posix,t=>{
  const h=fixture();t.after(h.close);const first=h.start(),record={id:'access',user_id:'owner',provider:'fixture'};
  const sealed=first.input.current!.seal(record,Buffer.from('PRIVATE_PROVIDER_CANARY'));
  h.store.db.prepare("INSERT INTO credentials (id,user_id,provider,cipher,nonce,key_version,abilities,created_at) VALUES (?,?,?,?,?,1,'[]',1)").run(record.id,record.user_id,record.provider,sealed.cipher,sealed.nonce);
  const rows=h.store.db.prepare('SELECT * FROM credentials').all(),material=readFileSync(h.file);fs.unlinkSync(h.file);
  assert.equal(h.start().report.reason,'secret_key_storage_missing');assert.deepEqual(h.store.db.prepare('SELECT * FROM credentials').all(),rows);
  writeFileSync(h.file,material,{mode:0o600});assert.equal(h.start().report.outcome,'ok');
  const restored=SecretKey.parse(material);restored.use({...record,...sealed},bytes=>assert.equal(bytes.toString(),'PRIVATE_PROVIDER_CANARY'));
});
