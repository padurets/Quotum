import type {Cdp} from './cdp.js';
import {accountingPath,accountingTotal} from './accountingTraffic';

const ASKED=new Set(['Fetch','XHR','EventSource','Document']);

/** Counts what the page asks the hub while `counting`: the stream of events it opened before is not asked again, one opened meanwhile is. */
export class Requests {
  counting = false;
  count = 0;
  bytes = 0;
  readonly byPath: Record<string, number> = {};
  readonly bytesByPath: Record<string, number> = {};
  readonly history: {scope:string|null;meters:string|null;from:number;to:number}[] = [];
  private readonly ids = new Map<string, string>();
  get historyPending() {return [...this.ids.values()].filter(accountingPath).length;}

  get historyRequests() {return accountingTotal(this.byPath);}
  get historyBytes() {return accountingTotal(this.bytesByPath);}

  constructor(cdp: Cdp) {
    const partial=new Map<string,number>();
    cdp.on<{requestId:string;encodedDataLength:number}>('Network.dataReceived',event=>{if(this.ids.has(event.requestId))partial.set(event.requestId,(partial.get(event.requestId)??0)+event.encodedDataLength);});
    cdp.on<{requestId:string}>('Network.loadingFailed',event=>{const path=this.ids.get(event.requestId);if(path){this.ids.delete(event.requestId);const bytes=partial.get(event.requestId)??0;this.bytes+=bytes;this.bytesByPath[path]=(this.bytesByPath[path]??0)+bytes;}partial.delete(event.requestId);});
    cdp.on<{requestId: string; type?: string; request: {url: string;postData?:string}}>('Network.requestWillBeSent', event => {
      if (!this.counting || !ASKED.has(event.type ?? '')) return;
      const url = new URL(event.request.url);
      this.count++;
      this.byPath[url.pathname] = (this.byPath[url.pathname] ?? 0) + 1;
      if(url.pathname==='/api/history')this.history.push({scope:url.searchParams.get('scope'),meters:url.searchParams.get('meters'),from:Number(url.searchParams.get('from')),to:Number(url.searchParams.get('to'))});
      if(accountingPath(url.pathname)&&url.pathname!=='/api/history'){const body=JSON.parse(event.request.postData??'{}');for(const scope of ['quota','budget','funds'])if(body[scope]){const q=body[scope];this.history.push({scope:scope==='funds'?'budget':scope,meters:q.meters??null,from:Number(q.from),to:Number(q.to)});}}
      this.ids.set(event.requestId, url.pathname);
    });
    cdp.on<{requestId: string; encodedDataLength: number}>('Network.loadingFinished', event => {
      const path = this.ids.get(event.requestId);
      if (path) {partial.delete(event.requestId);this.ids.delete(event.requestId); this.bytes += event.encodedDataLength; this.bytesByPath[path] = (this.bytesByPath[path] ?? 0) + event.encodedDataLength;}
    });
  }
}
