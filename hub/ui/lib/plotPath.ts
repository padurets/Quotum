import {drain, type Preparation} from './prepare';

type Point = {x: number; y: number; sx?: string; sy?: string};

// Multiplication can round a binary value onto a decimal tie. Only those values
// need toFixed's exact tie decision; ordinary plot coordinates need no strings.
function rounded(value: number) {
  const scaled = value * 10;
  const tie = Math.abs(scaled - Math.floor(scaled) - .5) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2;
  const result = tie || Math.abs(scaled) >= 1e12 ? Math.round(Number(value.toFixed(1)) * 10) : Math.round(scaled);
  return result === 0 ? value < 0 ? -0 : 0 : result;
}
const coordinate = (value: number) => Object.is(value, -0) ? '-0.0' : (value / 10).toFixed(1);

/** Keeps the same rounded outline, omitting only vertices on straight boundaries. */
export function* plotPathPrepared(runs: readonly (readonly (readonly [number, number])[])[],stepped=false): Preparation<string> {
  let result = '';
  for (const run of runs) {
    if(stepped) {
      for(let i=0;i<run.length;i++){const [x,y]=run[i];result+=i?`H${x.toFixed(1)}V${y.toFixed(1)}`:`M${x.toFixed(1)},${y.toFixed(1)}`;yield;}
      continue;
    }
    const parts: Point[] = [];
    let before: Point | null = null, last: Point | null = null;
    for (const [x, y] of run) {
      yield;
      const next: Point = {x: rounded(x), y: rounded(y)};
      if (Math.abs(x) >= 1e11) next.sx = x.toFixed(1);
      if (Math.abs(y) >= 1e11) next.sy = y.toFixed(1);
      if (before && last && (last.x - before.x) * (next.y - last.y) === (last.y - before.y) * (next.x - last.x) && (last.x - before.x) * (next.x - last.x) + (last.y - before.y) * (next.y - last.y) >= 0) {
        parts[parts.length - 1] = next;
      } else {
        parts.push(next);
        before = last;
      }
      last = next;
    }
    for (let i = 0; i < parts.length; i++) {const point = parts[i]; result += `${i ? 'L' : 'M'}${point.sx ?? coordinate(point.x)},${point.sy ?? coordinate(point.y)}`; yield;}
  }
  return result;
}

export function plotPath(...args: Parameters<typeof plotPathPrepared>): string {return drain(plotPathPrepared(...args));}

/** Deadline endpoints draw a held value; they are never measurement markers. */
export function* observationRunsPrepared(points:readonly [number,number,number,number?][],from:number,to:number,now:number):Preparation<{runs:[number,number][][];last:[number,number]|null}> {
  const runs:[number,number][][]=[];
  let last:[number,number]|null=null,previousEnd=-Infinity,segment=-1;
  for(let i=0;i<points.length;i++) {
    const [at,value,group,deadline]=points[i];yield;
    if(at>now||at>=to)break;
    if(!Number.isSafeInteger(deadline)||deadline!<=at||deadline!<=from)continue;
    const beginning=Math.max(from,at),end=Math.min(deadline!,points[i+1]?.[0]??Infinity,now,to);
    if(end<beginning)continue;
    if(group!==segment||previousEnd!==beginning)runs.push([]);
    const run=runs.at(-1)!;
    if(run.at(-1)?.[0]!==beginning||run.at(-1)?.[1]!==value)run.push([beginning,value]);
    if(end>beginning)run.push([end,value]);
    previousEnd=end;segment=group;
    if(at>=from)last=[at,value];
  }
  return {runs,last};
}
