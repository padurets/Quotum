import {accountingPath} from './accountingTraffic';
import {createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse} from 'node:http';
import {promisify} from 'node:util';
import {brotliCompress, brotliDecompress, constants} from 'node:zlib';
import type {RunOwner} from './runOwner.js';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {HistoryBasis} from '../server/domain/history.js';

const compress = promisify(brotliCompress), decompress = promisify(brotliDecompress);
export const HISTORY_CODEC = {quality: 4, mode: 'text', lgwin: 22, node: process.version} as const;
export const HISTORY_ATTEMPT_HEADER = 'x-quotum-bench-attempt';
let requestSerial = 0;
export const HISTORY_CODEC_PARAMS = {[constants.BROTLI_PARAM_QUALITY]: HISTORY_CODEC.quality, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_LGWIN]: HISTORY_CODEC.lgwin};
export type Transfer = {id: string; phase: string; cell: number; from: number; to: number; started: number; status?: number; decoded?: number; encoded?: number; sent: boolean; finished: boolean; aborted: boolean};

export const RAW_HISTORY_400 = 'browser/1d/activity/400ms/0.5/take1';
type RawRead = {id:string;phase:string;attemptId?:string;transferId?:string;httpStatus?:number|null;canceled?:boolean;count?:BodyCount};
type RawTotals = {attempts:number;decoded:number|null;encodedUpper:number|null;referenceDecoded:number;referenceEncoded:number};
type RawEnd = {status:string;reads:RawRead[];bases:[string,HistoryBasis][];aggregate?:RawTotals};
type RawOptions = {directory:string;save(value:unknown):void};
export type HistoryRaw400 = {errors:number;request(transfer:Transfer,method:string,path:string):void;ready(transfer:Transfer,body:Buffer,encoded:Buffer):void;post(id:string,phase:string,text:string):void;finish(value?:RawEnd):void};

/** A temporary, one-cohort lease of original buffers; exports only after original checks. */
function historyRaw400({directory,save}:RawOptions):HistoryRaw400 {
  const phases=new Set(['seed','cold','reference/quota','reference/budget','reference/funds'].map(suffix=>RAW_HISTORY_400+'/'+suffix));
  const selected=(phase:string)=>phases.has(phase);
  const records=new Map<string,{transfer:Transfer;method:string;path:string;body?:Buffer;encoded?:Buffer}>(),posts=new Map<string,{phase:string;text:string}>();
  let sealed=false,retained=0,postBytes=0,pathBytes=0,omitted=0;
  const capture:HistoryRaw400={errors:0,
    request(transfer,method,path){
      if(sealed||!selected(transfer.phase))return;
      const bytes=Buffer.byteLength(path)+Buffer.byteLength(method);
      if(records.has(transfer.id)){capture.errors++;return;}
      if(records.size>=96||pathBytes+bytes>128*1024){omitted++;return;}
      pathBytes+=bytes;records.set(transfer.id,{transfer,method,path});
    },
    ready(transfer,body,encoded){
      if(sealed||!selected(transfer.phase))return;
      const row=records.get(transfer.id);if(!row){omitted++;return;}
      if(row.body){capture.errors++;return;}
      if(retained+body.length+encoded.length>4*1024*1024){omitted++;return;}
      retained+=body.length+encoded.length;row.body=body;row.encoded=encoded;
    },
    post(id,phase,text){
      if(sealed||!selected(phase))return;
      if(posts.has(id)){capture.errors++;return;}
      const bytes=Buffer.byteLength(text);if(posts.size>=96||postBytes+bytes>128*1024){omitted++;return;}
      postBytes+=bytes;posts.set(id,{phase,text});
    },
    finish(value={status:'incomplete',reads:[],bases:[]}){
      if(sealed)return;sealed=true;
      const files:{name:string;bytes:number|null;sha256:string|null}[]=[],rows:unknown[]=[],usedPosts=new Set<string>();
      let qualified=(value.status==='passed'||value.status==='over-budget')&&records.size>0,indexWritten=false,unknown=0;
      const hash=(body:Buffer)=>createHash('sha256').update(body).digest('hex');
      const write=(name:string,body:Buffer)=>{
        try{writeFileSync(join(directory,name),body,{mode:0o600,flag:'wx'});files.push({name,bytes:body.length,sha256:hash(body)});}
        catch(error){try{const partial=readFileSync(join(directory,name));files.push({name,bytes:partial.length,sha256:hash(partial)});}catch{files.push({name,bytes:null,sha256:null});}throw error;}
        return name;
      };
      try{
        mkdirSync(directory,{mode:0o700});
        let ordinal=0;
        for(const row of records.values()){
          const transfer={...row.transfer},stem='pair-'+String(++ordinal).padStart(3,'0'),matches=value.reads.filter(read=>read.attemptId===transfer.id);
          const read=matches.length===1?matches[0]:undefined,post=read?posts.get(read.id):undefined;
          let requestBody:string|undefined;
          if(row.method==='POST'){
            if(!read||!post||post.phase!==transfer.phase||usedPosts.has(read.id)){unknown++;qualified=false;}
            else{usedPosts.add(read.id);requestBody=write(stem+'.post.json',Buffer.from(post.text));}
          }else if(row.method!=='GET'){unknown++;qualified=false;}
          const complete=transfer.status===200&&transfer.sent&&transfer.finished&&!transfer.aborted&&!!row.body&&!!row.encoded;
          if(!complete){unknown++;qualified=false;}
          if(row.method==='POST'&&(!read?.count?.complete||read.canceled||read.httpStatus!==200||read.phase!==transfer.phase||
            read.transferId!==transfer.id||read.count.id!==transfer.id||read.count.responseId!==transfer.id||read.count.coding!=='br'||
            read.count.decoded!==row.body?.length||read.count.lower!==row.encoded?.length||read.count.upper!==row.encoded?.length||
            read.count.length!==row.encoded?.length)){unknown++;qualified=false;}
          const json=row.body?write(stem+'.json',row.body):undefined,br=row.encoded?write(stem+'.br',row.encoded):undefined;
          rows.push({transfer,method:row.method,path:row.path,read,requestBody,json,br});
        }
        if(usedPosts.size!==posts.size){unknown++;qualified=false;}
        const seed=[...records.values()].filter(row=>row.transfer.phase===RAW_HISTORY_400+'/seed'),cold=[...records.values()].filter(row=>row.transfer.phase===RAW_HISTORY_400+'/cold'),refs=[...records.values()].filter(row=>row.transfer.phase.startsWith(RAW_HISTORY_400+'/reference/')),aggregate=value.aggregate;
        if(!aggregate||!seed.length||!refs.length||!value.bases.length||!value.reads.some(read=>read.phase===RAW_HISTORY_400+'/seed')||
          cold.length!==aggregate.attempts||cold.length!==value.reads.filter(read=>read.phase===RAW_HISTORY_400+'/cold').length||
          cold.reduce((n,row)=>n+(row.body?.length??0),0)!==aggregate.decoded||cold.reduce((n,row)=>n+(row.encoded?.length??0),0)!==aggregate.encodedUpper||
          refs.reduce((n,row)=>n+(row.body?.length??0),0)!==aggregate.referenceDecoded||refs.reduce((n,row)=>n+(row.encoded?.length??0),0)!==aggregate.referenceEncoded){unknown++;qualified=false;}
        const sourceFiles=['./historyProxy.ts','./historyTrafficBrowser.ts','./historyTraffic.ts','./index.ts','./evidence.ts','../server/history.ts','../server/periodRead.ts','../server/domain/periodWire.ts','../server/domain/periodSequenceWire.ts','../server/domain/valueChanges.ts'];
        const sources=sourceFiles.map(path=>{const body=readFileSync(new URL(path,import.meta.url));return{path,bytes:body.length,sha256:hash(body)};});
        const identity=(JSON.parse(readFileSync(join(dirname(directory),'manifest.json'),'utf8')) as {identity:unknown}).identity;
        const index={mode:'diagnostic',status:qualified&&!omitted&&!capture.errors?'complete':'insufficient-evidence',name:RAW_HISTORY_400,originalStatus:value.status,identity,receivedParsedClient:'unavailable',codec:HISTORY_CODEC,params:HISTORY_CODEC_PARAMS,node:process.version,sources,omitted,errors:capture.errors,unknown,limits:{pairs:96,posts:96,rawBytes:4*1024*1024,postBytes:128*1024,metadataBytes:128*1024},retained,postBytes,aggregate,bases:value.bases,rows,files:[...files]};
        const body=Buffer.from(JSON.stringify(index));if(body.length>128*1024)throw new Error('raw history metadata limit');
        write('index.json',body);indexWritten=true;
      }catch{capture.errors++;}
      finally{
        try{save({mode:'diagnostic',name:RAW_HISTORY_400,status:qualified&&indexWritten&&!omitted&&!capture.errors?'complete':'insufficient-evidence',originalStatus:value.status,indexWritten,pairs:records.size,posts:posts.size,retained,postBytes,omitted,errors:capture.errors,unknown,files:files.map(({sha256,...file})=>({...file,sha:sha256}))});}catch{/* Capture cannot replace the original result or cleanup. */}
        records.clear();posts.clear();retained=postBytes=pathBytes=0;
      }
    },
  };
  return capture;
}

/** The benchmark owns this loopback forwarder, its fixed upstream and every socket. */
export async function historyProxy(upstream: string, owner?: RunOwner, rawOptions?:RawOptions) {
  owner?.signal.throwIfAborted();
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('history proxy requires its own loopback HTTP hub');
  const raw400=rawOptions?historyRaw400(rawOptions):undefined;
  let phase = 'seed', latency = 0, serial = 0;
  const transfers: Transfer[] = [], requests = new Set<ReturnType<typeof request>>(), delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  const identities = new Set<string>();
  const terminals = new Map<string, Promise<void>>();
  const server = createServer((incoming, outgoing) => {
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {outgoing.writeHead(400).end(); return;}
    const url = new URL(incoming.url, upstream), history = accountingPath(url.pathname);
    const attempt = incoming.headers[HISTORY_ATTEMPT_HEADER];
    if (history && attempt !== undefined && (typeof attempt !== 'string' || !/^[a-zA-Z0-9:._-]{1,96}$/.test(attempt) || identities.has(attempt))) {outgoing.writeHead(400).end(); return;}
    let id = typeof attempt === 'string' ? attempt : `p${++serial}`;
    if (attempt === undefined) while (identities.has(id)) id = `p${++serial}`;
    const transfer: Transfer | null = history ? {id, phase, cell: Number(url.searchParams.get('cell')), from: Number(url.searchParams.get('from')), to: Number(url.searchParams.get('to')), started: performance.now(), sent: false, finished: false, aborted: false} : null;
    let terminal = () => {};
    if (transfer) {identities.add(transfer.id); terminals.set(transfer.id, new Promise<void>(resolve => {terminal = resolve;}));}
    if (transfer) transfers.push(transfer);
    if(transfer&&raw400)try{raw400.request(transfer,incoming.method??'',incoming.url);}catch{raw400.errors++;}
    const wait = latency;
    const headers: IncomingHttpHeaders = {...incoming.headers, 'accept-encoding': 'identity'};
    // Attempt identity belongs to this fixture, never to the production hub.
    delete headers[HISTORY_ATTEMPT_HEADER];
    const forwarded = request({hostname: target.hostname, port: target.port, path: incoming.url, method: incoming.method, headers}, response => {
      if (!transfer) {outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); return;}
      transfer.status = response.statusCode;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', () => outgoing.destroy());
      response.on('end', () => void sendHistory(response, outgoing, chunks, transfer, wait).catch(() => outgoing.destroy()));
    });
    requests.add(forwarded);
    forwarded.on('close', () => requests.delete(forwarded));
    forwarded.on('error', () => outgoing.destroy());
    outgoing.on('finish', () => {if (transfer) transfer.finished = true; terminal();});
    outgoing.on('close', () => {if (!outgoing.writableFinished && transfer) transfer.aborted = true; terminal(); forwarded.destroy();});
    incoming.pipe(forwarded);
  });
  async function sendHistory(response: IncomingMessage, outgoing: ServerResponse, chunks: Buffer[], transfer: Transfer, wait: number) {
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('unexpected upstream history coding');
    const body = Buffer.concat(chunks); chunks.length = 0;
    transfer.decoded = body.length;
    const encoded = await compress(body, {params:HISTORY_CODEC_PARAMS}); transfer.encoded = encoded.length;
    if(raw400)try{raw400.ready(transfer,body,encoded);}catch{raw400.errors++;}
    if (wait) await new Promise<void>(resolve => {const timer = setTimeout(() => {delays.delete(timer); resolve();}, wait); delays.set(timer, resolve);});
    if (outgoing.destroyed) return;
    const headers: IncomingHttpHeaders = {...response.headers, 'content-encoding': 'br', 'content-length': String(encoded.length), vary: 'Accept-Encoding', 'x-quotum-bench-id': transfer.id};
    delete headers['transfer-encoding'];
    outgoing.writeHead(response.statusCode!, headers); transfer.sent = true; outgoing.end(encoded);
  }
  let closing: Promise<void> | undefined;
  const stop = () => closing ??= (async () => {for (const [timer, resolve] of delays) {clearTimeout(timer); resolve();} delays.clear(); for (const req of requests) req.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));})();
  const close = owner?.resource(stop) ?? stop;
  const listen = () => new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  await (owner ? owner.operation(listen) : listen());
  if (owner?.signal.aborted) {await close(); owner.signal.throwIfAborted();}
  return {url: `http://127.0.0.1:${(server.address() as {port: number}).port}`, transfers,raw400,
    phase(value: string, addedLatency = 0) {phase = value; latency = addedLatency;},
    async settled(value: string) {await Promise.all(transfers.filter(t => t.phase === value).map(t => terminals.get(t.id)));},
    close,
  };
}

export type BodyCount = {complete: boolean; decoded?: number; lower: number; upper?: number; coding?: string; length?: number; id?: string; responseId?: string};
/** Raw HTTP bytes exclude headers; partial transfers retain their measured lower bound. */
export function historyBody(url: string, cookie: string, signal?: AbortSignal, counted?: (body: BodyCount) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `n${++requestSerial}`;
    let lower = 0, ended = false, upper: number | undefined, coding: string | undefined, responseId: string | undefined;
    const fail = (error: Error) => {if (ended) return; ended = true; counted?.({complete: false, lower, upper, coding, length: upper, id, responseId}); reject(error);};
    const req = request(url, {headers: {cookie, 'accept-encoding': 'br', [HISTORY_ATTEMPT_HEADER]: id}, signal}, response => {
      upper = response.headers['content-length'] === undefined ? undefined : Number(response.headers['content-length']);
      coding = response.headers['content-encoding']; responseId = response.headers['x-quotum-bench-id'] as string | undefined;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {lower += chunk.length; chunks.push(chunk);});
      response.on('error', fail);
      response.on('end', () => void (async () => {
        if (coding !== 'br' || !Number.isFinite(upper) || lower !== upper) throw new Error('history body coding or length mismatch');
        if (responseId !== undefined && responseId !== id) throw new Error('history response identity mismatch');
        const decoded = await decompress(Buffer.concat(chunks));
        if (ended) return;
        const answer: unknown = JSON.parse(decoded.toString());
        ended = true; counted?.({complete: true, decoded: decoded.length, lower, upper, coding, length: upper, id, responseId});
        if (response.statusCode !== 200) reject(new Error(`history HTTP ${response.statusCode}`)); else resolve(answer);
      })().catch(fail));
    });
    req.on('error', fail); req.end();
  });
}
