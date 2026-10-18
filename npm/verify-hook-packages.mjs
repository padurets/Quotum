/** Pack and extract the actual npm archives, then compare their immutable sidecars. */
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PLATFORMS} from './platforms.mjs';
import {verifyHook} from './hook-artifact.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(readFileSync(path.join(root,'hub/package.json'),'utf8'));
const temp=mkdtempSync(path.join(os.tmpdir(),'quotum-hook-packages-'));
let checked=0;
try {
  for(const platform of PLATFORMS) {
    const directory=path.join(root,'npm/dist',`quotum-${platform.name}`);
    if(!existsSync(directory))continue;
    const result=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',temp],{cwd:directory,encoding:'utf8',shell:process.platform==='win32'}));
    const filename=result[0].filename;
    if(path.basename(filename)!==filename)throw new Error('Invalid archive name');
    const extracted=path.join(temp,platform.name);mkdirSync(extracted);
    execFileSync('tar',['-xf',path.join(temp,filename),'-C',extracted]);
    verifyHook(path.join(root,'agent/target/hook-dist'),platform.name,version,path.join(extracted,'package/bin'));
    checked++;
  }
  if(!checked)throw new Error('No built npm packages to verify');
  console.log(`Canonical hook payloads verified in ${checked} extracted npm archives.`);
}finally{rmSync(temp,{recursive:true,force:true});}
