import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {namedCounters,pressureCounters,processCounters,StartupSampler,startupTrials} from '../startupDiagnostic.js';
import {Evidence,safeEvidence} from '../evidence.js';
import type {LaunchReport} from '../chrome.js';
import {RunOwner} from '../runOwner.js';

test('startup counters preserve units and omit process names and unselected fields',()=>{
  const fields=Array.from({length:50},(_,i)=>String(i));fields[0]='D';
  const parsed=processCounters('99 (private name ) secret) '+fields.join(' '));
  assert.deepEqual(parsed,{state:'D',parent:1,birth:19,minorFaults:7,majorFaults:9,userTicks:11,systemTicks:12,threads:17,blockIoTicks:39});
  assert.equal(processCounters(null),null);assert.equal(processCounters('not a stat'),null);
  assert.deepEqual(pressureCounters('some avg10=3.2 avg60=1.0 avg300=0.1 total=987\nfull avg10=0.0 avg60=0.0 avg300=0.0 total=32\n'),{some:987,full:32});
  assert.equal(pressureCounters(null),null);
  assert.deepEqual(namedCounters('read_bytes: 2048\nprivate: 999\nwrite_bytes: 12\n',['read_bytes','write_bytes']),{read_bytes:2048,write_bytes:12});
  assert.doesNotMatch(JSON.stringify(parsed),/private|secret/);
});

test('startup sampling follows only supplied process identities and records unavailable evidence', {skip:process.platform!=='linux'},async t=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  t.after(async()=>{child.kill();await exit;});
  const counter=processCounters(await readFile(`/proc/${child.pid}/stat`,'utf8'))!;
  let result:unknown;
  const sampler=new StartupSampler(value=>{result=structuredClone(value);});
  sampler.observe({pid:child.pid,stage:'spawn',elapsedMs:0,processes:[{pid:child.pid!,birth:String(counter.birth)}]} as LaunchReport);
  await sampler.start();await sampler.stop();
  const captured=JSON.parse(JSON.stringify(safeEvidence(result)));
  assert.equal(captured.samples.length,2);assert.equal(captured.omitted,0);
  assert.equal(captured.samples[0].tasks[0].pid,child.pid);
  assert.equal(captured.samples[0].tasks[0].birth,counter.birth);
  assert.ok(captured.samples[0].collectionMs>=0);
  assert.doesNotMatch(JSON.stringify(captured),/setInterval|node_modules|\/home\/|commandLine/);
  let recycled:unknown;
  const wrong=new StartupSampler(value=>{recycled=value;});
  wrong.observe({pid:child.pid,stage:'spawn',elapsedMs:0,processes:[{pid:child.pid!,birth:String(counter.birth!+1)}]} as LaunchReport);
  await wrong.start();await wrong.stop();
  assert.deepEqual((recycled as {samples:{tasks:unknown[]}[]}).samples[0].tasks,[null]);
});

test('the fixed launch pair retains a failed first launch even when the second is ready', {skip:process.platform!=='linux'},async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'quotum-startup-pair-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  t.mock.method(console,'error',()=>{});
  const executable=path.join(root,'chrome'),counter=path.join(root,'count');
  writeFileSync(executable,`#!/usr/bin/env node
const fs=require('node:fs'),http=require('node:http');
const counter=${JSON.stringify(counter)};
const count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1;fs.writeFileSync(counter,String(count));
if(count===1)process.exit(7);
const profile=process.argv.find(arg=>arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const server=http.createServer((req,res)=>res.end(JSON.stringify({Browser:'Chrome/fixture',webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+'/devtools/browser/fixture'})));
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(profile+'/DevToolsActivePort',server.address().port+'\\n/devtools/browser/fixture\\n'));
`,{mode:0o755});
  const directory=path.join(root,'evidence'),evidence=new Evidence(directory),owner=new RunOwner(evidence);
  t.after(()=>owner.close());
  assert.equal(await startupTrials(executable,true,owner,evidence),1);
  assert.equal(readFileSync(counter,'utf8'),'2');
  const folder=path.join(directory,readdirSync(directory)[0]);
  const first=JSON.parse(readFileSync(path.join(folder,'startup-1-result.json'),'utf8'));
  const second=JSON.parse(readFileSync(path.join(folder,'startup-2-result.json'),'utf8'));
  assert.equal(first.status,'failed');assert.equal(first.browser.failure,'early-exit');
  assert.equal(first.browser.cleanup.status,'closed');assert.equal(second.status,'ready');
  assert.equal(JSON.parse(readFileSync(path.join(folder,'startup-2-cleanup.json'),'utf8')).cleanup.status,'closed');
});
