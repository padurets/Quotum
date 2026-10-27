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
  inputs,github:{event_name:'workflow_dispatch',ref:'refs/heads/task',run_id:100,run_attempt:1,event:{},...github},
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
