#!/usr/bin/env node
/** The sole producer of helper bytes for CLI, npm and desktop packaging. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PLATFORMS} from './platforms.mjs';
import {hookArtifact} from './hook-artifact.mjs';

const agent=fileURLToPath(new URL('../agent/',import.meta.url));
const version=/\[workspace\.package\][^[]*?\nversion = "([^"]+)"/.exec(readFileSync(path.join(agent,'Cargo.toml'),'utf8'))?.[1];
if(!version)throw new Error('Missing workspace version');
const args=process.argv.slice(2),wanted=args.filter(value=>!value.startsWith('--'));
const platforms=wanted.length?PLATFORMS.filter(p=>wanted.includes(p.name)):PLATFORMS;
if(platforms.length!==(wanted.length||PLATFORMS.length))throw new Error('Unknown hook platform');
const output=path.join(agent,'target/hook-dist');
const sources=directory=>readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  if(entry.name==='target')return [];
  const file=path.join(directory,entry.name);
  return entry.isDirectory()?sources(file):/\.(rs|toml|lock)$/.test(entry.name)?[file]:[];
});
const digest=createHash('sha256');
for(const file of sources(agent)){digest.update(path.relative(agent,file));digest.update(readFileSync(file));}
digest.update(readFileSync(fileURLToPath(import.meta.url)));
const input=digest.digest('hex');
for(const platform of platforms) {
  const directory=path.join(output,platform.name),stamp=path.join(directory,'build-input');
  if(!args.includes('--rebuild')&&existsSync(stamp)&&readFileSync(stamp,'utf8')===input) {
    hookArtifact(output,platform.name,version);continue;
  }
  execFileSync('cargo',['zigbuild','--release','--locked','--target',platform.target,'-p','quotum-hook'],{cwd:agent,stdio:'inherit'});
  const source=path.join(agent,'target',platform.target,'release',`quotum-hook${platform.exe??''}`);
  const bytes=readFileSync(source),sha256=createHash('sha256').update(bytes).digest('hex');
  mkdirSync(directory,{recursive:true});
  copyFileSync(source,path.join(directory,path.basename(source)));chmodSync(path.join(directory,path.basename(source)),0o755);
  writeFileSync(path.join(directory,'payload-manifest.json'),JSON.stringify({schemaVersion:1,version,platform:platform.name,target:platform.target,sha256})+'\n');
  writeFileSync(stamp,input);
  hookArtifact(output,platform.name,version);
}
