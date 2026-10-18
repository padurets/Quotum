import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const directory=path.resolve(process.argv[2]??'target/release');
const suffix=process.platform==='win32'?'.exe':'';
const env={...process.env,RUST_BACKTRACE:'full',ANTHROPIC_API_KEY:'release-token-secret-canary',ANTHROPIC_BASE_URL:'https://secret-user:secret-password@openrouter.ai/secret-path?secret-query#secret-fragment'};
for(const args of [[],['--version'],['--generation','invalid'],['--generation','12345678-1234-1234-1234-123456789012','unexpected']]) {
  const result=spawnSync(path.join(directory,`quotum-hook${suffix}`),args,{env,input:'malformed private input',timeout:5000,maxBuffer:16*1024});
  assert.equal(result.error,undefined);assert.equal(result.status,0);
  assert.equal(result.stdout.length,0);assert.equal(result.stderr.length,0);
}
const aborted=spawnSync(path.join(directory,`examples/panic${suffix}`),['--invalid'],{env,timeout:5000,maxBuffer:16*1024});
assert.equal(aborted.error,undefined);
if(process.platform==='win32')assert.ok(aborted.status!==null&&[3,0xc0000409].includes(aborted.status>>>0),`unexpected abort code ${aborted.status}`);
else assert.equal(aborted.signal,'SIGABRT');
assert.equal(aborted.stdout.length,0);assert.equal(aborted.stderr.length,0);
console.log('Release helper arguments and panic abort preserve silent output.');
