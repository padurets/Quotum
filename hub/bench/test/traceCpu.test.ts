import {test} from 'node:test';
import assert from 'node:assert/strict';
import {threadCpuBounds} from '../traceCpu.js';
import type {SafeTrace} from '../panningDiagnostic.js';

const point=(ts:number,threadTs:number):SafeTrace=>({name:'TimeStamp',phase:'I',pid:1,tid:2,ts,threadTs});

test('equal wall intervals distinguish CPU execution from an idle thread without guessing between samples',()=>{
  const busy=threadCpuBounds([point(0,0),point(100,90),point(99_900,99_880),point(100_000,99_970)],1,2,0,100_000);
  const idle=threadCpuBounds([point(0,0),point(100,90),point(99_900,180),point(100_000,270)],1,2,0,100_000);
  assert.equal(busy.status,'bounded');assert.equal(idle.status,'bounded');
  assert.ok(busy.cpuLowerMs!>99);assert.ok(idle.cpuUpperMs!<1);
  const sparse=threadCpuBounds([point(0,0),point(200_000,100_000)],1,2,50_000,150_000);
  assert.equal(sparse.cpuLowerMs,0);assert.equal(sparse.cpuUpperMs,100);
  assert.equal(sparse.beforeGapMs,50);assert.equal(sparse.afterGapMs,50);
});

test('nested slices cannot double count CPU and other threads cannot fill a missing clock',()=>{
  const events:SafeTrace[]=[{name:'RunTask',phase:'X',pid:1,tid:2,ts:0,duration:100_000,threadTs:0,threadDuration:70_000},
    {name:'FunctionCall',phase:'X',pid:1,tid:2,ts:10_000,duration:80_000,threadTs:5_000,threadDuration:60_000}];
  const result=threadCpuBounds(events,1,2,0,100_000);
  assert.ok(result.cpuLowerMs!>69.99&&result.cpuUpperMs!<70.01);
  assert.equal(threadCpuBounds(events,1,3,0,100_000).status,'missing-thread-clock');
  assert.equal(threadCpuBounds(events.map(({threadTs:_,...event})=>event),1,2,0,100_000).status,'missing-thread-clock');
});

test('incomplete boundaries and regressing thread clocks never become zero CPU evidence',()=>{
  assert.equal(threadCpuBounds([point(10,2),point(90,5)],1,2,0,100).status,'missing-thread-clock');
  assert.equal(threadCpuBounds([point(0,100),point(100,0)],1,2,0,100).status,'inconsistent-thread-clock');
  assert.equal(threadCpuBounds([],1,2,100,0).status,'invalid-interval');
});
