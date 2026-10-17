import type {SafeTrace} from './panningDiagnostic.js';

/** Compare cumulative thread clocks at observed anchors, without interpolating missing work. */
export function threadCpuWindow(events: SafeTrace[], pid: number, tid: number, from: number, to: number) {
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)return {status:'invalid-interval'};
  const points=events.filter(event=>event.pid===pid&&event.tid===tid&&event.ts!==undefined&&event.threadTs!==undefined)
    .flatMap(event=>[
      {at:event.ts!,cpu:event.threadTs!},
      ...(event.phase==='X'&&event.duration!==undefined&&event.threadDuration!==undefined
        ?[{at:event.ts!+event.duration,cpu:event.threadTs!+event.threadDuration}]:[]),
    ]).filter(point=>Number.isFinite(point.at)&&Number.isFinite(point.cpu)&&point.at>=0&&point.cpu>=0)
    .sort((a,b)=>a.at-b.at||a.cpu-b.cpu);
  // JSON trace clocks round to microseconds. Larger regressions cannot support a bound.
  if(points.some((point,index)=>index>0&&point.cpu<points[index-1].cpu-2))return {status:'inconsistent-thread-clock'};
  const reversed=[...points].reverse();
  const before=reversed.find(point=>point.at<=from),after=points.find(point=>point.at>=to);
  const first=points.find(point=>point.at>=from&&point.at<=to),last=reversed.find(point=>point.at>=from&&point.at<=to);
  if(!before||!after)return {status:'missing-thread-clock'};
  const cpuInsideMs=first&&last?(last.cpu-first.cpu)/1000:0,cpuOutsideMs=(after.cpu-before.cpu)/1000;
  // Trace wall and thread clocks are read separately; a signal can run between reads.
  // Keep counter excess visible instead of clipping it into an impossible bound.
  return {status:'observed',wallMs:(to-from)/1000,cpuInsideMs,cpuOutsideMs,
    clockExcessMs:Math.max(0,cpuOutsideMs-(after.at-before.at)/1000),
    beforeGapMs:(from-before.at)/1000,afterGapMs:(after.at-to)/1000};
}
