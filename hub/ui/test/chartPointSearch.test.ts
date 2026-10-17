import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {pointIndex} from '../lib/lines';
import {valueAt} from '../lib/readout';

type Point = [number, number];
type Input = {lines: {points: Point[]}[]; plans: {runs: Point[][]}[]; forecasts: {points: Point[]}[]; from: number; to: number; stacked?: number};

/** The previous segment walk is an independent oracle for endpoint precedence. */
function linearValue(runs: Point[][], at: number): number | undefined {
  for (const run of runs) {
    if (at < run[0][0] || at > run.at(-1)![0]) continue;
    for (let i = 1; i < run.length; i++) {
      const [a, av] = run[i - 1], [b, bv] = run[i];
      if (at <= b) return b === a ? bv : av + (bv - av) * (at - a) / (b - a);
    }
  }
  return undefined;
}

const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
const labelStart = source.indexOf('  const labelY = '), labelEnd = source.indexOf('\n  // With labels', labelStart);
const stackStart = source.indexOf('  const stackTop = '), stackEnd = source.indexOf('\n  // Stacked from', stackStart);
function chartReader(label: string, stack: string) {
  const context = {pointIndex, valueAt, read: null as unknown as (input: Input, end: boolean) => {labelY: number; stackTop: boolean}};
  runInNewContext(ts.transpileModule(`function read(input,end){
  const {lines,plans,forecasts}=input,stacked=input.stacked??3,height=300,top=12,bottom=28,width=1000,right=12,LABEL_STEP=22,LABEL_WIDTH=220,LABEL_BAND=15;
  const anchor=width-right,start=anchor-LABEL_WIDTH;
  const timeAt=x=>x<=start?input.from:x>=anchor?input.to:input.from+(x-start)/LABEL_WIDTH*(input.to-input.from);
  ${label}
  ${stack}
  return {labelY:labelY(end?anchor:start,end),stackTop};
}\nglobalThis.read=read;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  return context;
}
const labelCode = source.slice(labelStart,labelEnd), stackCode = source.slice(stackStart,stackEnd);
const context = chartReader(labelCode,stackCode);

/** Complete independent scans, including both inclusive boundaries and every duplicate. */
function linearChart(input: Input) {
  const height = 300, top = 12, bottom = 28, stacked = input.stacked ?? 3;
  let low = 0, high = 0, stackLow = 0, stackHigh = 0;
  const band = ((stacked * 22 + 6) / (height - top - bottom)) * 100;
  const count = (value: number | undefined) => {if (value === undefined) return; if (value < band) stackLow++; else if (value > 100 - band) stackHigh++;};
  for (const line of input.lines) for (const [at, value] of line.points) if (at >= input.from && at <= input.to) {
    if (value < 15) low++; else if (value > 85) high++;
    count(value);
  }
  for (const share of [0, .25, .5, .75, 1]) {
    const at = input.from + (input.to - input.from) * share;
    for (const forecast of input.forecasts) count(linearValue([forecast.points], at));
    for (const plan of input.plans) count(linearValue(plan.runs, at));
  }
  return {labelY: low > high ? top + 18 : height - bottom - 8, stackTop: !!stacked && stackHigh < stackLow};
}

test('interpolation preserves duplicate endpoints, singleton runs, gaps and first covering run', () => {
  const fixtures: Point[][][] = [[], [[[5, 9]]], [[[0, 10], [0, 20], [10, 30], [10, 40]]],
    [[[0, 10], [10, 20]], [[10, 80], [20, 90]]], [[[0, 10], [5, 30]], [[10, 40], [15, 70]]],
    [[[0, 10], [10, 20]], [[5, 90], [15, 80]]]];
  for (const runs of fixtures) for (const at of [-Infinity, -1, 0, .5, 5, 5.5, 9.5, 10, 10.5, 15, 20, 21, Infinity, NaN]) assert.equal(valueAt(runs, at), linearValue(runs, at));
  assert.equal(valueAt([[[0, 10], [0, 20], [10, 30]]], 0), 20);
  assert.equal(valueAt([[[0, 10], [10, 20]], [[10, 80], [20, 90]]], 10), 20);
  assert.equal(valueAt([[[5, 9]]], 5), undefined);
});

test('ordered interpolation matches the old walk across generated repeated timestamps', () => {
  let seed = 120; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let sample = 0; sample < 200; sample++) {
    const runs: Point[][] = []; let base = 0;
    for (let r = 0; r < 3; r++) {let at = base; const run: Point[] = [];
      for (let i = 0; i < 40; i++) {at += Math.floor(random() * 4); run.push([at, random() * 200 - 50]);}
      runs.push(run); base = at + 5;
    }
    for (const run of runs) for (const [at] of run) for (const offset of [-.5, 0, .5]) assert.equal(valueAt(runs, at + offset), linearValue(runs, at + offset));
  }
});

test('actual chart label and edge overlap preserve inclusive duplicates, empty and reversed ranges', () => {
  const lines = [{points: []}, {points: [[0, 0], [0, 100], [5, 5], [5, 7], [10, 98], [15, 50], [20, 0]] as Point[]}];
  const plans = [{runs: [[[0, 100], [10, 0]], [[15, 100], [20, 0]]] as Point[][]}], forecasts = [{points: [[0, 90], [10, 20], [20, 0]] as Point[]}];
  const ranges = [[-20, -1], [0, 0], [0, 5], [5, 5], [5, 10], [7, 9], [20, 25], [21, 30], [10, 5], [-Infinity, Infinity]];
  for (const [from, to] of ranges) for (const stacked of [0, 1, 3, 12]) for (const end of [false, true]) {
    const input = {lines, plans, forecasts, from, to, stacked}, actual = context.read(input, end);
    assert.deepEqual([actual.labelY, actual.stackTop], Object.values(linearChart(input)), `${from}..${to}, stack ${stacked}, end ${end}`);
  }
});

function counted(points: Point[]) {
  let reads = 0;
  const values = new Proxy(points, {get(target, key, receiver) {if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver);}});
  return {points: values, reads: () => reads, reset: () => {reads = 0;}};
}

test('actual chart overlap reads the selected band rather than every retained point', () => {
  const rows = Array.from({length: 12}, (_, n) => counted(Array.from({length: 4096}, (_, at) => [at, (at + n) % 101])));
  const input = {lines: rows.map(row => ({points: row.points})), plans: [], forecasts: [], from: 4070, to: 4080};
  const actual = context.read(input, true), bounded = rows.reduce((sum, row) => sum + row.reads(), 0);
  assert.deepEqual([actual.labelY, actual.stackTop], Object.values(linearChart(input)));
  rows.forEach(row => row.reset()); linearChart(input);
  const linear = rows.reduce((sum, row) => sum + row.reads(), 0);
  assert.equal(linear, 12 * 4096);
  assert.ok(bounded < 12 * 120, `${bounded} point reads for two selected-band calculations`);
  // Restore the old loops only in this VM: it must regain the full retained-series cost.
  const restoredLabel = labelCode.replace(/for \(let i = pointIndex\(points, a\); i < points\.length; i\+\+\) \{\s+const \[at,value\]=points\[i\];\s+if\(at>b\)break;/,
    'for (const [at,value] of line.points) {if (at < a || at > b) continue;');
  const restoredStack = stackCode.replace(/if\(a<=b\)for \(const line of lines\) \{\s+const points=line\.points;\s+for \(let i = pointIndex\(points, a\); i < points\.length; i\+\+\) \{\s+const \[at,value\]=points\[i\];\s+if\(at>b\)break;\s+count\(value\);\s+\}\s+\}/,
    'for (const line of lines) for (const [at,value] of line.points) if (at >= a && at <= b) count(value);');
  assert.notEqual(restoredLabel,labelCode);assert.notEqual(restoredStack,stackCode);
  rows.forEach(row=>row.reset());const restored = chartReader(restoredLabel,restoredStack).read(input,true);
  assert.deepEqual([restored.labelY,restored.stackTop],[actual.labelY,actual.stackTop]);
  assert.equal(rows.reduce((sum,row)=>sum+row.reads(),0),2*12*4096);
});

test('interpolation uses a bounded search even near the end of a retained run', () => {
  const row = counted(Array.from({length: 4096}, (_, at) => [at, at % 101])), runs = [row.points];
  const actual = valueAt(runs, 4094.5), bounded = row.reads(); row.reset();
  assert.equal(actual, linearValue(runs, 4094.5)); assert.ok(row.reads() > 8000);
  assert.ok(bounded < 25, `${bounded} point reads for interpolation`);
});
