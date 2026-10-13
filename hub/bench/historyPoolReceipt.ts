/** One opt-in page observes existing pool operations; it never supplies scheduling or retention decisions. */
export function historyPoolReceiptScript() {
  return `(() => {
    const limit=4096,tileLimit=1024,byteLimit=262144,summaryLimit=512,entries=[],nearRows=[],members=[],ids=new WeakMap(),targets=new WeakMap(),summaries=new Map();let nextId=0,count=0,bytes=0,nearBytes=0,nearOmitted=0,omitted=0,errors=0,snapshotOmitted=0,summaryOmitted=0,reserveSerial=0,reserve=null,attached=false,lastMark=null,chargeCalls=0,peakCharge=null;
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
    window.__quotumHistoryPoolReceipt={mark:(phase,step)=>observe(()=>{if(lastMark===phase+':'+step)return;lastMark=phase+':'+step;emit('checkpoint',{phase,step,members:members.map(m=>{const state=retained(m.value);return{memberId:m.id,target:targets.get(m.value)??null,interest:interest(m.value),retainedIds:state.values.map(v=>v.row[1]),retainedCount:state.total,retainedOmitted:state.omitted};})});}),read:()=>{const final=observe(()=>members.map(m=>{const state=retained(m.value);return{memberId:m.id,currentBytes:n(m.value.bytes),target:targets.get(m.value)??null,interest:interest(m.value),retained:state.values.map(v=>v.row),retainedOmitted:state.omitted};}));const order=members.length===4&&members[0].kind==='period'&&members.slice(1).every(m=>m.kind==='chart'&&m.value.env?.sharedTransport===true)&&members[1].scope==='quota'&&members[2].scope==='budget'&&members[3].scope==='budget';const receipt={status:attached&&order&&lastMark==='2:3'&&!omitted&&!errors&&!snapshotOmitted&&!summaryOmitted&&!nearOmitted?'complete':'insufficient-evidence',attached,registrationOrderQualified:order,members:members.map((m,i)=>({id:m.id,ordinal:i+1,kind:m.kind,scope:m.scope,sharedTransport:m.value.env?.sharedTransport===true})),count,bytes,omitted,errors,snapshotOmitted,summaryOmitted,nearBytes,nearOmitted,limit,byteLimit,tileLimit,summaryLimit,nearBudgetRatio:.95,reserveCalls:reserveSerial,chargeCalls,peakCharge,ordinaryByFlight:[...summaries.values()],nearRows,entries,final,lastCheckpoint:lastMark==='2:3'};const size=JSON.stringify(receipt).length;if(size>900000)return{status:'insufficient-evidence',reason:'receipt size',originalBytes:size,attached,count,bytes,nearBytes,omitted,nearOmitted,errors,snapshotOmitted,summaryOmitted,omittedDetailedSummaries:summaries.size,omittedFinal:true,ordinaryCountsByFlight:[...summaries.values()].map(s=>[s.flightId,s.calls,s.ordinaryAccepted,s.nearBudgetCalls]),entries,nearRows};return receipt;}};
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
          const originalCandidates=member.evictionCandidates;
          member.evictionCandidates=function(...args){const candidates=originalCandidates.apply(this,args);for(const candidate of candidates){const originalDrop=candidate.drop;candidate.drop=function(...args){const before=observe(()=>retained(member));observe(()=>{if(reserve)reserve.drops++;emit('drop-before',{memberId:record.id,reserveId:reserve?.reserveId??null,bytes:n(candidate.bytes),shownAt:n(candidate.shownAt),active:typeof member.active==='boolean'?member.active:null,target:targets.get(member)??null,interest:interest(member),retainedCount:before?.total??null,retainedOmitted:before?.omitted??null});});let complete=false;try{const result=originalDrop.apply(this,args);complete=true;return result;}finally{observe(()=>{const after=retained(member),kept=new Set(after.values.map(v=>v.entry));emit('drop-after',{memberId:record.id,reserveId:reserve?.reserveId??null,complete,removed:before?.values.filter(v=>!kept.has(v.entry)).map(v=>v.row)??null,retainedCount:after.total,retainedOmitted:after.omitted});});}};}return candidates;};
          if(chart){
            for(const name of ['target','plotTarget']){const original=member[name];member[name]=function(...args){const result=original.apply(this,args);observe(()=>targets.set(member,{kind:name,cell:n(result.cell),from:n(result.k0*result.cell),to:n((result.k1+1)*result.cell)}));return result;};}
            const originalBad=member.bad;
            member.bad=function(target){const result=originalBad.call(this,target);if(result.length)observe(()=>emit('first-bad',{memberId:record.id,cell:n(target.cell),from:n(target.k0*target.cell),to:n((target.k1+1)*target.cell),first:n(result[0]),missing:result.length,interest:interest(member)}));return result;};
            const originalRead=member.env.read;
            member.env.read=function(board,cell,from,to,...args){observe(()=>{const state=retained(member,{cell,from,to});emit('read',{memberId:record.id,cell:n(cell),from:n(from),to:n(to),interest:interest(member),retained:state.values.map(v=>v.row),retainedOmitted:state.omitted});});return originalRead.call(this,board,cell,from,to,...args);};
          }
        });return result;};
      });
    };
    const originalFetch=window.fetch.bind(window);
    window.fetch=function(resource,init){observe(()=>{const uri=resource instanceof Request?resource.url:String(resource),path=new URL(uri,location.href).pathname;if(!/^\\/api\\/boards\\/[^/]+\\/period(?:\\/sessions)?$/.test(path))return;const attemptId=new Headers(init?.headers??(resource instanceof Request?resource.headers:undefined)).get('x-quotum-bench-attempt');emit('http',{attemptId:attemptId&&/^b\\d+:\\d+$/.test(attemptId)?attemptId:null});});return originalFetch(resource,init);};
  })()`;
}

/** CPU-prefix diagnostics omit ordinary flights; only pressure, freshness and original checkpoints are observed. */
export function historyPoolCriticalReceiptScript() {
  return `(() => {
    const limit=4096,tileLimit=1024,entryByteLimit=131072,nearByteLimit=262144,tileByteLimit=262144,depthLimit=8;
    const entries=[],nearRows=[],tiles=[],members=[],ids=new WeakMap(),versions=new WeakMap(),contexts=Array.from({length:depthLimit},()=>[0,null,null,null,0,false,null,false]);
    let nextId=0,count=0,entryBytes=0,nearBytes=0,tileBytes=0,nextSnapshot=0,nextVersion=0,omitted=0,nearOmitted=0,tileOmitted=0,errors=0,reserveCalls=0,chargeCalls=0,chargeThrows=0,nearCalls=0,ordinaryCalls=0,ownerLookups=0,depth=0,depthOmitted=0,peakCharge=null,attached=false,ready=false,lastPhase=null,lastStep=null;
    const n=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
    const id=value=>value&&typeof value==='object'?(ids.has(value)?ids.get(value):(ids.set(value,++nextId),nextId)):null;
    const observe=run=>{try{return run();}catch{errors++;return null;}};
    // A JSON number is shorter than 32 bytes. The conservative bound requires no hot-path serialization.
    const emit=(kind,row,values=[])=>{count++;const size=96+32*(row.length+values.length);if(entries.length>=limit||entryBytes+size>entryByteLimit){omitted++;return;}entryBytes+=size;entries.push({id:count,kind,row,values});};
    const interest=member=>{const p=member.interest;return p?[n(p.token),n(p.length),n(p.from),n(p.to),n(p.direction)]:[null,null,null,null,null];};
    const snapshot=(record,range)=>{
      const member=record.ref.deref(),snapshotId=++nextSnapshot,values=[],tileIds=[];let total=0,lost=0;
      if(!member){errors++;return {snapshotId,total:0,lost:0,tileIds};}
      const add=(entry,row)=>{
        total++;const tileId=id(entry);tileIds.push(tileId);let previous=versions.get(entry);
        if(previous&&previous.row.length===row.length&&previous.row.every((value,index)=>value===row[index])){values.push(previous.version);return;}
        const size=96+32*(row.length+4);if(tiles.length>=tileLimit||tileBytes+size>tileByteLimit){tileOmitted++;lost++;values.push(null);return;}
        const version=++nextVersion;tileBytes+=size;tiles.push([version,record.id,tileId,...row]);versions.set(entry,{version,row});values.push(version);
      };
      if(member.grids instanceof Map)for(const [cell,grid]of member.grids)for(const [index,tile]of grid){if(range&&(cell!==range.cell||tile.to<=range.from||tile.from>=range.to))continue;add(tile,[0,n(cell),n(index),n(tile.from),n(tile.to),n(tile.readFrom),n(tile.readTo),n(tile.validTo),n(tile.bytes),n(tile.shownAt),member.reservations.has(cell+':'+index),n(tile.writeSeq)]);}
      else for(const [code,map]of [[1,member.valueCache],[2,member.retained]])if(map instanceof Map)for(const entry of map.values())add(entry,[code,null,null,null,null,null,null,null,n(entry.bytes),n(entry.at),null,null]);
      emit('retained',[snapshotId,record.id,total,lost,...record.target,...interest(member),n(member.epoch),n(member.cutTo),n(member.meta?.now)],values);
      return {snapshotId,total,lost,tileIds};
    };
    const owner=(pool,flight)=>{
      ownerLookups++;const active=pool.active.get(flight)?.owner;
      if(active)for(const record of members){const member=record.ref.deref();if(member&&(member===active||member.transport===active))return [record,member.transport===active?1:2];}
      for(const record of members){const member=record.ref.deref();if(record.kind==='chart'&&member&&(member.flights.has(flight)||member.responses.has(flight)||[...member.reservations.values()].includes(flight)))return [record,3];}
      return [null,0];
    };
    window.__quotumHistoryPoolReceipt={mark:(phase,step)=>observe(()=>{
      if(lastPhase===phase&&lastStep===step)return;lastPhase=phase;lastStep=step;
      const snapshots=members.map(record=>snapshot(record));emit('checkpoint',[phase,step],snapshots.map(state=>state.snapshotId));
    }),read:()=>{
      observe(()=>{const snapshots=members.map(record=>snapshot(record));emit('final',[],snapshots.map(state=>state.snapshotId));});
      const order=members.length===4&&members[0].kind==='period'&&members.slice(1).every(record=>record.kind==='chart'&&record.sharedTransport)&&members[1].scope==='quota'&&members[2].scope==='budget'&&members[3].scope==='budget';
      const receipt={mode:'diagnostic',scope:{kind:'critical-only'},status:attached&&ready&&order&&lastPhase===2&&lastStep===3&&!omitted&&!nearOmitted&&!tileOmitted&&!errors&&!depthOmitted?'critical-scope-complete':'insufficient-evidence',attached,ready,registrationOrderQualified:order,members:members.map((record,index)=>({id:record.id,ordinal:index+1,kind:record.kind,scope:record.scope,sharedTransport:record.sharedTransport})),ordinary:{status:'unobserved',reserveCalls:ordinaryCalls},clock:{status:'unobserved'},reserveCalls,chargeCalls,chargeThrows,nearCalls,peakCharge,ownerLookups,weakIdsCreated:nextId,snapshotCalls:nextSnapshot,depthOmitted,errors,omitted,nearOmitted,tileOmitted,count,entryBytes,nearBytes,tileBytes,limit,tileLimit,entryByteLimit,nearByteLimit,tileByteLimit,depthLimit,nearBudgetRatio:.95,lastPhase,lastStep,lastCheckpoint:lastPhase===2&&lastStep===3,entries,nearRows,tiles};
      const size=JSON.stringify(receipt).length;if(size>900000)return{mode:'diagnostic',scope:{kind:'critical-only'},status:'insufficient-evidence',reason:'receipt size',originalBytes:size,attached,ready,reserveCalls,chargeCalls,chargeThrows,nearCalls,ordinary:{status:'unobserved',reserveCalls:ordinaryCalls},omitted,nearOmitted,tileOmitted,depthOmitted,errors,omittedReceipt:true,lastPhase,lastStep};return receipt;
    }};
    window.__quotumInspectHistoryPool=pool=>{
      if(attached){errors++;return;}attached=true;
      observe(()=>{
        if(!(pool.members instanceof Set)||pool.members.size!==0)throw Error();
        const charge=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pool),'estimatedBytes'),threshold=pool.budget*.95;
        if(!charge?.get)throw Error();
        Object.defineProperty(pool,'estimatedBytes',{get(){
          chargeCalls++;let value;try{value=charge.get.call(this);}catch(error){chargeThrows++;throw error;}
          const current=contexts[depth-1];if(current)current[3]=current[3]===null?value:Math.max(current[3],value);
          if(typeof value==='number'&&Number.isFinite(value)){peakCharge=peakCharge===null?value:Math.max(peakCharge,value);if(value>=threshold){nearCalls++;if(current)current[7]=true;else observe(()=>emit('charge-pressure',[n(value),n(pool.budget),depth]));}}
          return value;
        }});
        const originalReserve=pool.reserve;
        pool.reserve=function(flight,bytes){
          reserveCalls++;const index=depth++,current=contexts[index];if(current){current[0]=reserveCalls;current[1]=flight;current[2]=bytes;current[3]=null;current[4]=0;current[5]=false;current[6]=null;current[7]=false;}else depthOmitted++;
          try{const result=originalReserve.call(this,flight,bytes);if(current){current[5]=true;current[6]=result;}return result;}
          finally{
            if(current){
              if(current[7]||current[4]||!current[5]||current[6]!==true)observe(()=>{
                const [record,kind]=owner(pool,flight),member=record?.ref.deref(),flightId=id(flight),row=[current[0],flightId,n(bytes),n(current[3]),typeof current[6]==='boolean'?current[6]:null,current[5],current[4],record?.id??null,kind,n(pool.reservations.get(flight)??0),...(record?.target??[null,null,null,null]),...(member?interest(member):[null,null,null,null,null])];
                if(current[7]){const size=16+32*row.length;if(nearRows.length>=limit||nearBytes+size>nearByteLimit)nearOmitted++;else{nearBytes+=size;nearRows.push(row);}}
                if(current[4]||!current[5]||current[6]!==true){const snapshots=members.map(value=>snapshot(value));emit('reserve-critical',row,snapshots.map(value=>value.snapshotId));}
              });else ordinaryCalls++;
              current[1]=null;current[2]=current[3]=current[6]=null;
            }
            depth--;
          }
        };
        const originalRegister=pool.register;
        pool.register=function(member){const result=originalRegister.call(this,member);observe(()=>{
          const chart=member.grids instanceof Map,period=member.transport&&member.retained instanceof Map&&member.valueCache instanceof Map;
          const record={ref:new WeakRef(member),id:id(member),kind:chart?'chart':period?'period':'unknown',scope:member.scope==='quota'?'quota':member.scope==='budget'?'budget':null,sharedTransport:member.env?.sharedTransport===true,target:[null,null,null,null]};members.push(record);emit('register',[record.id,members.length]);
          const originalCandidates=member.evictionCandidates;
          member.evictionCandidates=function(...args){const candidates=originalCandidates.apply(this,args);for(const candidate of candidates){const originalDrop=candidate.drop;candidate.drop=function(...args){const current=contexts[depth-1];if(current)current[4]++;let before=null;observe(()=>{before=snapshot(record);emit('drop-before',[record.id,current?.[0]??null,n(candidate.bytes),n(candidate.shownAt),typeof member.active==='boolean'?member.active:null,before.snapshotId,...record.target,...interest(member)]);});let complete=false;try{const value=originalDrop.apply(this,args);complete=true;return value;}finally{observe(()=>{const after=snapshot(record),kept=new Set(after.tileIds);emit('drop-after',[record.id,current?.[0]??null,complete,after.snapshotId],before?.tileIds.filter(value=>!kept.has(value))??[]);});}};}return candidates;};
          if(chart){
            for(const [name,kind]of [['target',1],['plotTarget',2]]){const original=member[name];member[name]=function(...args){const value=original.apply(this,args);try{record.target[0]=kind;record.target[1]=n(value.cell);record.target[2]=n(value.k0*value.cell);record.target[3]=n((value.k1+1)*value.cell);}catch{errors++;}return value;};}
            const originalBad=member.bad;member.bad=function(target){const value=originalBad.call(this,target);if(value.length)observe(()=>{const state=snapshot(record,{cell:target.cell,from:target.k0*target.cell,to:(target.k1+1)*target.cell});emit('first-bad',[record.id,n(target.cell),n(target.k0*target.cell),n((target.k1+1)*target.cell),n(value[0]),value.length,state.snapshotId,...interest(member)]);});return value;};
            const originalRead=member.env.read;member.env.read=function(board,cell,from,to,...args){observe(()=>{const state=snapshot(record,{cell,from,to});emit('read',[record.id,n(cell),n(from),n(to),state.snapshotId,...record.target,...interest(member)]);});return originalRead.call(this,board,cell,from,to,...args);};
          }
        });return result;};
        ready=true;
      });
    };
  })()`;
}
