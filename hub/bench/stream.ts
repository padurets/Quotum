import {sseParser} from '../ui/lib/live.js';

/**
 * The benchmark's own reader of a board's events (spec/dashboard-v1.md), asked for as the
 * page asks. Board events and owner-private contact metadata are counted separately;
 * the latter must match the owner's baseline and the narrow contact wire contract.
 * Empty owner semantic hints are reported separately too; board changes still fail.
 */
export type Heard = {
  counts(): Record<string, number>;
  boardCounts(): Record<string, number>;
  contacts(): {packets:number;entries:number;bytes:number;maxEntries:number;invalid:number};
  hints(): {packets:number;bytes:number;invalid:number};
  reset(): void;
  close(): void;
};

export class EventCounts {
  private own=new Set<string>();
  private all:Record<string,number>={};
  private board:Record<string,number>={};
  private contact={packets:0,entries:0,bytes:0,maxEntries:0,invalid:0};
  private hint={packets:0,bytes:0,invalid:0};
  readonly push=sseParser((type,data)=>{
    this.all[type]=(this.all[type]??0)+1;
    this.board[type]=(this.board[type]??0)+1;
    if(type==='snapshot') {
      this.own.clear();
      try {
        const contacts=JSON.parse(data).deviceContacts;
        if(contacts&&typeof contacts==='object'&&!Array.isArray(contacts))for(const [id,at] of Object.entries(contacts))
          if(/^[A-Za-z0-9_-]{12}$/.test(id)&&Number.isSafeInteger(at)&&Number(at)>=0)this.own.add(id);
      }catch { /* A malformed snapshot remains a board event. */ }
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
  reset(){this.all={};this.board={};this.contact={packets:0,entries:0,bytes:0,maxEntries:0,invalid:0};this.hint={packets:0,bytes:0,invalid:0};}
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
    reset: () => ledger.reset(),
    close: () => stop.abort(),
  };
}
