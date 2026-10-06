import {randomBytes, randomUUID} from 'node:crypto';
import {closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeSync} from 'node:fs';
import path from 'node:path';
import {SecretError, SecretKey} from './crypto.js';

type Mount = {id: string; device: string; root: string; at: string};
const within = (parent: string, child: string) => {const relative=path.relative(parent,child);return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const decoded = (value: string) => value.replace(/\\([0-7]{3})/g,(_,octal:string)=>String.fromCharCode(parseInt(octal,8)));
export function mountsOf(text: string): Mount[] {
  return text.trim().split('\n').map(line=>{
    const fields=line.split(' '),split=fields.indexOf('-');
    if(split<6||fields.length<split+4||!/^\d+:\d+$/.test(fields[2]))throw new SecretError('secret_key_storage_unavailable');
    return {id:fields[0],device:fields[2],root:decoded(fields[3]),at:decoded(fields[4])};
  });
}
/** Mount roots, rather than device numbers alone, distinguish named volumes on one filesystem. */
export function separateMount(data: string, keys: string, mounts: Mount[], opened: {data: string; keys: string}) {
  const identified=(id:string)=>{const found=mounts.filter(mount=>mount.id===id);if(found.length!==1)throw new SecretError('secret_key_storage_unavailable');return found[0];};
  const dataMount=identified(opened.data),keyMount=identified(opened.keys);
  if(!dataMount||!keyMount||keyMount.at!==keys||dataMount.at===keyMount.at)throw new SecretError('secret_key_storage_unavailable');
  if(!within(dataMount.at,data)||!within(keyMount.at,keys))throw new SecretError('secret_key_storage_unavailable');
  const backing=path.resolve(keyMount.root,path.relative(keyMount.at,keys));
  if(dataMount.device===keyMount.device&&within(dataMount.root,backing))throw new SecretError('secret_key_storage_unavailable');
}

function containerMount(data: string, keys: string) {
  const dataFd=openSync(data,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  let keysFd:number|undefined;
  try {
    keysFd=openSync(keys,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    const mountId=(fd:number)=>{
      const id=readFileSync('/proc/self/fdinfo/'+fd,'utf8').match(/^mnt_id:\s*(\d+)\s*$/m)?.[1];
      if(!id)throw new SecretError('secret_key_storage_unavailable');return id;
    };
    // Opened directories identify the visible mounts, including overmounts hiding older children.
    separateMount(data,keys,mountsOf(readFileSync('/proc/self/mountinfo','utf8')),{data:mountId(dataFd),keys:mountId(keysFd)});
    for(const [fd,name] of [[dataFd,data],[keysFd,keys]] as const) {
      const held=fstatSync(fd),named=lstatSync(name);
      if(held.dev!==named.dev||held.ino!==named.ino)throw new SecretError('secret_key_storage_unavailable');
    }
  } finally {closeSync(dataFd);if(keysFd!==undefined)closeSync(keysFd);}
}

function secureParents(location: string) {
  const uid=process.getuid!();
  for(let current=location;;current=path.dirname(current)) {
    const stat=lstatSync(current);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid&&stat.uid!==0||(stat.mode&0o022)!==0&&!(stat.uid===0&&(stat.mode&0o1000)!==0))throw new SecretError('secret_key_storage_unavailable');
    if(path.dirname(current)===current)break;
  }
}
function directoryAt(location: string) {
  try {const stat=lstatSync(location);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid!()||(stat.mode&0o777)!==0o700)throw new SecretError('secret_key_storage_unavailable');}
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const parent=path.dirname(location);if(parent===location)throw new SecretError('secret_key_storage_unavailable');
    if(!exists(parent))directoryAt(parent);
    secureParents(parent);
    try {mkdirSync(location,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    directoryAt(location);
  }
}
function exists(location: string) {try {lstatSync(location);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
function barrier(directory: string) {
  // Repeat parent-entry barriers on admission too, including interrupted first publication.
  for(let current=directory;;current=path.dirname(current)) {
    const fd=openSync(current,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try {fsyncSync(fd);}finally {closeSync(fd);}
    if(path.dirname(current)===current)break;
  }
}
function admitted(file: string, directory: string): SecretKey {
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),bytes=Buffer.alloc(44);
  try {
    const stat=fstatSync(fd),named=lstatSync(file);
    if(!stat.isFile()||stat.uid!==process.getuid!()||(stat.mode&0o777)!==0o600||stat.size!==43||stat.ino!==named.ino||stat.dev!==named.dev)throw new SecretError('secret_key_storage_invalid');
    let count=0;
    while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
    if(count!==43)throw new SecretError('secret_key_storage_invalid');
    const key=SecretKey.parse(bytes.subarray(0,43));
    fsyncSync(fd);barrier(directory);return key;
  } finally {bytes.fill(0);closeSync(fd);}
}

/** Called under the secrets database transaction. A missing established key is never regenerated. */
export function managedFile(dataDir: string, configured: string | undefined, clean: boolean, container = false): SecretKey {
  let temporary:string|undefined;
  try {
    const data=realpathSync(dataDir),directory=path.resolve(configured??data+'.keys');
    if(!configured&&container||configured!==undefined&&!configured||within(data,directory))throw new SecretError('secret_key_storage_unavailable');
    let parent=path.dirname(directory);while(!exists(parent))parent=path.dirname(parent);
    secureParents(parent);
    if(container)containerMount(data,directory);
    if(!exists(directory)&&!clean)throw new SecretError('secret_key_storage_missing');
    directoryAt(directory);secureParents(directory);
    const real=realpathSync(directory),dataStat=lstatSync(data),keyStat=lstatSync(real);
    if(real!==directory||within(data,real)||dataStat.dev===keyStat.dev&&dataStat.ino===keyStat.ino)throw new SecretError('secret_key_storage_unavailable');
    const file=path.join(directory,'current.key');
    if(!exists(file)) {
      if(!clean)throw new SecretError('secret_key_storage_missing');
      temporary=path.join(directory,'.'+randomUUID()+'.key');
      const candidate=randomBytes(32),bytes=Buffer.from(candidate.toString('base64url'),'ascii');candidate.fill(0);
      const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try {let count=0;while(count<bytes.length)count+=writeSync(fd,bytes,count);fsyncSync(fd);}
      finally {bytes.fill(0);closeSync(fd);}
      try {linkSync(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    }
    const key=admitted(file,directory);
    if(temporary){unlinkSync(temporary);temporary=undefined;}
    return key;
  } catch(error) {throw error instanceof SecretError&&error.code.startsWith('secret_key_storage_')?error:new SecretError('secret_key_storage_unavailable');}
  finally {if(temporary)try{unlinkSync(temporary);}catch{/* Only our own transient file is disposable. */}}
}
