import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const workflow=(name:string)=>readFileSync(new URL(`../../../.github/workflows/${name}.yml`,import.meta.url),'utf8');
const ci=workflow('ci');
const job=(name:string)=>{
  const text=ci.split(`\n  ${name}:\n`)[1];assert.ok(text,`missing job ${name}`);
  return text.split(/\n  [\w-]+:/)[0];
};
const expression=(text:string,key:string)=>{
  const value=text.match(new RegExp(`^ *${key}: \\$\\{\\{ (.+) \\}\\}$`,'m'))?.[1];
  assert.ok(value,`missing expression ${key}`);return value;
};
const evaluate=(text:string,inputs:object={},github:object={})=>runInNewContext(text,{
  inputs:new Proxy(inputs,{get:(target,key)=>Reflect.get(target,key)??''}),runner:{temp:'/fixture/runner-temp'},github:{event_name:'workflow_dispatch',ref:'refs/heads/task',run_id:100,run_attempt:1,event:{},...github},
  always:()=>true,startsWith:(value:string,prefix:string)=>value.startsWith(prefix),
  format:(pattern:string,...values:unknown[])=>pattern.replace(/\{(\d+)\}/g,(_,index)=>String(values[Number(index)])),
});
const selected=(name:string,inputs:object={},github:object={})=>Boolean(evaluate(expression(job(name),'if'),inputs,github));
const modes=['trace_only','original_timing','native_trace','native_profile','caption_control','native_postmortem_control','history_scroll_control','history_preinput_binding','history_pool_control','startup_io_control','compositor_guard_control'];

test('ordinary CI requires all three independent producers, including every unsuccessful result',{skip:process.platform==='win32'},()=>{
  const aggregate=job('bench');
  assert.ok(aggregate.includes('always()'));
  assert.ok(aggregate.includes('needs: [bench-history, bench-dashboard, bench-panning]'));
  assert.ok(!aggregate.includes('continue-on-error:'));
  for(const [key,name] of [['HISTORY','history'],['DASHBOARD','dashboard'],['PANNING','panning']]){
    assert.ok(aggregate.includes(`${key}_RESULT: \${{ needs['bench-${name}'].result }}`));
  }
  const script=aggregate.split('        run: |\n')[1].split('\n').map(line=>line.slice(10)).join('\n');
  const results=['success','failure','skipped','cancelled',''];
  for(const history of results)for(const dashboard of results)for(const panning of results){
    const result=spawnSync('bash',['-eu','-c',script],{env:{...process.env,HISTORY_RESULT:history,DASHBOARD_RESULT:dashboard,PANNING_RESULT:panning},encoding:'utf8'});
    assert.ifError(result.error);
    assert.equal(result.status===0,[history,dashboard,panning].every(value=>value==='success'),JSON.stringify({history,dashboard,panning}));
  }
  for(const name of ['bench-history','bench-dashboard','bench-panning']){
    assert.ok(job(name).includes('\n    timeout-minutes: 20\n'));
    assert.ok(!job(name).includes('\n    needs:'));
    assert.ok(job(name).includes('\n        if: always()\n'));
  }
  const panning=job('bench-panning');
  assert.ok(panning.includes('npm run bench -- --ci --scope panning'));
  assert.ok(!panning.includes('continue-on-error:'));
  assert.ok(panning.includes('bench-panning-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'));
  assert.ok(panning.includes('path: ${{ runner.temp }}/quotum-bench-panning'));
});

test('new panning job never joins legacy diagnostics and dashboard keeps their composite scope',()=>{
  const scope=expression(job('bench-dashboard'),'BENCH_SCOPE');
  for(const event_name of ['push','pull_request','workflow_dispatch']){
    for(const name of ['bench','bench-history','bench-dashboard','bench-panning'])assert.equal(selected(name,{}, {event_name}),true,name);
    assert.equal(evaluate(scope), 'updates');
  }
  for(const mode of modes){
    const inputs={diagnostic_ref:'1'.repeat(40),[mode]:true};
    assert.equal(selected('bench-panning',inputs),false,mode);
    assert.equal(selected('bench-panning',{[mode]:true}),false,`unpinned ${mode}`);
    assert.equal(selected('bench',inputs),false,mode);
    if(['native_trace','native_profile','caption_control'].includes(mode)){
      assert.equal(selected('bench-dashboard',inputs),true,mode);
      assert.equal(evaluate(scope,inputs),'dashboard',mode);
    }else assert.equal(selected('bench-dashboard',inputs),false,mode);
  }
  assert.equal(selected('bench-panning',{diagnostic_ref:'1'.repeat(40)}),false);
  for(const name of ['bench','bench-history','bench-dashboard','bench-panning'])assert.equal(selected(name,{}, {ref:'refs/tags/v1.0.0'}),false,name);
  assert.ok(job('idle-cpu-control').includes('--ci --scope dashboard'));
});

test('only superseded direct PR runs share a cancellable workflow-specific group',()=>{
  const groups=new Map<string,string>();
  for(const name of ['ci','desktop']){
    const text=workflow(name),block=text.split('\nconcurrency:\n')[1].split('\njobs:\n')[0];
    const group=expression(block,'group'),cancel=expression(block,'cancel-in-progress');
    const called=text.split('  workflow_call:\n')[1].split('\n  workflow_dispatch:')[0];
    assert.match(called,/reusable_call:\n[\s\S]*?type: boolean\n\s+default: true/);
    assert.ok(!text.split('  workflow_dispatch:\n')[1].split('\npermissions:')[0].includes('reusable_call:'));
    const pr={event_name:'pull_request',event:{pull_request:{number:119}},run_id:100};
    const first=evaluate(group,{},pr);
    assert.equal(evaluate(group,{}, {...pr,run_id:101}),first);
    assert.equal(evaluate(cancel,{},pr),true);
    assert.notEqual(evaluate(group,{}, {...pr,event:{pull_request:{number:120}}}),first);
    groups.set(name,first);
    for(const event_name of ['push','workflow_dispatch','pull_request']){
      const inputs=event_name==='pull_request'?{reusable_call:true}:{};
      const context={...pr,event_name};
      assert.equal(evaluate(cancel,inputs,context),false);
      assert.notEqual(evaluate(group,inputs,context),first);
      assert.notEqual(evaluate(group,inputs,{...context,run_id:101}),evaluate(group,inputs,context));
      assert.notEqual(evaluate(group,inputs,{...context,run_attempt:2}),evaluate(group,inputs,context));
      assert.notEqual(evaluate(group,inputs,{...context,workflow:'Release'}),'release-refs/heads/task');
    }
  }
  assert.notEqual(groups.get('ci'),groups.get('desktop'));
  const release=workflow('release');
  assert.match(release,/concurrency: release-\$\{\{ github.ref \}\}/);
  assert.ok(!release.includes('reusable_call: false'));
});

test('the pinned quota24 trace alone selects standalone panning in the existing dashboard job',()=>{
  const inputs={diagnostic_ref:'1'.repeat(40),expected_client_sha256:'2'.repeat(64),native_trace:true,native_target:'quota/24h'};
  assert.equal(selected('bench-dashboard',inputs),true);
  for(const name of ['bench','bench-history','bench-panning','idle-cpu-control','native-postmortem-control','startup-io-control'])assert.equal(selected(name,inputs),false,name);
  const dashboard=job('bench-dashboard');assert.equal(evaluate(expression(dashboard,'BENCH_SCOPE'),inputs),'panning');
  assert.equal(evaluate(expression(dashboard,'QUOTUM_BENCH_EXPECTED_CLIENT_SHA256'),inputs),inputs.expected_client_sha256);
  assert.equal(evaluate(expression(dashboard,'QUOTUM_BENCH_SOURCE_SHA'),inputs),inputs.diagnostic_ref);
  for(const target of ['activity/24h','session/30d','budget/30d'])for(const mode of ['native_trace','native_profile']){
    const selectedInputs={diagnostic_ref:inputs.diagnostic_ref,[mode]:true,native_target:target};
    assert.equal(evaluate(expression(dashboard,'BENCH_SCOPE'),selectedInputs),'dashboard');
    assert.equal(selected('bench-dashboard',selectedInputs),true);
    for(const name of ['bench','bench-history','bench-panning','idle-cpu-control','native-postmortem-control','startup-io-control'])assert.equal(selected(name,selectedInputs),false,name);
  }
  assert.ok(ci.includes('options: [activity/24h, session/30d, quota/24h, budget/30d]'));assert.ok(dashboard.includes('timeout-minutes: 20'));
});


const jobs=[...ci.split('\njobs:\n')[1].matchAll(/^  ([\w-]+):$/gm)].map(match=>match[1]);
const combined={combined_benchmark:true,diagnostic_ref:'1'.repeat(40),expected_client_sha256:'2'.repeat(64)};
const step=(name:string)=>{
  const block=job('bench-dashboard').split('\n      - ').slice(1).find(block=>block.startsWith(`name: ${name}\n`));
  assert.ok(block,`missing dashboard step ${name}`);return block;
};
const environment=(block:string,inputs:object,github:object={})=>Object.fromEntries(
  [...block.matchAll(/^          (\w+): \$\{\{ (.+) \}\}$/gm)].map(([,key,value])=>[key,String(evaluate(value,inputs,github))]));
const shell=(block:string)=>block.split('        run: |\n')[1].split('\n').map(line=>line.slice(10)).join('\n');
const onlyCombined=(inputs:object,github:object={})=>{
  assert.equal(selected('bench-dashboard',inputs,github),true,'combined request must reach its guard');
  for(const name of jobs.filter(name=>name!=='bench-dashboard'))assert.equal(selected(name,inputs,github),false,name);
};

test('combined benchmark selects only the existing dashboard job and the full canonical scope',()=>{
  onlyCombined(combined);
  const dashboard=job('bench-dashboard');
  assert.equal(evaluate(expression(dashboard,'BENCH_SCOPE'),combined),'all');
  assert.ok(dashboard.includes('npm run bench -- --ci --scope "${BENCH_SCOPE}"'));
  assert.equal(jobs.length,12,'reuse the existing job set');
  assert.match(ci.split('  workflow_dispatch:\n')[1],/combined_benchmark:\n[^]*?type: boolean\n\s+default: false/);
  assert.ok(!ci.split('  workflow_call:\n')[1].split('  workflow_dispatch:')[0].includes('combined_benchmark:'));
  assert.match(dashboard,/^    timeout-minutes: 20$/m);
  assert.ok(!dashboard.includes('continue-on-error:'));
  assert.match(dashboard,/name: Benchmark evidence\n        if: always\(\)\n        uses: actions\/upload-artifact@v7/);
  assert.ok(dashboard.includes('name: bench-dashboard-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'));
  assert.ok(dashboard.includes('path: ${{ runner.temp }}/quotum-bench-dashboard'));
  assert.ok(dashboard.includes('if-no-files-found: warn'));
  assert.equal(evaluate(expression(dashboard,'ref'),combined),combined.diagnostic_ref);
  for(const [key,expected] of [['QUOTUM_BENCH_SOURCE_SHA',combined.diagnostic_ref],['QUOTUM_BENCH_EXPECTED_CLIENT_SHA256',combined.expected_client_sha256],['QUOTUM_BENCH_DIAGNOSE_IDLE_CPU',''],['QUOTUM_BENCH_NATIVE_TARGET',''],['QUOTUM_BENCH_CAPTION_CONTROL','']]){
    assert.equal(evaluate(expression(dashboard,key),combined),expected,key);
  }
  for(const native_target of ['activity/24h','session/30d','quota/24h']){
    const inputs={...combined,native_target};onlyCombined(inputs);
    assert.equal(evaluate(expression(dashboard,'BENCH_SCOPE'),inputs),'all');
    assert.equal(evaluate(expression(dashboard,'QUOTUM_BENCH_NATIVE_TARGET'),inputs),'');
  }
  const verify=step('Verify the requested source and received-client identity');
  assert.equal(Boolean(evaluate(expression(verify,'if'),combined)),true);
  const env=environment(verify,combined);
  assert.equal(env.COMBINED_BENCHMARK,'true');assert.equal(env.QUOTUM_BENCH_SOURCE_SHA,combined.diagnostic_ref);
  assert.equal(env.EXPECTED_CLIENT_SHA256,combined.expected_client_sha256);
});

test('combined guard is the first step and rejects invalid requests before checkout',{skip:process.platform==='win32'},()=>{
  const dashboard=job('bench-dashboard'),guard=step('Require the isolated pinned combined benchmark');
  assert.ok(dashboard.split('    steps:\n')[1].startsWith('      - name: Require the isolated pinned combined benchmark\n'));
  assert.ok(guard.includes('working-directory: ${{ runner.temp }}'));assert.ok(guard.includes('shell: bash'));
  assert.equal(Boolean(evaluate(expression(guard,'if'),combined)),true);
  assert.equal(Boolean(evaluate(expression(guard,'if'),{})),false);
  const run=(inputs:object,github:object={})=>{
    onlyCombined(inputs,github);
    const result=spawnSync('bash',['-eu','-c',shell(guard)],{env:{...process.env,...environment(guard,inputs,github)},encoding:'utf8'});
    assert.ifError(result.error);return result;
  };
  for(const native_target of [undefined,'activity/24h','quota/24h'])assert.equal(run({...combined,native_target}).status,0);
  const invalid:[object,object][]=[
    ...modes.flatMap(mode=>[[{...combined,[mode]:true},{}],[{combined_benchmark:true,[mode]:true},{}]] as [object,object][]),
    ...['diagnostic_ref','expected_client_sha256'].flatMap(key=>['','main','A'.repeat(key==='diagnostic_ref'?40:64),'a'.repeat(key==='diagnostic_ref'?39:63),'a'.repeat(key==='diagnostic_ref'?41:65),'1'.repeat(key==='diagnostic_ref'?40:64)+'\n'].map(value=>[{...combined,[key]:value},{}] as [object,object])),
    [{combined_benchmark:true},{}],
    ...['push','pull_request','workflow_call','release'].map(event_name=>[combined,{event_name}] as [object,object]),
    [combined,{ref:'refs/tags/v1.0.0'}],
    [{...combined,reusable_call:true},{event_name:'pull_request'}],
  ];
  for(const [inputs,github] of invalid){
    const result=run(inputs,github);assert.notEqual(result.status,0,JSON.stringify({inputs,github}));
    assert.match(result.stderr,/Choose only the manual combined benchmark/);
  }
});

test('combined false keeps ordinary manual, reusable, release and tag job selection',()=>{
  const ordinary=['dev-tooling','hub','bench','bench-history','bench-dashboard','bench-panning','managed-keys','agent','installers'];
  const tags=['dev-tooling','hub','managed-keys','agent','installers'];
  for(const [inputs,github,expected] of [
    [{},{event_name:'push'},ordinary],[{},{event_name:'pull_request'},ordinary],
    [{native_target:'activity/24h'},{event_name:'workflow_dispatch'},ordinary],
    [{reusable_call:true},{event_name:'pull_request'},ordinary],
    [{reusable_call:true},{event_name:'push',ref:'refs/tags/v1.0.0'},tags],
    [{},{event_name:'push',ref:'refs/tags/v1.0.0'},tags],
  ] as [object,object,string[]][]){
    for(const patch of [{},{combined_benchmark:false}]){
      const actual=jobs.filter(name=>selected(name,{...inputs,...patch},github));assert.deepEqual(actual,expected);
      assert.equal(evaluate(expression(job('bench-dashboard'),'BENCH_SCOPE'),{...inputs,...patch},github),'updates');
    }
  }
});


test('combined post-build preflight verifies the actual checkout and compiled client before execution',()=>{
  const dashboard=job('bench-dashboard'),verify=step('Verify the requested source and received-client identity');
  assert.ok(dashboard.indexOf('      - run: npm run build\n')<dashboard.indexOf('      - name: Verify the requested source'));
  assert.ok(dashboard.indexOf('      - name: Verify the requested source')<dashboard.indexOf('npm run bench -- --ci'));
  const source=shell(verify).split("node --import tsx --input-type=module <<'JS'\n")[1].split('\nJS')[0]
    .replace(/^import .+;\n/gm,'');
  const check=(inputs:object,actual=combined.diagnostic_ref,client:object={status:'available',sha256:combined.expected_client_sha256})=>runInNewContext(source,{
    process:{env:environment(verify,inputs)},console:{log:()=>{}},clientIdentity:()=>client,
    execFileSync:(command:string,args:string[])=>{
      assert.equal(command,'git');assert.deepEqual(Array.from(args),['rev-parse','HEAD']);return actual+'\n';
    },
  });
  assert.doesNotThrow(()=>check(combined));
  for(const mode of ['native_trace','native_profile','caption_control']){
    assert.doesNotThrow(()=>check({...combined,combined_benchmark:false,[mode]:true}));
    assert.throws(()=>check({...combined,[mode]:true}),/Choose one diagnostic mode/);
  }
  assert.throws(()=>check({...combined,combined_benchmark:false}),/Choose one diagnostic mode/);
  for(const [inputs,actual,client] of [
    [combined,'3'.repeat(40),{status:'available',sha256:combined.expected_client_sha256}],
    [combined,combined.diagnostic_ref,{status:'available',sha256:'3'.repeat(64)}],
    [combined,combined.diagnostic_ref,{status:'unavailable'}],
    [{...combined,diagnostic_ref:'main'},'main',{status:'available',sha256:combined.expected_client_sha256}],
    [{...combined,expected_client_sha256:'bad'},combined.diagnostic_ref,{status:'available',sha256:'bad'}],
  ] as [object,string,object][])assert.throws(()=>check(inputs,actual,client),/source or client mismatch/);
});
