/**
 * Waiting for the page to be still before deciding on it. The page is laid out anew in passes, a
 * frame or more apart (the board after a resize, its widgets sliding to their places), and what
 * stands in between is not where things end up. `stir` tells of a pass; once a frame has gone
 * by with none and nothing `busy`, `done` runs, once. Frames, not time: `frames` are the
 * window's, or a test's.
 */

export type Frames = {
  request(run: () => void): number;
  cancel(id: number): void;
};

export const windowFrames: Frames = {
  request: run => requestAnimationFrame(run),
  cancel: id => cancelAnimationFrame(id),
};

export function settler(done: () => void, busy: () => boolean, frames: Frames = windowFrames) {
  let frame = 0;
  let stirred = false;
  const tick = () => {
    if (stirred || busy()) {
      stirred = false;
      frame = frames.request(tick);
      return;
    }
    frame = 0;
    done();
  };
  return {
    /** A pass of the page's layout. */
    stir() {
      stirred = true;
      if (!frame) frame = frames.request(tick);
    },
    /** Whether the page is being laid out: it has stirred and is not still yet. */
    moving: () => frame !== 0,
    stop() {
      if (frame) frames.cancel(frame);
      frame = 0;
    },
  };
}
