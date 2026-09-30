import {existsSync, readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import path from 'node:path';
import {atomic, git, locked, ownedMembers, readJson, saveJson} from './system.mjs';

const defaults = {DEV_PORT_START: '8080', DEV_MODE: 'demo', DEV_SET: 'all', DEV_STILL: 'false', DEV_RESETS: '',
  SLOT_CPUS: '4', DEV_ACCESS: 'none', PUBLIC_DOMAIN: '', CODER_WORKSPACE_ID: '', CODER_WORKSPACE_AGENT_NAME: '',
  CODER_WORKSPACE_NAME: '', CODER_WORKSPACE_OWNER_NAME: ''};
const addressKeys = ['QUOTUM_PUBLIC_URL', 'QUOTUM_ALLOWED_HOSTS', 'QUOTUM_TRUST_PROXY', 'QUOTUM_FRAME_ANCESTORS'];
export const configKeys = [...Object.keys(defaults), ...addressKeys, 'QUOTUM_PORT'];

/** A small dotenv grammar: no interpolation, commands, or shell evaluation. */
export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) throw new Error('Invalid .env line; use KEY=value. Original file was preserved.');
    if (Object.hasOwn(values, m[1])) throw new Error(`Duplicate .env key: ${m[1]}`);
    let value = m[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quoted = value.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
      if (!quoted) throw new Error(`Invalid quoted .env value: ${m[1]}`);
      value = quoted[2];
    } else value = value.replace(/\s+#.*$/, '').trim();
    values[m[1]] = value;
  }
  return values;
}
export const envText = root => existsSync(path.join(root, '.env')) ? readFileSync(path.join(root, '.env'), 'utf8') : '';
export function number(value, name, max = 65535) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > max) throw new Error(`Invalid ${name}; expected an integer from 1 to ${max}.`);
  return Number(value);
}
export function config(root, env = process.env) {
  const file = parseEnv(envText(root));
  const c = {...defaults};
  for (const key of configKeys) c[key] = env[key] ?? file[key] ?? c[key];
  // Once saved, the port is a lease, not an inherited shell override.
  c.QUOTUM_PORT = file.QUOTUM_PORT ?? env.QUOTUM_PORT;
  number(c.DEV_PORT_START, 'DEV_PORT_START');
  number(c.SLOT_CPUS, 'SLOT_CPUS', 1024);
  if (c.QUOTUM_PORT !== undefined) number(c.QUOTUM_PORT, 'QUOTUM_PORT');
  if (!['demo', 'hub'].includes(c.DEV_MODE)) throw new Error('DEV_MODE must be demo or hub.');
  if (!['true', 'false'].includes(c.DEV_STILL)) throw new Error('DEV_STILL must be true or false.');
  if (!['none', 'coder'].includes(c.DEV_ACCESS)) throw new Error('DEV_ACCESS must be none or coder.');
  if (c.PUBLIC_DOMAIN && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(c.PUBLIC_DOMAIN)) throw new Error('PUBLIC_DOMAIN must be a DNS suffix without a scheme.');
  for (const key of ['CODER_WORKSPACE_AGENT_NAME', 'CODER_WORKSPACE_NAME', 'CODER_WORKSPACE_OWNER_NAME']) {
    if (c[key] && !/^[a-z0-9][a-z0-9-]*$/i.test(c[key])) throw new Error(`Invalid ${key}.`);
  }
  if (c.QUOTUM_PUBLIC_URL) {
    let url;
    try { url = new URL(c.QUOTUM_PUBLIC_URL); } catch { throw new Error('Invalid QUOTUM_PUBLIC_URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('QUOTUM_PUBLIC_URL must be an HTTP(S) origin without credentials.');
  }
  if (c.QUOTUM_ALLOWED_HOSTS?.split(',').some(host => host.trim() === '*')) throw new Error('Development stands require exact allowed hosts.');
  return c;
}
export function updateEnv(root, changes) {
  let text = envText(root);
  const old = parseEnv(text);
  const additions = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!configKeys.includes(key) || typeof value !== 'string' || /[\r\n"']/.test(value)) throw new Error(`Cannot write generated setting: ${key}`);
    const line = `${key}=${value}`;
    if (Object.hasOwn(old, key)) text = text.replace(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'm'), line);
    else additions.push(line);
  }
  if (additions.length) text += `${text && !text.endsWith('\n') ? '\n' : ''}# Quotum development settings\n${additions.join('\n')}\n`;
  atomic(path.join(root, '.env'), text);
}

/** Probe wildcard IPv4 and IPv6, including listeners bound only on a non-loopback address. */
export async function portFree(port) {
  for (const host of ['0.0.0.0', '::']) {
    const free = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', error => {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
        else if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code) && host === '::') resolve(true);
        else reject(error);
      });
      server.listen({host, port, ipv6Only: true}, () => server.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}

export function treeRoots(ctx) {
  return git(ctx.root, 'worktree', 'list', '--porcelain', '-z').split('\0').filter(v => v.startsWith('worktree ')).map(v => v.slice(9));
}
export function validateState(ctx, state) {
  if (!state) return;
  if (state.version !== 1 || state.root !== ctx.root || typeof state.instance !== 'string' || !/^[a-f0-9-]{36}$/.test(state.instance)) throw new Error('Unsupported or mismatched managed state; local cleanup blocked.');
}
export async function allocate(ctx, c, access, retryFrom) {
  return locked(path.join(ctx.shared, 'allocation.lock'), async () => {
    const reserved = new Map();
    for (const root of treeRoots(ctx)) {
      const p = parseEnv(envText(root)).QUOTUM_PORT;
      if (p) {
        const port = number(p, 'reserved QUOTUM_PORT');
        reserved.set(port, [...(reserved.get(port) ?? []), root]);
      }
    }
    // Removed trees are free only after their managed group is gone. Keep their journal
    // for diagnostics; it never turns a stale publication into a permanent port lease.
    const {readdirSync} = await import('node:fs');
    const dir = path.join(ctx.shared, 'trees');
    if (existsSync(dir)) for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const s = readJson(path.join(dir, file));
      if (!s || s.version !== 1) throw new Error('Unsupported managed registry state.');
      if (s.root !== ctx.root && ownedMembers(s).length) reserved.set(s.port, [...(reserved.get(s.port) ?? []), s.root]);
    }
    const port = c.QUOTUM_PORT && retryFrom === undefined ? number(c.QUOTUM_PORT, 'QUOTUM_PORT') : undefined;
    if (port) {
      if (reserved.get(port)?.some(root => root !== ctx.root)) throw new Error(`Port ${port} is reserved by another tree.`);
      if (access && !(await access.eligible(port))) throw new Error(`Port ${port} has an unknown or different external access policy.`);
      return port;
    }
    const rows = access ? await access.snapshot() : null;
    for (let candidate = retryFrom ?? number(c.DEV_PORT_START, 'DEV_PORT_START'); candidate <= 65535; candidate++) {
      if (reserved.has(candidate) || !(await portFree(candidate)) || (access && !(await access.eligible(candidate, rows)))) continue;
      const inherited = Object.fromEntries(Object.entries(c).filter(([key, value]) => key in defaults && value !== undefined && !Object.hasOwn(parseEnv(envText(ctx.root)), key)));
      updateEnv(ctx.root, {...inherited, QUOTUM_PORT: String(candidate)});
      saveJson(path.join(ctx.local, 'lease.json'), {version: 1, port: candidate, initial: true});
      return candidate;
    }
    throw new Error('No eligible TCP port remains at or above DEV_PORT_START.');
  });
}
