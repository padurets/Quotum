import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ChromeLaunchError, launchedChrome, launchChrome, probeFailure, safeStream, StartupSpans, type LaunchReport} from '../chrome.js';

const until = async (ready: () => boolean) => {
  const deadline = Date.now() + 4_000;
  while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(ready(), 'the real stand-in reached its synchronization point');
};

function fixture(t: TestContext, mode = 'ready', holdPort = false) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'quotum-chrome-test-'));
  const workers=new Set<number>();
  // This is a real process with real pipes and a real listening socket, not an installed browser.
  const script = `
    const fs = require('node:fs'), http = require('node:http'), cp = require('node:child_process');
    const profile = process.argv[1], mode = process.argv[2], holdPort = process.argv[3] === 'true';
    if (mode === 'exit') process.exit(7);
    if (mode === 'term-ignore') process.on('SIGTERM', () => {});
    const server = http.createServer((req, res) => {
      fs.writeFileSync(profile+'/requested','');
      if (mode === 'headers-hang') return;
      if (mode === 'body-hang') {res.writeHead(200);res.write('{');return;}
      if (mode === 'oversize') {res.end('x'.repeat(17000));return;}
      if (mode === 'redirect') {res.writeHead(302, {location:'http://127.0.0.1:1/private'});res.end();return;}
      const port = server.address().port;
      const reply = () => res.end(JSON.stringify({Browser:'Chrome/fixture',webSocketDebuggerUrl:'ws://127.0.0.1:'+port+'/devtools/browser/'+(mode === 'mismatch'?'foreign':'fixture')}));
      if (mode === 'body-delay') {res.writeHead(200);res.flushHeaders();}
      if (mode === 'headers-delay' || mode === 'body-delay') setTimeout(reply, 1200); else reply();
    }).listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      if (mode !== 'no-port' && !holdPort) fs.writeFileSync(profile+'/DevToolsActivePort', (mode === 'invalid'?'65536':port)+'\\n/devtools/browser/fixture\\n');
      if (mode === 'worker' || mode === 'escaped-worker') {
        const worker=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:mode==='escaped-worker',stdio:mode==='escaped-worker'?'ignore':['ignore','inherit','inherit']});
        fs.writeFileSync(profile+'/worker',String(worker.pid));
      }
      fs.writeFileSync(profile+'/started.tmp',String(port));
      fs.renameSync(profile+'/started.tmp',profile+'/started');
    });
  `;
  const child = spawn(process.execPath, ['-e', script, profile, mode, String(holdPort)], {detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
  t.mock.method(console, 'error', () => {});
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (existsSync(profile + '/worker')) workers.add(Number(readFileSync(profile + '/worker', 'utf8')));
    for(const pid of workers){
      try {process.kill(pid, 'SIGKILL');} catch {}
    }
    rmSync(profile, {recursive: true, force: true});
  });
  return {profile, child, publishPort: () => {
    const port = readFileSync(profile+'/started','utf8');
    writeFileSync(profile+'/DevToolsActivePort', port+'\n/devtools/browser/fixture\n');
  }, launch: async(signal?: AbortSignal, progress?: (report: LaunchReport) => void, startedAt?:number) => {
    const browser=await launchedChrome(child, profile, process.platform !== 'win32', signal, 'stand-in', progress, startedAt);
    if(existsSync(profile+'/worker'))workers.add(Number(readFileSync(profile+'/worker','utf8')));
    return browser;
  }};
}

test('silent real DevTools readiness and idempotent cleanup close the endpoint and profile', async t => {
  const {profile, launch} = fixture(t);
  const browser = await launch();
  assert.equal((browser.launchReport!() as {version: string}).version, 'Chrome/fixture');
  if(process.platform==='linux'){
    const report=browser.launchReport!() as LaunchReport;
    assert.equal(report.startupSamples?.status,'available');
    assert.equal(report.startupSamples?.omitted,0);
    assert.ok(report.startupSamples!.samples.every(sample=>sample.pid===report.pid&&sample.userTicks!==null&&sample.majorFaults!==null));
    assert.ok(report.portMs!<=report.readyMs!);
    const rows = await browser.observeProcesses!(new AbortController().signal);
    assert.ok(rows.some(row => row.pid === report.pid && row.birth && row.userTicks !== null));
    assert.ok(rows.every(row => row.group === report.pid && row.session === report.pid), 'only the owned stand-in group is retained');
    assert.ok(!rows.some(row => row.pid === process.pid), 'the observing process is not owned');
    const abort = new AbortController(), reason = new Error('process read cancelled');
    const cancelled = browser.observeProcesses!(abort.signal); abort.abort(reason);
    await assert.rejects(cancelled, error => error === reason);
  }
  assert.equal((await fetch(browser.endpoint + '/json/version')).status, 200);
  await browser.close(); await browser.close();
  assert.equal(existsSync(profile), false);
  await assert.rejects(fetch(browser.endpoint + '/json/version'));
});

test('prior startup work leaves only the remainder of the original twenty seconds',async t=>{
  const {profile,launch}=fixture(t,'headers-delay');
  const startedAt=performance.now()-19_500;
  await assert.rejects(launch(undefined,undefined,startedAt),error=>{
    assert.ok(error instanceof ChromeLaunchError);assert.equal(error.report.cleanup?.status,'closed');
    assert.ok(error.report.elapsedMs>=19_900);return true;
  });
  assert.equal(existsSync(profile),false);
});

test('an already expired startup window cannot receive a fresh readiness allowance',async t=>{
  const {profile,launch}=fixture(t);
  await assert.rejects(launch(undefined,undefined,performance.now()-20_001),error=>{
    assert.ok(error instanceof ChromeLaunchError);assert.equal(error.report.cleanup?.status,'closed');return true;
  });
  assert.equal(existsSync(profile),false);
});

test('a future startup timestamp cannot extend the fixed readiness budget',async t=>{
  const {profile,launch}=fixture(t);
  await assert.rejects(launch(undefined,undefined,performance.now()+5_000),error=>{
    assert.ok(error instanceof ChromeLaunchError);assert.equal(error.report.cleanup?.status,'closed');return true;
  });
  assert.equal(existsSync(profile),false);
});

for (const mode of ['headers-delay', 'body-delay']) test(`finite slow ${mode} readiness uses the remaining startup budget`, async t => {
  const {profile, launch} = fixture(t, mode);
  const browser = await launch(AbortSignal.timeout(3500));
  try {
    const report = browser.launchReport!() as LaunchReport;
    assert.equal(report.stage, 'ready'); assert.equal(report.version, 'Chrome/fixture');
    assert.equal(report.probes!.attempts, 1, 'a valid slow response must not be cancelled and retried');
    assert.ok(report.probes!.elapsedMs >= 1100, 'the real HTTP response exceeded the former per-probe cutoff');
  } finally {await browser.close();}
  assert.equal(existsSync(profile), false);
});

test('an unfinished body exhausts the original twenty-second startup deadline and is cancelled', {timeout: 30_000}, async t => {
  const {profile, launch} = fixture(t, 'body-hang');
  await assert.rejects(launch(), error => {
    assert.ok(error instanceof ChromeLaunchError);
    assert.equal(error.report.failure, 'endpoint-unreachable');
    assert.equal(error.report.probes!.stage, 'body');
    assert.equal(error.report.probes!.attempts, 1);
    assert.ok(error.report.elapsedMs >= 19_900);
    assert.equal(error.report.cleanup!.status, 'closed');
    return true;
  });
  assert.equal(existsSync(profile), false);
});

test('a port file timestamp cannot authorize publication or replace real silent readiness', async t => {
  const {profile, launch, publishPort} = fixture(t, 'ready', true);
  const reports: LaunchReport[] = [];
  const pending = launch(undefined, report => {reports.push(report);});
  await until(() => existsSync(profile + '/started') && reports.some(report => report.failure === 'no-port'));
  publishPort();
  const future = new Date('2099-01-01T00:00:00Z');
  utimesSync(profile + '/DevToolsActivePort', future, future);
  const browser = await pending, report = browser.launchReport!() as LaunchReport;
  assert.equal(report.stage, 'ready'); assert.equal(report.version, 'Chrome/fixture');
  assert.ok(reports.length > 0 && reports.every(value => value.startupSpans === undefined), 'polling does not export the passive ring');
  const spans = report.startupSpans!;
  assert.equal(spans.status, 'observed'); assert.equal(spans.publicationProof, false);
  assert.equal(spans.clockMapping.status, 'unknown'); assert.equal(spans.observerOverheadMs, null);
  const scan = spans.scans.find(value => value.metadata?.status === 'available')!;
  assert.ok(scan && scan.observeFrom && scan.observeTo && scan.portFrom && scan.portTo);
  assert.ok(scan.observeTo.monoAfterMs <= scan.portFrom.monoBeforeMs);
  assert.equal(scan.metadata!.before!.modifiedWallMs, future.getTime());
  assert.ok(scan.metadata!.before!.modifiedWallMs > scan.portTo.wallMs, 'mtime remains a proxy outside the observed wall bracket');
  const probe = spans.probes.at(-1)!;
  assert.ok(probe.from && probe.headers && probe.body && probe.parse && probe.jsonTo && probe.to);
  assert.ok(probe.headers.monoBeforeMs <= probe.body.monoBeforeMs && probe.body.monoBeforeMs <= probe.parse.monoBeforeMs
    && probe.parse.monoBeforeMs <= probe.jsonTo.monoBeforeMs && probe.jsonTo.monoBeforeMs <= probe.to.monoBeforeMs);
  const frozen = JSON.stringify(spans);
  await browser.close(); await browser.close();
  assert.equal(JSON.stringify((browser.launchReport!() as LaunchReport).startupSpans), frozen, 'cleanup cannot revise startup observations');
  assert.equal(existsSync(profile), false);
  await assert.rejects(fetch(browser.endpoint + '/json/version'));
});

test('publication between a port scan and its wait wakes full validation without a polling tick', {timeout: 15_000}, async t => {
  const {profile, launch, publishPort} = fixture(t, 'ready', true);
  await until(() => existsSync(profile + '/started'));
  const controller = new AbortController();
  const cancel = () => {t.mock.timers.reset(); controller.abort();};
  t.signal.addEventListener('abort', cancel, {once: true});
  t.mock.timers.enable({apis: ['setTimeout']});
  let published = false, browser: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    browser = await launch(controller.signal, report => {
      if (!published && report.failure === 'no-port') {published = true; publishPort();}
    });
    const report = browser.launchReport!() as LaunchReport;
    assert.equal(published, true); assert.equal(report.stage, 'ready');
    assert.equal(report.version, 'Chrome/fixture'); assert.equal(report.probes!.attempts, 1);
  } finally {
    t.mock.timers.reset(); t.signal.removeEventListener('abort', cancel);
    if (browser) await browser.close();
  }
  assert.equal(existsSync(profile), false);
});

test('startup span tails retain omissions and cannot rewrite a terminal receipt', () => {
  const spans = new StartupSpans();
  let last: ReturnType<StartupSpans['scan']>;
  for (let i = 0; i < 51; i++) {last = spans.scan(); last.observeTo = spans.clock();}
  for (let i = 0; i < 66; i++) {const probe = spans.probe(); probe.to = spans.clock();}
  const report = spans.freeze(), frozen = JSON.stringify(report);
  assert.equal(report.status, 'incomplete'); assert.equal(report.scans.length, 48); assert.equal(report.omittedScans, 3);
  assert.equal(report.probes.length, 64); assert.equal(report.omittedProbes, 2);
  assert.equal(report.scans.at(-1)!.id, 51); assert.equal(report.probes.at(-1)!.id, 66);
  last!.observeTo = null; spans.scan(); spans.probe();
  assert.equal(spans.freeze(), report); assert.equal(JSON.stringify(report), frozen);
  assert.equal(report.publicationProof, false);

  const pending = new StartupSpans(), scan = pending.scan(), probe = pending.probe(), completed = pending.clock();
  const partial = pending.freeze(), partialJSON = JSON.stringify(partial);
  assert.equal(partial.status, 'incomplete'); assert.equal(partial.omittedScans, 0); assert.equal(partial.omittedProbes, 0);
  assert.equal(partial.scans[0].observeTo, null); assert.equal(partial.probes[0].to, null);
  scan.observeTo = completed; probe.to = completed;
  assert.equal(JSON.stringify(pending.freeze()), partialJSON, 'late completion cannot fill a censored operation');
});

test('an invalid diagnostic wall clock stays unavailable without a publication claim', t => {
  t.mock.method(Date, 'now', () => NaN);
  const spans = new StartupSpans(); spans.scan();
  const report = spans.freeze();
  assert.equal(report.status, 'unavailable'); assert.ok(report.unavailableClocks > 0);
  assert.equal(report.scans[0].observeFrom, null); assert.equal(report.terminal, null);
  assert.equal(report.publicationProof, false); assert.equal(report.clockMapping.status, 'unknown');
});

test('early process exit and missing executable fail promptly and remove owned profiles', async t => {
  const {profile, launch} = fixture(t, 'exit');
  await assert.rejects(launch(), /early-exit/);
  assert.equal(existsSync(profile), false);
  await assert.rejects(launchChrome('/nonexistent/quotum-test-chrome', true), /spawn-error/);
});

test('pre-aborted startup creates no process', async () => {
  await assert.rejects(launchChrome('/nonexistent/quotum-test-chrome', true, AbortSignal.abort()), /cancelled/);
});

for (const mode of ['no-port', 'invalid', 'mismatch', 'redirect', 'headers-hang', 'body-hang', 'oversize']) {
  test(`cancelled ${mode} startup never grants readiness and closes its owned endpoint`, async t => {
    const hangs = mode === 'headers-hang' || mode === 'body-hang';
    const {profile, launch, publishPort} = fixture(t, mode, hangs), controller = new AbortController();
    let ready = false;
    let observed: LaunchReport | undefined;
    let failure: Partial<Pick<LaunchReport, 'stage'|'failure'|'probes'|'startupSpans'>> | undefined;
    const pending = launch(controller.signal, report => {observed = report;}).then(browser => {ready = true; return browser.close();});
    const outcome = pending.then(() => ({rejected: false, error: undefined}), (error: unknown) => ({rejected: true, error}));
    try {
      await until(() => existsSync(profile + '/started'));
      const port = readFileSync(profile + '/started', 'utf8');
      assert.match(port, /^[1-9]\d{0,4}$/);
      assert.ok(Number(port) <= 65535, 'the stand-in published its listening port');
      if (hangs) {
        // A listening child need not have published its endpoint or received a probe yet.
        await until(() => observed?.failure === 'no-port');
        assert.equal(observed?.probes, undefined);
        assert.equal(existsSync(profile+'/requested'), false);
        publishPort();
        await until(() => observed?.probes?.stage === (mode === 'headers-hang' ? 'headers' : 'body')
          && existsSync(profile+'/requested'));
      } else if (mode === 'no-port' || mode === 'invalid') {
        await until(() => observed?.failure === (mode === 'no-port' ? 'no-port' : 'invalid-port'));
      } else {
        await until(() => Object.keys(observed?.probes?.failures ?? {}).length > 0);
      }
      assert.equal(ready, false); controller.abort();
      const result = await outcome; assert.equal(result.rejected, true);
      const error = result.error;
      assert.ok(error instanceof ChromeLaunchError);
      assert.equal(error.report.failure,'cancelled');
      assert.equal(error.report.cleanup?.status,'closed');
      if(mode==='headers-hang'||mode==='body-hang') {
        assert.equal(error.report.probes?.stage,mode==='headers-hang'?'headers':'body');
        assert.ok(error.report.probes!.attempts>0);
        assert.ok(error.report.port!>0);
        const spans = error.report.startupSpans!, probe = spans.probes.at(-1)!;
        assert.ok(spans.scans.length > 0 && spans.scans.length <= 48 && spans.probes.length > 0 && spans.probes.length <= 64);
        assert.ok(probe.headers); assert.equal(probe.parse, null); assert.equal(probe.jsonTo, null);
        if (mode === 'headers-hang') assert.equal(probe.body, null); else assert.ok(probe.body);
        if (probe.to === null) assert.equal(spans.status, 'incomplete', 'cancellation cannot invent an operation end');
        assert.equal(spans.publicationProof, false); assert.equal(spans.clockMapping.status, 'unknown');
      }
      assert.equal(existsSync(profile), false);
      await assert.rejects(fetch('http://127.0.0.1:' + port));
    } catch (error) {
      if (error instanceof Error) {
        failure = {stage: observed?.stage, failure: observed?.failure, probes: observed?.probes && {...observed.probes, failures: {...observed.probes.failures}}};
        error.cause ??= failure;
      }
      throw error;
    } finally {
      // A failed phase handshake must drain startup without replacing its own error.
      controller.abort(); const result = await outcome;
      if (failure && result.error instanceof ChromeLaunchError) failure.startupSpans = result.error.report.startupSpans;
    }
  });
}

test('an owned worker that survives its parent receives escalation and cannot retain pipes', {skip: process.platform !== 'linux'}, async t => {
  const {profile, launch} = fixture(t, 'worker');
  const browser = await launch();
  const worker = Number(readFileSync(profile + '/worker', 'utf8'));
  await browser.close();
  assert.equal(existsSync(profile), false);
  const stat = (() => {try {return readFileSync(`/proc/${worker}/stat`, 'utf8');} catch {return '';}})();
  assert.ok(!stat || /\) Z /.test(stat), 'worker exited, even if the platform has not reaped its zombie yet');
});

test('an escaped owned worker cannot authorize another group signal or a successful cleanup', {skip:process.platform!=='linux'},async t=>{
  const {profile,launch}=fixture(t,'escaped-worker');
  const browser=await launch(),worker=Number(readFileSync(profile+'/worker','utf8'));
  await assert.rejects(browser.close(),/cleanup unconfirmed/);
  assert.equal(existsSync(profile),true,'the profile stays while an observed owner remains alive');
  process.kill(worker,0);
  assert.equal((browser.launchReport!() as {cleanup:{status:string;pipesClosed:boolean}}).cleanup.status,'residual');
});

test('probe failure categories never copy a raw network error or its cause',()=>{
  assert.equal(probeFailure({message:'private path',cause:{code:'ECONNREFUSED',message:'secret-canary'}},false),'ECONNREFUSED');
  assert.equal(probeFailure({cause:{code:'secret-canary'}},false),'unavailable');
  assert.equal(probeFailure(new SyntaxError('secret-canary'),false),'invalid-json');
  assert.equal(probeFailure(new Error('secret-canary'),true),'cancelled-or-deadline');
});

test('stream evidence omits secrets, private paths and arbitrary text while counting truncation', () => {
  const stream = safeStream();
  stream.add('token=secret-canary /home/private /private/workspace https://private.invalid\n');
  stream.add('DevTools listening on ws://127.0.0.1:32123/devtools/browser/fixture\n');
  stream.add('x'.repeat(5000));
  const result = stream.read();
  assert.equal(result.counts['devtools-announcement'], 1);
  assert.ok(result.discardedBytes > 5000); assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-canary|private|5000x/);
});

test('interrupting the actual entry point during startup reaps its detached browser and removes its profile',
  {skip: process.platform === 'win32'}, async t => {
    const root = mkdtempSync(path.join(tmpdir(), 'quotum-test-bench-signal-'));
    const recordFile = path.join(root, 'started.json'), executable = path.join(root, 'chrome');
    writeFileSync(executable, '#!/usr/bin/env node\n'
      + "const fs=require('node:fs');\n"
      + "const profile=process.argv.find(value=>value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);\n"
      + "fs.writeFileSync(process.env.QUOTUM_BENCH_TEST_RECORD,JSON.stringify({pid:process.pid,profile}));\n"
      + "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n", {mode: 0o755});
    const env = {...process.env};
    for (const key of Object.keys(env)) if (key.startsWith('QUOTUM_')) delete env[key];
    env.QUOTUM_CHROME = executable; env.QUOTUM_BENCH_TEST_RECORD = recordFile; env.CI = '1';
    const bench = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/starting-bench.mjs', import.meta.url))], {
      cwd: new URL('../../', import.meta.url), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', owned: {pid: number; profile: string} | undefined;
    bench.stdout.on('data', value => {output += value;}); bench.stderr.on('data', value => {output += value;});
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve =>
      bench.once('exit', (code, signal) => resolve({code, signal})));
    const signal = (pid: number) => {try {process.kill(-pid, 'SIGKILL');} catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }};
    t.after(async () => {
      if (!owned && existsSync(recordFile)) owned = JSON.parse(readFileSync(recordFile, 'utf8'));
      if (owned && existsSync(owned.profile)) {signal(owned.pid); rmSync(owned.profile, {recursive: true, force: true});}
      if (bench.exitCode === null && bench.signalCode === null) {signal(bench.pid!); await exited;}
      rmSync(root, {recursive: true, force: true});
    });
    const startedBy = Date.now() + 5_000;
    while (!existsSync(recordFile) && Date.now() < startedBy) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(recordFile), output);
    owned = JSON.parse(readFileSync(recordFile, 'utf8'));
    process.kill(-bench.pid!, 'SIGINT');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('benchmark cancellation did not finish\n' + output)), 9_000);
    })]).finally(() => clearTimeout(deadline));
    assert.equal(result.code, 1, output);
    assert.throws(() => process.kill(owned!.pid, 0), {code: 'ESRCH'});
    assert.equal(existsSync(owned!.profile), false, output);
  });
