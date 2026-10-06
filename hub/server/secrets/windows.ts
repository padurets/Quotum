import {spawnSync} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {DatabaseSync} from 'node:sqlite';
import {SecretError, SecretKey} from './crypto.js';
import {transaction} from '../touches.js';

/** Reserve a stable nonsecret namespace before the helper can publish any registry material. */
export function reserveManagedId(db: DatabaseSync): string {
  return transaction(db,()=>{
    const existing=db.prepare("SELECT value FROM meta WHERE key='managedKeyId'").get()?.value;
    if(existing!==undefined) {if(typeof existing!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(existing))throw new SecretError('secret_key_metadata_invalid');return existing;}
    const id=randomUUID();db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('managedKeyId',id);return id;
  });
}

/** The helper owns the cross-session mutex and durable registry write, even if this parent dies. */
export function managedRegistry(id: string, clean: boolean, directory?: string): SecretKey {
  if(directory!==undefined)throw new SecretError('secret_key_storage_unavailable');
  const frame=Buffer.alloc(84),random=randomBytes(32),candidate=Buffer.from(random.toString('base64url'));random.fill(0);
  frame.write('QKI1',0,'ascii');frame.write(id,4,'ascii');frame[40]=clean?1:0;candidate.copy(frame,41);candidate.fill(0);
  let output:Buffer|undefined;
  try {
    const root=process.env.SystemRoot??process.env.SYSTEMROOT;
    if(!root||!path.isAbsolute(root))throw new SecretError('secret_key_storage_unavailable');
    const native=path.join(root,process.arch==='ia32'&&existsSync(path.join(root,'Sysnative'))?'Sysnative':'System32','WindowsPowerShell','v1.0','powershell.exe');
    const executable=realpathSync(native),script=fileURLToPath(new URL('./windows.ps1',import.meta.url));
    const result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{input:frame,timeout:10_000,maxBuffer:4096,windowsHide:true,stdio:['pipe','pipe','pipe']});
    output=result.stdout;
    // Raw stderr, exceptions and helper transcripts never cross the boundary.
    result.stderr?.fill(0);
    if(result.error||result.status!==0||!Buffer.isBuffer(output)||output.length<5||output.subarray(0,4).toString('ascii')!=='QKR1')throw new SecretError('secret_key_storage_unavailable');
    if(output[4]!==0)throw new SecretError(output.length===5&&output[4]===1?'secret_key_storage_missing':output.length===5&&output[4]===2?'secret_key_storage_invalid':'secret_key_storage_unavailable');
    if(output.length!==48)throw new SecretError('secret_key_storage_invalid');
    return SecretKey.parse(output.subarray(5));
  } catch(error) {throw error instanceof SecretError?error:new SecretError('secret_key_storage_unavailable');}
  finally {frame.fill(0);output?.fill(0);}
}
