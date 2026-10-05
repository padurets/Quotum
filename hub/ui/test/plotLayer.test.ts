import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {plotLayerFixture} from './plotLayerFixture';

const {clipPlot, PlotLayer} = plotLayerFixture();

test('the moving artwork keeps its SVG projection inside a stationary CSS clip', () => {
  const rendered = renderToStaticMarkup(createElement(PlotLayer, {
    width: 400, height: 200, scale: .875, left: 40, right: 12, main: true,
    children: createElement('path', {d: 'M-100,10L500,20'}),
  }));
  assert.ok(rendered.includes('class="plot-clip" style="left:35px;right:10.5px"'));
  assert.ok(rendered.includes('class="plot-move" data-plot-main="true" style="left:-35px;width:350px"'));
  assert.ok(rendered.includes('viewBox="0 0 400 200" preserveAspectRatio="none"'));
  assert.ok(rendered.includes('M-100,10L500,20'), 'the fixed HTML viewport, not the artwork coordinates, clips overscan');
});

test('changing a whole-bar clip preserves its origin and SVG dimensions', () => {
  const moving = {style: {left: '-35px', width: '350px', height: '100%', transform: 'translateX(-20px)'}};
  const counter = {style: {transform: ''}, firstElementChild: moving};
  const end = {style: {transform: ''}, firstElementChild: counter};
  const start = {style: {transform: ''}, firstElementChild: end};
  const frame = {style: {left: '35px', right: '10.5px', visibility: ''}, firstElementChild: start} as unknown as HTMLDivElement;
  for (const [from, to] of [[35, 339.5], [67.5, 301.25], [-10, 400], [300, 250], [400, 500]]) {
    clipPlot(frame, from, to, 350);
    const shift = (node: typeof counter | typeof start | typeof end) => Number(node.style.transform.match(/^translateX\(([-.\d]+)px\)$/)?.[1] ?? 0);
    const a = shift(start), b = frame.style.visibility === 'hidden' ? a : 304.5 + a + shift(end);
    assert.ok(a >= 0 && b >= a && b <= 304.5);
    const fromEdge = Math.max(0, Math.min(304.5, from - 35)), toEdge = Math.max(fromEdge, Math.min(304.5, to - 35));
    assert.equal(frame.style.visibility === 'hidden', toEdge === fromEdge);
    if (toEdge > fromEdge) assert.deepEqual([a, b], [fromEdge, toEdge], 'the visible intersection is exactly the requested whole-bar interval');
    for (const point of [-100, 0, 99.5, 350]) assert.ok(Math.abs(a + shift(end) + shift(counter) + point - point) < 1e-10, 'the clip changes without scaling or shifting its artwork');
    assert.equal(frame.style.left, '35px', 'the clip does not lay out its ancestors again');
    assert.equal(frame.style.right, '10.5px');
    assert.equal(35 + parseFloat(moving.style.left), 0, 'source coordinates remain in the chart’s fixed projection');
    assert.equal(moving.style.width, '350px');
    assert.equal(moving.style.height, '100%');
    assert.equal(moving.style.transform, 'translateX(-20px)', 'clipping cannot replace the gesture transform');
  }
});
