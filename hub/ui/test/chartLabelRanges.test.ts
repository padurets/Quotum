import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {valueAt} from '../lib/readout';

type Point = [number, number, number];
type Input = {
  lines: {points: Point[]}[];
  forecasts?: {points: Point[]}[];
  plans?: {runs: Point[][]}[];
};

function draw(input: Input) {
  const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('Chart.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const helper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'firstAt');
  const start = source.indexOf('  const labelY = '), end = source.indexOf('  // Stacked from ', start);
  assert.ok(start > 0 && end > start, 'load the production label calculations');
  const context = {valueAt, calculate: null as unknown as (input: Input) => {stackTop: boolean; labelY: (anchor: number, end: boolean) => number}};
  runInNewContext(ts.transpileModule(`${helper?.getText(ast) ?? ''}
    function calculate(input) {
      const {lines, forecasts = [], plans = []} = input;
      const width = 900, height = 220, top = 12, bottom = 28, right = 12;
      const LABEL_WIDTH = 220, LABEL_BAND = 15, LABEL_STEP = 22;
      const beyond = [{}], announced = [{}], past = [{}, {}], more = [];
      const timeAt = px => px;
      ${source.slice(start, end)}
      return {stackTop, labelY};
    }
    globalThis.calculate = calculate;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  return context.calculate(input);
}

test('label ranges keep duplicate boundary points and include forecast and plan samples', () => {
  const points: Point[] = [[-1, 0, 1], [668, 0, 1], [668, 0, 1], [700, 100, 1], [750, 100, 1],
    [800, 100, 1], [888, 0, 1], [888, 0, 1], [889, 100, 1], [900, 100, 1]];
  const measured = draw({lines: [{points}]});
  assert.equal(measured.stackTop, true, 'both inclusive boundaries retain both repeated low points');
  assert.equal(measured.labelY(888, true), 30);
  assert.equal(measured.labelY(889, true), 184, 'moving the range excludes its old left boundary');
  const forecasts = [{points: [[0, 100, 1], [1000, 100, 1]] as Point[]}];
  assert.equal(draw({lines: [{points}], forecasts}).stackTop, false, 'five forecast samples add high values');
  const plans = [{runs: [[[0, 0, 1], [1000, 0, 1]] as Point[]]}];
  assert.equal(draw({lines: [{points}], forecasts, plans}).stackTop, true, 'five plan samples add low values');
});

test('dense label calculations inspect only the covered part of sorted series', () => {
  let reads = 0;
  const points: Point[] = Array.from({length: 32768}, (_, at) => [at, at >= 668 && at <= 888 ? 100 : 0, 1]);
  const watched = new Proxy(points, {get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  }});
  const result = draw({lines: Array.from({length: 12}, () => ({points: watched}))});
  assert.equal(result.stackTop, false);
  const stackReads = reads;
  reads = 0;
  assert.equal(result.labelY(0, false), 30);
  const leftReads = reads;
  reads = 0;
  assert.equal(result.labelY(888, true), 184);
  assert.ok(stackReads < 3000, `stack inspected ${stackReads} points outside its narrow range`);
  assert.ok(leftReads < 3000, `left label inspected ${leftReads} points outside its narrow range`);
  assert.ok(reads < 3000, `right label inspected ${reads} points outside its narrow range`);
});
