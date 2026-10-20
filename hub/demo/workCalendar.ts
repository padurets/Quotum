import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import {AGENT_HOURS_HEATMAP,showWidgets} from '../server/domain/widgets.js';
import type {Stand} from './setup.js';
import {boards,DAY,HOUR,MIN} from './model.js';

/** Real retained work feeds both the calendar and its daily analytical drill. */
export function seedCalendar(store:Store,directory:Directory,stand:Stand){
  const owner=stand.people.get('ana')!;
  const device=directory.devices(owner.id)[0];
  const today=Math.floor(stand.start/DAY)*DAY;
  const pace=[.7,1.2,2,.15,.8,1.5,3.2,2.6,.5,1.1,1.8,.9,1.4];
  for(let d=89;d>0;d--){
    const day=today-d*DAY,index=89-d,week=Math.floor(index/7),weekday=(new Date(day).getUTCDay()+6)%7;
    // Quiet stretches, release weeks and light weekends make the whole window readable.
    if((week===3&&weekday<5)||index%17===4||weekday===6&&week%3!==1)continue;
    const base=[.25,2,5,9,14,22,12][(index*3+week)%7];
    const hours=d===20||d===55?84:Math.round(base*pace[week]*(weekday>=5?.2:1)*4)/4;
    const agents=Math.ceil(hours/20);
    for(let agent=0;agent<agents;agent++){
      const from=day+(2+agent*.5)*HOUR,to=from+hours/agents*HOUR;
      store.creditWork(device.id,from,to,[{source:null,client:agent%2?'codex':'opencode',origin:'terminal',project:d>30?'Earlier project':week%3===0?'Docs':'Quotum',folder:'calendar',startedAt:from,identity:{kind:'stable',sessionId:`calendar-${d}-${agent}`}}]);
    }
  }
  // The opening analytical period contains several real retained sessions too.
  for(let agent=0;agent<3;agent++){
    const from=stand.start-(6-agent)*HOUR,to=stand.start-agent*30*MIN;
    store.creditWork(device.id,from,to,[{source:null,client:agent===1?'codex':'opencode',origin:'terminal',project:agent===2?'Docs':'Quotum',folder:'calendar',startedAt:from,identity:{kind:'stable',sessionId:`calendar-recent-${agent}`}}]);
  }
  // A short concurrent burst crosses a date boundary independently of other rows.
  const midnight=today-2*DAY;
  for(const [i,before,after] of [[0,30,30],[1,15,15]])store.creditWork(device.id,midnight-before*MIN,midnight+after*MIN,[{source:null,client:'opencode',origin:'terminal',project:'Midnight',folder:'calendar',startedAt:midnight-before*MIN,identity:{kind:'stable',sessionId:`midnight-${i}`}}]);
  const viewOf=(view:ReturnType<Directory['view']>)=>{
    const shown=showWidgets(view,[AGENT_HOURS_HEATMAP,'agents','activity']);
    return {...shown,layout:{...shown.layout,places:{...shown.layout.places,[AGENT_HOURS_HEATMAP]:{x:0,y:0,w:3},agents:{x:3,y:0,w:3},activity:{x:0,y:1,w:6}}}};
  };
  for(const user of stand.people.values()){
    const board=directory.boards(user.id).find(b=>b.personal)!;
    directory.saveView(board.id,viewOf(directory.view(board.id)),user.id,stand.start);
  }
  for(const board of boards(stand.set)){
    const id=stand.boards.get(board.id)!;
    directory.saveView(id,viewOf(directory.view(id)),stand.people.get(board.owner)!.id,stand.start);
  }
}
