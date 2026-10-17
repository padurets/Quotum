import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixtureEvidence} from './evidence.mjs';

test('fixture evidence persists classifications without private configuration or raw output', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'quotum-evidence-'));
  const previous = process.env.QUOTUM_TEST_DIAGNOSTICS_DIR;
  process.env.QUOTUM_TEST_DIAGNOSTICS_DIR = root;
  t.after(() => {if (previous === undefined) delete process.env.QUOTUM_TEST_DIAGNOSTICS_DIR; else process.env.QUOTUM_TEST_DIAGNOSTICS_DIR = previous; rmSync(root, {recursive:true,force:true});});
  const log = path.join(root, 'private.log');writeFileSync(log, 'private-canary\nEACCES\n{"code":"port_in_use"}\n');
  const evidence=fixtureEvidence('bind-race');
  evidence.record('before-stop', {log, config:{secret:'private-canary'}, root:'private-canary', failureCode:'PORT_BUSY', supervisor:{pid:1,start:'2',group:1}}, 'PORT_BUSY');
  const directory=path.join(root,readdirSync(root).find(name=>name!=='private.log'));
  const text=readFileSync(path.join(directory,'phases.json'),'utf8');
  assert.ok(!text.includes('private-canary') && !text.includes(root));
  assert.deepEqual(JSON.parse(text)[1].output, {bytes:Buffer.byteLength(readFileSync(log)),portInUse:true,errorCodes:['EACCES'],readinessFailed:false,listenerMismatch:false});
  process.env.QUOTUM_TEST_DIAGNOSTICS_DIR=log;
  assert.doesNotThrow(()=>fixtureEvidence('unwritable').record('before-cleanup'));
});
