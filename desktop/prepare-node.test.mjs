import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {prepareNode} from './prepare-node.mjs';

// Tiny recorded tar.xz/ZIP archives hold only a stand-in binary and its license.
const archives = {"linux":"/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AKJdADcbyLBT1zzV8zUG5g/DbNYsHTB6a5X1d8kXSFK2D1wNHBC8L45x0PdApTv4r0JPC5QuTsz/2kuBshXeRyoDrjNXvVfnHGUfR4jPIURaj00Z8LSRWPBmXBovaUQmuTqof0ixWFaXhn+4BkLD5D76aPoEFhvpzWlZSywmRX1B2Sbh+sEmFcnHclgkRJxHqKAJZwPrI+/tG1QqgosiWq5wa/3wAAAAAM8juCbQVNSuAAG+AYBQAADjFxBfscRn+wIAAAAABFla","windows":"UEsDBBQAAAAAAAAAIQC2zn/XDQAAAA0AAAAlAAAAbm9kZS12MjQuMC4wLWZpeHR1cmUtd2luLXg2NC9ub2RlLmV4ZWZpeHR1cmUgbm9kZQpQSwMEFAAAAAAAAAAhAFQPDY0QAAAAEAAAACQAAABub2RlLXYyNC4wLjAtZml4dHVyZS13aW4teDY0L0xJQ0VOU0VmaXh0dXJlIGxpY2Vuc2UKUEsBAhQDFAAAAAAAAAAhALbOf9cNAAAADQAAACUAAAAAAAAAAAAAAIABAAAAAG5vZGUtdjI0LjAuMC1maXh0dXJlLXdpbi14NjQvbm9kZS5leGVQSwECFAMUAAAAAAAAACEAVA8NjRAAAAAQAAAAJAAAAAAAAAAAAAAAgAFQAAAAbm9kZS12MjQuMC4wLWZpeHR1cmUtd2luLXg2NC9MSUNFTlNFUEsFBgAAAAACAAIApQAAAKIAAAAAAA==","missingLicense":"/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AH9dADcbyLBT1zzV8zUG5g/DbNYsHTB6a5X1d8kXSFK2D1wNHBC8L45x0PdApTv4r0JPC5QuTsz/2kuBshXeRyoDrjNXvVfnHGUfR4jPIURaj00Z8LSRWPBmXBpE5oBZ9PCTRQjyr7N+1yD4IW+r89VcMMF9Xg6YIXkKYkiPNT8Ob4AAAP6TMsCo1df2AAGbAYBQAABmg3EIscRn+wIAAAAABFla"};
const version = 'v24.0.0-fixture';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t, kind = 'linux') {
  const root = mkdtempSync(path.join(tmpdir(), 'quotum-node-test-'));
  const cache = path.join(root, 'cache'), work = path.join(root, 'work'), here = path.join(root, 'app');
  mkdirSync(work);
  const saved = new Map(['XDG_CACHE_HOME', 'TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]));
  process.env.XDG_CACHE_HOME = cache;
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = work;
  t.after(() => {
    for (const [key, value] of saved) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
    rmSync(root, {recursive: true, force: true});
  });
  const windows = kind === 'windows';
  const target = windows ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
  const bytes = Buffer.from(archives[kind], 'base64');
  const node = {archive: `node-${version}-${windows ? 'win-x64.zip' : 'linux-x64.tar.xz'}`, sha256: sha(bytes), binary: windows ? 'node.exe' : 'bin/node'};
  const cacheFile = path.join(cache, 'quotum-build/node', node.archive);
  const binary = path.join(here, 'binaries', `quotum-node-${target}${windows ? '.exe' : ''}`);
  const stamp = path.join(here, 'binaries', `quotum-node-${target}.sha256`);
  const warnings = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', value => warnings.push(value));
  const timeout = AbortSignal.timeout;
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => {deadlines.push(ms); assert.equal(ms, 120_000); return timeout(ms);});
  let calls = 0;
  const download = body => t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, `https://nodejs.org/dist/${version}/${node.archive}`);
    assert.ok(options.signal instanceof AbortSignal);
    return typeof body === 'function' ? body() : new Response(body ?? bytes);
  });
  const clean = () => {
    assert.deepEqual(readdirSync(work), []);
    const directory = path.dirname(cacheFile);
    if (existsSync(directory)) assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('quotum-node-')), []);
  };
  return {here, target, node, bytes, cacheFile, binary, stamp, warnings, deadlines, download, clean,
    calls: () => calls, run: () => prepareNode(here, target, node, version)};
}

for (const kind of ['linux', 'windows']) {
  test(`${kind} archives are verified, extracted and reused without another download`, async t => {
    const f = fixture(t, kind); f.download();
    const license = await f.run();
    assert.equal(f.calls(), 1); assert.deepEqual(f.deadlines, [120_000]);
    assert.equal(readFileSync(f.binary, 'utf8'), 'fixture node\n');
    assert.equal(readFileSync(license, 'utf8'), 'fixture license\n');
    assert.equal(readFileSync(f.stamp, 'utf8'), `${f.node.sha256} ${sha(readFileSync(f.binary))}`);
    assert.deepEqual(readFileSync(f.cacheFile), f.bytes); f.clean();
    rmSync(path.join(f.here, 'binaries'), {recursive: true});
    await f.run();
    assert.equal(f.calls(), 1); assert.deepEqual(f.deadlines, [120_000]); f.clean();
    writeFileSync(f.binary, 'modified stand-in');
    await f.run();
    assert.equal(readFileSync(f.binary, 'utf8'), 'fixture node\n');
    assert.equal(f.calls(), 1); f.clean();
    await f.run(); assert.equal(f.calls(), 1); f.clean();
  });
}

test('a corrupt cache is explicitly rejected before the one verified replacement download', async t => {
  const f = fixture(t);
  mkdirSync(path.dirname(f.cacheFile), {recursive: true}); writeFileSync(f.cacheFile, 'corrupt cached archive');
  f.download(); await f.run();
  assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], /SHA-256 mismatch/);
  assert.equal(f.calls(), 1); assert.deepEqual(f.deadlines, [120_000]);
  assert.deepEqual(readFileSync(f.cacheFile), f.bytes); f.clean();
});

test('a corrupt cache cannot convert a failed download into success or retry it', async t => {
  const f = fixture(t);
  mkdirSync(path.dirname(f.cacheFile), {recursive: true}); writeFileSync(f.cacheFile, 'corrupt cached archive');
  const failure = new DOMException('stand-in timeout', 'TimeoutError');
  f.download(() => {throw failure;});
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(f.calls(), 1); assert.deepEqual(f.deadlines, [120_000]);
  assert.equal(f.warnings.length, 1); assert.equal(existsSync(f.cacheFile), false);
  assert.equal(existsSync(f.stamp), false); f.clean();
});

test('an HTTP failure publishes no cache or stamp and cleans the download directory', async t => {
  const f = fixture(t); f.download(() => new Response('', {status: 503}));
  await assert.rejects(f.run(), /HTTP 503/);
  assert.equal(f.calls(), 1); assert.equal(existsSync(f.cacheFile), false);
  assert.equal(existsSync(f.stamp), false); f.clean();
});

test('an incomplete response body preserves its error without retry or cache publication', async t => {
  const f = fixture(t), failure = new DOMException('stand-in body timeout', 'TimeoutError');
  f.download(() => new Response(new ReadableStream({start(controller) {controller.error(failure);}})));
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(f.calls(), 1); assert.equal(existsSync(f.cacheFile), false);
  assert.equal(existsSync(f.stamp), false); f.clean();
});

test('a download checksum mismatch never reaches extraction or creates an accepted stamp', async t => {
  const f = fixture(t); f.download(Buffer.from('corrupt download'));
  await assert.rejects(f.run(), /SHA-256 .* expected/);
  assert.equal(f.calls(), 1); assert.equal(existsSync(f.binary), false);
  assert.equal(existsSync(f.cacheFile), false); assert.equal(existsSync(f.stamp), false); f.clean();
});

test('an extraction failure cleans its owned directory even after checksum acceptance', async t => {
  const f = fixture(t); f.node.sha256 = sha(Buffer.from('invalid archive')); f.download(Buffer.from('invalid archive'));
  await assert.rejects(f.run());
  assert.equal(f.calls(), 1); assert.equal(existsSync(f.cacheFile), false);
  assert.equal(existsSync(f.stamp), false); f.clean();
});

test('a missing archive license cannot publish a stamp or cache', async t => {
  const f = fixture(t, 'missingLicense'); f.download();
  await assert.rejects(f.run(), {code: 'ENOENT'});
  assert.equal(f.calls(), 1); assert.equal(existsSync(f.stamp), false);
  assert.equal(existsSync(f.cacheFile), false); f.clean();
});

test('optional cache publication failure keeps verified preparation and cleans both temporary directories', async t => {
  const f = fixture(t);
  f.download(() => {mkdirSync(f.cacheFile, {recursive: true}); return new Response(f.bytes);});
  const license = await f.run();
  assert.equal(f.calls(), 1); assert.deepEqual(f.deadlines, [120_000]);
  assert.equal(readFileSync(f.binary, 'utf8'), 'fixture node\n');
  assert.equal(readFileSync(license, 'utf8'), 'fixture license\n');
  assert.equal(readFileSync(f.stamp, 'utf8'), `${f.node.sha256} ${sha(readFileSync(f.binary))}`);
  assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], /^could not cache /); f.clean();
});

test('an unreadable cache entry is optional and permits only the original download', async t => {
  const f = fixture(t); mkdirSync(f.cacheFile, {recursive: true}); f.download();
  const license = await f.run();
  assert.equal(f.calls(), 1); assert.deepEqual(f.deadlines, [120_000]);
  assert.equal(readFileSync(license, 'utf8'), 'fixture license\n');
  assert.equal(readFileSync(f.stamp, 'utf8'), `${f.node.sha256} ${sha(readFileSync(f.binary))}`);
  assert.equal(f.warnings.length, 2); assert.match(f.warnings[0], /^could not read cached /);
  assert.match(f.warnings[1], /^could not cache /); f.clean();
});
