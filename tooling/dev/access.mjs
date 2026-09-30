import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash, locked, readJson, saveJson} from './system.mjs';

/** Provider records form a reusable pool. Observation never grants deletion rights. */
export class Pool {
  constructor({file, agent, get, post}) {
    Object.assign(this, {file, agent, get, post});
  }
  ledger() {
    const data = readJson(this.file) ?? {version: 1, ports: {}};
    if (data.version !== 1 || !data.ports) throw new Error('Unsupported publication ledger.');
    return data;
  }
  async snapshot() { return this.get(); }
  row(port, rows) { return rows.find(row => row.agent_name === this.agent && row.port === port); }
  matching(row) { return row?.share_level === 'public' && row.protocol === 'http'; }
  async eligible(port, rows = null) {
    const row = this.row(port, rows ?? await this.snapshot());
    return !row || (this.matching(row) && !!this.ledger().ports[port]);
  }
  async observe(port) {
    const row = this.row(port, await this.snapshot());
    if (!row) return this.ledger().ports[port]?.phase === 'intent'
      ? {status: 'unconfirmed', observed: 'absent', evidence: 'Earlier publication outcome is unknown; no matching row is observed and no second POST is sent.'}
      : {status: 'absent'};
    if (!this.matching(row) || !this.ledger().ports[port]) return {status: 'conflict'};
    return {status: 'public', evidence: this.ledger().ports[port].phase === 'acknowledged' ? 'acknowledged pool entry' : 'observed after an unconfirmed request'};
  }
  async publish(port) {
    return locked(`${this.file}.lock`, async () => {
      const data = this.ledger();
      const row = this.row(port, await this.snapshot());
      if (row) {
        if (!this.matching(row) || !data.ports[port]) return {status: 'conflict'};
        const evidence = data.ports[port].phase === 'acknowledged' ? 'acknowledged pool entry' : 'read-only reuse after an unconfirmed request';
        data.ports[port].observedAt = new Date().toISOString();
        saveJson(this.file, data);
        return {status: 'public', evidence};
      }
      if (data.ports[port]?.phase === 'intent') return {status: 'unconfirmed', evidence: 'Earlier request outcome is unknown; no second POST was sent.'};
      const prior = data.ports[port];
      data.ports[port] = {phase: 'intent', requestedAt: new Date().toISOString()};
      saveJson(this.file, data);
      try {
        const created = await this.post({agent_name: this.agent, port, protocol: 'http', share_level: 'public'});
        if (!this.matching(created) || created.agent_name !== this.agent || created.port !== port) throw new Error('Unexpected publication response.');
        data.ports[port] = {phase: 'acknowledged', acknowledgedAt: new Date().toISOString()};
        saveJson(this.file, data);
        return {status: 'public', evidence: 'new publication acknowledged'};
      } catch (error) {
        if (error.code === 'PUBLICATION_REJECTED') {
          if (prior) data.ports[port] = prior;
          else delete data.ports[port];
          saveJson(this.file, data);
          return {status: 'rejected', detail: `Coder API rejected publication (HTTP ${error.status}); retry after correcting access.`};
        }
        return {status: 'unconfirmed', evidence: 'Publication request failed or its response was lost; local stand remains ready.'};
      }
    });
  }
}

export function externalUrl(c, port) {
  if (c.DEV_ACCESS !== 'coder') return c.QUOTUM_PUBLIC_URL || null;
  if (!c.PUBLIC_DOMAIN) throw new Error('Coder access needs PUBLIC_DOMAIN.');
  for (const key of ['CODER_WORKSPACE_AGENT_NAME', 'CODER_WORKSPACE_NAME', 'CODER_WORKSPACE_OWNER_NAME']) {
    if (!c[key]) throw new Error(`Coder access needs ${key}.`);
  }
  return `https://${port}--${c.CODER_WORKSPACE_AGENT_NAME}--${c.CODER_WORKSPACE_NAME}--${c.CODER_WORKSPACE_OWNER_NAME}.${c.PUBLIC_DOMAIN}`;
}

/** Use the CLI's existing login at runtime; never copy it into tree or pool state. */
export async function coderPool(c, env = process.env) {
  if (c.DEV_ACCESS !== 'coder') return null;
  externalUrl(c, 1);
  if (!c.CODER_WORKSPACE_ID) throw new Error('Coder access needs CODER_WORKSPACE_ID.');
  const dir = env.CODER_CONFIG_DIR || path.join(os.homedir(), '.config', 'coderv2');
  let base, token;
  try {
    base = (env.CODER_URL || readFileSync(path.join(dir, 'url'), 'utf8')).trim();
    token = (env.CODER_SESSION_TOKEN || readFileSync(path.join(dir, 'session'), 'utf8')).trim();
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.origin;
    if (!token) throw new Error();
  } catch { throw new Error('Coder CLI login unavailable; sign in with coder login.'); }
  const api = async (suffix, method = 'GET', body) => {
    let response;
    try {
      response = await fetch(`${base}/api/v2/workspaces/${encodeURIComponent(c.CODER_WORKSPACE_ID)}${suffix}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: {'Coder-Session-Token': token, 'Content-Type': 'application/json'},
        ...(body ? {body: JSON.stringify(body)} : {}),
      });
    } catch { throw new Error('Coder API unavailable; local lifecycle remains independent.'); }
    if (!response.ok) throw Object.assign(new Error(`Coder API returned HTTP ${response.status}.`), {
      // Validation/auth denials cannot have published the requested row. Transport
      // failures and server errors retain the uncertain intent instead.
      code: method === 'POST' && [400, 401, 403, 404, 422].includes(response.status) ? 'PUBLICATION_REJECTED' : 'API_ERROR',
      status: response.status,
    });
    try { return await response.json(); } catch { throw new Error('Invalid Coder API response.'); }
  };
  const workspace = await api('');
  const agents = workspace.latest_build?.resources?.flatMap(r => r.agents ?? []) ?? [];
  if (workspace.id !== c.CODER_WORKSPACE_ID || workspace.name !== c.CODER_WORKSPACE_NAME || workspace.owner_name !== c.CODER_WORKSPACE_OWNER_NAME || !agents.some(a => a.name === c.CODER_WORKSPACE_AGENT_NAME)) throw new Error('Configured Coder workspace/agent does not match API metadata.');
  const key = hash(`${base}|${workspace.id}|${c.CODER_WORKSPACE_AGENT_NAME}`);
  return new Pool({
    file: path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'quotum-dev', 'publications', `${key}.json`),
    agent: c.CODER_WORKSPACE_AGENT_NAME,
    get: async () => {
      const data = await api('/port-share');
      if (!Array.isArray(data.shares) || data.shares.some(row => row.workspace_id !== workspace.id)) throw new Error('Invalid Coder share list.');
      return data.shares;
    },
    post: body => api('/port-share', 'POST', body),
  });
}
