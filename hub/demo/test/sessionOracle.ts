import {boards,cards,isOn,machines,personOf,sessionsAt,awake,workSince,MIN,type DemoSet} from '../model.js';

/** The fixture's complete member cohort, including the last awake report still confirmed. */
export function currentCohort(set:DemoSet,boardId:string,now:number) {
  const board=boards(set).find(board=>board.id===boardId),members=new Set(board?[board.owner,...board.members]:[boardId]),counts:Record<string,number>={};
  for(const machine of machines(set)){
    if(!members.has(personOf(set,machine)))continue;
    let report=Math.floor((now-15_000)/15_000)*15_000;
    while(report>=now-5*MIN&&!awake(machine,report))report-=15_000;
    if(report<now-5*MIN)continue;
    const count=sessionsAt(set,machine,0,report).length;
    if(count)counts[machine.renamed??machine.id]=count;
  }
  return counts;
}

/** Independent minute fixture integration; sums and union are kept separately. */
export function capturedCohort(set:DemoSet,boardId:string,period:number) {
  const board=boards(set).find(board=>board.id===boardId),members=new Set(board?[board.owner,...board.members]:[boardId]);
  const machineMap=new Map(machines(set).map(machine=>[machine.id,machine]));
  const all=new Set<number>(),byDevice:Record<string,number>={},bySource:Record<string,number>={};let agentMs=0,agents=0;
  for(const card of cards(set))for(const agent of card.agents??[]){
    const machine=machineMap.get(agent.machine)!,owner=personOf(set,machine);if(!members.has(owner)||!agent.works)continue;
    const from=Math.max(workSince(set),-period,agent.since,board?.joined?.[owner]??workSince(set)),to=Math.min(0,agent.until??0);
    let credit=0;
    for(let at=Math.ceil(from/MIN)*MIN;at<to;at+=MIN)if(awake(machine,at)&&isOn(agent.works,at)){credit+=MIN;all.add(at);}
    if(!credit)continue;
    agentMs+=credit;agents++;
    const device=machine.renamed??machine.id,source=!board||card.on?.[boardId]?card.id:'notProvided';
    byDevice[device]=(byDevice[device]??0)+credit;bySource[source]=(bySource[source]??0)+credit;
  }
  return {agentMs,activeMs:all.size*MIN,agents,byDevice,bySource};
}
