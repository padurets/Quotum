// Temporary opt-in experiment. It never runs in a normal build or required gate.
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
function createRecorder(clock, maxSpans = 8192, maxFunctions = 512) {
  let active = false, hashing = false, generation = 0, current = 0, open = 0;
  let aliases, functions, spans, calls, omitted, filteredShort, unbound, invalid, openAtStop;
  const reset = () => {
    aliases = new WeakMap(); functions = []; spans = [];
    calls = omitted = filteredShort = unbound = invalid = openAtStop = 0;
  };
  reset();
  const call = (Component, props, secondArg) => {
    if (!active) return Component(props, secondArg);
    const token = generation, parent = current;
    let id = 0, alias = 0, from = null, threw = 1;
    try {
      id = ++calls; current = id; open++;
      alias = aliases.get(Component) ?? 0;
      if (!alias && functions.length < maxFunctions) {
        alias = functions.push(Component); aliases.set(Component, alias);
      }
      if (!alias) unbound++;
      from = clock();
      if (!Number.isFinite(from)) {invalid++; from = null;}
    } catch {invalid++;}
    try {
      const value = Component(props, secondArg);
      threw = 0;
      return value;
    } finally {
      // Observation cannot change the original return or thrown object.
      try {
        if (generation === token) {
          const to = clock();
          if (from === null || !Number.isFinite(to) || to < from) invalid++;
          else if (to - from < 5) filteredShort++;
          else if (spans.length < maxSpans) spans.push({id, parent, alias, from, to, threw});
          else omitted++;
          current = parent; open--;
        }
      } catch {invalid++; current = parent; open--;}
    }
  };
  return {
    call,
    start() {
      if (active || open || hashing) throw Error('render body window already active');
      reset(); generation++; active = true;
    },
    stop() {if (active) {active = false; openAtStop = open;}},
    snapshot() {
      return {active, generation, calls, omitted, filteredShort, unbound, invalid, openAtStop, open, functions: functions.length, spans: spans.map(span => ({...span}))};
    },
    async hashes(digest) {
      if (active || open || hashing) throw Error('render body hashes require a closed window');
      hashing = true;
      try {
        const rows = [];
        for (let index = 0; index < functions.length; index++) {
          let hash = null;
          try {
            const value = await digest(Function.prototype.toString.call(functions[index]));
            if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) hash = value;
          } catch { /* An unavailable identity remains unknown. */ }
          rows.push({alias: index + 1, hash});
        }
        return {generation, rows};
      } finally {
        hashing = false;
      }
    },
  };
}

const hash = source => createHash('sha256').update(source).digest('hex');
const expected = {
  'node_modules/react-dom/cjs/react-dom-client.production.js': '8a8147c1cebdb19d82fd11bdb76391be9b20d00edf67cc8e8b30f44e850ce693',
  'bench/panning.ts': 'e2334b6feafae874570d99631d9221be2ed7e7f77ee22f2330f92ee1740ed392',
};
if (process.env.QUOTUM_DIAGNOSTIC_RENDER_BODIES !== 'once') throw Error('Explicit one-shot diagnostic required');
const originals = Object.fromEntries(Object.entries(expected).map(([file, sha]) => {
  const source = readFileSync(file, 'utf8');
  if (hash(source) !== sha) throw Error('Diagnostic source identity mismatch');
  return [file, source];
}));
function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Diagnostic patch target is not unique');
  return source.replace(before, after);
}
const renderer = 'node_modules/react-dom/cjs/react-dom-client.production.js';
let patchedRenderer = originals[renderer];
const wrapped = '(globalThis.__quotum113RenderCall ? globalThis.__quotum113RenderCall(Component, props, secondArg) : Component(props, secondArg))';
for (const assignment of ['nextRenderLanes', 'children']) {
  patchedRenderer = replaceOne(patchedRenderer, assignment+' = Component(props, secondArg);', assignment+' = '+wrapped+';');
}
let panning = originals['bench/panning.ts'];
panning = replaceOne(panning, "import type {Cdp} from './cdp.js';", "import type {Cdp} from './cdp.js';\nimport {clientIdentity} from './evidence.js';");
panning = replaceOne(panning, "  cdp.at?.('panning/setup');", "  cdp.at?.('panning/setup');\n  const renderBodyClient = clientIdentity();");
const install = '\n        if(!window.__quotum113RenderTiming){const recorder=('+createRecorder.toString()+')(performance.now.bind(performance));Object.defineProperty(globalThis,"__quotum113RenderCall",{value:recorder.call,writable:false,configurable:false});Object.defineProperty(globalThis,"__quotum113RenderTiming",{value:recorder,writable:false,configurable:false});}else{const d=Object.getOwnPropertyDescriptor(globalThis,"__quotum113RenderCall");if(!d||d.value!==window.__quotum113RenderTiming.call||d.writable||d.configurable)throw Error("render body slot mismatch");}';
const initiator = '        const initiator=${JSON.stringify(initiator)},period=${JSON.stringify(period)};';
panning = replaceOne(panning, initiator, initiator+install);
const start = "      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});";
panning = replaceOne(panning, start, start+`
      let bodyWindowFrom: {generation:number;timeOrigin:number;from:number};
      try {
        bodyWindowFrom = await deadline(5000, signal => cdp.evaluate<{generation:number;timeOrigin:number;from:number}>('(()=>{const r=window.__quotum113RenderTiming;if(!r)throw Error("render body recorder missing");r.start();return {generation:r.snapshot().generation,timeOrigin:performance.timeOrigin,from:performance.now()};})()', signal));
      } catch {
        evidence?.save('render-eligible-bodies-'+initiator+'-'+period, {mode:'diagnostic', schemaVersion:2, kind:'eligible-body-spans', minimumBodyMs:5, status:'insufficient-evidence', stage:'start'});
        throw Error('Render body diagnostic did not start; no later diagnostic window will run');
      }`);
const endExpression = `(async()=>{const r=window.__quotum113RenderTiming;if(!r)return {status:'unavailable'};r.stop();const ended=performance.now(),snapshot=r.snapshot();const bindings=await r.hashes(async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),value=>value.toString(16).padStart(2,'0')).join(''));return {status:'recorded',timeOrigin:performance.timeOrigin,ended,snapshot,bindings:{generation:bindings.generation,rows:bindings.rows.map(row=>({alias:row.alias,functionHash:row.hash}))}};})()`;
const afterReport = "      at('postconditions');\n      await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});";
const read = `
      // Keep the original report before a bounded, post-movement diagnostic read.
      try {
        const body = await deadline(5000, signal => cdp.evaluate<object>(${JSON.stringify(endExpression)}, signal));
        if (!('status' in body) || body.status !== 'recorded') throw Error('Render body evidence unavailable');
        evidence?.save('render-eligible-bodies-'+initiator+'-'+period, {mode:'diagnostic', schemaVersion:2, kind:'eligible-body-spans', minimumBodyMs:5, from:bodyWindowFrom, clientHash:renderBodyClient.status==='available'?renderBodyClient.sha256:null, clientBytes:renderBodyClient.status==='available'?renderBodyClient.bytes:null, ...body});
      } catch {
        evidence?.save('render-eligible-bodies-'+initiator+'-'+period, {mode:'diagnostic', schemaVersion:2, kind:'eligible-body-spans', minimumBodyMs:5, status:'insufficient-evidence', stage:'read', from:bodyWindowFrom});
        throw Error('Render body diagnostic read incomplete; original report retained');
      }`;
panning = replaceOne(panning, afterReport, afterReport+read);
const changes = {[renderer]:patchedRenderer, 'bench/panning.ts':panning};
for (const [file, source] of Object.entries(changes)) writeFileSync(file, source);
console.log(JSON.stringify({mode:'eligible-render-body-diagnostic',callSites:2,sources:Object.entries(changes).map(([file, source])=>({name:file===renderer?'renderer':'panning',beforeHash:expected[file],afterHash:hash(source)})),nativeProbeInstall:true,readAfterOriginalReport:true,readAfterRateOne:true,canonicalAcceptance:false}));
