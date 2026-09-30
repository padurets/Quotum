import {Agent, request} from 'node:https';
import {SecretError} from '../secrets/crypto.js';

export type Destination = {host: string; port: number; operations: Readonly<Record<string, {path: string; query?: readonly string[]}>>};

/** This transport accepts operations from connector code, never URLs from a caller. */
export class ConnectorTransport {
  #agent: Agent;
  constructor(private readonly destination: Destination, options: {ca?: string; timeoutMs?: number; maxBytes?: number} = {}) {
    if (!/^[a-z0-9.-]+$/.test(destination.host) || destination.host !== destination.host.toLowerCase() || !Number.isInteger(destination.port) || destination.port < 1 || destination.port > 65535 || Object.values(destination.operations).some(op => !/^\/[A-Za-z0-9/_-]*$/.test(op.path))) throw new SecretError('connector_destination_invalid');
    // An explicit agent has no global proxy settings, including Node's environment proxy.
    this.#agent = new Agent({rejectUnauthorized: true, ...(options.ca ? {ca: options.ca} : {})});
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
  }
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  send(operation: string, secret: Buffer, query: Readonly<Record<string, string>> = {}, signal?: AbortSignal): Promise<unknown> {
    const spec = Object.hasOwn(this.destination.operations, operation) ? this.destination.operations[operation] : undefined;
    if (!spec || Object.entries(query).some(([name, value]) => !spec.query?.includes(name) || typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))) return Promise.reject(new SecretError('connector_destination_invalid'));
    if (!secret.length || secret.length > 4096 || !secret.every(byte => byte >= 0x21 && byte <= 0x7e)) return Promise.reject(new SecretError('credential_invalid'));
    const search = new URLSearchParams(query).toString();
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: string | null, value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (code) reject(new SecretError(code)); else resolve(value);
      };
      const cancel = () => { finish('connector_cancelled'); req.destroy(); };
      const req = request({protocol: 'https:', hostname: this.destination.host, port: this.destination.port, path: spec.path + (search ? '?' + search : ''), method: 'GET', agent: this.#agent, rejectUnauthorized: true, headers: {authorization: `Bearer ${secret.toString('ascii')}`, accept: 'application/json'}}, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) { finish('connector_redirect'); response.destroy(); return; }
        if (status < 200 || status >= 300) { finish('connector_status'); response.destroy(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.maxBytes) { finish('connector_response_too_large'); response.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        response.on('end', () => {
          if (done) return;
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish('connector_invalid_response'); }
        });
        response.on('error', () => finish('connector_failed'));
        response.on('aborted', () => finish('connector_failed'));
      });
      req.on('error', () => finish('connector_failed'));
      timer = setTimeout(() => { finish('connector_timeout'); req.destroy(); }, this.timeoutMs);
      signal?.addEventListener('abort', cancel, {once: true});
      if (signal?.aborted) cancel(); else req.end();
    });
  }
  close(): void { this.#agent.destroy(); }
}
