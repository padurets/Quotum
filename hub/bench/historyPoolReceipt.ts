/** One opt-in page observes existing pool operations; it never supplies scheduling or retention decisions. */
export function historyPoolReceiptScript() {
  return `(() => {
    const limit=4096,tileLimit=1024,byteLimit=262144,summaryLimit=512,entries=[],nearRows=[],members=[],ids=new WeakMap(),targets=new WeakMap(),summaries=new Map();let nextId=0,count=0,bytes=0,nearBytes=0,nearOmitted=0,omitted=0,errors=0,snapshotOmitted=0,summaryOmitted=0,reserveSerial=0,reserve=null,attached=false,lastMark=null,chargeCalls=0,peakCharge=null,reading=null;
    const id=value=>value&&typeof value==='object'?(ids.has(value)?ids.get(value):(ids.set(value,++nextId),nextId)):null;
    const n=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
    const interest=member=>{const p=member.interest;return p?[n(p.token),n(p.length),n(p.from),n(p.to),n(p.direction)]:null;};
    const emit=(kind,values)=>{count++;if(entries.length>=limit){omitted++;return;}const entry={id:count,at:performance.now(),kind,...values},size=JSON.stringify(entry).length;if(bytes+size>byteLimit){omitted++;return;}bytes+=size;entries.push(entry);};
    const observe=run=>{try{return run();}catch{errors++;return null;}};
    const owner=value=>members.find(m=>m.value===value)?.id??members.find(m=>m.value.transport===value)?.id??null;
    const reservationOwner=(pool,flight)=>{const admitted=pool.active.get(flight)?.owner,known=admitted?members.find(m=>m.value===admitted||m.value.transport===admitted):null;if(known)return{memberId:known.id,kind:known.value.transport===admitted?'transport':known.kind};const chart=members.find(m=>m.kind==='chart'&&(m.value.flights.has(flight)||m.value.responses.has(flight)||[...m.value.reservations.values()].includes(flight)));return{memberId:chart?.id??null,kind:chart?'chart-staging':'unknown'};};
    const retained=(member,range)=>{
      const values=[];let total=0;
      const add=(entry,row)=>{total++;if(values.length<tileLimit)values.push({entry,row});else snapshotOmitted++;};
      if(member.grids instanceof Map)for(const [cell,tiles]of member.grids)for(const [index,tile]of tiles){if(range&&(cell!==range.cell||tile.to<=range.from||tile.from>=range.to))continue;add(tile,[0,id(tile),n(cell),n(index),n(tile.from),n(tile.to),n(tile.readFrom),n(tile.readTo),n(tile.validTo),n(tile.bytes),n(tile.shownAt),member.reservations.has(cell+':'+index)]);}
      else for(const [code,map]of [[1,member.valueCache],[2,member.retained]])if(map instanceof Map)for(const entry of map.values())add(entry,[code,id(entry),null,null,null,null,null,null,n(entry.bytes),n(entry.at)]);
      return {values,total,omitted:Math.max(0,total-values.length)};
    };
    window.__quotumHistoryPoolReceipt={mark:(phase,step)=>observe(()=>{if(lastMark===phase+':'+step)return;lastMark=phase+':'+step;emit('checkpoint',{phase,step,members:members.map(m=>{const state=retained(m.value);return{memberId:m.id,target:targets.get(m.value)??null,interest:interest(m.value),retainedIds:state.values.map(v=>v.row[1]),retainedCount:state.total,retainedOmitted:state.omitted};})});}),read:()=>{const final=observe(()=>members.map(m=>{const state=retained(m.value);return{memberId:m.id,currentBytes:n(m.value.bytes),target:targets.get(m.value)??null,interest:interest(m.value),retained:state.values.map(v=>v.row),retainedOmitted:state.omitted};}));const order=members.length===4&&members[0].kind==='period'&&members.slice(1).every(m=>m.kind==='chart'&&m.transportBound===true&&!m.bindingMismatch)&&members[1].scope==='quota'&&members[2].scope==='budget'&&members[3].scope==='budget';const receipt={status:attached&&order&&lastMark==='2:3'&&!omitted&&!errors&&!snapshotOmitted&&!summaryOmitted&&!nearOmitted?'complete':'insufficient-evidence',attached,registrationOrderQualified:order,members:members.map((m,i)=>({id:m.id,ordinal:i+1,kind:m.kind,scope:m.scope,transportBound:m.transportBound===true,transportScope:m.transportScope??null,bindingMismatch:m.bindingMismatch===true})),count,bytes,omitted,errors,snapshotOmitted,summaryOmitted,nearBytes,nearOmitted,limit,byteLimit,tileLimit,summaryLimit,nearBudgetRatio:.95,reserveCalls:reserveSerial,chargeCalls,peakCharge,ordinaryByFlight:[...summaries.values()],nearRows,entries,final,lastCheckpoint:lastMark==='2:3'};const size=JSON.stringify(receipt).length;if(size>900000)return{status:'insufficient-evidence',reason:'receipt size',originalBytes:size,attached,count,bytes,nearBytes,omitted,nearOmitted,errors,snapshotOmitted,summaryOmitted,omittedDetailedSummaries:summaries.size,omittedFinal:true,ordinaryCountsByFlight:[...summaries.values()].map(s=>[s.flightId,s.calls,s.ordinaryAccepted,s.nearBudgetCalls]),entries,nearRows};return receipt;}};
    window.__quotumInspectHistoryPool=pool=>{
      if(attached){errors++;return;}attached=true;
      observe(()=>{
        if(!(pool.members instanceof Set)||pool.members.size!==0)throw Error();
        const charge=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pool),'estimatedBytes');
        if(!charge?.get)throw Error();
        Object.defineProperty(pool,'estimatedBytes',{get(){const value=charge.get.call(this);observe(()=>{chargeCalls++;peakCharge=peakCharge===null?value:Math.max(peakCharge,value);if(reserve)reserve.charge=reserve.charge===null?value:Math.max(reserve.charge,value);else if(value>pool.budget)emit('charge-pressure',{bytes:n(value),budget:n(pool.budget)});});return value;}});
        const originalReserve=pool.reserve;
        pool.reserve=function(flight,bytes){const previous=reserve,current={reserveId:++reserveSerial,flightId:null,owner:null,bytes:n(bytes),previous:null,charge:null,drops:0,accepted:null,complete:false};observe(()=>{current.flightId=id(flight);current.owner=reservationOwner(pool,flight);current.previous=n(pool.reservations.get(flight)??0);});reserve=current;try{const result=originalReserve.call(this,flight,bytes);current.accepted=result;current.complete=true;return result;}finally{observe(()=>{let summary=summaries.get(current.flightId);if(!summary){if(summaries.size>=summaryLimit)summaryOmitted++;else{summary={flightId:current.flightId,owner:current.owner,calls:0,ordinaryAccepted:0,nearBudgetCalls:0,first:current,peak:current,last:current};summaries.set(current.flightId,summary);}}const near=current.charge!==null&&current.charge>=pool.budget*.95,critical=!current.complete||!current.accepted||current.drops>0||current.charge>pool.budget;if(summary){summary.calls++;summary.ordinaryAccepted+=!critical&&!near?1:0;summary.nearBudgetCalls+=near?1:0;if((current.charge??-Infinity)>(summary.peak.charge??-Infinity))summary.peak=current;summary.last=current;if(near&&!summary.firstNear)summary.firstNear=current;}if(near){const row=[current.reserveId,current.flightId,current.bytes,current.previous,current.charge,current.accepted],size=JSON.stringify(row).length;if(nearRows.length>=limit||nearBytes+size>byteLimit)nearOmitted++;else{nearBytes+=size;nearRows.push(row);}}if(critical)emit('reserve-critical',current);});reserve=previous;}};
        const originalRequest=pool.request;
        pool.request=function(member,flight,start,cancel){observe(()=>emit('queue-request',{memberId:owner(member),flightId:id(flight)}));return originalRequest.call(this,member,flight,start,cancel);};
        const originalRegister=pool.register;
        pool.register=function(member){const result=originalRegister.call(this,member);observe(()=>{
          const chart=member.grids instanceof Map,period=member.transport&&member.retained instanceof Map&&member.valueCache instanceof Map;
          const record={value:member,id:id(member),kind:chart?'chart':period?'period':'unknown',scope:member.scope==='quota'?'quota':member.scope==='budget'?'budget':null};members.push(record);
          emit('register',{memberId:record.id,member:{kind:record.kind},scope:record.scope,ordinal:members.length});
          if(period&&typeof member.transport.read==='function'){
            const originalTransportRead=member.transport.read;
            member.transport.read=function(scope,...args){observe(()=>{
              if(!reading)return;
              const chart=reading,expected=chart.scope==='quota'?'quota':members.indexOf(chart)===3?'funds':'budget';
              const valid=this===member.transport&&members[0]===record&&scope===expected;
              chart.bindingMismatch=chart.bindingMismatch===true||!valid;
              if(valid){chart.transportBound=true;chart.transportScope=expected;}
            });return originalTransportRead.call(this,scope,...args);};
          }
          const originalCandidates=member.evictionCandidates;
          member.evictionCandidates=function(...args){const candidates=originalCandidates.apply(this,args);for(const candidate of candidates){const originalDrop=candidate.drop;candidate.drop=function(...args){const before=observe(()=>retained(member));observe(()=>{if(reserve)reserve.drops++;emit('drop-before',{memberId:record.id,reserveId:reserve?.reserveId??null,bytes:n(candidate.bytes),shownAt:n(candidate.shownAt),active:typeof member.active==='boolean'?member.active:null,target:targets.get(member)??null,interest:interest(member),retainedCount:before?.total??null,retainedOmitted:before?.omitted??null});});let complete=false;try{const result=originalDrop.apply(this,args);complete=true;return result;}finally{observe(()=>{const after=retained(member),kept=new Set(after.values.map(v=>v.entry));emit('drop-after',{memberId:record.id,reserveId:reserve?.reserveId??null,complete,removed:before?.values.filter(v=>!kept.has(v.entry)).map(v=>v.row)??null,retainedCount:after.total,retainedOmitted:after.omitted});});}};}return candidates;};
          if(chart){
            for(const name of ['target','plotTarget']){const original=member[name];member[name]=function(...args){const result=original.apply(this,args);observe(()=>targets.set(member,{kind:name,cell:n(result.cell),from:n(result.k0*result.cell),to:n((result.k1+1)*result.cell)}));return result;};}
            const originalBad=member.bad;
            member.bad=function(target){const result=originalBad.call(this,target);if(result.length)observe(()=>emit('first-bad',{memberId:record.id,cell:n(target.cell),from:n(target.k0*target.cell),to:n((target.k1+1)*target.cell),first:n(result[0]),missing:result.length,interest:interest(member)}));return result;};
            const originalRead=member.env.read;
            member.env.read=function(board,cell,from,to,...args){observe(()=>{const state=retained(member,{cell,from,to});emit('read',{memberId:record.id,cell:n(cell),from:n(from),to:n(to),interest:interest(member),retained:state.values.map(v=>v.row),retainedOmitted:state.omitted});});const previous=reading;reading=record;try{return originalRead.call(this,board,cell,from,to,...args);}finally{reading=previous;}};
          }
        });return result;};
      });
    };
    const originalFetch=window.fetch.bind(window);
    window.fetch=function(resource,init){observe(()=>{const uri=resource instanceof Request?resource.url:String(resource),path=new URL(uri,location.href).pathname;if(!/^\\/api\\/boards\\/[^/]+\\/period(?:\\/sessions)?$/.test(path))return;const attemptId=new Headers(init?.headers??(resource instanceof Request?resource.headers:undefined)).get('x-quotum-bench-attempt');emit('http',{attemptId:attemptId&&/^b\\d+:\\d+$/.test(attemptId)?attemptId:null});});return originalFetch(resource,init);};
  })()`;
}
