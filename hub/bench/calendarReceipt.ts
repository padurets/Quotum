/** Delegating observations installed before the period reader's first calendar configuration. */
export function calendarReceiptScript() {
  return `
    const calendarReceipt=(()=>{
      const rows=[],stack=[],identities=new Map(),calls={},noops={},limit=4096,byteLimit=2097152,rowByteLimit=byteLimit-65536,entryLimit=128;
      let attached=false,early=false,sequence=0,serial=0,bytes=0,omitted=0,errors=0,snapshotOmitted=0,lastMark=null,calendar=null,pool=null,lastDemand=null,encoder=null;
      const byteSize=text=>(encoder??=new TextEncoder()).encode(text).length;
      const number=value=>typeof value!=='number'?null:Number.isFinite(value)?value:String(value);
      const identity=value=>{if(value===undefined||value===null)return null;if(!identities.has(value)){if(identities.size>=1024){errors++;return null;}identities.set(value,identities.size+1);}return identities.get(value);};
      const safe=run=>{try{return run();}catch{errors++;return null;}};
      const emit=(kind,value)=>{const row={sequence:++sequence,at:performance.now(),kind,...value},size=byteSize(JSON.stringify(row));if(rows.length>=limit||bytes+size>rowByteLimit){omitted++;return;}bytes+=size;rows.push(row);};
      const range=value=>value?{from:number(value.from),to:number(value.to)}:null;
      const selection=value=>value?{mode:value.mode,periodMs:number(value.periodMs),...range(value)}:null;
      const basis=value=>value?{run:identity(value.run),revision:identity(value.revision),revisionValue:typeof value.revision==='string'&&/^[0-9]{1,20}$/.test(value.revision)?value.revision:null,filter:identity(value.filterKey),authority:identity(value.workAuthority),calendar:identity(value.calendarKey),range:range(value.range),evaluatedAt:number(value.evaluatedAt),evidenceCut:number(value.evidenceCut)}:null;
      const window=value=>value?{zone:value.zone,range:range(value.range),edges:value.edges?.length,first:value.edges?.[0],last:value.edges?.at(-1)}:null;
      const entries=()=>{const all=[...calendar.cache.entries];if(all.length>entryLimit)snapshotOmitted+=all.length-entryLimit;return all.slice(0,entryLimit).map(e=>({id:id(e),basis:basis(e.basis),zone:e.zone,from:number(e.from),to:number(e.to),cut:number(e.cut),validBefore:number(e.validBefore),known:number(e.known),retained:number(e.retained),retention:number(e.retention),period:number(e.period),cursor:identity(e.cursor),curve:id(e.curve),bytes:number(e.bytes),at:number(e.at)}));};
      const state=()=>({generation:calendar.generation,context:identity(calendar.context),selection:selection(calendar.selection),visible:calendar.visible,limited:calendar.limited,needed:calendar.needed,state:id(calendar.state),window:window(calendar.state.window),basis:basis(calendar.state.basis),value:calendar.state.value?{cursor:identity(calendar.state.value.cursor),cells:calendar.state.value.cells.length}:null,loading:calendar.state.loading,error:calendar.state.error,entries:entries(),pool:{budget:pool.budget,active:pool.active.size,waiting:pool.waiting.length,reservations:pool.reservations.size}});
      const argsOf=(name,args)=>{
        if(name==='calendar.configure')return{visible:args[0],context:identity(args[1]),now:number(args[2]),limited:args[3],selection:selection(args[4])};
        if(name==='cache.read')return{window:window(args[0]),selection:selection(args[1]),now:number(args[2])};
        if(name==='cache.add')return{basis:basis(args[0]),zone:args[1]?.zone,cells:args[1]?.cells?.length,proof:args[1]?.proof?{period:number(args[1].proof.periodMs),retention:number(args[1].proof.retentionMs)}:null,staging:number(args[3])};
        if(name==='calendar.receive')return{state:args[0]?.state,basis:basis(args[0]?.basis),generation:args[1]};
        if(name==='calendar.dirty'||name==='cache.invalidate')return{since:number(args[0]),argumentCount:args.length};
        if(name==='calendar.tick')return{now:number(args[0]),checkZone:args[1]};
        if(name==='calendar.clear')return{retainContext:args[0]};
        return{};
      };
      const resultOf=(name,value)=>name==='cache.read'?{hit:value!==null,basis:basis(value?.basis),window:window(value?.window)}:name==='calendar.demand'?value?{zone:value.zone,cursor:identity(value.cursor)}:null:typeof value==='boolean'?value:null;
      const invoke=(name,original,receiver,args)=>{
        const call={id:++serial,parent:stack.at(-1)?.id??null,startSequence:++sequence,startedAt:performance.now(),before:safe(state),args:safe(()=>argsOf(name,args)),reserves:{calls:0,accepted:0,rejected:0,peak:null,first:null,last:null}};
        calls[name]=(calls[name]??0)+1;stack.push(call);let value,complete=false;
        try{value=original.apply(receiver,args);complete=true;return value;}
        finally{
          stack.pop();safe(()=>{
            const after=state(),result=complete?resultOf(name,value):null,unchanged=JSON.stringify(call.before)===JSON.stringify(after);
            const noop=complete&&unchanged&&(name==='calendar.configure'&&value===false||name==='calendar.tick'&&value===false||name==='calendar.demand'&&JSON.stringify(result)===lastDemand);
            if(name==='calendar.demand')lastDemand=JSON.stringify(result);
            if(noop){const row=noops[name]??={calls:0,first:call.startSequence,last:call.startSequence};row.calls++;row.last=call.startSequence;return;}
            emit(name,{...call,complete,result,after,finishedAt:performance.now()});
          });
        }
      };
      const wrap=(target,key,name)=>{const original=target[key];if(typeof original!=='function'){errors++;return;}target[key]=function(...args){return invoke(name,original,this,args);};};
      const receipt={
        attach(member,shared){safe(()=>{
          if(attached){errors++;return;}calendar=member.calendar;pool=shared;
          if(!calendar||!(calendar.cache?.entries instanceof Set)){errors++;return;}
          attached=true;early=calendar.context===''&&!calendar.visible&&calendar.cache.entries.size===0;
          emit('calendar.attach',{early,state:state()});
          for(const key of ['configure','dirty','receive','demand','tick','clear'])wrap(calendar,key,'calendar.'+key);
          for(const key of ['read','add','invalidate','clear'])wrap(calendar.cache,key,'cache.'+key);
          const original=calendar.cache.evictionCandidates;
          calendar.cache.evictionCandidates=function(...args){const values=original.apply(this,args);for(const value of values){const drop=value.drop;value.drop=function(...args){return invoke('cache.drop',drop,this,args);};}return values;};
        });},
        reserve(value){safe(()=>{
          if(!stack.length)return;
          const row={reserveId:value.reserveId,flightId:value.flightId,bytes:value.bytes,previous:value.previous,peakCharge:value.charge,lastCharge:value.lastCharge,drops:value.drops,accepted:value.accepted,complete:value.complete};
          for(const call of stack){const r=call.reserves;r.calls++;r.accepted+=value.accepted===true?1:0;r.rejected+=value.accepted===false?1:0;r.peak=value.charge===null?r.peak:Math.max(r.peak??0,value.charge);r.first??=row;r.last=row;}
          if(!value.complete||!value.accepted||value.drops||value.charge>pool.budget)emit('pool.reserve',{callId:stack.at(-1).id,...row});
        });},
        trim(value,result,complete){safe(()=>{if(attached&&(!complete||result===false||value?.drops||value?.charge>pool.budget))emit('pool.trim',{callId:stack.at(-1)?.id??null,reserveId:value?.reserveId??null,result,complete,peakCharge:value?.charge??null,lastCharge:value?.lastCharge??null,drops:value?.drops??null});});},
        mark(phase,step){safe(()=>{if(!attached||lastMark===phase+':'+step)return;lastMark=phase+':'+step;emit('calendar.checkpoint',{phase,step,state:state()});});},
        read(){
          const final=safe(()=>attached?state():null),value={status:attached&&early&&lastMark==='2:3'&&!omitted&&!errors&&!snapshotOmitted?'complete':'insufficient-evidence',mode:'diagnostic',attached,early,scenarioComplete:lastMark==='2:3',limit,byteLimit,rowByteLimit,entryLimit,rowBytes:bytes,omitted,errors,snapshotOmitted,calls,noops,rows,final};
          const size=byteSize(JSON.stringify(value));
          return size<=byteLimit?value:{status:'insufficient-evidence',mode:'diagnostic',reason:'receipt size',originalBytes:size,byteLimit,attached,early,omitted:omitted+rows.length,errors,snapshotOmitted,rows:[],final:null};
        }
      };
      return receipt;
    })();
    window.__quotumCalendarReceipt=calendarReceipt;
  `;
}
