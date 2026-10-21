import {defaultFilters} from '../../server/domain/dataFilters';
import {selectedAllowanceIds} from '../lib/moneySelection';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ApiError} from '../lib/http';
import {MAX_METERS} from '../../server/domain/meterHistory';

// Exercise the production consumer across render, effect and delayed transport commits.
function fixture(){
  let cursor=0,ids=['extra-a'],board='one';
  const slots:any[]=[],effects:(()=>void)[]=[],flights:{ids:string[];signal:AbortSignal;resolve:(v:any)=>void;reject:(e:unknown)=>void}[]=[];
  const source={id:'source',provider:'openrouter',keys:[],meters:[]};
  const hooks={useState:(initial:any)=>{const at=cursor++;if(!(at in slots))slots[at]=initial;return [slots[at],(next:any)=>slots[at]=typeof next==='function'?next(slots[at]):next];},
    useEffect:(run:()=>void|(()=>void),deps:unknown[])=>{const at=cursor++,previous=slots[at];if(!previous||deps.some((d,i)=>d!==previous.deps[i]))effects.push(()=>{previous?.cleanup?.();slots[at]={deps,cleanup:run()};});}};
  const modules:Record<string,unknown>={react:hooks,'./moneySelection':{selectedAllowanceIds},'./dataFilters':{useDataFilters:()=>({current:{...defaultFilters(),wallet:{mode:'only',values:ids.map(key=>({source:source.id,kind:'keyCap',key}))}}})},'./prefs':{usePref:()=>({})},'../../server/domain/dataFilters':{walletRule:()=>({mode:'only',values:ids.map(key=>({source:source.id,kind:'keyCap',key}))})},'./view':{keyShown:()=>true},'./http':{ApiError},'../../server/domain/meterHistory':{MAX_METERS},'./keyReads':{readKeyIds:(_board:string,_source:string,ids:string[],signal:AbortSignal)=>new Promise((resolve,reject)=>flights.push({ids,signal,resolve,reject}))}};
  const context={exports:{} as typeof import('../lib/moneyKeys'),require:(name:string)=>modules[name],AbortController};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/moneyKeys.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const render=(commit=true)=>{cursor=0;const result=context.exports.useShownKeys(source as any,undefined,board);if(commit)effects.splice(0).forEach(run=>run());return result;};
  return {render,flights,select:(next:string[])=>{ids=next;},board:(next:string)=>{board=next;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const part=(id:string)=>({keys:[{id}],meters:[{id:`key:${id}:cap`}]});

test('selected caps beyond the preview retain their query identity, recover and reject cancelled answers',async()=>{
  const f=fixture();assert.equal(f.render().loading,true);assert.equal(f.flights.length,1);
  f.flights[0].resolve(part('extra-a'));await flush();let result=f.render();assert.equal(result.keys[0].id,'extra-a');assert.equal(result.loading,false);
  result.retry();f.render();result=f.render();assert.equal(result.keys[0].id,'extra-a','same-query refresh keeps its last complete amount');assert.equal(result.loading,true);
  f.flights[1].reject(new ApiError(503,'unavailable'));await flush();result=f.render();assert.equal(result.loading,false);assert.equal(result.keys[0].id,'extra-a');assert.ok(result.error);
  result.retry();f.render();f.select(['extra-b']);result=f.render();assert.equal(result.keys.length,0,'old amounts retire before the replacement effect');assert.equal(result.loading,true);assert.equal(result.error,null);assert.equal(f.flights[2].signal.aborted,true);
  f.flights[2].resolve(part('extra-a'));await flush();assert.equal(f.render().keys.length,0);
  f.flights[3].resolve(part('extra-b'));await flush();assert.equal(f.render().keys[0].id,'extra-b');assert.equal(f.flights.length,4,'ordinary renders never reread the inventory');
  f.board('two');assert.equal(f.render().keys.length,0);assert.equal(f.render().loading,true);
  f.select([]);assert.equal(f.render().selected,false);assert.equal(f.flights[4].signal.aborted,true);assert.equal(f.render().loading,false);
});

test('an excessive cap selection reports the bounded refusal without starting transport',()=>{
  const f=fixture();f.select(Array.from({length:MAX_METERS+1},(_,i)=>String(i)));f.render();const result=f.render();assert.equal(result.loading,false);assert.equal((result.error as ApiError).code,'filters_limit');assert.equal(f.flights.length,0);
});

test('lost cap access retires retained amounts while an ordinary transport failure preserves them',async()=>{
  for(const status of [401,403,404,503]){
    const f=fixture();f.render();f.flights[0].resolve(part('extra-a'));await flush();const result=f.render();assert.equal(result.keys.length,1);
    result.retry();f.render();f.flights[1].reject(new ApiError(status,'unavailable'));await flush();assert.equal(f.render().keys.length,status===503?1:0);assert.equal(f.render().meters.length,status===503?1:0);
  }
});
