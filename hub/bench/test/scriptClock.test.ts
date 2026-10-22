import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Cdp} from '../cdp.js';
import {ScriptClock} from '../scriptClock.js';

function fixture(navigate=false,fail=false){
  const listeners=new Map<string,((value:any)=>void)[]>(),commands:string[]=[];
  const primary={endpoint:'ws://synthetic',on:(name:string,fn:any)=>listeners.set(name,[...(listeners.get(name)??[]),fn]),off:(name:string,fn:any)=>listeners.set(name,(listeners.get(name)??[]).filter(f=>f!==fn))};
  const auxListeners=new Map<string,((value:any)=>void)[]>();let stage=0;
  const aux={on:(name:string,fn:any)=>auxListeners.set(name,[...(auxListeners.get(name)??[]),fn]),off:(name:string,fn:any)=>auxListeners.set(name,(auxListeners.get(name)??[]).filter(f=>f!==fn)),
    send:async(name:string)=>{commands.push(name);if(fail&&name==='Performance.enable')throw Error('Unavailable');},close:()=>commands.push('close'),
    evaluate:async(source:string)=>{const title=JSON.parse(source.match(/console\.timeStamp\(("[^"]+")\)/)![1]),at=++stage;
      // CDP notifications may arrive after the evaluation reply, on both sockets.
      setImmediate(()=>{for(const [into,cost] of [[listeners,.01],[auxListeners,.002]] as const)for(const fn of into.get('Performance.metrics')??[])fn({title,metrics:[{name:'Timestamp',value:at===1?1:4},{name:'ScriptDuration',value:at*cost}]});
        if(navigate&&at===2)for(const fn of listeners.get('Page.frameNavigated')??[])fn({});});
    }};
  return {primary:primary as unknown as Cdp,connect:async()=>aux as unknown as Cdp,commands,listeners,auxListeners};
}
test('outer script counters wait for both late receipts and release the independent agent',async()=>{
  const f=fixture(),clock=await ScriptClock.open(f.primary,f.connect),report=await clock.after({Timestamp:2,ScriptDuration:.01},{Timestamp:3,ScriptDuration:.02});
  assert.equal(report.status,'observed');assert.equal(report.outerThreadScriptMs,2);assert.equal(report.elapsedScriptMs,10);
  assert.deepEqual(f.commands,['Performance.enable','Performance.disable','close']);
  assert.ok([...f.listeners.values(),...f.auxListeners.values()].every(rows=>!rows.length));
});
test('navigation or unavailable auxiliary counters retain an insufficient observation',async()=>{
  for(const f of [fixture(true),fixture(false,true)]){const clock=await ScriptClock.open(f.primary,f.connect),report=await clock.after({Timestamp:2,ScriptDuration:.01},{Timestamp:3,ScriptDuration:.02});
    assert.equal(report.status,'insufficient-evidence');assert.equal(report.outerThreadScriptMs,undefined);assert.equal(f.commands.at(-1),'close');}
});
