// Temporary opt-in identity experiment; never part of a normal build or required gate.
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import ts from 'typescript';
// Private experiment: committed identity observations, never CPU or DOM-operation attribution.
export function createRecorder(clock, frameKey, limits = {}) {
  const maxRows = limits.rows ?? 8192, maxTypes = limits.types ?? 512;
  const maxVisited = limits.visited ?? 8192, maxDepth = limits.depth ?? 64;
  const maxTotalVisits = limits.totalVisited ?? 262144;
  let active = false, generation = 0, hashing = false, exhausted = false;
  let root = null, renderer = null, rootChanged = 0, ambiguousRoot = false;
  let aliases, types, commits, frames, pending, deleted;
  let rows, invalid, overflow, outside, discarded, visits, totalCommits, unmounts, skippedCommits, skippedUnmounts;
  const clear = () => {
    aliases = new Map(); types = []; commits = []; frames = []; pending = []; deleted = new Map();
    rows = invalid = overflow = outside = discarded = visits = totalCommits = unmounts = 0;
    rootChanged = skippedCommits = skippedUnmounts = 0; exhausted = false;
  };
  clear();
  const overflowed = () => {overflow++; exhausted = true;};
  const own = (object, key) => {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return null;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !('value' in descriptor)) throw Error('Accessor evidence is unavailable');
    return descriptor ?? null;
  };
  const alias = value => {
    if (value === null || value === undefined) return 0;
    if (aliases.has(value)) return aliases.get(value);
    if (types.length >= maxTypes) {overflowed(); return 0;}
    const id = types.push(value); aliases.set(value, id); return id;
  };
  const pair = fiber => [alias(fiber.type), alias(fiber.elementType)];
  const leaf = props => {
    if (!props || typeof props !== 'object') return null;
    const keys = Reflect.ownKeys(props);
    if (keys.length !== 2 || !keys.includes('cell') || !keys.includes('render')) return null;
    const cell = own(props, 'cell')?.value, render = own(props, 'render')?.value;
    if (!cell || typeof cell !== 'object' || typeof render !== 'function') return null;
    const at = own(cell, 'at'), time = own(cell, 'time'), changesAt = own(cell, 'changesAt');
    if ('at' in cell && typeof at?.value !== 'function') throw Error('Unsupported inherited or nonfunction clock cell');
    const ticking = typeof at?.value === 'function';
    if (ticking && (typeof time?.value !== 'string' || typeof changesAt?.value !== 'function')) throw Error('Invalid clock cell');
    return {cell, render, ticking};
  };
  const composite = fiber => [0, 1, 11, 14, 15].includes(fiber.tag);
  const hostOutput = (fiber, previous) => {
    const next = fiber.child, before = previous?.child;
    if (!next || !before || next.sibling || before.sibling || ![5, 6].includes(next.tag) || next.tag !== before.tag ||
      next.type !== before.type || next.elementType !== before.elementType || next.key !== before.key ||
      next.stateNode !== before.stateNode || !next.stateNode) return 'unknown';
    if (next.tag === 6) return Object.is(next.memoizedProps, before.memoizedProps) ? 'same' : 'different';
    const currentProps = next.memoizedProps, oldProps = before.memoizedProps;
    if (!currentProps || !oldProps) return 'unknown';
    const keys = Reflect.ownKeys(currentProps), oldKeys = Reflect.ownKeys(oldProps);
    if (keys.length > 32 || oldKeys.length > 32) return 'unknown';
    if (keys.length !== oldKeys.length || keys.some(key => !oldKeys.includes(key))) return 'different';
    return keys.every(key => Object.is(own(currentProps, key)?.value, own(oldProps, key)?.value)) ? 'same' : 'different';
  };
  const bump = (map, entry) => {
    const key = JSON.stringify(entry), previous = map.get(key);
    if (previous) previous.count++;
    else if (map.size >= maxRows) overflowed();
    else map.set(key, {...entry, count: 1});
  };
  const validKey = key => Number.isFinite(key) && key >= 0;
  const observeUnmount = (id, fiber) => {
    if (!active) return;
    try {
      unmounts++;
      if (exhausted) {skippedUnmounts++; return;}
      if (++visits > maxTotalVisits) {overflowed(); return;}
      if (renderer !== null && renderer !== id) {rootChanged++; return;}
      if (composite(fiber)) {
        const props = leaf(fiber.memoizedProps), [type, elementType] = pair(fiber);
        bump(deleted, {type, elementType, tag: fiber.tag, leaf: props !== null, ticking: props?.ticking ?? null});
      }
    } catch {invalid++;}
  };
  const observeCommit = (id, nextRoot) => {
    if (!active) {
      if (root && (root !== nextRoot || renderer !== id)) ambiguousRoot = true;
      root = nextRoot; renderer = id; return;
    }
    try {
      totalCommits++;
      if (exhausted) {skippedCommits++; return;}
      const from = clock(), key = frameKey();
      if (root !== nextRoot || renderer !== id) rootChanged++;
      const counts = new Map(), stack = [[nextRoot.current, nextRoot.current.alternate, 0]], seen = new Set();
      let count = 0;
      while (stack.length) {
        const [fiber, previous, depth] = stack.pop();
        if (!fiber || seen.has(fiber) || depth > maxDepth || ++count > maxVisited || ++visits > maxTotalVisits) {overflowed(); break;}
        if (exhausted) break;
        seen.add(fiber);
        if (composite(fiber) && (!previous || (fiber.flags & 1) === 1)) {
          const current = leaf(fiber.memoizedProps);
          if (current) {
            const before = previous ? leaf(previous.memoizedProps) : null;
            const [type, elementType] = pair(fiber);
            bump(counts, {type, elementType, tag: fiber.tag, mounted: !previous,
              beforeLeaf: before !== null, beforeTicking: before?.ticking ?? null, ticking: current.ticking,
              sameCell: before ? Object.is(before.cell, current.cell) : null,
              sameRender: before ? Object.is(before.render, current.render) : null,
              sameProps: previous ? Object.is(previous.memoizedProps, fiber.memoizedProps) : null,
              state: hostOutput(fiber, previous)});
          }
        }
        if (previous && fiber.child === previous.child) continue;
        let siblings = 0;
        for (let child = fiber.child; child; child = child.sibling) {
          if (++siblings > maxVisited || stack.length >= maxVisited) {overflowed(); break;}
          stack.push([child, previous ? child.alternate : null, depth + 1]);
        }
      }
      if (exhausted) {deleted.clear(); return;}
      const to = clock(), endKey = frameKey();
      const entries = [...counts.values()], removals = [...deleted.values()]; deleted.clear();
      const entryRows = 1 + entries.length + removals.length;
      if (![from, to].every(Number.isFinite) || to < from || !validKey(key) || key !== endKey || key && from < key) {invalid++; return;}
      if (rows + entryRows > maxRows) {overflowed(); return;}
      const receipt = {commit: totalCommits, from, to, key, visited: count, entries, removals};
      commits.push(receipt); rows += entryRows;
      if (key) pending.push(receipt); else outside++;
    } catch {invalid++;}
  };
  return {
    observeCommit, observeUnmount,
    error() {if (active) invalid++;},
    start() {
      if (active || hashing || !root || renderer === null || ambiguousRoot) throw Error('One observed root and closed prior window are required');
      clear(); generation++; active = true;
    },
    resetFrame() {if (active) {discarded += pending.length; pending = []; }},
    frame(frame) {
      if (!active || exhausted) return;
      try {
        const {from, to, frameId, segment} = frame;
        if (![from, to, frameId].every(Number.isFinite) || from < 0 || to < from) {invalid++; return;}
        const enclosed = pending.filter(receipt => receipt.key === from && receipt.from >= from && receipt.to <= to);
        const mismatched = pending.length - enclosed.length;
        if (mismatched) invalid += mismatched;
        if (from && to - from > 50) {
          if (rows >= maxRows) overflowed();
          else {frames.push({from, to, frameId, segment, commits: enclosed.map(receipt => receipt.commit)}); rows++;}
        }
        pending = [];
      } catch {invalid++;}
    },
    stop() {active = false; discarded += pending.length; pending = []; if (deleted.size) invalid++; deleted.clear();},
    snapshot() {
      return JSON.parse(JSON.stringify({active, generation, rows, invalid, overflow, exhausted, rootChanged, outside, discarded, visits,
        totalCommits, unmounts, skippedCommits, skippedUnmounts, types: types.length, commits, frames}));
    },
    async bindings(digest) {
      if (active || hashing) throw Error('Bindings require a closed window');
      hashing = true;
      try {
        const result = [];
        for (let index = 0; index < types.length; index++) {
          const value = types[index];
          if (typeof value === 'function') {
            let functionHash = null;
            try {const hash = await digest(Function.prototype.toString.call(value)); if (/^[a-f0-9]{64}$/.test(hash ?? '')) functionHash = hash;} catch { /* Unknown source. */ }
            result.push({alias: index + 1, kind: 'function', functionHash});
          } else if (typeof value === 'string') result.push({alias: index + 1, kind: 'host', name: value});
          else result.push({alias: index + 1, kind: typeof value});
        }
        return {generation, rows: result};
      } finally {hashing = false;}
    },
  };
}

export function wrapHook(hook, recorder) {
  for (const name of ['onCommitFiberRoot', 'onCommitFiberUnmount']) if (typeof hook[name] !== 'function') throw Error('Existing hook is required');
  for (const [name, observe] of [['onCommitFiberRoot', recorder.observeCommit], ['onCommitFiberUnmount', recorder.observeUnmount]]) {
    const original = hook[name];
    hook[name] = function(...args) {
      try {return Reflect.apply(original, this, args);}
      finally {try {Reflect.apply(observe, recorder, args);} catch {recorder.error();}}
    };
  }
}

import {createHash} from 'node:crypto';

export const expected = {
  'bench/probe.ts': '55dcea8a00786df7d927577c3c78d1feb89e74bb34461dc52cf3554b406cffd4',
  'bench/panning.ts': 'e2334b6feafae874570d99631d9221be2ed7e7f77ee22f2330f92ee1740ed392',
  'node_modules/react-dom/cjs/react-dom-client.production.js': '8a8147c1cebdb19d82fd11bdb76391be9b20d00edf67cc8e8b30f44e850ce693',
  'ui/components/TableCell.tsx': '0e6a266b5c53a27722afafea91ea4c865ec73ca43b36d3398ddd53a6e96b596b',
  'ui/components/AnalyticsTable.tsx': '00102d1e91ea5f969fcd342bfc06b57c803d66b9aa8f176e4adc41b42bad8a7e',
};
export const hash = value => createHash('sha256').update(value).digest('hex');
const replaceOne = (source, before, after) => {
  if (source.split(before).length !== 2) throw Error('Patch target is not unique');
  return source.replace(before, after);
};
export function patches(originals) {
  for (const [file, sha] of Object.entries(expected)) if (hash(originals[file] ?? '') !== sha) throw Error('Source identity mismatch');
  let probe = originals['bench/probe.ts'], panning = originals['bench/panning.ts'];
  const installer = `const recorder=(${createRecorder.toString()})(globalThis.performance.now.bind(globalThis.performance),()=>globalThis.__quotumPan?.last??0);(${wrapHook.toString()})(globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__,recorder);Object.defineProperty(globalThis,"__quotum113CellCommits",{value:recorder,writable:false,configurable:false});`;
  if (Buffer.byteLength(installer) > 64 * 1024) throw Error('Injected collector byte limit');
  const end = '${JSON.stringify(NODES)}); })();`;';
  probe = replaceOne(probe, end, '${JSON.stringify(NODES)}); '+installer+' })();`;');
  panning = replaceOne(panning, "import type {Cdp} from './cdp.js';", "import type {Cdp} from './cdp.js';\nimport {clientIdentity} from './evidence.js';");
  panning = replaceOne(panning, "  cdp.at?.('panning/setup');", "  cdp.at?.('panning/setup');\n  const cellCommitClient = clientIdentity();");
  if (panning.split('probe.last=0').length !== 4) throw Error('Native reset identity mismatch');
  panning = panning.replaceAll('probe.last=0', '(window.__quotum113CellCommits.resetFrame(),probe.last=0)');
  panning = replaceOne(panning, 'probe.updated++;', "window.__quotum113CellCommits.frame({from:probe.last,to:now,frameId:stamp,segment:folding?'fold':probe.segment});probe.updated++;");
  const start = "      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});";
  panning = replaceOne(panning, start, start+`
      let cellWindowFrom: {generation:number;timeOrigin:number;from:number};
      try {
        cellWindowFrom = await deadline(5000, signal => cdp.evaluate<{generation:number;timeOrigin:number;from:number}>('(()=>{const r=window.__quotum113CellCommits;if(!r)throw Error("cell commit recorder missing");r.start();return {generation:r.snapshot().generation,timeOrigin:performance.timeOrigin,from:performance.now()};})()', signal));
      } catch {
        evidence?.save('cell-commits-'+initiator+'-'+period,{mode:'diagnostic',schemaVersion:1,status:'insufficient-evidence',stage:'start'});
        throw Error('Cell commit diagnostic did not start; no later diagnostic window will run');
      }`);
  const endExpression = `(async()=>{const r=window.__quotum113CellCommits;if(!r)return {status:'unavailable'};r.stop();const ended=performance.now(),snapshot=r.snapshot();const bindings=await r.bindings(async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),value=>value.toString(16).padStart(2,'0')).join(''));const result={status:'recorded',timeOrigin:performance.timeOrigin,ended,snapshot,bindings},bytes=new TextEncoder().encode(JSON.stringify(result)).byteLength;return bytes<=1048576?result:{status:'insufficient-evidence',stage:'byte-limit',bytes};})()`;
  const afterReport = "      at('postconditions');\n      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});";
  panning = replaceOne(panning, afterReport, afterReport+`
      // Keep the original report before a bounded post-movement identity read.
      try {
        const body = await deadline(5000, signal => cdp.evaluate<object>(${JSON.stringify(endExpression)},signal));
        if(!('status' in body)||body.status!=='recorded')throw Error('Cell commit evidence unavailable');
        evidence?.save('cell-commits-'+initiator+'-'+period,{mode:'diagnostic',schemaVersion:1,from:cellWindowFrom,clientHash:cellCommitClient.status==='available'?cellCommitClient.sha256:null,clientBytes:cellCommitClient.status==='available'?cellCommitClient.bytes:null,...body});
      } catch {
        evidence?.save('cell-commits-'+initiator+'-'+period,{mode:'diagnostic',schemaVersion:1,status:'insufficient-evidence',stage:'read',from:cellWindowFrom});
        throw Error('Cell commit diagnostic read incomplete; original report retained');
      }`);
  return {'bench/probe.ts': probe, 'bench/panning.ts': panning};
}

export function extractDefinition(source, ts) {
  const digest = text => createHash('sha256').update(text).digest('hex');
  const file = ts.createSourceFile('client.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), candidates = [];
  const visit = node => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
      node.parameters.length === 1 && ts.isObjectBindingPattern(node.parameters[0].name)) {
      const keys = node.parameters[0].name.elements.map(element => (element.propertyName ?? element.name).getText(file)).sort();
      const text = node.getText(file);
      if (JSON.stringify(keys) === '["cell","render"]' && text.includes('.changesAt')) candidates.push({
        functionHash: digest(text), bytes: Buffer.byteLength(text), start: node.getStart(file), end: node.end,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return {status: candidates.length === 1 && !file.parseDiagnostics.length ? 'available' : 'unavailable',
    clientHash: digest(source), clientBytes: Buffer.byteLength(source), candidates};
}

if(process.env.QUOTUM_DIAGNOSTIC_CELL_COMMITS!=='once')throw Error('Explicit one-shot diagnostic required');
const originals=Object.fromEntries(Object.keys(expected).map(file=>[file,readFileSync(file,'utf8')]));
const changes=patches(originals),after={"bench/probe.ts":"1e1fa43be7d1784798990acdb20c6404ccfc824e2260e068c8b5154864e189de","bench/panning.ts":"217fa706da234ad6241347bbacfdc6349a2f372107c880544965f5509b675092"};
for(const [file,source] of Object.entries(changes))if(hash(source)!==after[file])throw Error('Patched source mismatch');
const directory=process.env.QUOTUM_BENCH_DIAGNOSTICS_DIR;
if(!directory)throw Error('Evidence destination required');
const assets=readdirSync('dist/client/assets').filter(name=>/^index-[\w-]+\.js$/.test(name));
if(assets.length!==1)throw Error('One compiled client required');
const definition=extractDefinition(readFileSync('dist/client/assets/'+assets[0],'utf8'),ts);
const receipt={schemaVersion:1,mode:'diagnostic',kind:'committed-cell-definition',...definition,
  sources:Object.entries(expected).map(([file,sha])=>({name:file,beforeHash:sha,afterHash:after[file]??sha}))};
mkdirSync(directory,{recursive:true,mode:0o700});
writeFileSync(directory+'/committed-cell-definition.json',JSON.stringify(receipt));
if(definition.status!=='available')throw Error('Unique cell definition unavailable; no capture will run');
for(const [file,source] of Object.entries(changes))writeFileSync(file,source);
console.log(JSON.stringify({mode:'committed-cell-identities-once',clientHash:definition.clientHash,clientBytes:definition.clientBytes,functionHash:definition.candidates[0].functionHash,sources:receipt.sources,canonicalAcceptance:false}));
