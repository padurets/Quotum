import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import {AGENT_HOURS_HEATMAP,showWidgets} from '../server/domain/widgets.js';
import type {Stand} from './setup.js';
import {DAY,HOUR,MIN} from './model.js';

/** Real retained work feeds both the calendar and its daily analytical drill. */
export function seedCalendar(store:Store,directory:Directory,stand:Stand){
  const owner=stand.people.get('ana')!;
  const device=directory.devices(owner.id)[0];
  const today=Math.floor(stand.start/DAY)*DAY;
  for(let d=0;d<90;d++){
    if(d%7===0||d%7===6)continue;
    const hours=[.25,2,8,20,24][d%5];
    for(let agent=0;agent<(d%5===4?4:1);agent++){
      const from=today-d*DAY+Math.min(22,agent*2)*HOUR,to=Math.min(from+hours*HOUR,stand.start);
      if(from<to)store.creditWork(device.id,from,to,[{source:null,client:'opencode',origin:'terminal',project:d>12?'Earlier project':'Quotum',folder:'calendar',startedAt:from,identity:{kind:'stable',sessionId:`calendar-${d}-${agent}`}}]);
    }
  }
  // A short concurrent burst crosses a date boundary independently of other rows.
  const midnight=today-2*DAY;
  for(const [i,before,after] of [[0,30,30],[1,15,15]])store.creditWork(device.id,midnight-before*MIN,midnight+after*MIN,[{source:null,client:'opencode',origin:'terminal',project:'Midnight',folder:'calendar',startedAt:midnight-before*MIN,identity:{kind:'stable',sessionId:`midnight-${i}`}}]);
  for(const user of stand.people.values()){
    const board=directory.boards(user.id).find(b=>b.personal)!;
    directory.saveView(board.id,showWidgets(directory.view(board.id),[AGENT_HOURS_HEATMAP,'agents','activity']),user.id,stand.start);
  }
  for(const board of stand.boards.values()){
    directory.saveView(board,showWidgets(directory.view(board),[AGENT_HOURS_HEATMAP,'agents','activity']),owner.id,stand.start);
  }
}
