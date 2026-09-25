const {test} = require('node:test');
const assert = require('node:assert/strict');
const {allowed, mayInvoke, external, navigation} = require('./policy.cjs');
const hub = 'http://127.0.0.1:23456/local?key=fixture';
test('only the current hub origin has the six app commands', () => {
  assert.equal(mayInvoke('http://127.0.0.1:23456/', hub, 'app_state'), true);
  for (const origin of ['http://127.0.0.1:23457/', 'http://localhost:23456/', 'https://example.org/', 'http://user@127.0.0.1:23456/']) assert.equal(mayInvoke(origin, hub, 'app_state'), false);
  assert.equal(mayInvoke(hub, hub, 'read_file'), false);
  assert.equal(mayInvoke(hub, 'quotum://localhost/index.html', 'app_state'), false);
});
test('the startup page can only quit', () => {
  assert.equal(mayInvoke('quotum://localhost/index.html', hub, 'quit'), true);
  assert.equal(mayInvoke('quotum://localhost/index.html', hub, 'save_settings'), false);
  assert.equal(allowed('file:///tmp/page.html', hub), false);
  assert.equal(allowed('quotum://elsewhere/index.html', hub), false);
});
test('external links cannot run programs or carry credentials', () => {
  assert.equal(external('https://github.com/padurets/Quotum'), true);
  for (const url of ['file:///bin/sh', 'javascript:alert(1)', 'custom:run', 'https://user:password@example.org/']) assert.equal(external(url), false);
});

test('only main-frame external navigation opens the browser', () => {
  assert.equal(navigation('https://example.org/', hub, true), 'external');
  assert.equal(navigation('https://example.org/', hub, false), 'deny');
  assert.equal(navigation('http://127.0.0.1:23456/', hub, true), 'allow');
  assert.equal(navigation('file:///tmp/example', hub, true), 'deny');
});
