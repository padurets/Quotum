import {calendarReceiptScript} from './calendarReceipt';
import type {WorkTrace} from '../server/domain/periodWork.js';

export function retirementBoundary(value:{selection:{mode:string;periodMs?:number};evaluatedAt:number;work:{value:WorkTrace|null}}|undefined){
  const periodMs=value?.selection.mode==='live'?value.selection.periodMs:undefined,work=value?.work.value;
  if(!periodMs||!Number.isSafeInteger(periodMs)||periodMs<=0||!Number.isFinite(value?.evaluatedAt)||!work?.packed||work.fixed||!Number.isFinite(work.anchor))return null;
  const {blocks,patterns}=work.packed;if(blocks.length%3)return null;let edge=Infinity;
  for(let i=0;i<blocks.length;i+=3){const end=blocks[i+1]*3_600_000+patterns[blocks[i+2]]?.at(-1)!;if(!Number.isFinite(end))return null;if(end>value!.evaluatedAt-periodMs)edge=Math.min(edge,end);}
  return {periodMs,at:value!.evaluatedAt,anchor:work.anchor,blocks:blocks.length,patterns:patterns.length,edge:Number.isFinite(edge)?edge:null};
}
export type RetirementAlignment={used:boolean;status:'inconclusive'|'exposed';reason:string;pair?:number;waitMs?:number;reads?:number;seed?:ReturnType<typeof retirementBoundary>;returned?:ReturnType<typeof retirementBoundary>};
export function claimRetirementAlignment(state:RetirementAlignment,seed:ReturnType<typeof retirementBoundary>,now:number,pair:number){
  if(state.used||!seed||seed.edge===null)return null;const remaining=seed.edge+seed.periodMs-now,wait=remaining+250;
  if(!Number.isFinite(remaining)||remaining<=0||wait>60_000)return null;
  Object.assign(state,{used:true,pair,waitMs:wait,seed,reason:'retirement-not-observed'});return wait;
}


/** One opt-in page observes existing pool operations; it never supplies scheduling or retention decisions. */
export function historyPoolReceiptScript(byteLimit=256*1024) {
  if(byteLimit!==256*1024&&byteLimit!==512*1024)throw new Error('Unsupported history receipt byte limit');
  return `(() => {
    const limit=4096,tileLimit=1024,byteLimit=${byteLimit},summaryLimit=512,ownershipLimit=128,ownershipByteLimit=262144,entries=[],nearRows=[],ownershipRows=[],ownershipGraphs=[],members=[],ids=new WeakMap(),targets=new WeakMap(),summaries=new Map(),demandBindings=new WeakMap(),readOwners=new WeakMap(),retainedOwnership=new WeakMap(),graphKeys=new Map(),aborting=new WeakSet();let nextId=0,count=0,bytes=0,nearBytes=0,nearOmitted=0,omitted=0,errors=0,snapshotOmitted=0,summaryOmitted=0,ownershipBytes=0,ownershipOmitted=0,ownershipMissing=0,bindingMissing=0,reserveSerial=0,reserve=null,attached=false,lastMark=null,chargeCalls=0,peakCharge=null,reading=null,readSerial=0,admitting=null,sendingUnknown=0,sending=null,sharedPreparations=null,sharedPool=null;
    const id=value=>value&&typeof value==='object'?(ids.has(value)?ids.get(value):(ids.set(value,++nextId),nextId)):null;
    const n=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
    const interest=member=>{const p=member.interest;return p?[n(p.token),n(p.length),n(p.from),n(p.to),n(p.direction)]:null;};
    const emit=(kind,values)=>{count++;if(entries.length>=limit){omitted++;return;}const entry={id:count,at:performance.now(),kind,...values},size=JSON.stringify(entry).length;if(bytes+size>byteLimit){omitted++;return;}bytes+=size;entries.push(entry);};
    const observe=run=>{try{return run();}catch{errors++;return null;}};
    ${calendarReceiptScript()}
    const owner=value=>members.find(m=>m.value===value)?.id??members.find(m=>m.value.transport===value)?.id??null;
    const periodState=()=>{
      const records=members.filter(record=>record.kind==='period'&&sharedPool?.members.has(record.value));
      if(records.length!==1)return null;const record=records[0];
      const value=record.value,work=value.work?.value,boolean=field=>typeof field==='boolean'?field:null;
      return {memberId:record.id,mode:['live','range'].includes(value.selection?.mode)?value.selection.mode:null,currentBytes:n(value.bytes),
        retiring:boolean(value.retiring),retirementPreparing:boolean(value.retirementPreparing),retirementAt:n(value.retirementAt),retirementFinite:typeof value.retirementAt==='number'?Number.isFinite(value.retirementAt):null,
        work:work?{fixed:!!work.fixed,packed:!!work.packed,refs:Array.isArray(work.refs)?work.refs.length:null,spans:Array.isArray(work.spans)?work.spans.length:null}:null};
    };
    const bounded=(values,read)=>{const rows=[];for(const value of values){if(rows.length===128){ownershipOmitted++;break;}rows.push(read(value));}return rows;};
    const scope=value=>['quota','budget','funds'].includes(value)?value:null;
    const numeric=value=>typeof value==='string'&&/^-?[0-9]{1,16}$/.test(value)?n(Number(value)):n(value);
    const selection=value=>value?{mode:['live','range'].includes(value.mode)?value.mode:null,periodMs:n(value.periodMs),from:n(value.from),to:n(value.to)}:null;
    const intent=value=>value?{generation:n(value.generation),revision:n(value.revision),resourceGeneration:n(value.resourceGeneration),calendarGeneration:n(value.calendarGeneration),facetGeneration:n(value.facetGeneration),proofEpoch:n(value.proofEpoch),selection:selection(value.request?.selection),evaluatedAt:n(value.request?.evaluatedAt)}:null;
    const request=value=>value?{version:n(value.version),selection:selection(value.selection),evaluatedAt:n(value.evaluatedAt),sections:['quota','budget','funds'].flatMap(key=>value[key]?[{scope:key,cell:numeric(value[key].cell),from:numeric(value[key].from),to:numeric(value[key].to),cells:value[key].cells==='skip'?'skip':'read',evidence:value[key].evidence==='skip'?'skip':value[key].evidence?'cursor':'baseline'}]:[]),values:Array.isArray(value.values)?value.values.length:0,sessions:!!value.sessions,facets:!!value.facets,sourceWork:!!value.sourceWork,calendar:value.calendar?{zone:typeof value.calendar.zone==='string'?value.calendar.zone:null,cursor:!!value.calendar.cursor}:null,workFilter:!!value.workFilter}:null;
    const flight=value=>({flightId:id(value),seq:n(value?.seq),epoch:n(value?.epoch),newsSeq:n(value?.newsSeq),cell:n(value?.cell),from:n(value?.from),to:n(value?.to),role:['visible','ahead'].includes(value?.role)?value.role:null,aborted:value?.controller?.signal?.aborted===true,ownSlot:sharedPool?.active.has(value)===true,extras:value?.extras===true,preparing:value?.preparing===true,intent:intent(value?.intent)});
    const demandOwner=demand=>{const binding=demandBindings.get(demand);if(!binding)bindingMissing++;return{demandId:id(demand),scope:scope(demand.scope),queryId:id(demand.query),signalId:id(demand.signal),chartMemberId:binding?.chartMemberId??null,chartFlightIds:binding?bounded(binding.chart.value.flights??[],flight=>flight.controller?.signal===demand.signal?id(flight):null).filter(value=>value!==null):[],bound:!!binding&&binding.query===demand.query&&binding.signal===demand.signal};};
    const reservationOwner=(pool,flight)=>{
      const transport=members.find(m=>m.kind==='period'&&m.value.transport?.flights?.has(flight));
      if(transport)return{memberId:transport.id,kind:'transport',ownSlot:pool.active.has(flight),extras:flight.extras===true,preparing:flight.preparing===true,demands:bounded(flight.demands??[],demandOwner)};
      const period=members.find(m=>m.kind==='period'&&m.value===flight.historyMember);
      if(period&&['calendar-projection','values','restore','adoption','retirement'].includes(flight.operation))return{memberId:period.id,kind:'period-staging',operation:flight.operation};
      const admitted=pool.active.get(flight)?.owner,known=admitted?members.find(m=>m.value===admitted||m.value.transport===admitted):null;
      if(known)return{memberId:known.id,kind:known.value.transport===admitted?'transport':known.kind};
      const chart=members.find(m=>m.kind==='chart'&&(m.value.flights.has(flight)||m.value.responses.has(flight)||[...m.value.reservations.values()].includes(flight)));
      return{memberId:chart?.id??null,kind:chart?'chart-staging':'unknown'};
    };
    const graph=member=>({
      work:id(member.work),workValue:id(member.work?.value),workPacked:id(member.work?.value?.packed),workSpans:id(member.work?.value?.spans),index:id(member.index),indexCurves:id(member.index?.curves),activity:id(member.activity),activityTrace:id(member.activity?.trace),sourceTape:id(member.sourceTape),sourceCurves:id(member.sourceCurves),
      tapes:bounded(member.tapes instanceof Map?member.tapes:[],([key,entry])=>({scope:scope(key),entry:id(entry),tape:id(entry.tape),accounting:id(entry.accounting),quota:bounded(entry.tape?.quota??[],row=>[id(row),id(row.samples)]),money:bounded(entry.tape?.money??[],row=>[id(row),id(row.readings),id(row.spans),id(row.paired),id(row.workCounter)])})),
      values:bounded(member.values instanceof Map?member.values.values():[],entry=>[id(entry),id(entry.value),id(entry.basis),id(entry.value?.states)])
    });
    const keepGraph=value=>{const key=JSON.stringify(value),known=graphKeys.get(key);if(known!==undefined)return known;if(ownershipGraphs.length===ownershipLimit||ownershipBytes+key.length>ownershipByteLimit){ownershipOmitted++;return null;}const number=ownershipGraphs.length+1;ownershipBytes+=key.length;graphKeys.set(key,number);ownershipGraphs.push({id:number,...value});return number;};
    const ownership=(pool,kind,current)=>{
      if(ownershipRows.length===ownershipLimit){ownershipOmitted++;return null;}
      const row={id:ownershipRows.length+1,kind,reserveId:current?.reserveId??null,members:members.map(m=>{
        const value=m.value,base={memberId:m.id,estimatedBytes:n(value.estimatedBytes)};
        if(m.kind!=='period')return{...base,tiles:retained(value).values.map(v=>v.row)};
        const calendar=value.calendar,cache=calendar?.cache;
        const storage=entry=>bounded(entry.storage instanceof Map?entry.storage:[],([root,size])=>[id(root),n(size)]);
        return{...base,currentBytes:n(value.bytes),current:keepGraph(graph(value)),storage:storage(value),
          retained:bounded(value.retained.values(),entry=>{const captured=retainedOwnership.get(entry);if(captured===undefined)ownershipMissing++;return{id:id(entry),bytes:n(entry.bytes),activityBytes:n(entry.activityBytes),copyBytes:n(entry.copyBytes),metadata:n(entry.metadata),storage:storage(entry),activity:id(entry.activity),activityTrace:id(entry.activity?.trace),captured:captured??null};}),
          valueCache:bounded(value.valueCache.values(),entry=>({id:id(entry),bytes:n(entry.bytes),metadata:n(entry.metadata),storage:storage(entry),values:id(entry.values),readings:bounded(entry.values instanceof Map?entry.values.values():[],reading=>[id(reading),id(reading.value),id(reading.basis)])})),
          restoring:bounded(value.restoring??[],entry=>{const captured=retainedOwnership.get(entry);if(captured===undefined)ownershipMissing++;return{id:id(entry),bytes:n(entry.bytes),metadata:n(entry.metadata),storage:storage(entry),captured:captured??null};}),
          leases:bounded(value.activityLeases instanceof Map?value.activityLeases:[],([projector,lease])=>({projector:id(projector),trace:id(projector.trace),count:n(lease.count),bytes:n(lease.bytes)})),
          calendar:calendar?{id:id(calendar),bytes:n(calendar.bytes),state:id(calendar.state),readingValue:id(calendar.state?.value),readingCells:id(calendar.state?.value?.cells),readingEdges:id(calendar.state?.value?.edges),readingBasis:id(calendar.state?.basis),cacheBytes:n(cache?.bytes),entries:bounded(cache?.entries??[],entry=>({id:id(entry),curve:id(entry.curve),bytes:n(entry.bytes),from:n(entry.from),to:n(entry.to),cut:n(entry.cut),at:n(entry.at),period:n(entry.period)})),borrowed:bounded(cache?.borrowed??[],([entry,count])=>[id(entry),n(count)])}:null};
      }),reservations:bounded(pool.reservations,([flight,bytes])=>({flightId:id(flight),bytes:n(bytes),owner:reservationOwner(pool,flight)}))};
      const size=JSON.stringify(row).length;if(ownershipBytes+size>ownershipByteLimit){ownershipOmitted++;return null;}ownershipBytes+=size;ownershipRows.push(row);return row.id;
    };
    const pending=member=>({queue:n(member.transport?.queue?.length),flights:n(member.transport?.flights?.size??member.flights?.size),preparing:member.transport?.flights instanceof Set?[...member.transport.flights].filter(f=>f.preparing).length:null,responses:n(member.responses?.size),reservations:n(member.reservations?.size),generation:n(member.generation),revision:n(member.revision),epoch:n(member.epoch),newsSeq:n(member.newsSeq),preparationSize:n((member.env?.preparations??sharedPreparations)?.size),workNeeded:typeof member.workNeeded==='boolean'?member.workNeeded:null,valuesNeeded:typeof member.valuesNeeded==='boolean'?member.valuesNeeded:null,calendar:member.calendar?{generation:n(member.calendar.generation),needed:member.calendar.needed===true,loading:member.calendar.state?.loading===true,entries:n(member.calendar.cache?.entries?.size),bytes:n(member.calendar.cache?.bytes)}:null});
    const retained=(member,range)=>{
      const values=[];let total=0;
      const add=(entry,row)=>{total++;if(values.length<tileLimit)values.push({entry,row});else snapshotOmitted++;};
      if(member.grids instanceof Map)for(const [cell,tiles]of member.grids)for(const [index,tile]of tiles){if(range&&(cell!==range.cell||tile.to<=range.from||tile.from>=range.to))continue;add(tile,[0,id(tile),n(cell),n(index),n(tile.from),n(tile.to),n(tile.readFrom),n(tile.readTo),n(tile.validTo),n(tile.bytes),n(tile.shownAt),member.reservations.has(cell+':'+index),n(tile.nativeFrom),n(tile.nativeTo),n(tile.nativeValidTo),n(tile.writeSeq),n(tile.nativeSeq)]);}
      else for(const [code,map]of [[1,member.valueCache],[2,member.retained]])if(map instanceof Map)for(const entry of map.values())add(entry,[code,id(entry),null,null,null,null,null,null,n(entry.bytes),n(entry.at)]);
      return {values,total,omitted:Math.max(0,total-values.length)};
    };
    window.__quotumHistoryPoolReceipt={retirementBoundary:()=>observe(()=>{const records=members.filter(record=>record.kind==='period'&&sharedPool?.members.has(record.value));return records.length===1?(${retirementBoundary.toString()})(records[0].value):null;}),mark:(phase,step)=>observe(()=>{calendarReceipt.mark(phase,step);if(lastMark===phase+':'+step)return;lastMark=phase+':'+step;emit('checkpoint',{phase,step,members:members.map(m=>{const state=retained(m.value);return{memberId:m.id,pending:pending(m.value),target:targets.get(m.value)??null,interest:interest(m.value),retainedIds:state.values.map(v=>v.row[1]),retainedCount:state.total,retainedOmitted:state.omitted};})});}),read:()=>{const final=observe(()=>members.map(m=>{const state=retained(m.value);return{memberId:m.id,pending:pending(m.value),currentBytes:n(m.value.bytes),target:targets.get(m.value)??null,interest:interest(m.value),retained:state.values.map(v=>v.row),retainedOmitted:state.omitted};}));const order=members.length===4&&members[0].kind==='period'&&members.slice(1,4).every(m=>m.kind==='chart'&&m.transportBound===true&&!m.bindingMismatch)&&members[1].scope==='quota'&&members[2].scope==='budget'&&members[3].scope==='budget';const receipt={status:attached&&order&&lastMark==='2:3'&&!omitted&&!errors&&!snapshotOmitted&&!summaryOmitted&&!nearOmitted&&!ownershipOmitted&&!ownershipMissing&&!bindingMissing&&!sendingUnknown?'complete':'insufficient-evidence',attached,registrationOrderQualified:order,members:members.map((m,i)=>({id:m.id,ordinal:i+1,kind:m.kind,scope:m.scope,transportBound:m.transportBound===true,transportScope:m.transportScope??null,bindingMismatch:m.bindingMismatch===true})),count,bytes,omitted,errors,snapshotOmitted,summaryOmitted,ownershipBytes,ownershipOmitted,ownershipMissing,bindingMissing,sendingUnknown,ownershipLimit,ownershipByteLimit,ownershipRows,ownershipGraphs,nearBytes,nearOmitted,limit,byteLimit,tileLimit,summaryLimit,nearBudgetRatio:.95,reserveCalls:reserveSerial,chargeCalls,peakCharge,ordinaryByFlight:[...summaries.values()],nearRows,entries,final,lastCheckpoint:lastMark==='2:3'};const size=JSON.stringify(receipt).length;if(size>900000)return{status:'insufficient-evidence',reason:'receipt size',originalBytes:size,attached,count,bytes,nearBytes,omitted,nearOmitted,errors,snapshotOmitted,summaryOmitted,ownershipOmitted,ownershipMissing,bindingMissing,sendingUnknown,omittedOwnershipRows:ownershipRows.length,omittedOwnershipGraphs:ownershipGraphs.length,omittedDetailedSummaries:summaries.size,omittedFinal:true,ordinaryCountsByFlight:[...summaries.values()].map(s=>[s.flightId,s.calls,s.ordinaryAccepted,s.nearBudgetCalls]),entries,nearRows};return receipt;}};
    window.__quotumHistoryPoolReceipt.checkpoint=label=>observe(()=>{
      if(typeof label!=='string'||label.length>64||!/^[a-z0-9 /-]+$/.test(label))throw Error();
      if(!sharedPool)throw Error();
      const pool=sharedPool,value={label,at:performance.now(),members:members.map(m=>{
        const value=m.value,state=retained(value),calendar=value.calendar;
        return{memberId:m.id,pending:pending(value),estimatedBytes:n(value.estimatedBytes),target:targets.get(value)??null,interest:interest(value),retained:state.values.map(v=>v.row),retainedOmitted:state.omitted,
          queue:bounded(value.transport?.queue??[],demandOwner),flights:bounded(value.transport?.flights??value.flights??[],flight),responses:bounded(value.responses??[],([key,response])=>({flight:flight(key),started:response.started===true,limited:response.limited===true})),reservations:bounded(value.reservations??[],([key,owner])=>({key:typeof key==='string'&&/^[0-9]+:[0-9]+$/.test(key)?key:null,flightId:id(owner)})),
          calendar:calendar?{generation:n(calendar.generation),needed:calendar.needed===true,reading:id(calendar.state),basis:calendar.state?.basis?{evaluatedAt:n(calendar.state.basis.evaluatedAt),evidenceCut:n(calendar.state.basis.evidenceCut),range:calendar.state.basis.range}:null,entries:bounded(calendar.cache.entries,entry=>({id:id(entry),curve:id(entry.curve),from:n(entry.from),to:n(entry.to),cut:n(entry.cut),bytes:n(entry.bytes),period:n(entry.period)}))}:null};
      }),pool:{bytes:n(pool.estimatedBytes),budget:n(pool.budget),active:n(pool.active.size),waiting:n(pool.waiting.length),reservations:bounded(pool.reservations,([key,bytes])=>({flightId:id(key),bytes:n(bytes),owner:reservationOwner(pool,key)}))},errors,omitted,snapshotOmitted,ownershipOmitted};
      emit('checkpoint-detail',{label,at:value.at});return value;
    });
    const originalPreparations=window.__quotumInspectPreparations;
    window.__quotumInspectPreparations=function(value){observe(()=>{sharedPreparations=value;});if(typeof originalPreparations==='function')return originalPreparations.apply(this,arguments);};
    window.__quotumInspectHistoryPool=pool=>{
      if(attached){errors++;return;}attached=true;sharedPool=pool;
      observe(()=>{
        if(!(pool.members instanceof Set)||pool.members.size!==0)throw Error();
        const charge=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pool),'estimatedBytes');
        if(!charge?.get)throw Error();
        Object.defineProperty(pool,'estimatedBytes',{get(){const value=charge.get.call(this);observe(()=>{chargeCalls++;peakCharge=peakCharge===null?value:Math.max(peakCharge,value);if(reserve){reserve.charge=reserve.charge===null?value:Math.max(reserve.charge,value);reserve.lastCharge=value;if(value>pool.budget&&!reserve.ownershipBefore)reserve.ownershipBefore=ownership(pool,'reserve-pressure',reserve);}else if(value>pool.budget)emit('charge-pressure',{bytes:n(value),budget:n(pool.budget)});});return value;}});
        const originalReserve=pool.reserve;
        pool.reserve=function(flight,bytes){const previous=reserve,current={reserveId:++reserveSerial,flightId:null,owner:null,bytes:n(bytes),previous:null,charge:null,lastCharge:null,drops:0,accepted:null,complete:false};observe(()=>{current.flightId=id(flight);current.owner=reservationOwner(pool,flight);current.previous=n(pool.reservations.get(flight)??0);});reserve=current;try{const result=originalReserve.call(this,flight,bytes);current.accepted=result;current.complete=true;return result;}finally{observe(()=>{let summary=summaries.get(current.flightId);if(!summary){if(summaries.size>=summaryLimit)summaryOmitted++;else{summary={flightId:current.flightId,owner:current.owner,calls:0,ordinaryAccepted:0,nearBudgetCalls:0,first:current,peak:current,last:current};summaries.set(current.flightId,summary);}}const near=current.charge!==null&&current.charge>=pool.budget*.95,critical=!current.complete||!current.accepted||current.drops>0||current.charge>pool.budget;if(summary){summary.calls++;summary.ordinaryAccepted+=!critical&&!near?1:0;summary.nearBudgetCalls+=near?1:0;if((current.charge??-Infinity)>(summary.peak.charge??-Infinity))summary.peak=current;summary.last=current;if(near&&!summary.firstNear)summary.firstNear=current;}if(near){const row=[current.reserveId,current.flightId,current.bytes,current.previous,current.charge,current.accepted],size=JSON.stringify(row).length;if(nearRows.length>=limit||nearBytes+size>byteLimit)nearOmitted++;else{nearBytes+=size;nearRows.push(row);}}if(critical){current.ownershipAfter=ownership(pool,'reserve-result',current);emit('reserve-critical',{...current,period:periodState()});}});calendarReceipt.reserve(current);reserve=previous;}};
        const originalTrim=pool.trim;
        pool.trim=function(...args){let result,complete=false;try{result=originalTrim.apply(this,args);complete=true;return result;}finally{calendarReceipt.trim(reserve,result,complete);}};
        const originalRequest=pool.request;
        pool.request=function(member,flight,start,cancel){observe(()=>emit('queue-request',{memberId:owner(member),flightId:id(flight)}));return originalRequest.call(this,member,flight,function(...args){const previous=admitting;admitting=flight;try{return start.apply(this,args);}finally{admitting=previous;}},cancel);};
        const originalRegister=pool.register;
        pool.register=function(member){const result=originalRegister.call(this,member);observe(()=>{
          const chart=member.grids instanceof Map,period=member.transport&&member.retained instanceof Map&&member.valueCache instanceof Map;
          const record={value:member,id:id(member),kind:chart?'chart':period?'period':'unknown',scope:member.scope==='quota'?'quota':member.scope==='budget'?'budget':null};members.push(record);
          emit('register',{memberId:record.id,member:{kind:record.kind},scope:record.scope,ordinal:members.length});
          if(period&&member.calendar)calendarReceipt.attach(member,pool);
          if(period&&typeof member.retainCurrent==='function'){
            const originalRetain=member.retainCurrent;
            member.retainCurrent=function(...args){const captured=observe(()=>graph(this)),before=observe(()=>this.retained instanceof Map?new Set(this.retained.values()):null);const result=originalRetain.apply(this,args);observe(()=>{for(const entry of this.retained.values())if(before&&!before.has(entry)&&!retainedOwnership.has(entry))retainedOwnership.set(entry,captured?keepGraph(captured):null);});return result;};
          }
          if(period&&typeof member.transport.read==='function'){
            const originalTransportRead=member.transport.read;
            member.transport.read=function(scope,...args){const chart=reading,before=observe(()=>this===member.transport&&Array.isArray(this.queue)?new Set(this.queue):null);observe(()=>{
              if(!reading)return;
              const expected=chart.record.scope==='quota'?'quota':members.indexOf(chart.record)===3?'funds':'budget';
              const valid=this===member.transport&&members[0]===record&&scope===expected;
              chart.record.bindingMismatch=chart.record.bindingMismatch===true||!valid;
              if(valid){chart.record.transportBound=true;chart.record.transportScope=expected;const readOwner=args[2];if(readOwner&&typeof readOwner==='object'){if(readOwners.has(readOwner)){readOwners.set(readOwner,null);errors++;}else readOwners.set(readOwner,chart);}}
            });const result=originalTransportRead.call(this,scope,...args);observe(()=>{
              if(!chart||!before)return;
              const added=this.queue.filter(demand=>!before.has(demand));
              if(added.length!==1||added[0].scope!==scope||added[0].query!==args[0]||added[0].signal!==args[1]){if(!args[1]?.aborted)bindingMissing++;return;}
              demandBindings.set(added[0],{chart:chart.record,chartMemberId:chart.record.id,readId:chart.readId,query:args[0],signal:args[1]});
            });return result;};
          }
          if(period&&typeof member.transport.send==='function'){
            record.sendObserved=true;
            const originalSend=member.transport.send;
            member.transport.send=function(board,body,signal,...args){
              const previous=sending,current=observe(()=>{const matches=[...this.flights].filter(value=>value.controller.signal===signal);if(this!==member.transport||matches.length!==1){bindingMissing++;return null;}const value=matches[0];return{memberId:record.id,flightId:id(value),signalId:id(signal),intent:intent(value.intent),request:request(body),board,bodyText:JSON.stringify(body)};});
              sending=current;observe(()=>emit('transport-send',current?{memberId:current.memberId,flightId:current.flightId,signalId:current.signalId,intent:current.intent,request:current.request}:{memberId:record.id,flightId:null}));
              try{return originalSend.call(this,board,body,signal,...args);}finally{sending=previous;}
            };
          }
          const originalCandidates=member.evictionCandidates;
          member.evictionCandidates=function(...args){const candidates=originalCandidates.apply(this,args);for(const candidate of candidates){const originalDrop=candidate.drop;candidate.drop=function(...args){const before=observe(()=>retained(member));observe(()=>{if(reserve)reserve.drops++;emit('drop-before',{memberId:record.id,reserveId:reserve?.reserveId??null,bytes:n(candidate.bytes),shownAt:n(candidate.shownAt),active:typeof member.active==='boolean'?member.active:null,target:targets.get(member)??null,interest:interest(member),retainedCount:before?.total??null,retainedOmitted:before?.omitted??null,ownership:ownership(pool,'drop-before',reserve)});});let complete=false;try{const result=originalDrop.apply(this,args);complete=true;return result;}finally{observe(()=>{const after=retained(member),kept=new Set(after.values.map(v=>v.entry));emit('drop-after',{memberId:record.id,reserveId:reserve?.reserveId??null,complete,removed:before?.values.filter(v=>!kept.has(v.entry)).map(v=>v.row)??null,retainedCount:after.total,retainedOmitted:after.omitted,ownership:ownership(pool,'drop-after',reserve)});});}};}return candidates;};
          if(chart){
            for(const name of ['target','plotTarget']){const original=member[name];member[name]=function(...args){const result=original.apply(this,args);observe(()=>targets.set(member,{kind:name,cell:n(result.cell),from:n(result.k0*result.cell),to:n((result.k1+1)*result.cell)}));return result;};}
            const originalBad=member.bad;
            member.bad=function(target){const result=originalBad.call(this,target);if(result.length)observe(()=>emit('first-bad',{memberId:record.id,cell:n(target.cell),from:n(target.k0*target.cell),to:n((target.k1+1)*target.cell),first:n(result[0]),missing:result.length,interest:interest(member)}));return result;};
            const originalRead=member.env.read;
            member.env.read=function(board,cell,from,to,...args){const readId=++readSerial;observe(()=>{const state=retained(member,{cell,from,to});emit('read',{readId,memberId:record.id,cell:n(cell),from:n(from),to:n(to),interest:interest(member),retained:state.values.map(v=>v.row),retainedOmitted:state.omitted});});const previous=reading;reading={record,readId};try{return originalRead.call(this,board,cell,from,to,...args);}finally{reading=previous;}};
            for(const name of member.scope==='budget'?['invalidate','news','abort','merge','releaseResponse']:['releaseResponse']){
              const original=member[name];if(typeof original!=='function')continue;
              member[name]=function(...args){
                const value=name==='invalidate'||name==='news'?null:args[0],range=value?{cell:value.cell,from:value.from,to:value.to}:undefined;
                const capture=()=>{const state=retained(member,range);return{epoch:n(member.epoch),newsSeq:n(member.newsSeq),flight:value?flight(value):null,response:value?member.responses.has(value):null,tiles:state.values.map(v=>v.row),retainedOmitted:state.omitted};};
                const before=observe(capture),wasAborting=value&&aborting.has(value);if(name==='abort'&&value&&typeof value==='object')aborting.add(value);let complete=false;
                if(name==='releaseResponse'&&before)observe(()=>emit('response-release',{memberId:record.id,flightId:id(value),seq:n(value.seq),epoch:n(value.epoch),memberEpoch:before.epoch,activityOnly:typeof value.activityOnly==='boolean'?value.activityOnly:null,responsePresent:before.response,retained:before.tiles,retainedOmitted:before.retainedOmitted}));
                try{const result=original.apply(this,args);complete=true;return result;}finally{
                  if(member.scope==='budget')observe(()=>{const after=capture();emit('budget-'+name,{memberId:record.id,complete,since:name==='news'?n(args[0]):null,aborting:!!value&&aborting.has(value),committedTileIds:value?after.tiles.filter(tile=>tile[15]===value.seq).map(tile=>tile[1]):[],before,after});});
                  if(name==='abort'&&value&&!wasAborting)aborting.delete(value);
                }
              };
            }
          }
        });return result;};
      });
    };
    const originalFetch=window.fetch.bind(window);
    window.fetch=function(resource,init){observe(()=>{
      const uri=resource instanceof Request?resource.url:String(resource),path=new URL(uri,location.href).pathname;if(!/^\\/api\\/boards\\/[^/]+\\/period(?:\\/sessions)?$/.test(path))return;
      const header=new Headers(init?.headers??(resource instanceof Request?resource.headers:undefined)).get('x-quotum-bench-attempt'),attemptId=header&&/^b\\d+:\\d+$/.test(header)?header:null;
      if(!attemptId)sendingUnknown++;
      const integer=value=>{const parsed=typeof value==='string'&&/^-?\\d+$/.test(value)?Number(value):value;return Number.isSafeInteger(parsed)?parsed:null;};
      // fetchPeriod calls fetch synchronously after pruning demands and marking their owners started.
      const admittedOwner=sharedPool?.active.get(admitting)?.owner,period=members[0];
      const bound=!!sending&&path==='/api/boards/'+encodeURIComponent(sending.board)+'/period'&&init?.body===sending.bodyText;
      if((sending||path.endsWith('/period')&&members.some(member=>member.sendObserved))&&!bound||bound&&!attemptId)bindingMissing++;
      const sender=null;
      const demands=period?.kind==='period'&&sharedPool.members.has(period.value)&&admittedOwner===period.value.transport&&Array.isArray(admitting?.demands)?admitting.demands.map(demand=>{const binding=readOwners.get(demand.owner)??(demand.owner?null:(()=>{const known=demandBindings.get(demand);return known?{record:known.chart,readId:known.readId}:null;})()),scope=['quota','budget','funds'].includes(demand.scope)?demand.scope:null,query=demand.query,cell=integer(query?.cell),from=integer(query?.from),to=integer(query?.to);if(!binding||!scope||cell===null||from===null||to===null)sendingUnknown++;return{memberId:binding?.record.id??null,readId:binding?.readId??null,scope,cell,from,to};}):null;
      if(!demands)sendingUnknown++;
      const charts=members.filter(m=>m.kind==='chart').map(m=>{const state=retained(m.value);return{memberId:m.id,interest:interest(m.value),lastProductionTarget:targets.get(m.value)??null,retained:state.values.map(v=>v.row),retainedOmitted:state.omitted};});
      emit('http',{attemptId,flightId:bound?sending.flightId:id(admitting),memberId:bound?sending.memberId:null,bound,intent:bound?sending.intent:null,request:bound?sending.request:null,extras:typeof admitting?.extras==='boolean'?admitting.extras:null,sender,demands,charts,sendingUnknown});
    });return originalFetch(resource,init);};
  })()`;
}
