import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {SETS} from '../../demo/catalogue.js';
import {ALWAYS,cards,DAY,MIN,historyTimes,machineInfo,snapshot,staleAfter,type Card,type DemoSet} from '../../demo/model.js';
import {Person} from '../../demo/client.js';
import {seedWork,STILL_FOR,type Stand} from '../../demo/setup.js';
import {Store} from '../../server/store/store.js';
import {Directory} from '../../server/store/directory.js';
import {AGENT_HOURS_HEATMAP,showWidgets} from '../../server/domain/widgets.js';
import {defaultFilters} from '../../server/domain/dataFilters.js';
import {moneyFamily,providerOf} from '../../server/domain/providers.js';
import {panningSet} from '../fixture.js';
import {fixtureTiming} from '../still.js';

const now=Date.parse('2026-10-15T10:32:12Z'),aged=fixtureTiming(now).start,prior=aged+10*MIN;
const timestampKeys=new Set(['at','observedAt','resetsAt','expiresAt','startedAt','from','to']);
function normalized(value:unknown,start:number){return JSON.stringify(value,(key,value:unknown)=>timestampKeys.has(key)&&value!==null?(typeof value==='string'?Date.parse(value):Number(value))-start:value);}
function journal(start:number){
  const hash=createHash('sha256');let count=0;
  return{add:(value:unknown)=>{hash.update(normalized(value,start)).update('\n');count++;},finish:()=>({count,hash:hash.digest('hex')})};
}
// Execute the actual unexported producer bodies, replacing only their write sinks.
function producers(file:URL,names:string[],bindings:Record<string,unknown>){
  const source=ts.createSourceFile(file.pathname,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  const statements=source.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text??'')||ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>names.includes(d.name.getText(source))));
  assert.equal(statements.length,names.length,'every requested production declaration must exist');
  const code=ts.transpileModule(statements.map(node=>node.getText(source)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  return runInNewContext(code+'\n({'+names.join(',')+'})',{exports:{},...bindings});
}

test('aging translates the complete quota seed stream without changing batches, values or availability',async()=>{
  const set=panningSet(SETS[0]);
  const api=producers(new URL('../../demo/setup.ts',import.meta.url),['BATCH','measured','seed'],{snapshot,staleAfter,historyTimes,STILL_FOR}) as {seed(stand:Stand,card:Card,now:()=>number,still:boolean):Promise<void>};
  async function capture(start:number){
    const output=journal(start),counts:number[]=[],cadence=new Set<number>();let fresh=0,stale=0;
    for(const card of cards(set)){
      let count=0,last:ReturnType<typeof snapshot>|undefined;
      const writer={ingest:async(batch:ReturnType<typeof snapshot>[],failures:unknown[],at:number)=>{
        output.add({card:card.id,at,batch,failures});count+=batch.length;last=batch.at(-1);return{accepted:batch.length,duplicates:0};
      }};
      await api.seed({set,start,agents:new Map([[card.machines[0],writer]])} as unknown as Stand,card,()=>start+20*MIN,true);
      const times=historyTimes(set,card);assert.equal(count,times.length);counts.push(count);
      for(const row of times)cadence.add(row.step);
      assert.ok(last);assert.equal(Date.parse(last.observedAt),start+times.at(-1)!.t);
      if(times.at(-1)!.t+staleAfter(times.at(-1)!.step)>0){fresh++;assert.equal(Date.parse(last.observedAt)+last.staleAfterMs,start+STILL_FOR);assert.ok(now+20*MIN<start+STILL_FOR);}
      else {stale++;assert.equal(last.staleAfterMs,staleAfter(times.at(-1)!.step),'aging must not make an unavailable seed healthy');}
    }
    assert.ok(fresh>0&&stale>0);assert.deepEqual([...cadence].sort((a,b)=>a-b),[5*MIN,15*MIN]);
    return{...output.finish(),counts};
  }
  const before=await capture(prior),after=await capture(aged);
  assert.ok(before.count>cards(set).length,'the real batching path covers historical observations');assert.deepEqual(after,before);
});

test('aging preserves actual stable and legacy work credits and persisted interval rows',t=>{
  let clock=prior;t.mock.method(Date,'now',()=>clock);
  const machine={kind:'machine' as const,id:'machine',expect:[]},span=6*MIN;
  const set:DemoSet={id:'fixture-aging',about:'',scene:'',workHistoryMs:span,entries:[
    {kind:'person',id:'person',name:'Person',expect:[]},
    {kind:'card',id:'mixed',provider:'codex',plan:'',machines:[machine.id],history:span,windows:[],expect:[],agents:[
      {machine:machine.id,origin:'terminal',project:'same',since:-span,works:ALWAYS},
      {machine:machine.id,origin:'terminal',project:'same',since:-span,until:-2*MIN,works:ALWAYS,legacy:true},
      {machine:machine.id,origin:'terminal',project:'same',since:-span,works:{period:2*MIN,on:MIN,phase:0},legacy:true},
    ]},
  ]};
  function capture(start:number){
    clock=start;const store=new Store(':memory:',start-span),directory=new Directory(store.db),calls:unknown[]=[];
    try{
      const user=directory.createUser('fixture@example.com','Fixture','fixture',start);
      directory.saveDevice({userId:user.id,machine:machineInfo(machine),agent:'quotum-demo/1',tokenId:null},start);
      const credit=store.creditWork.bind(store);
      store.creditWork=(...args)=>{const [,from,to,keys]=args;calls.push({from,to,keys});return credit(...args);};
      seedWork(store,{set,start,people:new Map([['person',new Person('',user.id,'','')]]),boards:new Map(),agents:new Map(),sources:new Map([['mixed','codex:fixture']])});
      const rows=store.db.prepare('SELECT producer_id AS producer,ordinal,started_at AS startedAt,project,folder,source_id AS source,client,origin,from_at AS "from",to_at AS "to" FROM agent_sessions s JOIN agent_work w ON w.session_id=s.id ORDER BY from_at,producer_id,ordinal').all();
      assert.ok(rows.some(row=>row.producer===null)&&rows.some(row=>row.producer!==null));
      assert.ok(rows.every(row=>Number(row.to)>Number(row.from)));assert.ok(calls.length>1);
      return{calls:normalized(calls,start),rows:normalized(rows,start),since:Number(store.db.prepare("SELECT value FROM meta WHERE key='agentWorkSince'").get()!.value)-start};
    }finally{store.close();}
  }
  assert.deepEqual(capture(aged),capture(prior));
});

test('aging translates every 75-day budget and funds write without changing their values or selections',()=>{
  function capture(start:number){
    const output=journal(start),sources:{id:string;provider:string}[]=[],times=new Map<string,number[]>();let closed=false;
    let view={names:{} as Record<string,string>,hidden:[] as string[],shown:[] as string[]};
    class Sink {
      db={exec:(sql:string)=>output.add({sql})};
      source(provider:string,key:string,at:number){const id=provider+':'+key;sources.push({id,provider});output.add({id,at});return id;}
      hold(source:string,owner:string,at:number){output.add({source,owner,at});}
      record(source:string,value:{observedAt:number;staleAfterMs:number}){assert.equal(value.staleAfterMs,6*60*MIN);const rows=times.get(source)??[];rows.push(value.observedAt);times.set(source,rows);output.add({source,value});}
      sources(){return sources;}
      close(){closed=true;}
    }
    class Views {
      view(){return view;}
      saveView(_board:string,next:typeof view,_owner:string,at:number){view=next;output.add({view,at});}
      filtersState(){return{filters:defaultFilters()};}
      saveFilters(_board:string,filters:unknown,_owner:string,at:number){output.add({filters,at});}
    }
    const api=producers(new URL('../fixture.ts',import.meta.url),['seedPanningBudgets'],{Store:Sink,Directory:Views,DAY,STILL_FOR,AGENT_HOURS_HEATMAP,showWidgets,moneyFamily,providerOf}) as {seedPanningBudgets(file:string,stand:Stand):void};
    api.seedPanningBudgets('unused',{start,people:new Map([['owner',{id:'owner',personalBoard:'board'}]])} as unknown as Stand);
    assert.equal(closed,true);assert.equal(sources.length,24);assert.equal(sources.filter(source=>source.provider==='codex').length,12);
    assert.equal(times.size,24);for(const rows of times.values()){assert.equal(rows.length,601);assert.equal(rows[0],start-75*DAY);assert.equal(rows.at(-1),start);assert.ok(rows.slice(1).every((at,index)=>at-rows[index]===3*60*MIN));}
    assert.equal(view.names['openrouter:benchmark-wallet-0'],'Budget 1');assert.equal(view.names['codex:benchmark-wallet-12'],'Subscription funds 1');
    assert.ok(now+20*MIN<start+6*60*MIN,'the latest monetary facts remain available throughout the original job');
    return output.finish();
  }
  assert.deepEqual(capture(aged),capture(prior));
});
