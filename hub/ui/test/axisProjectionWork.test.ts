import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

test('actual projection helpers read only authored pose between animations and still sample an owned animation', () => {
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const visualGeometry = '), geometry = source.slice(start, source.indexOf('  const freezeSlides = ', start));
  const screenX = source.slice(source.indexOf('screenX: (at: number) => ')).split(', get held')[0].replace('screenX: ', '');
  for (const span of [0, 3_600_000]) {
    let lookups = 0, computed = 0;
    const layer = {}, base = 1_791_000_000_000;
    const context = {drawing: {current: {from: base, to: base + span, end: base + span}}, pose: {current: {a: 1.2, b: -73, offset: 130}},
      animations: {current: new Map<object, object>()}, width: 920, scale: .73, left: 48, right: 12,
      box: {current: {querySelector: () => {lookups++; return layer;}}},
      getComputedStyle: () => {computed++; return {transform: 'matrix(1.05,0,0,1,-32,0)'};},
      DOMMatrix: class {a = 1.05; e = -32;},
      visual: null as unknown as () => {from: number; to: number}, screen: null as unknown as (at: number) => number,
    };
    runInNewContext(ts.transpileModule(`${geometry}\nglobalThis.visual=visualGeometry;globalThis.screen=${screenX};`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
    const expected = (at: number, a = context.pose.current.a, b = context.pose.current.b) => a * (48 + (at - base) / Math.max(60_000, span) * 860) + b + 130 / .73;
    for (let i = 0; i < 100; i++) {
      context.visual();
      for (const at of [base + i * 60_000, base + (i + 1) * 60_000]) assert.ok(Math.abs(context.screen(at) - expected(at)) < 1e-4);
    }
    assert.equal(lookups, 0, 'the active edge painter must not query its already owned main layer');
    assert.equal(computed, 0);
    context.animations.current.set(layer, {});
    const at = base + 30_000;
    assert.ok(Math.abs(context.screen(at) - expected(at, 1.05, -32)) < 1e-4);
    assert.equal(lookups, 1); assert.equal(computed, 1, 'an interrupted fold still reads the actual animated pose');
    context.animations.current.clear();
    assert.ok(Math.abs(context.screen(at) - expected(at)) < 1e-4); assert.equal(lookups, 1);
  }
});
