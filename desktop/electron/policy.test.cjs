const {test} = require('node:test');
const assert = require('node:assert/strict');
const {allowed, mayInvoke, external, navigation} = require('./policy.cjs');
const hub = 'http://127.0.0.1:23456/local?key=fixture';
const {EventEmitter} = require('node:events');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

// Run the real main process handlers with a web view whose navigations commit
// only when the test asks. No Electron, display, filesystem writes or clients.
async function mainProcess() {
  let channel;
  let window;
  const navigations = [];
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setDesktopName() {}, enableSandbox() {}, setPath() {},
    whenReady: () => Promise.resolve(), quit() {},
  });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      window = this;
      this.url = '';
      this.webContents = Object.assign(new EventEmitter(), {
        getURL: () => this.url, setWindowOpenHandler() {},
      });
    }
    setMenu() {}
    loadURL(url) { navigations.push(url); return new Promise(() => {}); }
  }
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return {
        app, BrowserWindow, ipcMain: {handle() {}, on() {}},
        protocol: {registerSchemesAsPrivileged() {}, handle() {}},
        session: {defaultSession: {setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}}},
        screen: {getAllDisplays: () => []},
      };
      if (name === 'node:net') return {Socket: class extends EventEmitter {
        constructor() { super(); channel = this; }
        setEncoding() {}
        write() {}
      }};
      if (name === 'node:fs') return {mkdirSync() {}, readFileSync() { throw new Error('no saved geometry'); }};
      return require(name);
    },
    process: {argv: [], on() {}}, __dirname, URL, Buffer, setTimeout, clearTimeout,
  });
  vm.runInContext(readFileSync(`${__dirname}/main.cjs`, 'utf8'), context);
  const deliver = (...messages) => channel.emit('data', messages.map(message => JSON.stringify(message) + '\n').join(''));
  deliver({type: 'init', profile: '/isolated/profile', geometry: '/isolated/window.json'});
  await new Promise(setImmediate);
  return {
    navigations, deliver,
    commit(url) { window.url = url; window.webContents.emit('did-finish-load'); },
  };
}

test('batched restart states replace an uncommitted navigation on the same port', async () => {
  const main = await mainProcess();
  main.deliver({type: 'state', generation: 1, url: hub});
  main.commit('http://127.0.0.1:23456/');
  main.navigations.length = 0;
  const next = 'http://127.0.0.1:23456/local?key=new-start';
  main.deliver(
    {type: 'state', generation: 2, url: 'quotum://localhost/index.html'},
    {type: 'state', generation: 3, url: next},
  );
  assert.deepEqual(main.navigations, ['quotum://localhost/index.html', next]);
  main.commit('quotum://localhost/index.html');
  assert.equal(main.navigations.at(-1), next, 'a late old commit is reconciled');
  main.commit('http://127.0.0.1:23456/');
  main.navigations.length = 0;
  main.deliver({type: 'state', generation: 2, url: 'quotum://localhost/index.html'});
  main.deliver({type: 'state', generation: 3, url: next});
  assert.deepEqual(main.navigations, [], 'old states and unchanged state cannot reload the board');
  main.deliver({type: 'state', generation: 3, url: next, force: true});
  assert.deepEqual(main.navigations, [next], 'explicit reentry still enters with the current key');
});

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
