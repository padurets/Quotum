import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {fitting, graphemes} from '../components/Chart';

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
    draw(cache: object, shown: string, end: boolean, color: string | undefined, fonts: number, x: number, offset: number, width: number, scale?: number): Backing;
  };
  const script = `${cache?.getText(source) ?? ''}
    globalThis.make = () => ${cache ? 'new LabelBoxes()' : '({})'};
    globalThis.draw = (boxes, shown, end, color, fonts, x, offset, width, scale = 1) => {
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

/** Execute the production shortening effect with native character widths supplied. */
function shortened() {
  const text = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
  const source = ts.createSourceFile('Chart.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const marker = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'MarkerLabel');
  const cache = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'LabelBoxes');
  assert.ok(marker && cache);
  const effects: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useLayoutEffect') effects.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(marker);
  assert.equal(effects.length, 2);
  type Reading = {fail?: boolean; characters?: number; width?: number};
  const context = {reads: 0, fitting, graphemes} as unknown as {
    reads: number;
    make(): object;
    draw(boxes: object, children: string, name: string, room: number, fonts?: number, color?: string, reading?: Reading, scale?: number): number | null;
  };
  const script = `${cache.getText(source)}
    globalThis.make = () => new LabelBoxes();
    globalThis.draw = (boxes, children, name, room, fonts = 0, color, reading = {}, scale = 1) => {
      const shorten = {name, room}, input = children + '|' + room + '|' + fonts;
      const whole = {current: {
        getSubStringLength(start, length) {reads++; if (reading.fail) throw Error('unavailable'); return length * (reading.width ?? 7);},
        getNumberOfChars() {reads++; return reading.characters ?? children.length + 1;},
      }};
      let saved = null;
      const setFit = update => {saved = update(saved);};
      (${effects[0].getText(source)})();
      return saved?.keep ?? null;
    };`;
  runInNewContext(ts.transpileModule(script, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  return context;
}

test('remounted captions reuse both whole and shortened native text fits', () => {
  const label = shortened(), cache = label.make();
  assert.equal(label.draw(cache, 'Reset: Codex', 'Codex', 200), null);
  label.draw(cache, 'Reset: Codex', 'Codex', 200);
  assert.equal(label.reads, 1, 'a whole fit is remembered too');
  assert.equal(label.draw(cache, 'Reset: Codex', 'Codex', 70), 2);
  const reads = label.reads;
  assert.equal(label.draw(cache, 'Reset: Codex', 'Codex', 70), 2);
  assert.equal(label.reads, reads, 'remounting does not flush layout to measure the same name');
});

test('caption fits follow their text, name, available width and font weight', () => {
  const label = shortened(), cache = label.make();
  label.draw(cache, 'Reset: Codex', 'Codex', 70);
  for (const [children, name, room, fonts, color] of [
    ['Reset: Codex', 'Codex', 71, 0, undefined],
    ['Reset: Codex', 'Codex', 71, 1, undefined],
    ['Reset: Codex', 'Codex', 71, 1, 'series'],
    ['Reset: Codex', 'Reset', 71, 1, 'series'],
    ['Reset: Other', 'Other', 71, 1, 'series'],
  ] as const) {
    const reads = label.reads;
    label.draw(cache, children, name, room, fonts, color);
    assert.ok(label.reads > reads);
  }
  const reads = label.reads;
  label.draw(cache, 'Reset: Other', 'Other', 71, 1, 'another-series');
  assert.equal(label.reads, reads, 'the actual colour does not change the font');
});

test('unavailable native fits can be measured again while character mismatches keep the whole text', () => {
  const label = shortened(), cache = label.make();
  assert.equal(label.draw(cache, 'Reset: Codex', 'Codex', 70, 0, undefined, {fail: true}), null);
  assert.equal(label.draw(cache, 'Reset: Codex', 'Codex', 70), 2);
  const other = label.make();
  assert.equal(label.draw(other, 'Reset: Codex', 'Codex', 70, 0, undefined, {characters: 10}), null);
  const reads = label.reads;
  label.draw(other, 'Reset: Codex', 'Codex', 70, 0, undefined, {characters: 10});
  assert.equal(label.reads, reads, 'the safe whole-text fallback needs no repeated native read');
});

test('Unicode caption fits remain bounded over changing names', () => {
  const label = shortened(), cache = label.make();
  const text = 'Русская подпись 👩‍💻';
  label.draw(cache, text, text, 500);
  label.draw(cache, text, text, 500);
  assert.equal(label.reads, 1);
  for (let i = 0; i < 300; i++) label.draw(cache, String(i), String(i), 500);
  const reads = label.reads;
  label.draw(cache, text, text, 500);
  assert.equal(label.reads, reads + 1, 'old fits leave the bounded caption cache');
});

test('a smaller SVG viewport remeasures native caption bounds at its new scale', () => {
  const label = labels(), cache = label.make();
  label.draw(cache, 'Caption', true, undefined, 0, 268, -180, 179, 1);
  const narrow = label.draw(cache, 'Caption', true, undefined, 0, 268, -179.5, 178.5, 240 / 280);
  assert.equal(narrow.x, 82.5);
  assert.equal(narrow.width, 190.5);
  assert.equal(label.reads, 2, 'the same font can have different native bounds at a fractional viewport scale');
});

test('native width changes at a fractional SVG scale invalidate a remembered text fit', () => {
  const label = shortened(), cache = label.make();
  assert.equal(label.draw(cache, 'Reset: Codex', 'Codex', 70), 2);
  assert.equal(label.draw(cache, 'Reset: Codex', 'Codex', 70, 0, undefined, {width: 7.1}, 240 / 280), 1);
});
