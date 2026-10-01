type Point = {x: number; y: number; text: string};

/** Keeps the same rounded outline, omitting only vertices on straight boundaries. */
export function plotPath(runs: readonly (readonly (readonly [number, number])[])[]) {
  return runs.map(run => {
    const parts: string[] = [];
    let before: Point | null = null, last: Point | null = null;
    for (const [x, y] of run) {
      const sx = x.toFixed(1), sy = y.toFixed(1);
      const next = {x: Math.round(Number(sx) * 10), y: Math.round(Number(sy) * 10), text: `${parts.length ? 'L' : 'M'}${sx},${sy}`};
      if (before && last && (last.x - before.x) * (next.y - last.y) === (last.y - before.y) * (next.x - last.x) && (last.x - before.x) * (next.x - last.x) + (last.y - before.y) * (next.y - last.y) >= 0) {
        parts[parts.length - 1] = next.text;
      } else {
        parts.push(next.text);
        before = last;
      }
      last = next;
    }
    return parts.join('');
  }).join('');
}
