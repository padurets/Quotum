import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpsServer} from 'node:https';
import {createServer as httpServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {ConnectorTransport} from '../connectors/index.js';
import {SecretError} from '../secrets/index.js';
import {TLS_CERT, TLS_KEY} from './fixtures/connector-tls.fixture.js';

const CANARY = Buffer.from('CANARY_PRIVATE_TRANSPORT_0123456789');
const fails = (code: string) => (error: unknown) => error instanceof SecretError && error.code === code && !error.message.includes(CANARY.toString());

test('connector uses only fixed HTTPS operations, validates TLS, refuses redirects, and bounds the exchange', async t => {
  let redirected = 0, sent = 0;
  const target = httpServer((_req, res) => { redirected++; res.end('unexpected'); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const server = httpsServer({key: TLS_KEY, cert: TLS_CERT}, (req, res) => {
    sent++;
    assert.equal(req.headers.authorization, `Bearer ${CANARY.toString()}`);
    if (req.url === '/redirect') { res.writeHead(302, {location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/`}); res.end(); }
    else if (req.url === '/large') res.end('x'.repeat(1100));
    else if (req.url === '/bad') res.end('{bad');
    else if (req.url === '/slow') res.writeHead(200);
    else if (req.url === '/status') { res.writeHead(401); res.end(CANARY); }
    else res.end('{"balance":12,"untrusted":"ignored by mapper"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); target.closeAllConnections(); target.close(); });
  const destination = {host: '127.0.0.1', port: (server.address() as AddressInfo).port, operations: Object.fromEntries(['balance', 'redirect', 'large', 'bad', 'slow', 'status'].map(name => [name, {path: '/' + name}]))};
  const transport = new ConnectorTransport(destination, {ca: TLS_CERT, timeoutMs: 200, maxBytes: 1024});
  t.after(() => transport.close());
  destination.operations.balance.path = '//elsewhere.example';
  destination.host = 'elsewhere.example';
  assert.deepEqual(await transport.send('balance', CANARY), {balance: 12, untrusted: 'ignored by mapper'});
  const untrusted = new ConnectorTransport({...destination, host: '127.0.0.1', operations: {balance: {path: '/balance'}}}); t.after(() => untrusted.close());
  await assert.rejects(untrusted.send('balance', CANARY), fails('connector_failed'));
  await assert.rejects(transport.send('redirect', CANARY), fails('connector_redirect'));
  assert.equal(redirected, 0);
  await assert.rejects(transport.send('large', CANARY), fails('connector_response_too_large'));
  await assert.rejects(transport.send('bad', CANARY), fails('connector_invalid_response'));
  await assert.rejects(transport.send('status', CANARY), fails('connector_status'));
  await assert.rejects(transport.send('slow', CANARY), fails('connector_timeout'));
  const before = sent;
  for (const operation of ['https://elsewhere.example/balance', 'http://127.0.0.1/', '/balance', '__proto__']) await assert.rejects(transport.send(operation, CANARY), fails('connector_destination_invalid'));
  await assert.rejects(transport.send('balance', CANARY, {url: 'https://elsewhere.example'}), fails('connector_destination_invalid'));
  await assert.rejects(transport.send('balance', Buffer.concat([CANARY, Buffer.from('\r\n')])), fails('credential_invalid'));
  assert.equal(sent, before, 'invalid destinations and keys never leave the process');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(transport.send('balance', CANARY, {}, abort.signal), fails('connector_cancelled'));
});

test('caller cannot introduce an HTTP URL, userinfo, another endpoint or a malformed port', () => {
  const base = {host: 'example.com', port: 443, operations: {balance: {path: '/balance'}}};
  for (const change of [{host: 'http://example.com'}, {host: 'user@example.com'}, {host: 'EXAMPLE.COM'}, {port: 0}, {port: 65536}, {operations: {balance: {path: '//elsewhere.example?secret=x'}}}]) assert.throws(() => new ConnectorTransport({...base, ...change}), fails('connector_destination_invalid'));
});

test('even Node environment proxy mode never proxies a connector credential', async t => {
  let proxyCalls = 0, directCalls = 0;
  const proxy = httpServer((_req, res) => { proxyCalls++; res.end('unexpected'); });
  proxy.on('connect', (_req, socket) => { proxyCalls++; socket.destroy(); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const server = httpsServer({key: TLS_KEY, cert: TLS_CERT}, (_req, res) => { directCalls++; res.end('{"ok":true}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); server.closeAllConnections(); server.close(); });
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const script = `import {ConnectorTransport} from ${JSON.stringify(new URL('../connectors/transport.ts', import.meta.url).href)}; import {TLS_CERT} from ${JSON.stringify(new URL('./fixtures/connector-tls.fixture.ts', import.meta.url).href)}; const client = new ConnectorTransport({host:'127.0.0.1',port:${(server.address() as AddressInfo).port},operations:{balance:{path:'/balance'}}},{ca:TLS_CERT}); try {await client.send('balance',Buffer.from('synthetic-transport-key'));process.stdout.write('ok');} finally {client.close();}`;
  const child = spawn(process.execPath, ['--use-env-proxy', '--import', 'tsx', '--input-type=module', '-e', script], {env: {...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: '', http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, no_proxy: '', NODE_USE_ENV_PROXY: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill());
  let output = '', error = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'isolated proxy probe exits successfully');
  assert.equal(output, 'ok'); assert.equal(error.includes('synthetic-transport-key'), false);
  assert.equal(directCalls, 1); assert.equal(proxyCalls, 0);
});
