/** Explicit live-client acceptance, exclusively inside the guarded disposable OS account. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {checkedBoundary} from './native-qa.mjs';
import {copyHook} from '../../npm/hook-artifact.mjs';

const account=checkedBoundary(),args=process.argv.slice(2);
const option=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const windows=process.platform==='win32',suffix=windows?'.exe':'';
const root=windows?path.join(account.localAppData,'Quotum/hooks'):path.join(account.home,'.local/share/quotum/hooks');
const receipt=path.join(account.home,'.quotum-hook-qa.json');
function run(program,argv,env={},cwd=account.home) {
  const shim=windows&&program.endsWith('.cmd');
  const output=spawnSync(shim?`"${program}"`:program,argv,{env:{...process.env,...env},cwd,input:'',encoding:'utf8',timeout:20_000,maxBuffer:128*1024,shell:shim});
  assert.equal(output.error,undefined,'native command could not start');
  assert.equal(output.status,0,`native ${path.basename(program)} did not exit successfully (stdout ${Buffer.byteLength(output.stdout??'')} bytes, stderr ${Buffer.byteLength(output.stderr??'')} bytes)`);
  return output;
}
function finish(marker) {
  for(const [field,prefix] of [['work','.quotum-hook-live-'],['package','.quotum-hook-package-']]) {
    const value=marker[field];
    assert.equal(path.dirname(value),account.home);assert.match(path.basename(value).slice(prefix.length),/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);assert.ok(path.basename(value).startsWith(prefix));
    assert.equal(lstatSync(value).isSymbolicLink(),false);
  }
  assert.equal(marker.cli,path.join(marker.package,`quotum${suffix}`));
  const manifest=JSON.parse(readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.installationGeneration,marker.generation);
  assert.equal(manifest.payload.sha256,marker.sha256);
  assert.equal(manifest.stage,'enabled','normal/hidden startup must repair the interrupted canary consent');
  // Removal from another frontend profile still uses the committed target.
  run(marker.cli,['hook','disable'],{CLAUDE_CONFIG_DIR:path.join(marker.work,'another-profile')});
  assert.equal(existsSync(root),false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(marker.work,'user/settings.json'),'utf8')),{fixture:true});
  rmSync(marker.work,{recursive:true});rmSync(marker.package,{recursive:true});rmSync(receipt);
}
if(args.includes('--finish')) {
  const meta=lstatSync(receipt);
  assert.ok(meta.isFile()&&!meta.isSymbolicLink()&&meta.nlink===1&&meta.size<=4096);
  if(!windows)assert.equal(meta.mode&0o077,0);
  finish(JSON.parse(readFileSync(receipt,'utf8')));
  console.log('Native hook: startup reconciliation and cross-profile removal passed.');
} else {
  assert.equal(existsSync(root),false,'use a fresh disposable OS account, never an existing consent');
  assert.equal(existsSync(receipt),false);
  const originalCli=path.resolve(option('--cli')??`agent/target/release/quotum${suffix}`);
  const claude=option('--claude');assert.ok(claude,'pass the real Claude Code executable');
  assert.ok(!claude.includes('"'),'invalid client path');
  const payloads=path.resolve(option('--payloads')??'agent/target/hook-dist');
  const version=run(originalCli,['--version']).stdout.trim().split(/\s+/).at(-1);
  const clientVersion=run(claude,['--version']).stdout.match(/\d+\.\d+\.\d+/)?.[0];assert.ok(clientVersion);
  console.log(`Native hook versions: Quotum ${version}; Claude Code ${clientVersion}.`);
  const packageDir=path.join(account.home,`.quotum-hook-package-${randomUUID()}`);
  const work=path.join(account.home,`.quotum-hook-live-${randomUUID()}`);
  mkdirSync(packageDir,{mode:0o700});mkdirSync(work,{mode:0o700});
  const cli=path.join(packageDir,`quotum${suffix}`);copyFileSync(originalCli,cli);chmodSync(cli,0o755);
  copyHook(payloads,`${process.platform}-${process.arch}`,version,packageDir);
  const user=path.join(work,'user'),project=path.join(work,'project');
  mkdirSync(user,{mode:0o700});mkdirSync(path.join(project,'.claude'),{recursive:true,mode:0o700});
  writeFileSync(path.join(user,'settings.json'),JSON.stringify({fixture:true}));
  const env={CLAUDE_CONFIG_DIR:user,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'])env[key]='';
  let enabled=false,kept=false;
  try {
    run(cli,['hook','enable'],env);enabled=true;
    const manifestPath=path.join(root,'manifest.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    const settings=JSON.parse(readFileSync(path.join(user,'settings.json'),'utf8'));
    const handler=settings.hooks.SessionStart[0].hooks[0];
    assert.equal(path.normalize(handler.command),path.join(root,`quotum-hook${suffix}`));
    assert.deepEqual(handler.args,['--generation',manifest.installationGeneration]);
    const records=()=>readdirSync(path.join(root,'records')).filter(name=>name.endsWith('.json'));
    const canary='QUOTUM_LIVE_SECRET_CANARY';
    const scenes=[
      {name:'subscription',project:{},env:{},record:true},
      {name:'project-api',project:{env:{ANTHROPIC_API_KEY:canary,ANTHROPIC_BASE_URL:`https://${canary}:${canary}@openrouter.ai/${canary}?${canary}#${canary}`}},env:{},record:true},
      {name:'scrub',project:{},env:{ANTHROPIC_API_KEY:canary,ANTHROPIC_AUTH_TOKEN:canary,CLAUDE_CODE_OAUTH_TOKEN:canary,CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:'1'},record:true},
      {name:'bare',project:{},env:{},record:false,bare:true},
      {name:'policy',project:{disableAllHooks:true},env:{},record:false},
    ];
    for(const scene of scenes) {
      console.log(`Native hook case: ${scene.name}.`);
      writeFileSync(path.join(project,'.claude/settings.json'),JSON.stringify(scene.project));
      const before=new Set(records());
      const output=run(claude,['--init-only',...scene.bare?['--bare']:[]],{...env,...scene.env},project);
      assert.equal(output.stdout,'');assert.equal(output.stderr,'');
      const fresh=records().filter(name=>!before.has(name));
      assert.equal(fresh.length,scene.record?1:0,scene.name+': native parent binding or hook discovery unavailable');
      if(!scene.record)continue;
      const raw=readFileSync(path.join(root,'records',fresh[0]),'utf8');
      assert.ok(!raw.includes(canary));
      const record=JSON.parse(raw);
      assert.equal(record.installationGeneration,manifest.installationGeneration);
      assert.ok(record.parentPid>0&&record.nativeBirth.length>0);
      if(scene.name==='subscription')assert.equal(record.flags.apiKey,false);
      if(scene.name==='project-api'){assert.equal(record.flags.apiKey,true);assert.equal(record.flags.host,'openrouter.ai');}
      if(scene.name==='scrub'){assert.equal(record.flags.scrubbed,true);assert.equal(record.flags.apiKey,false);}
    }
    const marker={cli,work,package:packageDir,generation:manifest.installationGeneration,sha256:manifest.payload.sha256};
    // Only ordinary native startup can finish this journal; explicit smoke stays fake.
    manifest.stage='installing';writeFileSync(manifestPath,JSON.stringify(manifest));
    writeFileSync(receipt,JSON.stringify(marker),{mode:0o600});
    if(args.includes('--keep-consent'))kept=true;
    else {run(cli,['config'],env);finish(marker);enabled=false;}
    console.log('Native hook: five live Claude cases passed with silent output and secret canaries.');
  } finally {
    if(!kept&&enabled) {
      run(cli,['hook','disable'],env);assert.equal(existsSync(root),false);
      rmSync(work,{recursive:true,force:true});rmSync(packageDir,{recursive:true,force:true});rmSync(receipt,{force:true});
    }
  }
}
