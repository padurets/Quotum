import type {Cdp} from './cdp';
import type {Evidence} from './evidence';
import {deadline} from './deadline';

/** Owned history pages retain only pressure witnesses, without inter-gesture checkpoints. */
export function historyPressureScript(){
  return `(() => {
    const limit=64,byteLimit=65536,memberLimit=16,tileLimit=128,rows=[],members=[],ids=new WeakMap(),records=new WeakMap(),bindings=new WeakMap();
    let serial=0,next=0,current=null,currentBytes=null,currentId=null,pressured=false,reading=null,pool=null,attached=false,pressure=false,saturated=false,bytes=0,omitted=0,errors=0,bindingErrors=0;
    const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
    const id=v=>v&&typeof v==='object'?(ids.has(v)?ids.get(v):(ids.set(v,++next),next)):null;
    const scope=v=>v==='quota'?0:v==='budget'?1:v==='funds'?2:null;
    const observe=run=>{try{return run();}catch{errors++;return null;}};
    const emit=(kind,data)=>observe(()=>{
      if(saturated||rows.length===limit){saturated=true;omitted++;return;}
      const row={kind,at:performance.now(),wallAt:Date.now(),...data},size=JSON.stringify(row).length;
      if(bytes+size>byteLimit){saturated=true;omitted++;return;}bytes+=size;rows.push(row);
    });
    const selected=v=>v?{mode:v.mode==='live'?0:v.mode==='range'?1:null,from:number(v.from),to:number(v.to),periodMs:number(v.periodMs)}:null;
    const bounded=values=>{const result=[];for(const value of values){if(result.length===32){omitted++;break;}result.push(value);}return result;};
    const tiles=member=>{
      const result=[];
      if(member.grids instanceof Map)for(const [cell,map] of member.grids)for(const tile of map.values()){
        if(result.length===tileLimit){omitted++;return result;}
        result.push([id(tile),number(cell),number(tile.from),number(tile.to),number(tile.readFrom),number(tile.readTo),number(tile.nativeFrom),number(tile.nativeTo),number(tile.bytes),number(tile.validTo),number(tile.nativeValidTo),number(tile.writeSeq),number(tile.nativeSeq)]);
      }
      return result;
    };
    const state=record=>record.member?({
      memberId:record.id,memberKind:record.kind,boundScope:record.scope,
      selection:selected(record.member.selection??record.member.selected),interest:selected(record.member.interest),
      native:tiles(record.member),currentBytes:number(record.member.bytes),estimatedBytes:number(record.member.estimatedBytes),epoch:number(record.member.epoch),newsSeq:number(record.member.newsSeq),
      retained:record.member.retained instanceof Map?bounded(record.member.retained.values()).map(v=>[id(v),number(v.bytes),number(v.copyBytes),number(v.at)]):[],
    }):({memberId:record.id,active:false});
    const owner=flight=>{
      const stage=flight?.historyMember?members.find(v=>v.member===flight.historyMember):null;
      if(stage)return{memberId:stage.id,kind:'period-staging',operation:['calendar-projection','values','restore','adoption','retirement'].includes(flight.operation)?flight.operation:null};
      const transport=members.find(v=>v.member?.transport?.flights?.has(flight));
      if(transport)return{memberId:transport.id,kind:'transport',demands:bounded(flight.demands??[]).map(d=>{const memberId=bindings.get(d)??null;if(memberId===null)bindingErrors++;return{memberId,scope:scope(d.scope)};})};
      const admitted=pool.active.get(flight)?.owner,known=admitted?members.find(v=>v.member===admitted||v.member?.transport===admitted):undefined;
      return{memberId:known?.id??null,kind:known?'chart-staging':'unknown'};
    };
    window.__quotumHistoryPressure={
      read:()=>{
        const receipt={status:attached&&members.filter(v=>v.member).length===4&&members.filter(v=>v.member&&v.kind===0).length===1&&members.filter(v=>v.member&&v.kind===1).length===3&&[0,1,2].every(s=>members.some(v=>v.member&&v.kind===1&&v.scope===s))&&!omitted&&!errors&&!bindingErrors?'complete':'insufficient-evidence',attached,limit,byteLimit,memberLimit,tileLimit,bytes,omitted,omissionCountExact:false,errors,bindingErrors,members:members.map(v=>({memberId:v.id,memberKind:v.kind,boundScope:v.scope,active:!!v.member})),rows:rows.slice()};
        while(JSON.stringify(receipt).length>byteLimit&&receipt.rows.length){receipt.bytes-=JSON.stringify(receipt.rows.pop()).length;receipt.omitted++;receipt.status='insufficient-evidence';}
        return receipt;
      },
      request:(attemptId,body)=>{
        if(!pressure)return;if(saturated){omitted++;return;}
        observe(()=>{
          if(typeof attemptId!=='string'||!/^b[0-9]+:[0-9]+$/.test(attemptId)||typeof body!=='string'||body.length>16384){omitted++;return;}
          const value=JSON.parse(body);
          emit('read',{attemptId,selection:selected(value.selection),values:Array.isArray(value.values)?value.values.length:0,sessions:!!value.sessions,calendar:!!value.calendar,
            sections:['quota','budget','funds'].flatMap(key=>value[key]?[{scope:scope(key),from:number(Number(value[key].from)),to:number(Number(value[key].to)),cell:number(Number(value[key].cell)),cells:value[key].cells==='skip'?0:1,evidence:value[key].evidence==='skip'?0:value[key].evidence?1:2}]:[])});
        });
      }
    };
    if(typeof window.__quotumInspectHistoryPool==='function'){errors++;return;}
    window.__quotumInspectHistoryPool=value=>observe(()=>{
      if(attached||!(value.members instanceof Set)||value.members.size)throw Error();
      attached=true;pool=value;
      const originalReserve=pool.reserve;
      pool.reserve=function(flight,amount){
        const previous=current,previousBytes=currentBytes,previousId=currentId,previousPressure=pressured;
        current=flight;currentBytes=amount;currentId=++serial;pressured=false;
        let accepted=null,complete=false;
        try{const result=originalReserve.call(this,flight,amount);accepted=result;complete=true;return result;}
        finally{
          if(pressured){if(saturated)omitted++;else observe(()=>emit('reserve-critical',{reserveId:currentId,flightId:id(flight),owner:owner(flight),bytes:number(amount),accepted,complete}));}
          current=previous;currentBytes=previousBytes;currentId=previousId;pressured=previousPressure;
        }
      };
      const originalRegister=pool.register;
      pool.register=function(member){
        const result=originalRegister.call(this,member);
        observe(()=>{
          const known=records.get(member);if(known){known.member=member;return;}
          if(members.length===memberLimit){omitted++;return;}
          const chart=member.grids instanceof Map,period=member.transport&&member.retained instanceof Map&&member.valueCache instanceof Map;
          const record={member,id:id(member),kind:chart?1:period?0:null,scope:null};members.push(record);records.set(member,record);
          if(record.kind===null)errors++;
          if(period&&typeof member.transport.read==='function'){
            const read=member.transport.read;
            member.transport.read=function(key,query,signal,...args){
              const chart=reading,before=chart&&Array.isArray(this.queue)?new Set(this.queue):null;
              const result=read.call(this,key,query,signal,...args);
              if(chart&&before)observe(()=>{
                const added=this.queue.filter(v=>!before.has(v)),code=scope(key);
                if(code===null||added.length!==1||added[0].scope!==key||added[0].query!==query||added[0].signal!==signal||chart.scope!==null&&chart.scope!==code){if(!signal?.aborted)bindingErrors++;return;}
                chart.scope=code;bindings.set(added[0],chart.id);
              });
              return result;
            };
          }
          if(chart&&typeof member.env?.read==='function'){
            const read=member.env.read;
            member.env.read=function(...args){const previous=reading;reading=record;try{return read.apply(this,args);}finally{reading=previous;}};
          }
          const candidates=member.evictionCandidates;
          member.evictionCandidates=function(...args){
            const result=candidates.apply(this,args);
            if(saturated){pressure=true;pressured=true;omitted++;return result;}
            observe(()=>{pressure=true;pressured=true;
            if(currentId===null)emit('charge-pressure',{reserveId:null,memberId:record.id});
            let wrapped=0;
            for(const candidate of result){
              if(wrapped++===tileLimit){omitted++;break;}
              const drop=candidate.drop;
              candidate.drop=function(...args){
                if(saturated){omitted++;return drop.apply(this,args);}
                const before=observe(()=>tiles(member));
                observe(()=>emit('drop-before',{reserveId:currentId,flightId:id(current),owner:owner(current),bytes:number(currentBytes),candidateBytes:number(candidate.bytes),shownAt:number(candidate.shownAt),budget:number(pool.budget),members:members.map(state),reservations:bounded(pool.reservations).map(([flight,bytes])=>({flightId:id(flight),bytes:number(bytes),owner:owner(flight)}))}));
                let complete=false;
                try{const result=drop.apply(this,args);complete=true;return result;}
                finally{observe(()=>{const after=tiles(member),kept=new Set(after.map(v=>v[0]));emit('drop-after',{reserveId:currentId,memberId:record.id,complete,removed:(before??[]).filter(v=>!kept.has(v[0])),state:state(record)});});}
              };
            }});
            return result;
          };
        });
        return result;
      };
      const originalUnregister=pool.unregister;
      pool.unregister=function(member){const result=originalUnregister.call(this,member);observe(()=>{for(const record of members)if(record.member===member)record.member=null;});return result;};
    });
  })()`;
}

/** A known warm assertion stays primary even when its responsive page cannot export. */
export async function saveHistoryPressure(cdp:Pick<Cdp,'evaluate'>,evidence:Pick<Evidence,'save'>|undefined,name:string,signal?:AbortSignal){
  if(!evidence)return;
  let receipt:unknown;
  try{receipt=await deadline(2000,pending=>cdp.evaluate('window.__quotumHistoryPressure?.read()??{status:"insufficient-evidence"}',pending),signal);}
  catch{receipt={status:'insufficient-evidence'};}
  try{evidence.save('pressure-'+name,receipt);}catch{/* Preserve the original warm failure. */}
}
