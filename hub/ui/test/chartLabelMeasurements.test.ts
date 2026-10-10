import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

/** Run the label's actual measurement effect with glyph bounds supplied by the browser. */
function labels() {
  const text = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
  const source = ts.createSourceFile('Chart.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const marker = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'MarkerLabel');
  assert.ok(marker);
  const effects: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useLayoutEffect') effects.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(marker);
  assert.equal(effects.length, 2);
  const cache = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'LabelBoxes');
  type Backing = {x: number; width: number};
  const context = {reads: 0, backing: null, make: null, draw: null} as unknown as {
    reads: number;
    make(): object;
    draw(cache: object, shown: string, end: boolean, color: string | undefined, fonts: number, x: number, offset: number, width: number): Backing;
  };
  const script = `${cache?.getText(source) ?? ''}
    globalThis.make = () => ${cache ? 'new LabelBoxes()' : '({})'};
    globalThis.draw = (boxes, shown, end, color, fonts, x, offset, width) => {
      const text = {current: {getBBox() {reads++; return {x: x + offset, width};}}};
      const setBox = update => {backing = update(backing);};
      (${effects[1].getText(source)})();
      return {x: x + backing.offset - 6, width: backing.width + 12};
    };`;
  runInNewContext(ts.transpileModule(script, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  return context;
}

test('remounted chart captions reuse glyph bounds at another position', () => {
  const label = labels(), cache = label.make();
  const first = label.draw(cache, 'Reset in 2h', true, undefined, 1, 100, -38, 37);
  const moved = label.draw(cache, 'Reset in 2h', true, undefined, 1, 300, -38, 37);
  assert.equal(first.x, 56);
  assert.equal(moved.x, 256);
  assert.equal(first.width, moved.width);
  assert.equal(label.reads, 1, 'the same text and font need only one native glyph read across mounts');
});

test('loaded fonts, text anchors and forecast weights keep their own glyph bounds', () => {
  const label = labels(), cache = label.make();
  const normal = label.draw(cache, 'Caption', true, undefined, 0, 100, -38, 37);
  const loaded = label.draw(cache, 'Caption', true, undefined, 1, 100, -45, 43);
  const start = label.draw(cache, 'Caption', false, undefined, 1, 100, 1, 43);
  const forecast = label.draw(cache, 'Caption', false, 'series', 1, 100, 2, 39);
  assert.equal(normal.width, 49);
  assert.equal(loaded.width, 55);
  assert.equal(start.x, 95);
  assert.equal(forecast.x, 96);
  assert.equal(forecast.width, 51);
  assert.equal(label.reads, 4);
  label.draw(cache, 'Caption', false, 'another-series', 1, 300, 2, 39);
  assert.equal(label.reads, 4, 'forecast colours share their font weight');
});

test('caption bounds retain Unicode text and remain bounded over changing captions', () => {
  const label = labels(), cache = label.make();
  const caption = 'Русская подпись 👩‍💻';
  const first = label.draw(cache, caption, true, undefined, 1, 100, -94, 92);
  assert.equal(first.x, 0);
  assert.equal(first.width, 104);
  label.draw(cache, caption, true, undefined, 1, 200, -94, 92);
  assert.equal(label.reads, 1);
  for (let i = 0; i < 300; i++) label.draw(cache, String(i), true, undefined, 1, 100, -10, 9);
  const reads = label.reads;
  label.draw(cache, caption, true, undefined, 1, 100, -94, 92);
  assert.equal(label.reads, reads + 1, 'old captions leave the bounded chart cache');
});
