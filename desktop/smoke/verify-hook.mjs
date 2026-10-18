/** Compare an extracted/installed package with the sole producer's checked payload. */
import assert from 'node:assert/strict';
import {lstatSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyHook} from '../../npm/hook-artifact.mjs';

const [directory,platform]=process.argv.slice(2);
if(!directory||!platform)throw new Error('Pass the extracted payload directory and its platform');
const root=fileURLToPath(new URL('../../',import.meta.url));
const {version}=JSON.parse(readFileSync(path.join(root,'hub/package.json'),'utf8'));
verifyHook(path.join(root,'agent/target/hook-dist'),platform,version,directory);
if(platform==='linux-x64') {
  for(const folder of [directory,path.dirname(directory)]) {
    const meta=lstatSync(folder);
    assert.ok(meta.isDirectory()&&!meta.isSymbolicLink()&&(meta.mode&0o022)===0,'Packaged hook directories must not be writable by another account');
  }
  for(const name of ['quotum-hook','payload-manifest.json']) {
    const meta=lstatSync(path.join(directory,name));
    assert.ok(meta.isFile()&&!meta.isSymbolicLink()&&meta.nlink===1&&(meta.mode&0o022)===0,'Packaged hook files must not be writable by another account');
  }
}
console.log(`Canonical hook payload verified: ${platform} ${version}.`);
