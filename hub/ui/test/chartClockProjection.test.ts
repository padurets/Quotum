import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';

test('current clock presentation keeps paired future paths, raw marker coordinates and composed overlays', () => {
  const H = 3_600_000, minute = 60_000, source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const model = '), head = source.slice(start, source.indexOf('  const none = ', start));
  const markerStart = source.indexOf('markers.map(marker => {'), markerEnd = source.indexOf('\n        {lines.map', markerStart);
  const markerRender = source.slice(markerStart, markerEnd).trim().slice(0, -1);
  const hoverX = source.split('\n').find(line => line.startsWith('  const hoverX = '));
  const bandWidth = source.split('\n').find(line => line.startsWith('  const bandWidth = '));
  const basis = {from: 0, to: 2 * H, end: H};
  const context = {React, prepared: {ready: true, value: {basis, now: H, lines: [], plans: [{key: 'expired', until: H}, {key: 'valid', until: 3 * H}], planPaths: ['expired-plan', 'valid-plan'],
    forecasts: [{key: 'expired', until: H}, {key: 'valid', until: 3 * H}], forecastPaths: ['expired-forecast', 'valid-forecast'],
    markers: [{key: 'entering', at: 2 * H + minute, until: 3 * H, label: 'reset', color: 'red'}, {key: 'expired', at: H, until: H}], paths: [], strip: null}},
    currentClock: H + minute, desiredFrom: minute, desiredNow: H + minute, desiredTo: 2 * H, desiredLive: true,
    incomingReady: true, cellMs: minute, left: 40, right: 12, width: 900, height: 220, top: 12, bottom: 28,
    axis: {basis, hover: H, screenX: (at: number) => 40 + (at - context.desiredFrom) / (context.desiredTo - context.desiredFrom) * 848, commitDrawing: () => {}},
    niceTicks: () => ({ticks: [], daily: false}), useLayoutEffect: () => {}, cellLabel: () => '',
    draw: null as unknown as () => {plans: {key: string}[]; planPaths: string[]; forecasts: {key: string}[]; forecastPaths: string[]; now: number; to: number; hoverX: number; bandWidth: number; elements: React.ReactNode[]; x: (at: number) => number},
  };
  runInNewContext(ts.transpileModule(`function draw(){${head}\n${hoverX}\n${bandWidth}\nreturn {plans,planPaths,forecasts,forecastPaths,now,to,hoverX,bandWidth,x,elements:${markerRender}};}\nglobalThis.draw=draw;`, {compilerOptions: {target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React}}).outputText, context);
  const first = context.draw();
  assert.deepEqual([...first.planPaths], ['valid-plan']); assert.deepEqual([...first.forecastPaths], ['valid-forecast']);
  assert.equal(first.plans[0].key, 'valid'); assert.equal(first.forecasts[0].key, 'valid');
  assert.equal(first.now, context.desiredNow); assert.equal(first.to, context.desiredTo); assert.equal(context.prepared.value.now, H);
  assert.equal(first.elements[0], null, 'a retained future marker stays hidden until the requested edge reaches it');
  assert.equal(first.hoverX, context.axis.screenX(Math.min(context.desiredNow, H + minute / 2)));
  assert.equal(first.bandWidth, context.axis.screenX(H + minute) - context.axis.screenX(H));
  context.desiredTo += 2 * minute;
  const entered = context.draw(), marker = entered.elements[0] as React.ReactElement<{children: React.ReactElement<{x1: number}>[]}>;
  const rawX = marker.props.children[0].props.x1;
  assert.equal(rawX, entered.x(2 * H + minute)); assert.ok(rawX > 888, 'moving artwork must not clamp to its old numeric edge');
  const composed = 40 + (rawX - 40) * (2 * H) / (context.desiredTo - context.desiredFrom) - context.desiredFrom / (context.desiredTo - context.desiredFrom) * 848;
  assert.ok(Math.abs(composed - context.axis.screenX(2 * H + minute)) < 1e-10);
  context.currentClock = 3 * H; assert.equal(context.draw().elements.length, 0, 'expired reset markers leave the retained model presentation');
});
