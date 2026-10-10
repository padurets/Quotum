import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync, renameSync, openSync, closeSync, fstatSync, readSync} from 'node:fs';
import path from 'node:path';

/** Only the synthetic test's classifications and owned process identities leave its fixture. */
export function fixtureEvidence(name) {
  const directory = process.env.QUOTUM_TEST_DIAGNOSTICS_DIR && path.join(process.env.QUOTUM_TEST_DIAGNOSTICS_DIR, randomUUID());
  const records = [], start = performance.now();
  let writeFailed = false, omitted = 0;
  let sha = null;
  try {sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000}).trim();} catch {}
  const save = () => {
    if (!directory) return;
    try {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const text = JSON.stringify(records), bytes = Buffer.byteLength(text);
    const payload = bytes <= 1_048_576 ? text : JSON.stringify({status: 'insufficient-evidence', originalBytes: bytes});
    const write = (file, body) => {writeFileSync(path.join(directory, file + '.tmp'), body, {mode: 0o600}); renameSync(path.join(directory, file + '.tmp'), path.join(directory, file));};
    write('phases.json', payload);
    write('manifest.json', JSON.stringify({schemaVersion: 1, fixture: name, sha, run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
      node: process.version, platform: process.platform, writeFailed, omitted, files: [{name: 'phases.json', bytes: Buffer.byteLength(payload), sha256: createHash('sha256').update(payload).digest('hex')}]}));
    } catch {writeFailed = true;}
  };
  const record = (phase, state, code) => {
    if (records.length >= 1000) {omitted++; save(); return;}
    const identity = value => value ? {pid: value.pid, group: value.group, birth: value.birth, start: value.start} : null;
    let output;
    if (state?.log) {
      let fd;
      try {
        fd = openSync(state.log, 'r'); const bytes = Buffer.alloc(16_000), size = fstatSync(fd).size;
        const text = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length))).toString();
        output = {bytes: size, portInUse: text.includes('"code":"port_in_use"'), errorCodes: [...new Set(text.match(/\bE[A-Z]{2,20}\b/g))],
          readinessFailed: text.includes('Hub did not get ready'), listenerMismatch: text.includes('Ready hub does not own')};
      } catch {} finally {if (fd !== undefined) closeSync(fd);}
    }
    records.push({phase, at: performance.now() - start, mode: state?.mode, status: state?.status, port: state?.port,
      failureCode: state?.failureCode, code: /^[A-Z_]+$/.test(code ?? '') ? code : undefined,
      supervisor: identity(state?.supervisor), hub: identity(state?.hub), output});
    save();
  };
  record('initial');
  return {record};
}
