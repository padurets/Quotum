import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,mkdirSync,readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {PLATFORMS} from './platforms.mjs';

export function hookArtifact(root,platform,version) {
  const spec=PLATFORMS.find(item=>item.name===platform);
  if(!spec) throw new Error('Unsupported hook platform');
  const directory=path.join(root,platform),manifestPath=path.join(directory,'payload-manifest.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const binary=path.join(directory,`quotum-hook${spec.exe??''}`),bytes=readFileSync(binary);
  if(manifest.schemaVersion!==1||manifest.version!==version||manifest.platform!==platform||manifest.target!==spec.target
    ||createHash('sha256').update(bytes).digest('hex')!==manifest.sha256) throw new Error('Hook artifact does not match its package');
  return {binary,manifestPath,manifest};
}

export function copyHook(root,platform,version,directory,binaryName) {
  const artifact=hookArtifact(root,platform,version);
  mkdirSync(directory,{recursive:true});
  const binary=path.join(directory,binaryName??path.basename(artifact.binary));
  copyFileSync(artifact.binary,binary);chmodSync(binary,0o755);
  copyFileSync(artifact.manifestPath,path.join(directory,'payload-manifest.json'));
  return artifact;
}

export function verifyHook(root,platform,version,directory) {
  const reference=hookArtifact(root,platform,version);
  const binary=path.join(directory,path.basename(reference.binary));
  if(!readFileSync(binary).equals(readFileSync(reference.binary))
    ||!readFileSync(path.join(directory,'payload-manifest.json')).equals(readFileSync(reference.manifestPath)))throw new Error('Packaged hook differs from the canonical payload');
  if(!platform.startsWith('win32')&&process.platform!=='win32'&&!(statSync(binary).mode&0o111))throw new Error('Packaged hook must be executable');
}
