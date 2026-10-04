import {createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse} from 'node:http';
import {promisify} from 'node:util';
import {brotliCompress, brotliDecompress, constants} from 'node:zlib';

const compress = promisify(brotliCompress), decompress = promisify(brotliDecompress);
export const HISTORY_CODEC = {quality: 4, mode: 'text', lgwin: 22, node: process.version} as const;
export const HISTORY_ATTEMPT_HEADER = 'x-quotum-bench-attempt';
let requestSerial = 0;
const params = {[constants.BROTLI_PARAM_QUALITY]: HISTORY_CODEC.quality, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_LGWIN]: HISTORY_CODEC.lgwin};
export type Transfer = {id: string; phase: string; cell: number; from: number; to: number; started: number; status?: number; decoded?: number; encoded?: number; sent: boolean; finished: boolean; aborted: boolean};

/** The benchmark owns this loopback forwarder, its fixed upstream and every socket. */
export async function historyProxy(upstream: string) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('history proxy requires its own loopback HTTP hub');
  let phase = 'seed', latency = 0, serial = 0;
  const transfers: Transfer[] = [], requests = new Set<ReturnType<typeof request>>(), delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  const identities = new Set<string>();
  const terminals = new Map<string, Promise<void>>();
  const server = createServer((incoming, outgoing) => {
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {outgoing.writeHead(400).end(); return;}
    const url = new URL(incoming.url, upstream), history = url.pathname === '/api/history';
    const attempt = incoming.headers[HISTORY_ATTEMPT_HEADER];
    if (history && attempt !== undefined && (typeof attempt !== 'string' || !/^[a-zA-Z0-9:._-]{1,96}$/.test(attempt) || identities.has(attempt))) {outgoing.writeHead(400).end(); return;}
    let id = typeof attempt === 'string' ? attempt : `p${++serial}`;
    if (attempt === undefined) while (identities.has(id)) id = `p${++serial}`;
    const transfer: Transfer | null = history ? {id, phase, cell: Number(url.searchParams.get('cell')), from: Number(url.searchParams.get('from')), to: Number(url.searchParams.get('to')), started: performance.now(), sent: false, finished: false, aborted: false} : null;
    let terminal = () => {};
    if (transfer) {identities.add(transfer.id); terminals.set(transfer.id, new Promise<void>(resolve => {terminal = resolve;}));}
    if (transfer) transfers.push(transfer);
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
    const encoded = await compress(body, {params}); transfer.encoded = encoded.length;
    if (wait) await new Promise<void>(resolve => {const timer = setTimeout(() => {delays.delete(timer); resolve();}, wait); delays.set(timer, resolve);});
    if (outgoing.destroyed) return;
    const headers: IncomingHttpHeaders = {...response.headers, 'content-encoding': 'br', 'content-length': String(encoded.length), vary: 'Accept-Encoding', 'x-quotum-bench-id': transfer.id};
    delete headers['transfer-encoding'];
    outgoing.writeHead(response.statusCode!, headers); transfer.sent = true; outgoing.end(encoded);
  }
  await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return {url: `http://127.0.0.1:${(server.address() as {port: number}).port}`, transfers,
    phase(value: string, addedLatency = 0) {phase = value; latency = addedLatency;},
    async settled(value: string) {await Promise.all(transfers.filter(t => t.phase === value).map(t => terminals.get(t.id)));},
    async close() {for (const [timer, resolve] of delays) {clearTimeout(timer); resolve();} delays.clear(); for (const req of requests) req.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));},
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
