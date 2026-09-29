const {test} = require('node:test');
const assert = require('node:assert/strict');
const {allowed, mayInvoke, external, navigation} = require('./policy.cjs');
const hub = 'http://127.0.0.1:23456/local?key=fixture';
const {EventEmitter} = require('node:events');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

// Run the real main process handlers with a web view whose navigations commit
// only when the test asks. No Electron, display, filesystem writes or clients.
async function mainProcess({cursor = () => ({x: 790, y: 590}), displays = [{workArea: {x: 0, y: 0, width: 800, height: 600}}], backend = '', env = {}, startup = [], panelHeight, nativePanel = false, panelRequest, deferClose = false} = {}) {
  let channel;
  let window;
  const windows = [];
  let invoke;
  const navigations = [];
  const sent = [];
  const traffic = [];
  const quits = [];
  let gone = false;
  let now = 0;
  const timers = [];
  const closing = [];
  const later = (run, delay) => { const timer = {run, at: now + delay, active: true, unref() {}}; timers.push(timer); return timer; };
  const cancel = timer => { if (timer) timer.active = false; };
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setDesktopName() {}, enableSandbox() {}, setPath() {},
    whenReady: () => Promise.resolve(), quit() { quits.push('quit'); },
    commandLine: {getSwitchValue: () => backend},
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options; this.destroyed = false; this.size = [options.width, options.height];
      windows.push(this);
      window = this;
      this.url = '';
      const frame = this;
      this.webContents = Object.assign(new EventEmitter(), {
        getURL: () => this.url, setWindowOpenHandler() {},
        // As Electron's does once the page's renderer is gone: its frame cannot be read.
        mainFrame: {get url() { if (gone) throw new Error('Render frame was disposed'); return frame.url; }},
        // Messages are made inside the script's own context: compared as JSON.
        send: (name, ...args) => sent.push(JSON.stringify([name, ...args])),
      });
    }
    setMenu() {}
    setShape(rects) { this.shape = rects; }
    getNativeWindowHandle() { const handle = Buffer.alloc(8); handle.writeUInt32LE(windows.indexOf(this) + 100); return handle; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() { this.visible = true; this.shows = (this.shows ?? 0) + 1; }
    showInactive() { this.show(); }
    focus() {}
    close() {
      if (this.destroyed || this.closing) return;
      this.closing = true; this.emit('close'); this.emit('blur');
      const finish = () => { this.visible = false; this.destroyed = true; this.emit('closed'); if (windows.every(w => w.destroyed)) app.emit('window-all-closed'); };
      if (deferClose) closing.push(finish); else finish();
    }
    getBounds() { return {x: this.position?.[0] ?? 0, y: this.position?.[1] ?? 0, width: this.size[0], height: this.size[1]}; }
    setPosition(x, y) { this.position = [x, y]; }
    getContentSize() { return this.size; }
    setContentSize(w, h) { this.size = [w, h]; }
    loadURL(url) { navigations.push(url); return new Promise((_, reject) => { this.failNavigation = code => reject(Object.assign(new Error('private entry URL'), {code})); }); }
  }
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return {
        app, BrowserWindow, ipcMain: {handle(_, handler) { invoke = handler; }, on() {}},
        protocol: {registerSchemesAsPrivileged() {}, handle() {}},
        session: {defaultSession: {setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}}},
        screen: {
          getPrimaryDisplay: () => displays[0],
          getAllDisplays: () => displays, getDisplayMatching: () => displays[0], getCursorScreenPoint: cursor,
          getDisplayNearestPoint: ({x, y}) => displays.find(({workArea: a}) => x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height) ?? displays[0],
        },
      };
      if (name === 'node:net') return {Socket: class extends EventEmitter {
        constructor() { super(); channel = this; }
        setEncoding() {}
        write(data) { traffic.push(JSON.parse(data)); }
      }};
      if (name === 'node:fs') return {mkdirSync() {}, readFileSync() { throw new Error('no saved geometry'); }};
      if (name === 'node:perf_hooks') return {performance: {now: () => now}};
      return require(name);
    },
    process: {argv: [], env, on() {}}, __dirname, URL, Buffer, setTimeout: later, clearTimeout: cancel,
  });
  vm.runInContext(readFileSync(`${__dirname}/main.cjs`, 'utf8'), context);
  const deliver = (...messages) => channel.emit('data', messages.map(message => JSON.stringify(message) + '\n').join(''));
  deliver({type: 'init', profile: '/isolated/profile', geometry: '/isolated/window.json', panelHeight, nativePanel, panelRequest}, ...startup);
  await new Promise(setImmediate);
  return {
    navigations, deliver, sent, traffic, quits, windows,
    invoke: (...args) => invoke(...args),
    commit(url) { window.url = url; window.webContents.emit('did-finish-load'); },
    crash() { gone = true; },
    tick(ms) { now += ms; for (const timer of timers) if (timer.active && timer.at <= now) { timer.active = false; timer.run(); } },
    finishClosing() { for (const finish of closing.splice(0)) finish(); },
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

test("the app's state goes only to the board of the hub's current start", async () => {
  const main = await mainProcess();
  main.deliver({type: 'state', generation: 1, url: hub});
  main.commit('http://127.0.0.1:23456/');
  main.deliver({type: 'app_state', generation: 1, state: {seq: 1}});
  assert.deepEqual(main.sent, [JSON.stringify(['quotum:state', {seq: 1}])]);
  main.sent.length = 0;
  main.deliver({type: 'app_state', generation: 0, state: {seq: 2}});
  assert.deepEqual(main.sent, [], 'of an earlier start');
  main.commit('https://example.org/');
  main.deliver({type: 'app_state', generation: 1, state: {seq: 3}});
  assert.deepEqual(main.sent, [], 'a page of another origin in the window');
  main.deliver({type: 'state', generation: 2, url: 'quotum://localhost/index.html'});
  main.commit('quotum://localhost/index.html');
  main.deliver({type: 'app_state', generation: 2, state: {seq: 4}});
  assert.deepEqual(main.sent, [], "the app's own page");
});

test("the app's state for a page whose renderer is gone is dropped, and the window stays", async () => {
  const main = await mainProcess();
  main.deliver({type: 'state', generation: 1, url: hub});
  main.commit('http://127.0.0.1:23456/');
  main.crash();
  main.deliver({type: 'app_state', generation: 1, state: {seq: 1}}, {type: 'state', generation: 2, url: 'quotum://localhost/index.html'});
  assert.deepEqual([main.sent, main.quits], [[], []]);
  assert.equal(main.navigations.at(-1), 'quotum://localhost/index.html', 'what came after it is heard');
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


test('compact capabilities never include settings, takeover or arbitrary geometry', () => {
  for (const command of ['app_state', 'reenter', 'open_main', 'close_panel', 'report_panel_height']) assert.ok(mayInvoke(hub, hub, command, 'compact'));
  for (const command of ['save_settings', 'save_desktop_settings', 'take_over', 'set_autostart', 'quit']) assert.equal(mayInvoke(hub, hub, command, 'compact'), false);
  for (const command of ['open_main', 'close_panel', 'report_panel_height']) assert.equal(mayInvoke(hub, hub, command, 'main'), false);
  assert.equal(mayInvoke(hub, hub, 'app_state', 'spoofed'), false);
  assert.equal(mayInvoke('https://foreign.invalid', hub, 'close_panel', 'compact'), false);
});

test('two surfaces keep separate geometry and reject commands from subframes or a closed instance', async () => {
  const main = await mainProcess();
  main.deliver({type: 'state', generation: 1, url: hub});
  main.deliver({type: 'focus', role: 'compact'});
  assert.equal(main.windows.length, 2);
  const [board, panel] = main.windows;
  assert.equal(panel.options.width, 400);
  assert.equal(panel.options.frame, false);
  assert.equal(board.options.frame, true);
  main.navigations.length = 0;
  main.deliver({type: 'state', generation: 1, url: hub, force: true, role: 'compact'});
  assert.equal(main.navigations.length, 1, 'reenter affects only the requesting surface');
  assert.ok(main.navigations.at(-1).endsWith('&view=compact'));
  panel.url = 'http://127.0.0.1:23456/compact';
  assert.throws(() => main.invoke({sender: panel.webContents, senderFrame: panel.webContents.mainFrame}, 'save_settings', {role: 'main'}), /not the board/);
  assert.throws(() => main.invoke({sender: panel.webContents, senderFrame: {}}, 'app_state'), /not the board/);
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 1000});
  assert.deepEqual(panel.size, [400, 480]);
  assert.deepEqual(board.size, [1280, 800]);
  main.deliver({type: 'panel', instance: 1, generation: 1, action: 'close'});
  assert.equal(panel.destroyed, false);
  panel.close();
  assert.throws(() => main.invoke({sender: panel.webContents, senderFrame: panel.webContents.mainFrame}, 'app_state'), /not the board/);
  main.deliver({type: 'focus', role: 'compact'});
  const reopened = main.windows.at(-1);
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'close'});
  assert.equal(reopened.destroyed, false);
  assert.equal(board.destroyed, false);
});


test('activation coordinates keep the compact surface inside its work area', async () => {
  const main = await mainProcess();
  main.deliver({type: 'state', generation: 1, url: hub});
  main.deliver({type: 'focus', role: 'compact', anchor: [790, 590]});
  const panel = main.windows.at(-1);
  panel.emit('ready-to-show');
  assert.deepEqual(panel.position, [390, 410]);
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 1000});
  assert.deepEqual(panel.size, [400, 480]);
  assert.deepEqual(panel.position, [390, 110]);
});

test('a tray menu uses its monitor on XWayland and keeps that anchor through content resizing', async () => {
  let point = {x: 1800, y: 900};
  const main = await mainProcess({
    cursor: () => point, backend: 'x11', env: {WAYLAND_DISPLAY: 'wayland-0'},
    displays: [{workArea: {x: 0, y: 0, width: 800, height: 600}}, {workArea: {x: 800, y: 0, width: 1200, height: 1000}}],
  });
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'focus', role: 'compact'});
  const panel = main.windows.at(-1);
  panel.emit('ready-to-show');
  assert.deepEqual(panel.position, [1400, 720]);
  point = {x: 400, y: 200};
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 1000});
  assert.deepEqual(panel.size, [400, 800], 'height comes from the activation monitor');
  assert.deepEqual(panel.position, [1400, 100], 'moving the pointer does not move an open panel');
  main.deliver({type: 'focus', role: 'compact'});
  assert.deepEqual(panel.size, [400, 480]);
  assert.deepEqual(panel.position, [0, 0], 'a new menu activation uses its current monitor');
});

test('native Wayland never asks for unsupported global pointer coordinates', async () => {
  const main = await mainProcess({backend: 'wayland', cursor() { throw new Error('unsupported global pointer'); }});
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'focus', role: 'compact', anchor: [790, 590]});
  const panel = main.windows.at(-1);
  panel.emit('ready-to-show');
  assert.equal(panel.position, undefined);
  assert.deepEqual(panel.size, [400, 180]);
});

test('the tray toggles a visible or loading panel and consumes the preceding blur of the same click', async () => {
  let point = {x: 790, y: 590};
  const main = await mainProcess({cursor: () => point});
  main.deliver({type: 'state', generation: 1, url: hub});
  const toggle = () => main.deliver({type: 'focus', role: 'compact', toggle: true});
  toggle();
  const first = main.windows.at(-1);
  assert.equal(first.visible, true, 'the native panel appears before the page is ready');
  toggle();
  assert.equal(first.destroyed, true, 'a second click also cancels a loading panel');
  first.emit('ready-to-show');
  assert.equal(first.shows, 1, 'a late ready event cannot reveal it again');
  toggle();
  const second = main.windows.at(-1);
  second.emit('blur');
  main.tick(80);
  toggle();
  assert.equal(main.windows.at(-1), second, 'the tray click that caused the blur must not reopen the panel');
  toggle();
  const third = main.windows.at(-1);
  assert.equal(third.destroyed, false, 'the next distinct activation can open it');
  point = {x: 50, y: 50};
  third.emit('blur');
  point = {x: 790, y: 590};
  main.tick(30);
  toggle();
  assert.notEqual(main.windows.at(-1), third, 'an outside click followed by a tray click is a new request');
});

test('queued tray activations retain their order and the engine exits after the gesture ends', async () => {
  const main = await mainProcess({startup: [
    {type: 'focus', role: 'compact', toggle: true},
    {type: 'focus', role: 'compact', toggle: true},
  ]});
  assert.equal(main.windows.filter(w => !w.destroyed).length, 1, 'two activations during startup leave only the main window');
  main.windows[0].close();
  main.tick(499);
  assert.deepEqual(main.quits, []);
  main.tick(1);
  assert.deepEqual(main.quits, ['quit'], 'no permanent renderer or engine cache');
});

test('only the panel height is reused when its renderer is recreated', async () => {
  const main = await mainProcess({panelHeight: 900});
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'focus', role: 'compact'});
  const panel = main.windows.at(-1);
  assert.deepEqual(panel.size, [400, 480], 'cached height is still clamped to this monitor');
  assert.equal(panel.options.height, 480, 'even the hidden window starts inside the monitor limit');
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 250});
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'close'});
  main.deliver({type: 'focus', role: 'compact'});
  assert.deepEqual(main.windows.at(-1).size, [400, 250]);
  assert.deepEqual(main.windows[0].size, [1280, 800]);
});

test('a tall monitor lets the compact panel grow beyond 600 pixels and shrink with its content', async () => {
  const main = await mainProcess({
    panelHeight: 784,
    cursor: () => ({x: 4400, y: 220}),
    displays: [{workArea: {x: 1200, y: 207, width: 3440, height: 1404}}],
  });
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'focus', role: 'compact'});
  const panel = main.windows.at(-1);
  assert.equal(panel.options.height, 784, 'the cached large panel has no fixed pixel ceiling');
  assert.deepEqual(panel.size, [400, 784]);
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 264});
  assert.deepEqual(panel.size, [400, 264], 'less content shrinks the window');
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 2000});
  assert.deepEqual(panel.size, [400, 1123], 'a large list is bounded by the work area');
  assert.deepEqual(panel.position, [4000, 207], 'the top tray anchor stays put');
});

test('rapid toggles retain their final intent while the previous renderer is closing', async () => {
  for (const count of [2, 3, 4]) {
    const main = await mainProcess({deferClose: true, startup: Array.from({length: count}, () => ({type: 'focus', role: 'compact', toggle: true}))});
    main.finishClosing();
    const panels = main.windows.filter(w => w.options.frame === false && !w.destroyed);
    assert.equal(panels.length, count % 2, `${count} queued activations`);
  }
  const main = await mainProcess({deferClose: true});
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'focus', role: 'compact', toggle: true});
  const panel = main.windows.at(-1);
  panel.url = 'http://127.0.0.1:23456/compact';
  main.deliver({type: 'focus', role: 'compact', toggle: true});
  assert.throws(() => main.invoke({sender: panel.webContents, senderFrame: panel.webContents.mainFrame}, 'open_main'), /not the board/);
  main.deliver({type: 'focus', role: 'compact', toggle: true}, {type: 'focus', role: 'main'});
  main.finishClosing();
  assert.equal(main.windows.filter(w => !w.destroyed).length, 1, 'opening the board cancels a pending panel reopen');
});

test('closing a loading panel is not a navigation failure, but a live page failing still is', async () => {
  const main = await mainProcess();
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'focus', role: 'compact'});
  const panel = main.windows.at(-1);
  panel.close();
  panel.failNavigation('ERR_FAILED');
  await new Promise(setImmediate);
  assert.deepEqual(main.traffic.filter(m => m.type === 'fault'), []);
  main.windows[0].failNavigation('ERR_FAILED');
  await new Promise(setImmediate);
  assert.deepEqual(main.traffic.filter(m => m.type === 'fault'), [{type: 'fault', process: 'navigation', reason: 'ERR_FAILED'}]);
});


test('a native loader hands off only to a painted panel of its current request', async () => {
  const main = await mainProcess({nativePanel: true});
  main.deliver({type: 'panel_intent', request: 1, open: true, anchor: [790, 590]});
  const panel = main.windows[1];
  assert.equal(panel.visible, undefined);
  main.deliver({type: 'panel_reveal', request: 1, instance: 2});
  assert.equal(panel.visible, undefined, 'never reveal an unpainted browser');
  panel.emit('ready-to-show');
  assert.deepEqual(main.traffic.filter(m => m.type === 'panel_ready'), [{type: 'panel_ready', request: 1, instance: 2, handle: 101}]);
  main.deliver({type: 'panel_reveal', request: 0, instance: 2});
  assert.equal(panel.visible, undefined);
  main.deliver({type: 'panel_reveal', request: 1, instance: 2});
  assert.equal(panel.visible, true);
  panel.emit('focus');
  panel.emit('blur');
  assert.equal(panel.destroyed, true);
  assert.deepEqual(main.traffic.filter(m => m.type === 'panel_closed'), [{type: 'panel_closed', request: 1, blur: true}]);
});

test('cancelled native requests cannot reappear after paint or a delayed reveal', async () => {
  const main = await mainProcess({nativePanel: true, deferClose: true});
  main.deliver({type: 'panel_intent', request: 1, open: true}, {type: 'panel_intent', request: 1, open: false});
  const old = main.windows[1];
  main.deliver({type: 'panel_intent', request: 2, open: true});
  old.emit('ready-to-show');
  main.deliver({type: 'panel_reveal', request: 1, instance: 2});
  assert.equal(old.visible, undefined);
  main.finishClosing();
  const current = main.windows[2];
  main.deliver({type: 'panel_intent', request: 1, open: false});
  current.emit('ready-to-show');
  main.deliver({type: 'panel_reveal', request: 2, instance: 3});
  assert.equal(current.visible, true, 'an older cancellation cannot close the newer request');
});


test('the compact surface rounds drawing and pointer input without cropping its centre', async () => {
  const main = await mainProcess();
  main.deliver({type: 'focus', role: 'compact'});
  const panel = main.windows[1];
  const contains = (x,y) => panel.shape.some(r => x >= r.x && x < r.x+r.width && y >= r.y && y < r.y+r.height);
  assert.equal(panel.options.transparent, true);
  assert.equal(contains(0,0), false);
  assert.equal(contains(panel.size[0]-1,panel.size[1]-1), false);
  assert.equal(contains(panel.size[0]/2,panel.size[1]/2), true);
  main.deliver({type: 'panel', instance: 2, generation: -1, action: 'height', height: 300});
  assert.equal(contains(panel.size[0]/2,299), true);
  assert.equal(main.windows[0].shape, undefined);
});
