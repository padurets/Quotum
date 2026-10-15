// Temporary startup control; the normal benchmark launcher is unchanged.
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const identity = (file: string) => {
  const s = statSync(file, {bigint: true});
  if (!s.isFile()) throw new Error('control requires an existing regular file');
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(k => [k, String(s[k as keyof typeof s])]));
};

// Specific 5 s cache-helper supervisor; exported only for the parent's fixed stand-ins.
export function cacheHelper(command: string, args: string[], signal: AbortSignal): Promise<any> {
  return new Promise(resolve => {
    const started = performance.now();
    let child: ReturnType<typeof spawn> | undefined, settled = false, bytes = 0, text = '';
    let exited = false, stdoutEnd = false, stderrEnd = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (body?: any) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort);
      const helper = {elapsedMs: performance.now() - started, exited, stdoutEnd, stderrEnd, bytes,
        status: body ? 'closed-drained' : 'unconfirmed'};
      // Pending inherited pipes do not keep the caller or this first outcome alive.
      child?.unref(); (child?.stdout as any)?.unref?.(); (child?.stderr as any)?.unref?.();
      resolve(body ? {...body, helper} : {status: 'unavailable', reason: 'cache-helper-unconfirmed', abortExperiment: true, helper});
    };
    const abort = () => finish();
    if (signal.aborted) {finish(); return;}
    signal.addEventListener('abort', abort, {once: true});
    timer = setTimeout(() => finish(), 5000); // Independent of child exit/close and pipe EOF.
    try {child = spawn(command, args, {env: process.env, stdio: ['ignore', 'pipe', 'pipe']});}
    catch {finish(); return;}
    const data = (chunk: Buffer, stdout: boolean) => {
      if (settled) return; bytes += chunk.length;
      if (bytes > 8192) {finish(); return;}
      if (stdout) text += chunk.toString('utf8');
    };
    child.stdout!.on('data', chunk => data(chunk, true)); child.stderr!.on('data', chunk => data(chunk, false));
    child.stdout!.on('end', () => {stdoutEnd = true;}); child.stderr!.on('end', () => {stderrEnd = true;});
    child.stdout!.on('error', () => finish()); child.stderr!.on('error', () => finish());
    child.on('error', () => finish()); child.on('exit', () => {exited = true;});
    child.on('close', (code, exitSignal) => {
      if (settled) return;
      if (performance.now() - started >= 5000 || signal.aborted || code !== 0 || exitSignal || !exited || !stdoutEnd || !stderrEnd) {finish(); return;}
      try {
        const body = JSON.parse(text);
        if (!body || !['cold-snapshot', 'unavailable'].includes(body.status) ||
            (body.status === 'cold-snapshot' && !(body.adviceCalls === 1 && body.mincoreCalls === 1 && body.residentPages === 0 &&
              Number.isSafeInteger(body.pages) && body.pages > 0 && body.isolatedCiAttested === true))) {finish(); return;}
        finish(body);
      } catch {finish();}
    });
  });
}

export async function prepareArm(launcher: string, lane: number, attempt: number, signal: AbortSignal) {
  if (![1, 2, 3].includes(lane) || ![1, 2].includes(attempt) || !path.isAbsolute(launcher)) throw new Error('invalid fixed control arm');
  const arm = (lane === 2 ? ['B', 'A'] : ['A', 'B'])[attempt - 1];
  const directory = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'quotum-startup-read-'));
  const config = {arm, lane, attempt, launcher, elf: '/opt/google/chrome/chrome', isolatedCiAttested: true,
    expected: identity('/opt/google/chrome/chrome'), nonce: path.basename(directory)};
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config), {mode: 0o600});
  const file = path.join(directory, 'launch');
  writeFileSync(file, readFileSync(path.join(import.meta.dirname, 'wrapper.py')), {mode: 0o700});
  // One attempt only. No install, cache retry, fallback, or Chrome launch on unknown qualification.
  const qualification = await cacheHelper('/usr/bin/sudo', ['-n', '--preserve-env=CI,GITHUB_ACTIONS',
    '/usr/bin/timeout', '--kill-after=0.5s', '4s', '/usr/bin/python3', path.join(import.meta.dirname, 'cache.py'), directory], signal);
  return {arm, file, directory, qualification};
}

export function goGate(directory: string, signal: AbortSignal, observe: (report: any) => void) {
  const go = path.join(directory, 'GO'), nonce = path.basename(directory);
  const receipt: Record<string, unknown> = {status: 'waiting', firstReportAt: null, launchCallReturnedAt: null,
    immediateAt: null, writeIssuedAt: null, writeCompletedAt: null, pending: false};
  let active = true, queued: NodeJS.Immediate | undefined, first = true, sealed = false;
  const stop = () => {active = false; if (queued) clearImmediate(queued);};
  signal.addEventListener('abort', stop, {once: true});
  if (signal.aborted) stop();
  return {
    observe(report: any) {
      observe(report);
      if (report.cleanup || report.startupSpans || report.exit || report.spawnCode) stop();
      if (!first || !active || report.stage !== 'spawn') return;
      first = false; receipt.firstReportAt = performance.now();
      queued = setImmediate(() => {
        receipt.immediateAt = performance.now();
        if (!active || signal.aborted || receipt.launchCallReturnedAt === null ||
            performance.now() - Number(receipt.firstReportAt) >= 20_000) {receipt.status = 'unavailable'; return;}
        receipt.writeIssuedAt = performance.now(); receipt.pending = true;
        // Non-atomic async publication is accepted only after the wrapper reads the full nonce.
        void writeFile(go, nonce, {flag: 'wx', mode: 0o600, signal}).then(() => {
          if (sealed) return; receipt.writeCompletedAt = performance.now(); receipt.pending = false;
          receipt.status = active && !signal.aborted ? 'released' : 'unavailable';
        }, () => {if (!sealed) {receipt.pending = false; receipt.status = 'unavailable';}});
      });
    },
    returned() {receipt.launchCallReturnedAt = performance.now();},
    close() {
      stop(); signal.removeEventListener('abort', stop);
      if (receipt.pending) receipt.status = 'unavailable';
      sealed = true;
      // An in-flight fs operation may finish after this snapshot: retain the directory and censor it.
      return {...receipt};
    },
  };
}
