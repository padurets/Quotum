import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('installer checks the whole payload before replacing the last CLI and never enables consent',{skip:process.platform==='win32'},()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'quotum-install-test-'));
  try {
    const assets=path.join(root,'assets'),bin=path.join(root,'tools'),destination=path.join(root,'installed');
    mkdirSync(assets);mkdirSync(bin);mkdirSync(destination);
    const platform=`${process.platform==='darwin'?'macos':'linux'}-${process.arch==='arm64'?'arm64':'x64'}`;
    const helper=`quotum-hook-${platform}`,cli=`quotum-cli-${platform}`;
    const expected=new Map([[cli,'#!/bin/sh\n[ "$1" = --version ] || exit 91\nprintf "quotum 0.7.0\\n"\n'],[helper,'native helper fixture'],[`${helper}.json`,'{"schemaVersion":1}\n']]);
    for(const [file,bytes] of expected)writeFileSync(path.join(assets,file),bytes);
    writeFileSync(path.join(assets,'SHA256SUMS'),[...expected].map(([file,bytes])=>`${createHash('sha256').update(bytes).digest('hex')}  ${file}\n`).join(''));
    writeFileSync(path.join(bin,'curl'),`#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);try{fs.copyFileSync(path.join(process.env.QUOTUM_FIXTURE_ASSETS,path.basename(args.at(-1))),args[args.indexOf('-o')+1]);}catch{process.exit(22);}\n`);
    chmodSync(path.join(bin,'curl'),0o755);
    const install=(version='0.7.0')=>spawnSync('sh',[fileURLToPath(new URL('./install.sh',import.meta.url))],{env:{...process.env,PATH:`${bin}:${process.env.PATH}`,QUOTUM_FIXTURE_ASSETS:assets,QUOTUM_INSTALL_DIR:destination,QUOTUM_VERSION:version,QUOTUM_RELEASES_URL:'https://fixture.invalid/releases'},encoding:'utf8'});
    writeFileSync(path.join(destination,'quotum'),'last whole CLI');
    writeFileSync(path.join(assets,helper),'corrupt helper');
    assert.notEqual(install().status,0);assert.equal(readFileSync(path.join(destination,'quotum'),'utf8'),'last whole CLI');
    assert.equal(existsSync(path.join(destination,'.quotum-hook-payloads')),false);
    writeFileSync(path.join(assets,helper),expected.get(helper));
    assert.equal(install().status,0);
    const payload=path.join(destination,'.quotum-hook-payloads/0.7.0');
    assert.equal(readFileSync(path.join(payload,'quotum-hook'),'utf8'),expected.get(helper));
    assert.equal(readFileSync(path.join(payload,'payload-manifest.json'),'utf8'),expected.get(`${helper}.json`));
    // Exact-version disagreement cannot replace either half of the installed pair.
    writeFileSync(path.join(payload,'quotum-hook'),'different installed helper');
    writeFileSync(path.join(destination,'quotum'),'last whole CLI');
    assert.notEqual(install().status,0);assert.equal(readFileSync(path.join(destination,'quotum'),'utf8'),'last whole CLI');
    for(const version of ['0.7.0/../../escape','0.7.0 trailing','0.7.0\nnext'])assert.notEqual(install(version).status,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
