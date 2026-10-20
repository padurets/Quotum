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
  for(let d=0;d<30;d++)for(let hour=0;hour<24;hour++){
    const day=today-(29-d)*DAY,weekday=new Date(day).getUTCDay(),working=weekday!==0&&weekday!==6,noise=((d*31+hour*17)%13)/12;
    let main=working&&hour>=9&&hour<13?.75+noise*1.7:working&&hour>=14&&hour<18?.55+noise*1.25:0;
    let docs=working&&hour>=13&&hour<16?.25+noise*.7:working&&hour>=8&&hour<10?.25:0;
    let website=working&&hour>=17&&hour<20&&d%3===0?.5+noise*.6:0;
    if(!working&&d%3===0&&hour>=11&&hour<14)main=.5+noise*.5;
    if(d>=9&&d<=11){main*=.18;docs*=.2;website=0;}
    if(d>=21&&working){main=hour>=15&&hour<19?1.1+noise:hour>=20&&hour<24?1.1+noise*1.3:0;docs=hour>=16&&hour<18?.5:0;}
    if(d===16&&hour>=10&&hour<15){main+=2.25;docs+=1.25;}
    if(d===17&&hour<3)website=1.5;
    for(const [project,amount] of [['Quotum',main],['Docs',docs],['Website',website]] as const){
      const hours=Math.round(amount*4)/4;
      for(let agent=0;agent<Math.ceil(hours);agent++){
        const from=day+hour*HOUR,to=Math.min(stand.start,from+Math.min(1,hours-agent)*HOUR);
        if(from>=to)continue;
        store.creditWork(device.id,from,to,[{source:null,client:agent%2?'codex':'opencode',origin:'terminal',project,folder:'calendar',startedAt:day,identity:{kind:'stable',sessionId:`calendar-${d}-${project}-${agent}`}}]);
      }
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
    return {...shown,layout:{...shown.layout,places:{...shown.layout.places,[AGENT_HOURS_HEATMAP]:{x:0,y:0,w:6},activity:{x:0,y:1,w:6},agents:{x:0,y:2,w:6}}}};
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
