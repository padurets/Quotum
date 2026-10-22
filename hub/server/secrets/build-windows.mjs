import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
if(process.platform==='win32') {
  const dll=path.join(here,'managed-key.dll');
  let result,build;
  try {
    rmSync(dll,{force:true});
    build=mkdtempSync(path.join(here,'.managed-key-'));
    const output=path.join(build,'managed-key.dll');
    const root=process.env.SystemRoot??process.env.SYSTEMROOT;
    if(!root||!path.isAbsolute(root))throw new Error();
    const framework=path.join(root,'Microsoft.NET',existsSync(path.join(root,'Microsoft.NET/Framework64'))?'Framework64':'Framework','v4.0.30319');
    // Use the installed compiler directly; native requests only load its output.
    const args=['/nologo','/noconfig','/nostdlib+','/target:library','/platform:anycpu','/reference:'+path.join(framework,'mscorlib.dll'),'/reference:'+path.join(framework,'System.dll'),'/out:'+output,path.join(here,'windows.cs')];
    result=spawnSync(realpathSync(path.join(framework,'csc.exe')),args,{maxBuffer:4096,windowsHide:true,stdio:['ignore','pipe','pipe']});
    if(result.error||result.signal!==null||result.status!==0||!statSync(output).isFile()||statSync(output).size===0)throw new Error();
    renameSync(output,dll);
  } catch {
    rmSync(dll,{force:true});
    throw new Error('The Windows managed-key helper could not be built');
  } finally {
    result?.stdout?.fill(0);result?.stderr?.fill(0);
    if(build&&(!result?.pid||!result.error&&result.signal===null&&Number.isInteger(result.status)))rmSync(build,{recursive:true,force:true});
  }
}
if(process.argv.includes('--dist')) {
  const dist=path.resolve(here,'../../dist/server/secrets');
  mkdirSync(dist,{recursive:true});
  copyFileSync(path.join(here,'windows.ps1'),path.join(dist,'windows.ps1'));
  if(process.platform==='win32')copyFileSync(path.join(here,'managed-key.dll'),path.join(dist,'managed-key.dll'));
}
