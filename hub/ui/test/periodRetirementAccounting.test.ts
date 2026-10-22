import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {expandPeriod} from '../../server/domain/periodWire';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {PeriodIndex} from '../../server/domain/periodIndex';
import {decodeSamples,sampleCount,sampleAt,numberAt} from '../../server/domain/periodTape';
import {Preparations} from '../lib/prepare';

test('clock retirement reuses unchanged source accounting and replaces trimmed or removed work',async t=>{
  const periodMs=24*H,start=NOW-periodMs;
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({personal:true,periodName:'24h',clocked:true,creditFrom:start+2*M,creditTo:start+5*M});
  const unchanged=h.store.source('codex','b'.repeat(24),start-H),trimmed=h.store.source('codex','d'.repeat(24),start-H),removed=h.source;
  const sources=[unchanged,trimmed,removed];
  const credit=(source:string,sessionId:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source,client:'codex',origin:'terminal',startedAt:start-H,project:'Work project',folder:'Private folder',identity:{kind:'stable',sessionId}}]);
  try{
    for(const source of [unchanged,trimmed]){
      h.store.hold(source,h.alice.id,start-H);
      for(let i=0;i<12;i++)h.store.record(source,{observedAt:start+M+i*10*M,plan:'',resets:null,staleAfterMs:2*periodMs,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:10+i*.1,remaining:90-i*.1,resetAt:NOW+periodMs}]});
    }
    // The first context expires inside an hour whose source still has other work.
    credit(unchanged,'b'.repeat(32),start+2*M,start+5*M);
    credit(unchanged,'f'.repeat(32),start+3*M,start+50*M);
    credit(trimmed,'d'.repeat(32),start+2*M,start+5*M);
    credit(trimmed,'d'.repeat(32),start+H+10*M,start+H+30*M);
    h.events.flush();await flush();
    const before=h.period.tapes.get('quota'),work=h.period.get().value,groups=h.period.index.curves.groups.source;
    assert.equal(before.tape.quota.length,3);
    assert.equal(sampleCount(before.accounting.quota.get(unchanged+'\nw').series.samples),12);
    assert.equal(h.period.get().rows.length,4);
    const indexes=new Map(sources.map(source=>[source,before.accounting.quota.get(source+'\nw')]));
    for(const index of indexes.values())assert.ok(index);
    const requests=h.requests.length,revision=h.period.getProjectionRevision('quota');
    now=NOW+5*M;h.jump(now);await flush();
    const after=h.period.tapes.get('quota'),retained=h.period.get().value,nextGroups=h.period.index.curves.groups.source;
    assert.equal(h.period.get().error,null);
    assert.notEqual(retained,work);
    assert.equal(retained.anchor,start+5*M);
    assert.equal(retained.knownFrom,work.knownFrom,'storage retirement does not move the authority cutoff');
    assert.equal(after.tape,before.tape,'no measurement prefix needs retirement at this boundary');
    assert.equal(nextGroups.get(unchanged),groups.get(unchanged));
    assert.notEqual(nextGroups.get(trimmed),groups.get(trimmed));
    assert.ok(nextGroups.has(trimmed));
    assert.equal(nextGroups.has(removed),false);
    assert.equal(after.accounting.quota.get(unchanged+'\nw'),indexes.get(unchanged),'an unchanged source timeline must retain its quota index');
    for(const source of [trimmed,removed]){
      const index=after.accounting.quota.get(source+'\nw'),previous=indexes.get(source);
      assert.notEqual(index,previous,'trimmed and removed source timelines must replace their quota indexes');
      for(const field of ['times','deadlines','spent','covered'])assert.strictEqual(index[field],previous[field],'work-only retirement preserves exact quota columns without rebuilding them');
    }
    assert.equal(h.period.getProjectionRevision('quota'),revision,'storage retirement does not invalidate chart geometry');
    assert.equal(h.requests.length,requests,'the shared clock retires work without reading history');
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes,'retirement releases every temporary reservation');

    const range={from:now-periodMs,to:now},queries=h.period.queries(h.page.get().board,range);
    const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs},evaluatedAt:now,...queries,sessions:{}})));
    assert.ok(fresh.sessions&&fresh.sessions.state!=='error');
    assert.ok(fresh.quota?.state==='complete'&&fresh.quota.value.tape);
    const tape=fresh.quota.value.tape;
    for(const series of tape.quota)if(series.samplesEncoding==='delta'){series.samples=decodeSamples(series.samples);delete series.samplesEncoding;}
    const index=new PeriodIndex(fresh.sessions.value),expected=new PeriodAccounting(tape,fresh.sessions.value,index.curves);
    assert.equal(fresh.sessions.value.knownFrom,retained.knownFrom);
    for(const source of sources)for(const at of [range.from,range.from+1,start+10*M,start+50*M,start+H+20*M,now])for(const selected of [{from:range.from,to:at},{from:at,to:now}]){
      assert.deepEqual(after.accounting.quotaSummary(source,'w',selected),expected.quotaSummary(source,'w',selected),'retained work and quota summaries match a fresh authorized producer read');
    }
    assert.deepEqual(after.accounting.fixed(range,10*M),expected.fixed(range,10*M));
  }finally{await h.close();}
});

const quotaColumns=['times','deadlines','spent','covered','worked','during'];
const columnValues=(column:any)=>Array.from({length:column.length},(_,i)=>numberAt(column,i));
const columnBuffers=(column:any):ArrayBufferLike[]=>ArrayBuffer.isView(column)?[column.buffer]:column.runs?[column.runs.ends.buffer,column.runs.bases.buffer,column.runs.steps.buffer]:column.values?[column.values.buffer]:[];
const quotaSnapshot=(index:any)=>({samples:Array.from({length:sampleCount(index.series.samples)},(_,i)=>sampleAt(index.series.samples,i)),descriptors:structuredClone(index.series.descriptors),columns:quotaColumns.map(field=>columnValues(index[field]))});

async function retirementControl(t:any,nonzeroSpending=false,nonzeroWork=false){
  const clock={now:NOW};t.mock.method(Date,'now',()=>clock.now);
  const h=await fixture({personal:true,periodName:'24h',clocked:true});
  try{
    const start=NOW-24*H,sources=['b','d','e'].map(account=>h.store.source('codex',account.repeat(24),start-H));
    for(const source of sources){
      h.store.hold(source,h.alice.id,start-H);
      for(let i=0;i<256;i++){const used=nonzeroSpending?.005*i:i<2?0:.005*(i-1);h.store.record(source,{observedAt:start+M+i*5*M,plan:'',resets:null,staleAfterMs:48*H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt:NOW+24*H}]});}
      if(nonzeroWork)h.store.creditWork(h.device,start+M,start+20*M,[{source,client:'codex',origin:'terminal',startedAt:start-H,project:'Work project',folder:'Private folder',identity:{kind:'stable',sessionId:['b','d','e'][sources.indexOf(source)].repeat(32)}}]);
    }
    h.events.flush();await flush();
    const before=h.period.tapes.get('quota'),old=sources.map(source=>before.accounting.quota.get(source+'\nw'));
    for(const index of old){
      assert.equal(sampleCount(index.series.samples),256);assert.ok(index.series.descriptors?.length);
      assert.ok(index.times.runs);assert.ok(index.spent.values instanceof Float64Array);assert.ok(index.covered.runs);
      assert.equal(h.period.index.curves.groups.source.has(index.series.source),nonzeroWork);
    }
    const snapshots=old.map(quotaSnapshot),work=h.period.get().value,workSnapshot=structuredClone(work);
    const bytes=h.pool.estimatedBytes,requests=h.requests.length,revision=h.period.getProjectionRevision('quota');
    const queue:(()=>void)[]=[];let time=0;
    const preparer=new Preparations({now:()=>++time,post:run=>queue.push(run)});
    const active=new Set<any>(),copied=new Set<any>(),coveredCopies=new Set<any>(),reads=new Map<string,number>();
    const watched:{column:any;descriptor:PropertyDescriptor}[]=[];
    let tails:Map<any,any>|undefined,proofs:any[]=[],preparations=0,availabilityReads=0;
    const watch=(tape:any)=>{
      for(const series of tape.quota)if(sources.includes(series.source)&&sampleCount(series.samples)===255){
        const column=series.samples.columns[1],descriptor=Object.getOwnPropertyDescriptor(column,'values')!;
        if(watched.some(item=>item.column===column))continue;
        assert.ok(descriptor.value instanceof Float64Array);watched.push({column,descriptor});reads.set(series.source,0);
        const stale=series.samples.columns[3],saved=Object.getOwnPropertyDescriptor(stale,'values')!;watched.push({column:stale,descriptor:saved});
        Object.defineProperty(stale,'values',{configurable:true,enumerable:true,get:()=>{if(active.size)availabilityReads++;return saved.value;}});
        Object.defineProperty(column,'values',{configurable:true,enumerable:true,get:()=>{reads.set(series.source,reads.get(series.source)!+1);return descriptor.value;}});
      }
    };
    const accounting=PeriodAccounting as any,prepare=accounting.prepare,retirement=accounting.prepareRetirement;
    t.mock.method(accounting,'prepare',(...args:any[])=>{watch(args[0]);return Reflect.apply(prepare,accounting,args);});
    if(typeof retirement==='function')t.mock.method(accounting,'prepareRetirement',(...args:any[])=>{
      preparations++;tails=args[6];proofs=[...tails!.entries()];watch(args[0]);return Reflect.apply(retirement,accounting,args);
    });
    const ctor=old[0].constructor,retire=ctor.retire;
    if(typeof retire==='function')t.mock.method(ctor,'retire',function*(...args:any[]):Generator<void,any,unknown>{
      const prior=args[3];active.add(prior);try{return yield*Reflect.apply(retire,ctor,args);}finally{active.delete(prior);}
    });
    for(const index of old){
      const values=index.spent.values,slice=values.slice.bind(values);
      t.mock.method(values,'slice',(from:number,to?:number)=>{assert.ok(h.pool.estimatedBytes>bytes,'admission precedes the real prefix copy');copied.add(index);return slice(from,to);});
      const bases=index.covered.runs.bases,copy=bases.slice.bind(bases);
      t.mock.method(bases,'slice',(from:number,to?:number)=>{coveredCopies.add(index);return copy(from,to);});
    }
    const stopReads=()=>{for(const {column,descriptor} of watched)Object.defineProperty(column,'values',descriptor);watched.length=0;};
    const unchanged=()=>{assert.deepEqual(old.map(quotaSnapshot),snapshots);assert.deepEqual(structuredClone(work),workSnapshot);};
    const drain=async()=>{for(let i=0;queue.length||preparer.size;i++){assert.ok(i<10000);queue.shift()?.();await flush();}};
    const startRetirement=async()=>{h.prepareWith(preparer);clock.now=NOW+6*M+1;h.jump(clock.now);await flush();};
    const insideCopy=async()=>{
      for(let i=0;!([...active].some(index=>copied.has(index)));i++){assert.ok(i<1000&&queue.length,'a real posted slice must stop after spent copy and before retirement completes');queue.shift()!();await flush();}
      assert.equal(tails?.size,3);assert.equal(h.period.tapes.get('quota'),before);
      assert.equal(h.period.get().value,work);assert.ok(h.pool.estimatedBytes>bytes);
    };
    return {h,clock,sources,before,old,work,requests,revision,queue,preparer,active,copied,coveredCopies,reads,stopReads,unchanged,drain,startRetirement,insideCopy,get tails(){return tails;},get proofs(){return proofs;},get preparations(){return preparations;},get availabilityReads(){return availabilityReads;}};
  }catch(error){await h.close();throw error;}
}

test('real single-observation retirement copies exact quota prefixes without reading every retained value',async t=>{
  const c=await retirementControl(t),{h}=c;
  try{
    await c.startRetirement();await c.drain();
    const counts=c.sources.map(source=>c.reads.get(source));c.stopReads();
    for(const count of counts){assert.notEqual(count,undefined,'actual retained used-column counter is present');assert.ok(count!<255,`accounting read the actual retained used column ${count} times; it must not scan all 255 values again`);}
    const after=h.period.tapes.get('quota');assert.notEqual(after,c.before);
    assert.equal(c.copied.size,3);assert.equal(c.proofs.length,3);assert.equal(c.tails?.size,0);
    assert.equal(after.accounting.quota.get(h.source+'\nw'),c.before.accounting.quota.get(h.source+'\nw'));
    const expired=c.old.flatMap(index=>[...quotaColumns.flatMap(field=>columnBuffers(index[field])),...index.series.samples.columns.flatMap(columnBuffers)]);
    for(let i=0;i<c.old.length;i++){
      const previous=c.old[i],index=after.accounting.quota.get(c.sources[i]+'\nw');
      assert.equal(sampleCount(index.series.samples),255);
      const proof=c.proofs.find(([series]:any[])=>series===index.series)?.[1];
      assert.equal(proof?.before,previous.series);assert.equal(proof?.after,index.series);assert.equal(proof?.removed,1);
      for(const buffer of [...quotaColumns.flatMap(field=>columnBuffers(index[field])),...index.series.samples.columns.flatMap(columnBuffers)])assert.ok(!expired.includes(buffer),'the committed index cannot retain an expired backing buffer');
    }
    c.unchanged();assert.equal(h.period.get().value,c.work);assert.equal(h.period.get().error,null);
    assert.equal(h.period.getProjectionRevision('quota'),c.revision);assert.equal(h.requests.length,c.requests);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes);assert.equal(c.preparer.size,0);
    const range={from:c.clock.now-24*H,to:c.clock.now},queries=h.period.queries(h.page.get().board,range);
    const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs:24*H},evaluatedAt:c.clock.now,...queries,sessions:{}})));
    assert.ok(fresh.sessions&&fresh.sessions.state!=='error');assert.ok(fresh.quota?.state==='complete'&&fresh.quota.value.tape);
    const tape=fresh.quota.value.tape;
    for(const series of tape.quota)if(series.samplesEncoding==='delta'){series.samples=decodeSamples(series.samples);delete series.samplesEncoding;}
    const index=new PeriodIndex(fresh.sessions.value),expected=new PeriodAccounting(tape,fresh.sessions.value,index.curves);
    for(const source of c.sources)for(const at of [range.from,range.from+1,range.from+5*M,range.to])for(const selected of [{from:range.from,to:at},{from:at,to:range.to}])assert.deepEqual(after.accounting.quotaSummary(source,'w',selected),expected.quotaSummary(source,'w',selected));
    assert.deepEqual(after.accounting.fixed(range,10*M),expected.fixed(range,10*M));
    assert.equal(h.requests.length,c.requests);
  }finally{c.stopReads();await h.close();c.preparer.dispose();}
});

test('nonzero spending retires integer coverage while rebuilding the exact floating prefix forward',async t=>{
  const c=await retirementControl(t,true),{h}=c;
  try{
    await c.startRetirement();await c.drain();c.stopReads();
    assert.equal(c.coveredCopies.size,3,'a nonzero spending origin must not rebuild the independent integer coverage');
    assert.equal(c.copied.size,0,'floating spending is recomputed instead of subtracting its expired prefix');
    const after=h.period.tapes.get('quota'),fresh=new PeriodAccounting(after.tape,c.work,h.period.index.curves);
    let inverseMismatches=0;
    for(let i=0;i<c.sources.length;i++){
      const key=c.sources[i]+'\nw',actual=after.accounting.quota.get(key),expected=(fresh as any).quota.get(key),previous=c.old[i];
      for(const field of quotaColumns)assert.deepEqual(columnValues(actual[field]),columnValues(expected[field]),`${field} must keep every exact fresh value`);
      const spent=columnValues(expected.spent),origin=numberAt(previous.spent,1)!;
      inverseMismatches+=spent.filter((value,j)=>!Object.is(value,numberAt(previous.spent,j+1)!-origin)).length;
      const expired=quotaColumns.flatMap(field=>columnBuffers(previous[field]));
      for(const buffer of quotaColumns.flatMap(field=>columnBuffers(actual[field])))assert.ok(!expired.includes(buffer),'retired prefixes own new buffers');
      for(const from of [c.clock.now-24*H,c.clock.now-12*H])assert.deepEqual(after.accounting.quotaSummary(c.sources[i],'w',{from,to:c.clock.now}),fresh.quotaSummary(c.sources[i],'w',{from,to:c.clock.now}));
    }
    assert.ok(inverseMismatches>0,'the fixture must distinguish forward floating addition from inverse subtraction');
    c.unchanged();assert.equal(h.requests.length,c.requests);assert.equal(h.period.getProjectionRevision('quota'),c.revision);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes);assert.equal(c.preparer.size,0);assert.equal(c.tails?.size,0);
  }finally{c.stopReads();await h.close();c.preparer.dispose();}
});

test('nonzero work and spending keep independent coverage while rebuilding all floating prefixes exactly',async t=>{
  const c=await retirementControl(t,true,true),{h}=c;
  try{
    for(const index of c.old){assert.ok(numberAt(index.worked,1)!>0);assert.ok(numberAt(index.during,1)!>0);}
    await c.startRetirement();await c.drain();c.stopReads();
    assert.equal(c.coveredCopies.size,3,'work must not force rebuilding independent integer coverage');
    assert.equal(c.availabilityReads,0,'retirement uses exact coverage instead of decoding every observation availability again');
    const after=h.period.tapes.get('quota'),fresh=new PeriodAccounting(after.tape,c.work,h.period.index.curves);
    for(const source of c.sources){
      const actual=after.accounting.quota.get(source+'\nw'),expected=(fresh as any).quota.get(source+'\nw');
      for(const field of quotaColumns)assert.deepEqual(columnValues(actual[field]),columnValues(expected[field]),`${field} must equal a fresh forward preparation`);
      for(const from of [c.clock.now-24*H,c.clock.now-12*H])assert.deepEqual(after.accounting.quotaSummary(source,'w',{from,to:c.clock.now}),fresh.quotaSummary(source,'w',{from,to:c.clock.now}));
    }
    c.unchanged();assert.equal(h.requests.length,c.requests);assert.equal(h.period.getProjectionRevision('quota'),c.revision);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes);assert.equal(c.preparer.size,0);assert.equal(c.tails?.size,0);
  }finally{c.stopReads();await h.close();c.preparer.dispose();}
});

test('canceling a real quota retirement between posted slices clears proof ownership and cannot publish copied prefixes',async t=>{
  const c=await retirementControl(t),{h}=c;
  try{
    await c.startRetirement();await c.insideCopy();
    assert.equal(h.requests.length,c.requests);c.unchanged();
    h.period.activate(false);await flush();await c.drain();c.stopReads();
    assert.equal(c.tails?.size,0);assert.equal(c.active.size,0);assert.equal(c.preparer.size,0);
    assert.equal(h.period.tapes.size,0);assert.equal(h.period.get().value,null,'deactivation stays empty after queued canceled work settles');
    assert.equal(h.requests.length,c.requests);assert.equal(h.pool.estimatedBytes,0);c.unchanged();
    h.jump(c.clock.now+M);await flush();await c.drain();assert.equal(h.period.tapes.size,0);assert.equal(h.requests.length,c.requests);
  }finally{c.stopReads();await h.close();c.preparer.dispose();}
});

test('a real pool refusal after spent copy preserves committed quota evidence and advances the retirement deadline',async t=>{
  const c=await retirementControl(t),{h}=c,reserve=h.pool.reserve.bind(h.pool);
  let refused:any,refusals=0;
  h.pool.reserve=(owner,bytes)=>{
    const copying=[...c.active].find(index=>c.copied.has(index));
    if(copying&&!refusals){refused=copying;refusals++;assert.equal(c.tails?.size,3);return false;}
    return reserve(owner,bytes);
  };
  try{
    await c.startRetirement();await c.drain();c.stopReads();
    assert.equal(refusals,1);assert.ok(refused);assert.equal(c.coveredCopies.has(refused),false,'capacity refusal precedes the next covered-buffer allocation');
    assert.equal(c.tails?.size,0);assert.equal(c.active.size,0);assert.equal(c.preparer.size,0);
    assert.equal(h.period.tapes.get('quota'),c.before);assert.equal(h.period.get().value,c.work);assert.equal(h.period.get().error,null);c.unchanged();
    assert.equal(h.period.getProjectionRevision('quota'),c.revision);assert.equal(h.requests.length,c.requests);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes,'the rejected job releases all staging');
    const next=h.period.retirementAt,attempts=c.preparations;assert.ok(Number.isFinite(next)&&next>c.clock.now);
    h.jump(c.clock.now);await flush();await c.drain();h.jump(c.clock.now+1);await flush();await c.drain();
    assert.equal(c.preparations,attempts,'the consumed expired edge cannot immediately reschedule the failed copy');
    assert.equal(h.period.retirementAt,next);assert.equal(refusals,1);assert.equal(h.requests.length,c.requests);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes);
  }finally{h.pool.reserve=reserve;c.stopReads();await h.close();c.preparer.dispose();}
});
