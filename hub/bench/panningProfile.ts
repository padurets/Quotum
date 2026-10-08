import type {Cdp} from './cdp.js';
import {panning} from './panning.js';

type Frame = {functionName: string; scriptId: string; lineNumber: number; columnNumber: number};
type Profile = {nodes: {id: number; callFrame: Frame; children?: number[]}[]; samples: number[]; timeDeltas: number[]};
type Event = {name: string; ph: string; dur?: number; cat?: string};

/** A separate replay diagnoses a failed budget; it never supplies budget readings. */
export async function profilePanning(cdp: Pick<Cdp, 'send' | 'evaluate' | 'on'>) {
  let active = false, events: Event[] = [];
  await cdp.send('Debugger.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', {interval: 1000});
  cdp.on<{value: Event[]}>('Tracing.dataCollected', data => events.push(...data.value));
  let ended: (() => void) | null = null;
  cdp.on('Tracing.tracingComplete', () => ended?.());
  const sources = new Map<string, string[]>();
  const stop = async () => {
    const {profile} = await cdp.send<{profile: Profile}>('Profiler.stop');
    const complete = new Promise<void>(resolve => {ended = resolve;});
    await cdp.send('Tracing.end');
    await complete;
    active = false;
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const parent = new Map<number, number>();
    for (const node of profile.nodes) for (const id of node.children ?? []) parent.set(id, node.id);
    const self = new Map<number, number>();
    profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + profile.timeDeltas[i] / 1000));
    const top = await Promise.all([...self].sort((a, b) => b[1] - a[1]).slice(0, 20).map(async ([id, ms]) => {
      const frame = nodes.get(id)!.callFrame;
      let source = sources.get(frame.scriptId);
      if (!source) {
        try {source = (await cdp.send<{scriptSource: string}>('Debugger.getScriptSource', {scriptId: frame.scriptId})).scriptSource.split('\n');}
        catch {source = [];}
        sources.set(frame.scriptId, source);
      }
      const chain: string[] = [];
      for (let at: number | undefined = id; at !== undefined && chain.length < 4; at = parent.get(at)) chain.push(nodes.get(at)!.callFrame.functionName);
      return {ms: Math.round(ms), name: frame.functionName, code: (source[frame.lineNumber] ?? '').slice(frame.columnNumber, frame.columnNumber + 180), chain};
    }));
    const trace = new Map<string, {count: number; ms: number; max: number}>();
    for (const event of events) if (event.ph === 'X' && event.dur && event.cat?.includes('devtools.timeline')) {
      const row = trace.get(event.name) ?? {count: 0, ms: 0, max: 0};
      row.count++; row.ms += event.dur / 1000; row.max = Math.max(row.max, event.dur / 1000);
      trace.set(event.name, row);
    }
    const preparation = await cdp.evaluate(`(() => {const diagnostic=window.__quotumStackDiagnostic;if(!diagnostic)return null;diagnostic.instance.draw=diagnostic.original;delete window.__quotumStackDiagnostic;return diagnostic.samples;})()`);
    console.error('pan diagnostic ' + JSON.stringify({top, preparation, trace: [...trace].sort((a, b) => b[1].ms - a[1].ms).slice(0, 16)}));
  };
  const measured = {
    on: cdp.on.bind(cdp),
    evaluate: cdp.evaluate.bind(cdp),
    send: async <T = unknown>(method: string, params: object = {}): Promise<T> => {
      const rate = (params as {rate?: number}).rate;
      if (method === 'Emulation.setCPUThrottlingRate' && rate === 4) {
        await cdp.evaluate(`(() => {
          const element=document.querySelector('.activity .chart'),key=Object.keys(element).find(key=>key.startsWith('__reactFiber'));
          let fiber=element[key];
          for(let depth=0;fiber&&depth<4;depth++,fiber=fiber.return)for(let hook=fiber.memoizedState,index=0;hook&&index<80;hook=hook.next,index++){
            const instance=hook.memoizedState?.current;
            if(!instance||typeof instance.draw!=='function'||!(instance.groups instanceof Map))continue;
            const diagnostic=window.__quotumStackDiagnostic={instance,original:instance.draw,samples:[]};
            instance.draw=function(groups,...geometry){
              const before=this.geometry,old=new Map([...this.groups].map(([key,value])=>[key,value.path]));
              const started=performance.now(),result=diagnostic.original.call(this,groups,...geometry);
              diagnostic.samples.push({ms:performance.now()-started,geometryChanged:before!==this.geometry,geometry:this.geometry,groups:groups.length,cells:groups.reduce((total,row)=>total+row.group.cells.length,0),changedPaths:[...this.groups].filter(([key,value])=>old.get(key)!==value.path).length});
              return result;
            };
            return;
          }
        })()`);
        events = [];
        await cdp.send('Tracing.start', {categories: 'devtools.timeline', transferMode: 'ReportEvents'});
        await cdp.send('Profiler.start'); active = true;
      } else if (method === 'Emulation.setCPUThrottlingRate' && rate === 1 && active) await stop();
      return cdp.send<T>(method, params);
    },
  };
  try {await panning(measured);}
  finally {
    if (active) await stop();
    await cdp.evaluate(`(() => {const diagnostic=window.__quotumStackDiagnostic;if(diagnostic){diagnostic.instance.draw=diagnostic.original;delete window.__quotumStackDiagnostic;}})()`);
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    await cdp.send('Debugger.disable');
    await cdp.send('Profiler.disable');
  }
}
