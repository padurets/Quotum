import type {CalendarCell} from '../../server/domain/workCalendar';
import {calendarCellAt,calendarRangeAt,calendarWindow,calendarLevel,type CalendarReading} from './workCalendar';
import {drain,type Preparation} from '../../server/domain/prepare';
const MIN=60_000,HOUR=60*MIN,DAY=24*HOUR;
export const HEATMAP_NATURAL=300,HEATMAP_MIN=160;
export type HeatmapView='matrix'|'calendar';
export type HeatCell={key:string;date:string;from:number;to:number;cell:CalendarCell;parts:CalendarCell[];partial:boolean;repeated:boolean;row:number;column:number;x:number;y:number;width:number;height:number;dayRange:{from:number;to:number};nominal?:{from:number;to:number};rowKey?:string};
export type HeatLabel={text:string;x:number;y:number;align?:'end'|'middle'};
export type HeatmapLayout={cells:HeatCell[];labels:HeatLabel[];height:number;naturalHeight:number;span:number;kind:'strip'|'rows'|'columns'|'calendar'};
type Group={key?:string;date:string;from:number;to:number;hour:number;offset:string;minute:number;shifted:boolean;agentMs:number;known:number;availableFrom:number;availableTo:number;validUntil:number|null;fold:number;parts:CalendarCell[]};
type Civil={date:string;hour:number;minute:number;offset:string};
const cache=new WeakMap<number[],{zone:string;parts:Civil[]}>();
const civilZones=new Map<string,{formatter:Intl.DateTimeFormat;instants:Map<number,Civil>}>();
function* civilPartsPrepared(reading:CalendarReading):Preparation<Civil[]>{
  const {edges,zone}=reading.window,old=cache.get(edges);if(old?.zone===zone)return old.parts;
  let stored=civilZones.get(zone);
  if(!stored){stored={formatter:new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'}),instants:new Map()};if(civilZones.size>=2)civilZones.delete(civilZones.keys().next().value!);}
  civilZones.delete(zone);civilZones.set(zone,stored);
  const {formatter,instants}=stored;
  // Replaced readings reuse their fine partition. Cache civil coordinates only;
  // work, availability and exact partial endpoints still come from each reading.
  const parts:Civil[]=[];
  for(const at of edges.slice(0,-1)){
    let value=instants.get(at);
    if(!value){const p=formatter.formatToParts(at),part=(key:string)=>p.find(p=>p.type===key)!.value;value={date:[part('year'),part('month'),part('day')].join('-'),hour:Number(part('hour')),minute:Number(part('minute')),offset:part('timeZoneName')};}
    instants.delete(at);instants.set(at,value);if(instants.size>4096)instants.delete(instants.keys().next().value!);
    parts.push(value);yield;
  }
  cache.set(edges,{zone,parts});return parts;
}
const time=(hour:number)=>String(hour).padStart(2,'0')+':00';
const labelFormats=new Map<string,Intl.DateTimeFormat>();
function labelFormat(key:string,locale:string,options:Intl.DateTimeFormatOptions){
  let format=labelFormats.get(key);
  if(!format){format=new Intl.DateTimeFormat(locale,options);if(labelFormats.size>=12)labelFormats.delete(labelFormats.keys().next().value!);labelFormats.set(key,format);}
  return format;
}
export const heatDateLabel=(date:string,locale:string)=>labelFormat('date:'+locale,locale,{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00Z'));
export function heatIntervalLabel(item:Pick<HeatCell,'from'|'to'|'dayRange'|'repeated'>,span:number,zone:string,locale:string){
  if(span>=23*HOUR&&item.from===item.dayRange.from&&item.to===item.dayRange.to&&!item.repeated)return '';
  const format=labelFormat(JSON.stringify([locale,zone,item.repeated]),locale,{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23',...(item.repeated?{timeZoneName:'shortOffset'}:{})});
  return format.format(item.from)+' — '+format.format(item.to);
}

/** Expiry changes only the cell's readout and paint, never prepared geometry. */
export function heatCellAt(item:HeatCell,now:number):HeatCell {
  let agentMs=0,known=0,from=Infinity,to=0,validUntil:number|null=null;
  for(const c of item.parts)if(c.agentMs!==null&&(c.validUntil===null||c.validUntil>now)){
    agentMs+=c.agentMs;known+=c.to-c.from;from=Math.min(from,c.from);to=Math.max(to,c.to);
    if(c.validUntil!==null)validUntil=Math.min(validUntil??Infinity,c.validUntil);
  }
  return {...item,cell:{agentMs:known?agentMs:null,from:known?from:item.from,to:known?to:item.from,validUntil},partial:known>0&&known<item.to-item.from};
}
export const heatCellChangesAt=(item:HeatCell,now:number)=>item.parts.reduce<number|null>((next,c)=>c.agentMs!==null&&c.validUntil!==null&&c.validUntil>now?Math.min(next??Infinity,c.validUntil):next,null);

type CivilGroup=Omit<Group,'agentMs'|'known'|'availableFrom'|'availableTo'|'validUntil'|'parts'>;
export type HeatmapCivil={window:CalendarReading['window'];groups:Map<number,CivilGroup[]>;view:HeatmapView;short:boolean};
export type HeatmapBasis={reading:CalendarReading;civil:HeatmapCivil};
// These bounded entries contain civil coordinates only, never work or availability.
const projectionCivil=new Map<string,HeatmapCivil>();

/** Civil grouping belongs to preparation; a clock never visits the fine work cells. */
export function* heatmapCivilPrepared(reading:CalendarReading,now:number,view:HeatmapView,width:number,allocated=0):Preparation<HeatmapCivil>{
  const range=calendarRangeAt(reading,now),short=range.to-range.from<=DAY;
  const duration=range.to-range.from,w=Math.max(100,width),height=Math.max(HEATMAP_MIN,allocated||HEATMAP_NATURAL);
  const counts=short?[1]:Array.from({length:Math.ceil(duration/(23*HOUR))+3-Math.floor(duration/(25*HOUR))},(_,i)=>Math.max(1,Math.floor(duration/(25*HOUR))+i));
  const spans=[...new Set(counts.map(count=>resolution(range,Array.from({length:count},()=>''),w,view,height).span))];
  for(const [key,saved] of projectionCivil)if(saved.window.zone===reading.window.zone&&saved.view===view&&saved.short===short&&spans.length===saved.groups.size&&spans.every(span=>saved.groups.has(span))&&heatmapCivilCovers(saved,reading,now)){
    projectionCivil.delete(key);projectionCivil.set(key,saved);return saved;
  }
  const window=calendarWindow(range.to,reading.window.zone,{mode:'range',from:Math.max(0,range.from-DAY),to:range.to+DAY});
  const key=JSON.stringify([window.zone,window.dates[0],window.dates.at(-1),short,view,spans]),saved=projectionCivil.get(key);
  if(saved){projectionCivil.delete(key);projectionCivil.set(key,saved);return saved;}
  // The fine civil partition is consumed once here. Clock projections reuse the
  // nominal groups for the possible resolutions, including DST offset folds.
  const step=short?MIN:15*MIN,from=window.dayEdges[0],to=window.dayEdges.at(-1)!;
  window.edges=Array.from({length:Math.ceil((to-from)/step)+1},(_,i)=>from+i*step);
  const civil=yield* civilPartsPrepared({...reading,window}),groups=new Map<number,CivilGroup[]>();
  for(const span of spans){
    const grouped=new Map<string,CivilGroup>();
    for(let i=0;i<window.edges.length-1;i++){
      yield;
      const from=window.edges[i],to=window.edges[i+1],part=civil[i];
      const hour=short?part.hour+Math.floor(part.minute/(span/MIN))*(span/MIN)/60:Math.floor(part.hour/(span/HOUR))*(span/HOUR);
      const key=short?String(Math.floor(from/span)):part.date+':'+hour+(view==='calendar'?'':':'+part.offset);
      let group=grouped.get(key);
      if(!group){group={key,date:part.date,from,to,hour,offset:part.offset,minute:part.minute,shifted:false,fold:0};grouped.set(key,group);}
      group.to=to;group.shifted ||= group.offset!==part.offset;
    }
    groups.set(span,[...grouped.values()]);
  }
  const result={window:{...window,edges:[]},groups,view,short};
  if(projectionCivil.size>=2)projectionCivil.delete(projectionCivil.keys().next().value!);
  projectionCivil.set(key,result);return result;
}

export function* heatmapBasisPrepared(reading:CalendarReading,view:HeatmapView,width:number,allocated=0):Preparation<HeatmapBasis>{
  return {reading,civil:yield* heatmapCivilPrepared(reading,reading.window.range.to,view,width,allocated)};
}

export function heatmapCivilCovers(civil:HeatmapCivil,reading:CalendarReading,now:number){
  const range=calendarRangeAt(reading,now);
  return range.from>=civil.window.dayEdges[0]&&range.to<=civil.window.dayEdges.at(-1)!;
}

/** Exact clipping and all details use one projection of the accepted integral. */
export function heatProjectionCellAt(basis:HeatmapBasis,item:HeatCell,now:number):HeatCell{
  const nominal=item.nominal??item,range=calendarRangeAt(basis.reading,now),from=Math.max(nominal.from,range.from),to=Math.max(from,Math.min(nominal.to,range.to));
  const cell=calendarCellAt(basis.reading,from,to,now);
  return {...item,from,to,cell,partial:cell.agentMs!==null&&cell.to-cell.from<to-from};
}

/** Coarse geometry follows the current dates; work is read only through integrals. */
export function heatmapProjection(basis:HeatmapBasis,now:number,width:number,view:HeatmapView,locale:string,allocated=0,civil=basis.civil):HeatmapLayout{
  const range=calendarRangeAt(basis.reading,now),all=civil.window;
  const first=all.dates.findIndex((_,i)=>all.dayEdges[i+1]>range.from);let last=all.dates.length-1;
  while(last>=0&&all.dayEdges[last]>=range.to)last--;
  const window={...all,range,dates:all.dates.slice(Math.max(0,first),last+1),dayEdges:all.dayEdges.slice(Math.max(0,first),last+2)};
  const w=Math.max(100,width),height=Math.max(HEATMAP_MIN,allocated||HEATMAP_NATURAL),{span,rows,left}=resolution(range,window.dates,w,view,height);
  const nominal=new Map<string,{from:number;to:number}>(),groups:Group[]=[];
  for(const group of civil.groups.get(span)??[])if(group.from<range.to&&group.to>range.from){
    const from=Math.max(group.from,range.from),to=Math.min(group.to,range.to);
    // A UTC-aligned short bucket may straddle a local midnight. Its visible
    // first instant, rather than its padded nominal start, owns the date label.
    const date=range.to-range.from<=DAY?window.dates[window.dayEdges.findIndex((at,i)=>at<=from&&window.dayEdges[i+1]>from)]??group.date:group.date;
    nominal.set(group.key!,{from:group.from,to:group.to});groups.push({...group,date,from,to,agentMs:0,known:0,availableFrom:Infinity,availableTo:0,validUntil:null,parts:[]});
  }
  const layout=drain(groupedLayoutPrepared(window,groups,w,view,locale,height,span,rows,left));
  layout.cells=layout.cells.map(item=>heatProjectionCellAt(basis,{...item,nominal:nominal.get(item.key)},now));
  return layout;
}

/** Plot structure and minute labels do not follow the active detail's faster clock. */
export function heatmapProjectionChangesAt(basis:HeatmapBasis,now:number){
  const range=calendarRangeAt(basis.reading,now),period=range.to-range.from,edges=basis.civil.window.dayEdges;
  const step=period<=DAY?MIN:15*MIN;
  return Math.min(Math.floor(now/step)*step+step,...edges.flatMap(at=>[at,at+period]).filter(at=>at>now));
}

/** Closed cells have no clock; changing boundary paint wakes only at its next change. */
export function heatProjectionPaintAt(basis:HeatmapBasis,item:HeatCell,span:number,now:number):number|null{
  const range=calendarRangeAt(basis.reading,now),nominal=item.nominal??item,integral=basis.reading.integral!;
  if(nominal.to<=range.from||nominal.from>=range.to)return null;
  const left=Math.max(range.from,now-integral.proof.retentionMs),through=integral.through();
  if(nominal.from>left&&nominal.to<=Math.min(range.to,through))return null;
  const signature=(at:number)=>{const c=heatProjectionCellAt(basis,item,at);return [c.cell.agentMs===null?-1:calendarLevel(c.cell.agentMs,span),c.partial,c.to>c.from].join(':');};
  const current=signature(now),parent=heatmapProjectionChangesAt(basis,now);
  // Only one edge crosses a bucket before the plot updates its geometry, so its
  // work amount and coverage move in one direction. Slope knots alone need no paint.
  if(signature(parent)===current)return null;
  let lo=now+1,hi=parent;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(signature(mid)===current)lo=mid+1;else hi=mid;}
  return lo<parent?lo:null;
}

/** Geometry groups exact fine intervals; resizing never divides coarse Activity bars. */
export const heatmapLayout=(...args:Parameters<typeof heatmapLayoutPrepared>)=>drain(heatmapLayoutPrepared(...args));
export function* heatmapLayoutPrepared(reading:CalendarReading,width:number,view:HeatmapView,locale:string,allocated=0):Preparation<HeatmapLayout> {
  const {window,value}=reading,{range,dates,edges}=window,w=Math.max(100,width),short=range.to-range.from<=DAY;
  const naturalHeight=HEATMAP_NATURAL,height=Math.max(HEATMAP_MIN,allocated||naturalHeight);
  const {rows,left,span}=resolution(range,dates,w,view,height);
  const parts=yield* civilPartsPrepared(reading),groups=new Map<string,Group>();
  for(let i=0;i<edges.length-1;i++){
    yield;
    const from=Math.max(edges[i],range.from),to=Math.min(edges[i+1],range.to);if(from>=to)continue;
    const part=parts[i],hour=short?part.hour+Math.floor(part.minute/(span/MIN))*(span/MIN)/60:Math.floor(part.hour/(span/HOUR))*(span/HOUR);
    const key=short?String(Math.floor(from/span)):part.date+':'+hour+(view==='calendar'?'':':'+part.offset);
    let g=groups.get(key);if(!g){g={date:part.date,from,to,hour,offset:part.offset,minute:part.minute,shifted:false,agentMs:0,known:0,availableFrom:Infinity,availableTo:0,validUntil:null,fold:0,parts:[]};groups.set(key,g);}g.to=to;g.shifted ||= part.offset!==g.offset;
    const c=value?.cells[i];if(c)g.parts.push(c);if(c?.agentMs!==null&&c?.agentMs!==undefined){g.agentMs+=c.agentMs;g.known+=Math.max(0,c.to-c.from);g.availableFrom=Math.min(g.availableFrom,c.from);g.availableTo=Math.max(g.availableTo,c.to);if(c.validUntil!==null)g.validUntil=Math.min(g.validUntil??Infinity,c.validUntil);}
  }
  return yield* groupedLayoutPrepared(window,[...groups.values()],w,view,locale,height,span,rows,left);
}

function resolution(range:{from:number;to:number},dates:string[],w:number,view:HeatmapView,height:number){
  const short=range.to-range.from<=DAY;
  let rows=false;
  let left=0;
  let span:number;
  if(short){const target=(range.to-range.from)/Math.max(1,Math.floor(w/24));span=([1,2,5,10,15,30,60].map(n=>n*MIN).find(n=>n>=target)??HOUR);}
  else if(view==='calendar'){
    const columns=Math.min(7,dates.length),cw=(w-(columns-1)*8)/columns,label=cw>=80?22:cw>=50?19:15,plot=cw-label;
    span=24*HOUR/(plot>=120?6:plot>=72?4:plot>=48?3:plot>=30?2:1);
  }else {
    let best={fit:0,rows:false,hours:1};
    for(const hours of [1,2,4,6]){
      const rowFit=Math.min((w-(w<420?51:63))/(24/hours),(height-24)/dates.length);
      const columnFit=Math.min((w-42)/dates.length,(height-30)/(24/hours));
      const candidate={fit:Math.max(rowFit,columnFit),rows:rowFit>=columnFit,hours};
      if(candidate.fit>best.fit)best=candidate;
      if(best.fit>=10)break;
    }
    rows=best.rows;left=rows?(w<420?51:63):42;span=best.hours*HOUR;
  }
  return {rows,left,span};
}

function* groupedLayoutPrepared(window:CalendarReading['window'],list:Group[],w:number,view:HeatmapView,locale:string,height:number,span:number,rows:boolean,left:number):Preparation<HeatmapLayout>{
  const {range,dates,dayEdges}=window,short=range.to-range.from<=DAY,naturalHeight=HEATMAP_NATURAL;
  const counts=new Map<string,number>(),folds=new Map<number,number>();
  for(const g of list){yield;const key=g.date+':'+g.hour;g.fold=counts.get(key)??0;counts.set(key,g.fold+1);folds.set(g.hour,Math.max(folds.get(g.hour)??1,g.fold+1));}
  const slots:{hour:number;fold:number}[]=[];if(!short)for(let h=0;h<24;h+=span/HOUR)for(let f=0;f<(folds.get(h)??1);f++)slots.push({hour:h,fold:f});
  const labels:HeatLabel[]=[],cells:HeatCell[]=[],weekday=new Intl.DateTimeFormat(locale,{weekday:'short',timeZone:'UTC'});
  const kind=short?'strip':view==='calendar'?'calendar':rows?'rows':'columns';let pitch=0;
  const fits=(i:number,count:number,pitch:number,space:number)=>i===0||i===count-1||i%Math.ceil(space/pitch)===0&&(count-1-i)*pitch>=space;
  if(kind==='strip'){
    const tick=new Intl.DateTimeFormat(locale,{timeZone:window.zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),date=new Intl.DateTimeFormat(locale,{timeZone:window.zone,day:'numeric',month:'short'});
    const n=Math.max(1,Math.min(6,Math.floor(w/(dates.length>1?125:60))));let previous='';for(let i=0;i<=n;i++){const at=range.from+(range.to-range.from)*i/n,day=date.format(at),label=(dates.length>1&&day!==previous?day+' ':'')+tick.format(at);labels.push({text:label,x:w*i/n,y:12,align:i===n?'end':i===0?undefined:'middle'});previous=day;}
  }else if(kind==='rows'){
    pitch=(height-24)/dates.length;
    for(const h of [0,...(w<420?[8,16]:[4,8,12,16,20]),24])labels.push({text:time(h),x:h===24?w:left+Math.max(0,slots.findIndex(s=>s.hour>=h&&s.fold===0))/slots.length*(w-left),y:11,align:h===24?'end':undefined});
    slots.forEach((s,i)=>{if(s.fold){const text=time(s.hour).slice(0,3)+String(list.find(g=>g.hour===s.hour&&g.fold===s.fold)?.minute??0).padStart(2,'0');const x=left+i/slots.length*(w-left);if(!labels.some(label=>Math.abs(label.x-x)<36))labels.push({text,x,y:11});}});
    dates.forEach((d,i)=>{if(fits(i,dates.length,pitch,16))labels.push({text:Number(d.slice(-2))+' '+weekday.format(new Date(d+'T12:00Z')),x:left-9,y:Math.min(height-2,24+(i+.5)*pitch+3),align:'end'});});
  }else if(kind==='columns'){
    pitch=(height-30)/slots.length;
    const cw=(w-left)/dates.length;dates.forEach((d,i)=>{if(fits(i,dates.length,cw,18))labels.push({text:String(Number(d.slice(-2))),x:left+(i+.5)*cw,y:11,align:'middle'});});
    let last=-Infinity;
    slots.forEach((s,i)=>{const y=24+i*pitch+4;if((s.hour%4===0||s.fold)&&y-last>=14&&height-2-y>=14){labels.push({text:time(s.hour).slice(0,3)+(s.fold?String(list.find(g=>g.hour===s.hour&&g.fold===s.fold)?.minute??0).padStart(2,'0'):'00'),x:left-8,y,align:'end'});last=y;}});labels.push({text:'24:00',x:left-8,y:height-2,align:'end'});
  }else{
    const cols=Math.min(7,dates.length),gap=w<420?5:8,cw=(w-gap*(cols-1))/cols,pad=dates.length<7?0:(new Date(dates[0]+'T12:00Z').getUTCDay()+6)%7;
    const weeks=Math.ceil((pad+dates.length)/cols);pitch=(height-24)/weeks;
    for(let i=0;i<cols;i++){const date=new Date(Date.UTC(2026,0,5+(dates.length<7?(new Date(dates[0]+'T12:00Z').getUTCDay()+6)%7:0)+i));labels.push({text:weekday.format(date),x:i*(cw+gap)+1,y:11});}
    dates.forEach((d,i)=>labels.push({text:String(Number(d.slice(-2))),x:((pad+i)%cols)*(cw+gap)+1,y:24+Math.floor((pad+i)/cols)*pitch+(pitch-8)/2+4}));
  }
  for(const g of list){
    yield;
    const day=dates.indexOf(g.date);if(day<0)continue;
    const slot=slots.findIndex(s=>s.hour===g.hour&&s.fold===g.fold);let x=0,y=24,cw=0,ch=0,row=0,column=0;
    if(kind==='strip'){x=(g.from-range.from)/(range.to-range.from)*w;cw=(g.to-g.from)/(range.to-range.from)*w-3;ch=height-30;column=cells.length;}
    else if(kind==='rows'){row=day;column=slot;const dx=(w-left)/slots.length;x=left+slot*dx;y+=day*pitch;cw=dx-Math.min(3,dx*.2);ch=pitch-Math.min(5,pitch*.2);}
    else if(kind==='columns'){row=slot;column=day;const dx=(w-left)/dates.length;x=left+day*dx;y+=slot*pitch;cw=dx-Math.min(3,dx*.2);ch=pitch-Math.min(2,pitch*.2);}
    else {const cols=Math.min(7,dates.length),gap=w<420?5:8,dx=(w-gap*(cols-1))/cols,label=dx>=80?22:dx>=50?19:15,pad=dates.length<7?0:(new Date(dates[0]+'T12:00Z').getUTCDay()+6)%7;row=Math.floor((pad+day)/cols);column=((pad+day)%cols)*(24*HOUR/span)+g.hour/(span/HOUR);const bx=(pad+day)%cols*(dx+gap);cw=(dx-label)/(24*HOUR/span)-2;x=bx+label+g.hour/(span/HOUR)*(dx-label)/(24*HOUR/span);y+=row*pitch;ch=pitch-8;}
    const rowKey=kind==='rows'?g.date:kind==='columns'?g.hour+':'+g.fold:kind==='calendar'?String(Date.parse(g.date+'T00:00Z')-((new Date(g.date+'T00:00Z').getUTCDay()+6)%7)*DAY):'strip';
    cells.push({rowKey,key:g.key??String(g.from),date:g.date,from:g.from,to:g.to,cell:{agentMs:g.known?g.agentMs:null,from:g.known?g.availableFrom:g.from,to:g.known?g.availableTo:g.from,validUntil:g.validUntil},parts:g.parts,partial:g.known>0&&g.known<g.to-g.from,repeated:g.shifted||(counts.get(g.date+':'+g.hour)??1)>1,row,column,x,y,width:Math.max(.5,cw),height:ch,dayRange:{from:dayEdges[day],to:dayEdges[day+1]}});
  }
  return {cells,labels,height,naturalHeight,span,kind};
}
