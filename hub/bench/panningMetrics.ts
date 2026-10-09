import type {Cdp} from './cdp.js';

export async function panMetrics(cdp: Pick<Cdp, 'send'>) {
  const reply=await cdp.send<{metrics:{name:string;value:number}[]}>('Performance.getMetrics');
  return Object.fromEntries(reply.metrics.map(metric=>[metric.name,metric.value]));
}

/** Reload may reset Chrome's counters; a cross-document difference is not a cost. */
export function panCost(before: Record<string,number>, after: Record<string,number>) {
  const scriptMs=(after.ScriptDuration-before.ScriptDuration)*1000,
    taskMs=(after.TaskDuration-before.TaskDuration)*1000,seconds=after.Timestamp-before.Timestamp;
  return {valid:[scriptMs,taskMs,seconds].every(value=>Number.isFinite(value)&&value>=0)&&seconds>0,scriptMs,taskMs,seconds};
}
