import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settler, type Frames} from '../lib/settle';

/** Frames run by hand: `next()` runs what asked for the coming one. */
function manual() {
  let queue = new Map<number, () => void>();
  let id = 0;
  const frames: Frames = {
    request: run => (queue.set(++id, run), id),
    cancel: frame => void queue.delete(frame),
  };
  const next = () => {
    const due = queue;
    queue = new Map();
    for (const run of due.values()) run();
  };
  return {frames, next, waiting: () => queue.size};
}

test('the page is still once a frame goes by with nothing laid out anew', () => {
  const {frames, next, waiting} = manual();
  let done = 0;
  const page = settler(() => done++, () => false, frames);
  assert.equal(page.moving(), false);
  page.stir();
  assert.equal(page.moving(), true);
  next();
  assert.equal(done, 0, 'the frame it stirred in');
  assert.equal(page.moving(), true, 'waiting for a still one');
  next();
  assert.equal(done, 1, 'a still one');
  assert.equal(page.moving(), false);
  assert.equal(waiting(), 0, 'and no more frames asked for');
  next();
  assert.equal(done, 1, 'once');
});

test('passes of the layout a frame apart keep it waiting, and many in one frame ask for one', () => {
  const {frames, next, waiting} = manual();
  let done = 0;
  const page = settler(() => done++, () => false, frames);
  page.stir();
  page.stir();
  page.stir();
  assert.equal(waiting(), 1);
  for (let pass = 0; pass < 5; pass++) {
    next();
    page.stir();
  }
  assert.equal(done, 0);
  next();
  next();
  assert.equal(done, 1);
});

test('something still sliding keeps it waiting until it is done', () => {
  const {frames, next} = manual();
  let done = 0;
  let sliding = 3;
  const page = settler(() => done++, () => sliding-- > 0, frames);
  page.stir();
  for (let frame = 0; frame < 4; frame++) next();
  assert.equal(done, 0);
  assert.equal(page.moving(), true, 'still moving while something slides');
  next();
  assert.equal(done, 1);
});

test('stopped, it decides nothing and asks for no more frames', () => {
  const {frames, next, waiting} = manual();
  let done = 0;
  const page = settler(() => done++, () => false, frames);
  page.stir();
  next();
  page.stop();
  assert.equal(waiting(), 0);
  assert.equal(page.moving(), false);
  next();
  assert.equal(done, 0);
  page.stir();
  next();
  next();
  assert.equal(done, 1, 'stirred again, it waits again');
});
