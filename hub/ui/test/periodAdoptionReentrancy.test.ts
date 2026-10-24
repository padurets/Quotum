import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW,H,M} from './periodRuntimeFixture';
import {Preparations} from '../lib/prepare';

for(const reentry of ['inactive','direct','calendar','projection','work'] as const)test(`completed period preparation cannot publish after deactivation with ${reentry} reentry`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,heatmap:true}),jobs:(()=>void)[]=[];
  let time=0,armed=false,reentered=0,insideCalendar=false,earlyNotifications=0,drawing:'pending'|'complete'|'error'|null=null;
  const scheduler=new Preparations({now:()=>time++,post:run=>jobs.push(run)}),delivered:number[]=[];
  const range={from:NOW-H,to:NOW},notifications={calendar:0,projection:0,work:0};
  const enter=()=>{if(armed&&!h.period.active){
    armed=false;reentered++;h.period.activate(true);
    if(reentry==='calendar'){
      const query=h.period.intent()?.request.quota;assert.ok(query);drawing='pending';
      void h.period.transport.read('quota',query).then(()=>{drawing='complete';},()=>{drawing='error';});
    }
  }};
  const stops=[
    h.period.calendar.subscribe(()=>{notifications.calendar++;insideCalendar=true;try{if(reentry==='calendar')enter();}finally{insideCalendar=false;}}),
    h.period.subscribeProjection('quota',()=>{notifications.projection++;if(insideCalendar)earlyNotifications++;if(reentry==='projection')enter();}),
    h.period.subscribe(()=>{notifications.work++;if(insideCalendar)earlyNotifications++;if(h.period.get().value)delivered.push(h.period.activity.summary(range,'source').agentMs);if(reentry==='work')enter();}),
  ];
  const empty=()=>{
    assert.equal(h.period.get().value,null);assert.equal(h.period.get().rows.length,0);
    assert.equal(h.period.tapes.size,0);assert.equal(h.period.values.size,0);assert.equal(h.period.activity,null);
    assert.equal(h.period.storage.size,0);assert.equal(h.period.retained.size,0);assert.equal(h.period.restoring.size,0);
    assert.equal(h.period.valueCache.size,0);assert.equal(h.period.activityLeases.size,0);
  };
  try{
    h.prepareWith(scheduler);h.credit(NOW-M,NOW);h.events.flush();await flush();
    assert.equal(scheduler.size,1,'the actual transport is awaiting cooperative adoption');
    for(let slices=0;scheduler.size;slices++){
      assert.ok(slices<1000);const run=jobs.shift();assert.ok(run);run();
      if(scheduler.size)await flush();
    }
    // The final slice resolved prepareAsync, but its adoption continuation has not run.
    assert.equal(h.pool.activeFlights,1);assert.ok(h.pool.estimatedBytes>h.period.estimatedBytes);
    const flight=[...h.period.transport.flights][0] as {releases:Set<()=>void>};
    assert.equal(flight.releases.size,1,'the decoded calendar remains pinned by this flight');
    armed=true;h.period.activate(false);
    assert.equal(h.pool.activeFlights,1,'abort retains the slot until its adoption continuation settles');
    assert.equal(flight.releases.size,1,'abort does not release a still-owned decoded calendar');
    if(reentry==='direct')h.period.activate(true);
    assert.equal(reentered,reentry==='calendar'||reentry==='projection'||reentry==='work'?1:0);
    assert.equal(earlyNotifications,0,'a nested clear preserves the outer notification owner until calendar publication returns');
    empty();delivered.length=0;
    const cleared={...notifications};await flush();
    empty();assert.deepEqual(delivered,[],'the completed old preparation never publishes into the cleared or reentered period');
    assert.equal(flight.releases.size,0,'the finished flight releases its calendar pin');
    assert.equal(h.period.transport.flights.has(flight),false);
    if(reentry==='calendar')assert.equal(drawing,'complete','the outer clear preserves the reentered drawing and its first cells reply');
    if(reentry==='inactive'){
      assert.deepEqual(notifications,cleared,'settling the old adoption adds no notification');
      assert.equal(h.period.calendar.get().value,null);assert.equal(h.period.calendar.bytes,0);
      assert.equal(h.period.calendar.retained.size,0);assert.equal(h.pool.estimatedBytes,0);assert.equal(h.pool.activeFlights,0);
    }else{
      assert.equal(scheduler.size,1,'reentry owns a fresh preparation after the old flight finishes');
      for(let slices=0;jobs.length||h.pool.activeFlights;slices++){assert.ok(slices<1000);jobs.shift()?.();await flush();}
      assert.deepEqual(delivered,[2*M],'only the fresh entry publishes the complete current work');
      if(reentry==='calendar')assert.equal(drawing,'complete','the reentered drawing receives its actual transport reply');
      assert.ok(h.period.calendar.get().value);assert.equal(h.period.calendar.retained.size,0);
      assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes);
      const requests=h.requests.length;h.period.changed();await flush();
      assert.equal(h.requests.length,requests,'the outer clear preserves the new entry identity and its accepted baseline');
      h.period.activate(false);h.period.activate(false);await flush();empty();
      assert.equal(h.period.calendar.bytes,0);assert.equal(h.pool.estimatedBytes,0);assert.equal(h.pool.activeFlights,0);
    }
  }finally{for(const stop of stops)stop();h.page.dispatch({type:'board-close'});await h.close();scheduler.dispose();}
});

for(const boundary of ['calendar','facets','value','source','projection','work'] as const)test(`fixed cached period ${boundary} deactivation notifies a fully cleared snapshot before reentry`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true,heatmap:true}),drawing=await drawings(h);
  let stop=()=>{},releaseFacets=()=>{},reentered=0;
  try{
    const a={from:NOW-H,to:NOW},b={from:NOW-2*H,to:NOW-H},original=h.period.get().value;
    h.selectRange(b);await flush();assert.ok(h.period.retained.size>0);
    const reads=h.requests.length;h.selectRange(a);await flush();
    assert.equal(h.requests.length,reads,'the fixed A→B→A return must actually reuse retained evidence');
    assert.equal(h.period.get().value,original);assert.ok(h.period.retained.size>0);
    releaseFacets=h.period.demandFacets();await flush();assert.ok(h.period.getFacets().value);
    const listener=()=>{
      if(h.period.active||reentered)return;
      reentered++;
      assert.equal(h.period.get().value,null);assert.equal(h.period.get().rows.length,0);
      assert.equal(h.period.getValue(h.source).value??null,null);assert.equal(h.period.values.size,0);
      assert.equal(h.period.getSource(h.source).length,0);assert.equal(h.period.getFacets().value,null);
      assert.equal(h.period.calendar.get().value,null);assert.equal(h.period.index,null);assert.equal(h.period.activity,null);
      assert.equal(h.period.tapes.size,0);assert.equal(h.period.sourceTape,null);assert.equal(h.period.sourceCurves,undefined);
      assert.equal(h.period.retained.size,0);assert.equal(h.period.restoring.size,0);assert.equal(h.period.valueCache.size,0);
      assert.equal(h.period.bytes,0);assert.equal(h.period.storage.size,0);
      h.period.activate(true);
    };
    stop=boundary==='calendar'?h.period.calendar.subscribe(listener):boundary==='facets'?h.period.subscribeFacets(listener):boundary==='value'?h.period.subscribeValue(h.source,listener):boundary==='source'?h.period.subscribeSource(h.source,listener):boundary==='projection'?h.period.subscribeProjection('quota',listener):h.period.subscribe(listener);
    h.requests.length=0;h.period.activate(false);await flush();
    assert.equal(reentered,1);assert.notEqual(h.period.get().value,original,'a deactivated retained root cannot restore itself');
    assert.equal(h.period.workSelection.mode,'range');assert.deepEqual(h.period.work.basis.range,a);
    assert.equal(h.period.activity.summary(a,'source').agentMs,M);assert.ok(h.period.getValue(h.source).value);
    assert.ok(h.period.calendar.get().value);assert.ok(h.period.getFacets().value);
    assert.ok(h.requests.some(request=>request.sessions&&!request.sessions.cursor),'reentry reads a fresh complete work basis');
    assert.equal(h.pool.activeFlights,0);assert.equal(h.period.calendar.retained.size,0);assert.ok(drawing.loader.estimatedBytes>0);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes+drawing.loader.estimatedBytes,'the period and actual drawing reader account for every retained byte');
    const requests=h.requests.length;h.period.changed();await flush();assert.equal(h.requests.length,requests,'the outer clear does not erase the fresh entry identity');
  }finally{stop();releaseFacets();drawing.close();h.page.dispatch({type:'board-close'});await h.close();}
});

for(const boundary of ['facets','value','source','work','projection'] as const)for(const replacement of ['clear','live','history'] as const)test(`fresh period ${boundary} notification can ${replacement} without reviving its captured reply`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true}),drawing=await drawings(h);
  const wanted={from:NOW-2*H,to:NOW-H};
  let stop=()=>{},releaseFacets=()=>{};
  try{
    if(boundary==='facets'){releaseFacets=h.period.demandFacets();await flush();}
    let inside=0,reentered=0,coherent=false;
    const adopt=h.period.adoptReply;
    h.period.adoptReply=async function(...args:unknown[]){inside++;try{return await adopt.apply(this,args);}finally{inside--;}};
    const listener=()=>{
      if(!inside||reentered)return;
      if(boundary==='facets'?h.period.getFacets().loading:boundary==='value'?h.period.getValue(h.source).loading:boundary==='work'?h.period.get().loading:false)return;
      reentered++;
      const value=h.period.getValue(h.source),work=h.period.get(),tape=h.period.tapes.get('quota');
      coherent=!!work.value&&work.value===h.period.work.value&&work.basis?.range.from===wanted.from&&work.basis?.range.to===wanted.to
        &&value.basis?.range.from===wanted.from&&value.basis?.range.to===wanted.to&&!value.loading
        &&!!tape&&h.period.storage.has(tape.tape)&&h.period.storage.has(tape.accounting)&&h.period.storage.has(value.value)
        &&h.period.storage.has(h.period.activity);
      if(replacement==='clear')h.page.dispatch({type:'board-close'});
      else if(replacement==='live')h.selectRange(null);
      else {
        h.store.creditWork(h.device,NOW-90*M,NOW-89*M,[{source:h.source,accountBy:'login',client:'codex',origin:'terminal',startedAt:NOW-95*M,project:'Late project',folder:'Late folder',identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);
        h.events.flush();
      }
    };
    stop=boundary==='facets'?h.period.subscribeFacets(listener):boundary==='value'?h.period.subscribeValue(h.source,listener):boundary==='source'?h.period.subscribeSource(h.source,listener):boundary==='work'?h.period.subscribe(listener):h.period.subscribeProjection('quota',listener);
    h.requests.length=0;h.selectRange(wanted);await flush();
    assert.equal(reentered,1,'the actual fresh adoption must notify this consumer');
    assert.equal(coherent,true,'the first notification sees the complete numeric snapshot and its resident storage');
    if(replacement==='clear'){
      assert.equal(h.page.get().board,null);assert.equal(h.period.get().value,null);assert.equal(h.period.get().rows.length,0);
      assert.equal(h.period.values.size,0);assert.equal(h.period.tapes.size,0);assert.equal(h.period.activity,null);
      assert.equal(h.period.estimatedBytes,0);assert.equal(h.period.transport.evidence().size,0);
    }else if(replacement==='live'){
      assert.equal(h.period.selection.mode,'live');assert.equal(h.period.workSelection.mode,'live');
      assert.equal(h.period.work.basis.range.from,NOW-H);assert.equal(h.period.work.basis.range.to,NOW);
      assert.ok(h.requests.some(request=>request.selection.mode==='live'&&request.sessions),'Live must retain its new sessions demand');
      assert.equal(h.period.workNeeded,false);
    }else{
      assert.ok(h.requests.filter(request=>request.selection.mode==='range'&&request.selection.from===wanted.from&&request.sessions).length>=2,'new evidence requires another sessions read for this same target');
      assert.equal(h.period.activity.summary(wanted,'source').agentMs,M,'the actual producer contributes the disjoint new minute');
      const latest=h.fresh();
      assert.equal(h.period.work.basis.revision,latest.basis.revision);assert.equal(h.period.workProofEpoch,h.period.proofEpoch);
      assert.equal(h.period.valuesProofEpoch,h.period.proofEpoch);assert.equal(h.period.workNeeded,false);assert.equal(h.period.valuesNeeded,false);
    }
  }finally{stop();releaseFacets();drawing.close();await h.close();}
});

for(const boundary of ['facets','value'] as const)for(const replacement of ['clear','live','history'] as const)test(`failed fresh period ${boundary} notification preserves a reentrant ${replacement}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true}),drawing=await drawings(h);
  let stop=()=>{},releaseFacets=()=>{};
  try{
    if(boundary==='facets'){releaseFacets=h.period.demandFacets();await flush();}
    let inside=0,reentered=0,coherent=false;
    const adopt=h.period.adoptReply;
    h.period.adoptReply=async function(...args:unknown[]){inside++;try{return await adopt.apply(this,args);}finally{inside--;}};
    const listener=()=>{
      if(!inside||reentered||!(boundary==='facets'?h.period.getFacets().error:h.period.getValue(h.source).error))return;
      reentered++;
      coherent=!!h.period.get().error&&!!h.period.getValue(h.source).error&&!h.period.get().loading&&!h.period.getValue(h.source).loading;
      if(replacement==='clear')h.page.dispatch({type:'board-close'});
      else if(replacement==='live')h.selectRange(null);
      else {
        h.store.creditWork(h.device,NOW-90*M,NOW-89*M,[{source:h.source,accountBy:'login',client:'codex',origin:'terminal',startedAt:NOW-95*M,project:'Late project',folder:'Late folder',identity:{kind:'stable',sessionId:'d'.repeat(32)}}]);
        h.events.flush();
      }
    };
    stop=boundary==='facets'?h.period.subscribeFacets(listener):h.period.subscribeValue(h.source,listener);
    const held=h.hold();h.selectRange({from:NOW-2*H,to:NOW-H});await flush();held.reject(new Error('fixture transport failure'));await flush();
    assert.equal(reentered,1);assert.equal(coherent,true,'error sections commit together before a subscriber can replace them');
    if(replacement==='clear'){assert.equal(h.period.get().value,null);assert.equal(h.period.values.size,0);assert.equal(h.period.estimatedBytes,0);}
    else {assert.equal(h.period.get().error,null);assert.equal(h.period.workNeeded,false);assert.equal(h.period.valuesNeeded,false);assert.equal(h.period.workSelection.mode,replacement==='live'?'live':'range');}
  }finally{stop();releaseFacets();drawing.close();await h.close();}
});

test('a resource change from the first publication still notifies surviving value subscribers',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true}),drawing=await drawings(h);
  const releaseFacets=h.period.demandFacets();await flush();
  let stopFacets=()=>{},stopValue=()=>{};
  try{
    let inside=0,reentered=0,ready=0;
    const wanted={from:NOW-2*H,to:NOW-H},adopt=h.period.adoptReply;
    h.period.adoptReply=async function(...args:unknown[]){inside++;try{return await adopt.apply(this,args);}finally{inside--;}};
    stopFacets=h.period.subscribeFacets(()=>{
      if(!inside||reentered||h.period.getFacets().loading)return;
      reentered++;
      const board=h.page.get().board!,generation=h.period.generation;
      h.event({type:'view',data:{revision:(board.viewRevision??0)+1,view:{...board.view,shown:['agents'],hidden:['activity','quota-history','quota-session-history','quota-table','quota-session-table','subscription-funds','budget-history','budget-table']}}});
      assert.ok(h.period.generation>generation,'the resource change invalidates the captured intent');
    });
    stopValue=h.period.subscribeValue(h.source,()=>{
      const reading=h.period.getValue(h.source);
      if(reading.value&&!reading.loading&&reading.basis?.range.to===wanted.to)ready++;
    });
    h.selectRange(wanted);await flush();
    assert.equal(reentered,1);assert.equal(ready,1,'a changed generation must not swallow the already committed value notification');
    assert.equal(h.period.getValue(h.source).basis.range.to,wanted.to);
  }finally{stopFacets();stopValue();releaseFacets();drawing.close();await h.close();}
});

for(const scenario of [
  {envelope:'complete',replacement:'failure',newWork:true},
  {envelope:'complete',replacement:'success',newWork:true},
  {envelope:'complete',replacement:'none',newWork:false},
  {envelope:'delta',replacement:'failure',newWork:true},
  {envelope:'delta',replacement:'success',newWork:true},
  {envelope:'error',replacement:'failure',newWork:true},
  {envelope:'error',replacement:'success',newWork:true},
  {envelope:'complete',replacement:'failure',newWork:true,returnLive:true},
] as const)test(`queued ${scenario.envelope} calendar with ${scenario.newWork?'new work':'unchanged evidence'} and ${scenario.replacement} replacement stays truthful after returning to ${'returnLive' in scenario?'live':'its range'}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,fixed:true,heatmap:true}),jobs:(()=>void)[]=[];
  let time=0,releaseFacets=()=>{};
  const scheduler=new Preparations({now:()=>time++,post:run=>jobs.push(run)});
  let a:ReturnType<typeof h.hold>|undefined,b:ReturnType<typeof h.hold>|undefined,c:ReturnType<typeof h.hold>|undefined;
  const calendarTotal=()=>h.period.calendar.get().value?.cells.reduce((sum:number,cell:{agentMs:number|null})=>sum+(cell.agentMs??0),0)??null;
  const workTotal=()=>h.period.get().rows.reduce((sum:number,row:{workedMs:number})=>sum+row.workedMs,0);
  const drain=async()=>{
    for(let slices=0;slices<1000;slices++){
      await flush();const run=jobs.shift();if(!run)return;run();
    }
    assert.fail('queued calendar adoption did not finish its bounded preparation');
  };
  try{
    // No native baseline barrier: the existing second slot serves genuinely new facets.
    const view=h.directory.view(h.board);
    h.directory.saveView(h.board,{...view,shown:['agents','agent-hours-heatmap'],hidden:['activity','quota-history','quota-session-history','quota-table','quota-session-table','budget-history','budget-table','subscription-funds']},h.alice.id,NOW+1);
    h.events.flush();await flush();h.requests.length=0;h.frames.length=0;
    assert.equal(calendarTotal(),M);assert.equal(h.pool.activeFlights,0);
    h.prepareWith(scheduler);
    a=h.hold();
    if(scenario.envelope==='delta'){
      // Resource adoption has an actual measurement to prepare independently of work.
      h.store.record(h.source,{observedAt:NOW-M/2,plan:'',resets:null,staleAfterMs:H,windows:[{id:'w',kind:'weekly',label:null,minutes:10080,used:30,remaining:70,resetAt:NOW+H}]});
      h.credit(NOW-2*M,NOW-M);h.events.flush();
    }
    else h.selectRange({from:NOW-2*H,to:NOW});
    await flush();
    const range=h.selectedRange();assert.ok(range);
    const first=a.reply?.calendar;
    assert.equal(first?.state,scenario.envelope==='delta'?'delta':'complete','A must contain the actual requested calendar representation');
    assert.ok(a.signal&&!a.signal.aborted);
    const calendarGeneration=h.period.calendar.generation,resourceGeneration=h.period.resourceGeneration;
    b=h.hold();releaseFacets=h.period.demandFacets();await flush();
    assert.equal(b.reply?.calendar?.state,scenario.envelope==='delta'?'delta':'complete','the real uncovered-facets request must also contain the calendar');
    assert.equal(h.requests.length,2);assert.equal(h.pool.activeFlights,2);
    assert.ok(h.requests[1].facets&&h.requests[1].calendar,'the second combined body actually covers facets and calendar');
    assert.equal(h.period.calendar.generation,calendarGeneration,'facets preserve calendar evidence');
    assert.equal(h.period.resourceGeneration,resourceGeneration,'opening choices does not change the resource cohort');
    assert.ok(h.pool.estimatedBytes<=h.pool.budget);
    a.release();await flush();
    assert.equal(scheduler.size,1,'A reached real cooperative resource adoption before B can publish');
    assert.ok(jobs.length);const beforeB=h.period.calendar.get();
    if(scenario.envelope==='error')b.reject(new Error('older calendar delivery failed'));
    else b.release();
    await flush();
    assert.equal(h.period.calendar.get(),beforeB,'B remains queued behind A rather than publishing at HTTP completion');
    assert.equal(scheduler.size,1);
    const requestsBeforeWork=h.requests.length,framesBeforeWork=h.frames.length,authority=h.page.get().board!.workAuthority;
    if(scenario.newWork){
      c=h.hold();const from=scenario.envelope==='delta'?NOW-M:NOW-2*M;
      h.credit(from,from+M);h.events.flush();await flush();
      assert.ok(h.frames.slice(framesBeforeWork).some(frame=>frame.type==='history'&&JSON.parse(frame.data).workSince===from),'the real accepted credit must reach the calendar owner');
      assert.equal(h.page.get().board!.workAuthority,authority,'positive work is not a hard authority retirement');
      assert.ok(h.period.resourceGeneration>resourceGeneration,'the producer invalidates the actual resource evidence');
      assert.ok(h.period.intent()?.request.calendar,'new work still demands the current calendar while old adoption waits');
    }
    await drain();
    if(scenario.newWork){
      assert.ok(c?.reply?.calendar,'C must actually start with its already formed calendar body');
      assert.equal(h.requests.length,requestsBeforeWork+1);
      assert.ok(h.requests.at(-1)!.calendar,'the required refresh was formed before obsolete B finishes');
      if(scenario.replacement==='failure')c.reject(new Error('current calendar delivery failed'));
      else c.release();
      await flush();await drain();
      if(scenario.replacement==='failure')assert.equal(h.period.calendar.get().error,'unavailable','the current failure remains actionable');
      else {assert.equal(calendarTotal(),scenario.envelope==='delta'?3*M:2*M);assert.equal(h.period.calendar.get().error,null);}
    }else{
      assert.equal(c,undefined,'the unchanged-evidence control owns no unused replacement hold');
      assert.equal(h.requests.length,requestsBeforeWork,'settling compatible old evidence must not invent C');
      assert.equal(calendarTotal(),M);assert.equal(h.period.calendar.get().error,null);
    }
    assert.equal(h.pool.activeFlights,0);assert.equal(h.period.calendar.retained.size,0);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes,'all decoded reply reservations have settled');
    h.prepareWith(null);
    h.selectRange({from:NOW-3*H,to:NOW-2*H});await flush();
    h.requests.length=0;h.selectRange('returnLive' in scenario?null:range);await flush();
    const expected=scenario.newWork?(scenario.envelope==='delta'?3*M:2*M):M;
    assert.equal(workTotal(),expected,'the returned sessions use the current producer evidence');
    assert.equal(calendarTotal(),expected,'a failed replacement cannot make the obsolete queued proof reusable');
    if('returnLive' in scenario){
      const cells=h.period.calendar.get().value!.cells.filter((cell:{from:number;to:number})=>cell.to>cell.from&&cell.from>=NOW-H&&cell.to<=NOW);
      assert.equal(cells.length,60);assert.ok(cells.every((cell:{agentMs:number|null})=>cell.agentMs!==null),'the selected live hour is fully known');
      assert.equal(cells.find((cell:{from:number;to:number})=>cell.from===NOW-2*M&&cell.to===NOW-M)?.agentMs,M,'the changed live minute cannot resurrect as a confirmed zero');
    }
    assert.equal(h.period.calendar.get().error,null);assert.equal(h.period.calendar.needed,false);
    if(scenario.newWork&&scenario.replacement==='failure')assert.ok(h.requests.some(request=>request.calendar),'returning after a failed fresh read must replace the dirty calendar proof');
    if(!scenario.newWork)assert.equal(h.requests.filter(request=>request.calendar).length,0,'unchanged complete evidence remains reusable');
    assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes);
    assert.equal(h.period.calendar.retained.size,0);
  }finally{
    releaseFacets();a?.release();b?.release();c?.release();await flush();await drain();
    h.prepareWith(null);h.page.dispatch({type:'board-close'});await h.close();scheduler.dispose();
    assert.equal(h.pool.activeFlights,0);assert.equal(h.pool.estimatedBytes,0);
  }
});
