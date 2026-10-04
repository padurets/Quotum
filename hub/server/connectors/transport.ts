import {Agent, request} from 'node:https';
import {SecretError, type SecretCode} from '../secrets/crypto.js';

export type Destination = {host: string; port: number; operations: Readonly<Record<string, {path: string; query?: readonly string[];cursor?:string}>>};
export type OrganizationReply={data:unknown;organization:string|null};
/** A proof is exactly one opaque printable value, never a caller-selected header. */
export function organizationProof(raw:readonly string[]):string|null {
  const values:string[]=[];
  for(let i=0;i<raw.length;i+=2)if(raw[i].toLowerCase()==='openai-organization')values.push(raw[i+1]);
  return values.length===1&&/^[\x21-\x7e]{1,256}$/.test(values[0])?values[0]:null;
}
export class ConnectorStatus extends SecretError {
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly retryNotBefore:number|null;
  constructor(status:number,retryAfter:unknown) {
    super('connector_status');
    this.status=[401,403,404,429].includes(status)||status>=500&&status<=599 ? status : null;
    this.retryAfterMs=typeof retryAfter==='string' && /^\d{1,6}$/.test(retryAfter) ? Math.min(Number(retryAfter)*1000,3_600_000) : null;
    const delay=typeof retryAfter==='string'&&/^\d{1,20}$/.test(retryAfter)?Number(retryAfter)*1000:null;
    const date=typeof retryAfter==='string'&&!/^\d+$/.test(retryAfter)?Date.parse(retryAfter):NaN;
    this.retryNotBefore=delay!==null?Math.min(Number.MAX_SAFE_INTEGER,Date.now()+delay):Number.isFinite(date)?Math.max(Date.now(),date):null;
  }
}

/** This transport accepts operations from connector code, never URLs from a caller. */
export class ConnectorTransport {
  #agent: Agent;
  private readonly destination: Destination;
  constructor(destination: Destination, options: {ca?: string; timeoutMs?: number; maxBytes?: number; decode?: (json:string)=>unknown;organizationProof?:boolean} = {}) {
    if (!/^[a-z0-9.-]+$/.test(destination.host) || destination.host !== destination.host.toLowerCase() || !Number.isInteger(destination.port) || destination.port < 1 || destination.port > 65535 || Object.values(destination.operations).some(op => !/^\/[A-Za-z0-9/_-]*$/.test(op.path))) throw new SecretError('connector_destination_invalid');
    // An explicit agent has no global proxy settings, including Node's environment proxy.
    this.#agent = new Agent({rejectUnauthorized: true, ...(options.ca ? {ca: options.ca} : {})});
    this.destination = Object.freeze({host: destination.host, port: destination.port, operations: Object.freeze(Object.fromEntries(Object.entries(destination.operations).map(([name, op]) => [name, Object.freeze({path: op.path, ...(op.query ? {query: Object.freeze([...op.query])} : {}),...(op.cursor?{cursor:op.cursor}:{})})])))});
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.decode=options.decode??JSON.parse;
    this.proof=options.organizationProof??false;
  }
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly decode:(json:string)=>unknown;
  private readonly proof:boolean;

  send(operation: string, secret: Buffer, query: Readonly<Record<string, string>> = {}, signal?: AbortSignal): Promise<unknown> {
    const spec = Object.hasOwn(this.destination.operations, operation) ? this.destination.operations[operation] : undefined;
    if (!spec || Object.entries(query).some(([name, value]) => !spec.query?.includes(name) || typeof value !== 'string' || !(name===spec.cursor?/^[\x20-\x7e]{1,1024}$/:/^[A-Za-z0-9_-]{1,128}$/).test(value))) return Promise.reject(new SecretError('connector_destination_invalid'));
    if (!secret.length || secret.length > 4096 || !secret.every(byte => byte >= 0x21 && byte <= 0x7e)) return Promise.reject(new SecretError('credential_invalid'));
    const search = new URLSearchParams(query).toString();
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: SecretCode | SecretError | null, value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (code) reject(code instanceof SecretError ? code : new SecretError(code)); else resolve(value);
      };
      const cancel = () => { finish('connector_cancelled'); req.destroy(); };
      const req = request({protocol: 'https:', hostname: this.destination.host, port: this.destination.port, path: spec.path + (search ? '?' + search : ''), method: 'GET', agent: this.#agent, rejectUnauthorized: true, headers: {authorization: `Bearer ${secret.toString('ascii')}`, accept: 'application/json'}}, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) { finish('connector_redirect'); response.destroy(); return; }
        if (status < 200 || status >= 300) { finish(new ConnectorStatus(status,response.headers['retry-after'])); response.destroy(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.maxBytes) { finish('connector_response_too_large'); response.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        response.on('end', () => {
          if (done) return;
          try { const data=this.decode(Buffer.concat(chunks).toString('utf8'));finish(null,this.proof?{data,organization:organizationProof(response.rawHeaders)}:data); }
          catch { finish('connector_invalid_response'); }
        });
        response.on('error', () => finish('connector_failed'));
        response.on('aborted', () => finish('connector_failed'));
      });
      req.on('error', () => finish('connector_failed'));
      timer = setTimeout(() => { finish('connector_timeout'); req.destroy(); }, this.timeoutMs);
      signal?.addEventListener('abort', cancel, {once: true});
      if (signal?.aborted) cancel(); else req.end();
    }).catch(error => { throw error instanceof SecretError ? error : new SecretError('connector_failed'); });
  }
  close(): void { this.#agent.destroy(); }
}
