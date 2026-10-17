import {sseParser} from '../ui/lib/live.js';
import {isDeepStrictEqual} from 'node:util';
import {utcPeriods} from '../server/domain/meters.js';
import {monetaryOf} from '../server/domain/providers.js';
import type {Card} from '../server/projection.js';
import type {CalendarReading} from './budget.js';

type CalendarWindow={from:number;to:number};

const money=(value:unknown)=>value===null||typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value);
const timestamp=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;

/** Without another observation, a new UTC period has no spending evidence. */
function calendarCard(card:Card,{from,to}:CalendarWindow):Card|null {
  if(!card.spending||typeof card.provider!=='string'||monetaryOf(card.provider)?.spending!=='counter'||!Number.isSafeInteger(card.successAt)||card.successAt===null||card.successAt<0||card.successAt>=from)return null;
  const before=utcPeriods(from),after=utcPeriods(to);
  if(before.day===after.day||Object.keys(card.spending).sort().join(',')!=='day,month,week')return null;
  const spending={...card.spending};
  for(const period of ['day','week','month'] as const) {
    const value=card.spending[period];
    if(!value||value.from!==before[period]||value.to!==Math.max(before[period],card.successAt))return null;
    if(Object.keys(value).sort().join(',')!=='amount,complete,from,knownFrom,to,uncertain,unlocated'||!money(value.amount)||typeof value.complete!=='boolean'||typeof value.uncertain!=='boolean'||value.knownFrom!==null&&(!timestamp(value.knownFrom)||value.knownFrom<value.from||value.knownFrom>value.to)||!Array.isArray(value.unlocated))return null;
    if(value.uncertain!==(value.unlocated.length>0)||value.unlocated.some(step=>!step||Object.keys(step).sort().join(',')!=='amount,evidence,from,to'||!timestamp(step.from)||!timestamp(step.to)||step.from>=step.to||!money(step.amount)||step.amount===null||!['continuous','gap','estimate'].includes(step.evidence)))return null;
    if(before[period]!==after[period])spending[period]={from:after[period],to:after[period],amount:null,complete:false,knownFrom:null,uncertain:false,unlocated:[]};
  }
  return {...card,spending};
}

/**
 * The benchmark's own reader of a board's events (spec/dashboard-v1.md), asked for as the
 * page asks. Board events and owner-private contact metadata are counted separately;
 * the latter must match the owner's baseline and the narrow contact wire contract.
 * Empty owner semantic hints and exact UTC calendar transitions are reported separately;
 * other board changes still fail, and no traffic exception permits extra page work.
 */
export type Heard = {
  counts(): Record<string, number>;
  boardCounts(): Record<string, number>;
  contacts(): {packets:number;entries:number;bytes:number;maxEntries:number;invalid:number};
  hints(): {packets:number;bytes:number;invalid:number};
  calendar(): CalendarReading;
  reset(window?:CalendarWindow): void;
  close(): void;
};

export class EventCounts {
  private own=new Set<string>();
  private all:Record<string,number>={};
  private board:Record<string,number>={};
  private contact={packets:0,entries:0,bytes:0,maxEntries:0,invalid:0};
  private hint={packets:0,bytes:0,invalid:0};
  private cards=new Map<string,Card>();
  private expected=new Map<string,Card>();
  private received=new Set<string>();
  private calendarBytes=0;
  private window:CalendarWindow|undefined;
  constructor(private readonly now:()=>number=Date.now){}
  readonly push=sseParser((type,data)=>{
    this.all[type]=(this.all[type]??0)+1;
    this.board[type]=(this.board[type]??0)+1;
    if(type==='snapshot') {
      this.own.clear();
      this.cards.clear();
      try {
        const snapshot=JSON.parse(data),contacts=snapshot.deviceContacts;
        if(Array.isArray(snapshot.sources))for(const card of snapshot.sources){
          if(!card||typeof card.id!=='string'||this.cards.has(card.id)){this.cards.clear();break;}
          this.cards.set(card.id,card);
        }
        if(contacts&&typeof contacts==='object'&&!Array.isArray(contacts))for(const [id,at] of Object.entries(contacts))
          if(/^[A-Za-z0-9_-]{12}$/.test(id)&&Number.isSafeInteger(at)&&Number(at)>=0)this.own.add(id);
      }catch { /* A malformed snapshot remains a board event. */ }
    }
    if(type==='lineup') {
      try{const ids=JSON.parse(data).sources;if(Array.isArray(ids))for(const id of this.cards.keys())if(!ids.includes(id))this.cards.delete(id);}catch{/* Invalid traffic remains counted. */}
    }
    if(type==='card') {
      try {
        const card=JSON.parse(data),expected=this.expected.get(card?.id),at=this.now();
        if(this.window&&expected&&!this.received.has(card.id)&&at>=this.window.from&&at<=this.window.to&&utcPeriods(at).day===utcPeriods(this.window.to).day&&isDeepStrictEqual(card,expected)) {
          this.received.add(card.id);this.calendarBytes+=Buffer.byteLength(data);
          if(--this.board[type]===0)delete this.board[type];
        }
        if(card&&this.cards.has(card.id))this.cards.set(card.id,card);
      }catch{/* Malformed cards cannot receive a calendar exception. */}
      return;
    }
    if(type==='devices') {
      try {
        const packet=JSON.parse(data);
        if(!packet||typeof packet!=='object'||Array.isArray(packet)||Object.keys(packet).length)throw new Error();
        this.hint.packets++;this.hint.bytes+=Buffer.byteLength(data);
        if(--this.board[type]===0)delete this.board[type];
      }catch {this.hint.invalid++;}
      return;
    }
    if(type!=='deviceContacts')return;
    try {
      const packet=JSON.parse(data),seen=new Set<string>();
      if(!packet||Object.keys(packet).length!==1||!Array.isArray(packet.devices)||!packet.devices.length||packet.devices.length>this.own.size)throw new Error();
      for(const row of packet.devices) {
        if(!row||Object.keys(row).length!==2||!this.own.has(row.deviceId)||seen.has(row.deviceId)||!Number.isSafeInteger(row.lastSeenAt)||row.lastSeenAt<0)throw new Error();
        seen.add(row.deviceId);
      }
      this.contact.packets++;this.contact.entries+=seen.size;this.contact.bytes+=Buffer.byteLength(data);
      this.contact.maxEntries=Math.max(this.contact.maxEntries,seen.size);
      if(--this.board[type]===0)delete this.board[type];
    }catch {this.contact.invalid++;}
  });
  counts(){return {...this.all};}
  boardCounts(){return {...this.board};}
  contacts(){return {...this.contact};}
  hints(){return {...this.hint};}
  calendar():CalendarReading{return {packets:this.received.size,bytes:this.calendarBytes,rejected:this.board.card??0,expected:[...this.expected.keys()].map(id=>({id})),received:[...this.received].map(id=>({id})),missing:[...this.expected.keys()].filter(id=>!this.received.has(id)).map(id=>({id}))};}
  reset(window?:CalendarWindow){
    if(window&&(!Number.isSafeInteger(window.from)||!Number.isSafeInteger(window.to)||window.to<=window.from||window.to-window.from>=86_400_000))throw new Error('invalid calendar observation window');
    this.all={};this.board={};this.contact={packets:0,entries:0,bytes:0,maxEntries:0,invalid:0};this.hint={packets:0,bytes:0,invalid:0};
    this.window=window;this.expected.clear();this.received.clear();this.calendarBytes=0;
    if(window)for(const [id,card]of this.cards){const next=calendarCard(card,window);if(next)this.expected.set(id,next);}
  }
}

export async function hear(base: string, cookie: string, board: string): Promise<Heard> {
  const stop = new AbortController();
  const response = await fetch(`${base}/api/events?board=${encodeURIComponent(board)}`, {headers: {cookie, 'quotum-stream': '1'}, signal: stop.signal});
  if (response.status !== 200 || !response.body) throw new Error(`the board's events: HTTP ${response.status}`);
  const ledger=new EventCounts();
  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  void (async () => {
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        ledger.push(decoder.decode(value, {stream: true}));
      }
    } catch {
      // Closed by `close`.
    }
  })();
  return {
    counts: () => ledger.counts(),
    boardCounts:()=>ledger.boardCounts(),
    contacts:()=>ledger.contacts(),
    hints:()=>ledger.hints(),
    calendar:()=>ledger.calendar(),
    reset: window => ledger.reset(window),
    close: () => stop.abort(),
  };
}
