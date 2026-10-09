const {test} = require('node:test');
const assert = require('node:assert/strict');
const {allowed, mayInvoke, external, navigation} = require('./policy.cjs');
const hub = 'http://127.0.0.1:23456/local?key=fixture';
const {EventEmitter} = require('node:events');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

// Run the real main process handlers with a web view whose navigations commit
// only when the test asks. No Electron, display, filesystem writes or clients.
async function mainProcess({cursor = () => ({x: 790, y: 590}), displays = [{workArea: {x: 0, y: 0, width: 800, height: 600}}], backend = '', env = {}, startup = [], panelHeight, nativePanel = false, panelRequest, panelCancelled = false, role, deferClose = false, initialHead, paintMain = true} = {}) {
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
  const immediates = [];
  const flush = () => { let count = 0; while (immediates.length) { assert.ok(count++ < 100, 'reconciliation settles'); immediates.shift()(); } };
  let revision = panelRequest ?? 0;
  let producer = {revision, target: panelCancelled ? 'none' : role ?? 'main'};
  const closing = [];
  const later = (run, delay) => { const timer = {run, at: now + delay, active: true, unref() {}}; timers.push(timer); return timer; };
  const cancel = timer => { if (timer) timer.active = false; };
  const screenEvents = new EventEmitter();
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setDesktopName() {}, enableSandbox() {}, setPath() {},
    getGPUFeatureStatus: () => ({}),
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
    emit(name, ...args) { const result = super.emit(name, ...args); if (name === 'ready-to-show') flush(); return result; }
    setMenu() {}
    setShape(rects) { this.shape = rects; }
    getNativeWindowHandle() { const handle = Buffer.alloc(8); handle.writeUInt32LE(windows.indexOf(this) + 100); return handle; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized === true; }
    restore() { this.minimized = false; this.restores = (this.restores ?? 0) + 1; }
    show() { this.showInactive(); this.focus(); this.afterShow?.(); }
    showInactive() { this.visible = true; this.shows = (this.shows ?? 0) + 1; }
    focus() { this.focuses = (this.focuses ?? 0) + 1; this.focused = true; }
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
        screen: Object.assign(screenEvents, {
          getPrimaryDisplay: () => displays[0],
          getAllDisplays: () => displays, getDisplayMatching: () => displays[0], getCursorScreenPoint: cursor,
          getDisplayNearestPoint: ({x, y}) => displays.find(({workArea: a}) => x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height) ?? displays[0],
        }),
      };
      if (name === 'node:net') return {Socket: class extends EventEmitter {
        constructor() { super(); channel = this; this.chunks = []; }
        setEncoding() {}
        read() { return this.chunks.shift() ?? null; }
        write(data) { traffic.push(JSON.parse(data)); }
      }};
      if (name === 'node:fs') return {mkdirSync() {}, readFileSync() { throw new Error('no saved geometry'); }};
      if (name === 'node:perf_hooks') return {performance: {now: () => now}};
      return require(name);
    },
    process: {argv: [], env, versions: {}, on() {}}, __dirname, URL, Buffer, setTimeout: later, clearTimeout: cancel, setImmediate: run => { immediates.push(run); return run; },
  });
  vm.runInContext(readFileSync(`${__dirname}/main.cjs`, 'utf8'), context);
  // Tests specify complete foreground snapshots. Revision omission is just
  // shorthand for a new controller request, never a GUI-generated revision.
  const encode = message => {
    if (message.type === 'foreground') {
      const head = {...message.head, revision: message.head.revision ?? ++revision};
      revision = Math.max(revision, head.revision);
      producer = head;
      return {...message, head};
    }
    return message;
  };
  const raw = (chunk, settle = true) => { channel.chunks.push(chunk); channel.emit('readable'); if (settle) flush(); };
  const deliver = (...messages) => raw(messages.map(message => JSON.stringify(encode(message)) + '\n').join(''));
  deliver({type: 'init', profile: '/isolated/profile', geometry: '/isolated/window.json', panelHeight, nativePanel, foreground: initialHead ?? producer}, ...startup);
  await new Promise(setImmediate);
  flush();
  if (paintMain) for (const board of windows.filter(w => w.options.frame)) board.emit('ready-to-show');
  return {
    navigations, deliver, raw, flush, sent, traffic, quits, windows, screenEvents,
    invoke: (...args) => invoke(...args),
    commit(url) { window.url = url; window.webContents.emit('did-finish-load'); },
    crash() { gone = true; },
    tick(ms) { now += ms; for (const timer of timers) if (timer.active && timer.at <= now) { timer.active = false; timer.run(); } },
    finishClosing() { for (const finish of closing.splice(0)) finish(); flush(); },
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

test('only the current hub origin has the app commands', () => {
  assert.equal(mayInvoke('http://127.0.0.1:23456/', hub, 'app_state'), true);
  for (const origin of ['http://127.0.0.1:23457/', 'http://localhost:23456/', 'https://example.org/', 'http://user@127.0.0.1:23456/']) assert.equal(mayInvoke(origin, hub, 'app_state'), false);
  assert.equal(mayInvoke(hub, hub, 'read_file'), false);
  assert.equal(mayInvoke(hub, 'quotum://localhost/index.html', 'app_state'), false);
});
test('trusted-key reset belongs only to a live main frame and rejects caller arguments', async () => {
  assert.equal(mayInvoke(hub, hub, 'reset_secret_key', 'main'), true);
  for (const role of ['compact', 'loader', 'unknown']) assert.equal(mayInvoke(hub, hub, 'reset_secret_key', role), false);
  for (const url of ['quotum://localhost/index.html', 'https://foreign.example/', 'http://localhost:23456/']) assert.equal(mayInvoke(url, hub, 'reset_secret_key'), false);
  const main = await mainProcess(); main.deliver({type:'state', generation:1, url:hub});
  const board = main.windows[0]; board.url = 'http://127.0.0.1:23456/';
  const event = {sender:board.webContents, senderFrame:board.webContents.mainFrame};
  assert.throws(() => main.invoke(event, 'reset_secret_key', {key:'synthetic'}), /secret_key_reset_invalid/);
  assert.throws(() => main.invoke({...event, senderFrame:{}}, 'reset_secret_key'), /not the board/);
  const pending = main.invoke(event, 'reset_secret_key').catch(() => {});
  assert.deepEqual(main.traffic.at(-1).request, {command:'reset_secret_key'});
  board.close(); assert.throws(() => main.invoke(event, 'reset_secret_key'), /not the board/);
  main.deliver({type:'reply', id:main.traffic.at(-1).id, error:'closed'}); await pending;
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
  main.deliver({type: 'foreground', head: {target: 'compact'}});
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
  main.deliver({type: 'foreground', head: {target: 'compact'}});
  const reopened = main.windows.at(-1);
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'close'});
  assert.equal(reopened.destroyed, false);
  assert.equal(board.destroyed, false);
});


test('activation coordinates keep the compact surface inside its work area', async () => {
  const main = await mainProcess();
  main.deliver({type: 'state', generation: 1, url: hub});
  main.deliver({type: 'foreground', head: {target: 'compact', anchor: [790, 590]}});
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
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'foreground', head: {target: 'compact'}});
  const panel = main.windows.at(-1);
  panel.emit('ready-to-show');
  assert.deepEqual(panel.position, [1400, 720]);
  point = {x: 400, y: 200};
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 1000});
  assert.deepEqual(panel.size, [400, 800], 'height comes from the activation monitor');
  assert.deepEqual(panel.position, [1400, 100], 'moving the pointer does not move an open panel');
  main.deliver({type: 'foreground', head: {target: 'compact'}});
  const relocated = main.windows.at(-1);
  assert.deepEqual(relocated.size, [400, 480]);
  assert.equal(relocated.getBounds().x, 0);
  assert.equal(relocated.getBounds().y, 0, 'a new presentation uses its activation monitor');
});

test('native Wayland never asks for unsupported global pointer coordinates', async () => {
  const main = await mainProcess({backend: 'wayland', cursor() { throw new Error('unsupported global pointer'); }});
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'foreground', head: {target: 'compact', anchor: [790, 590]}});
  const panel = main.windows.at(-1);
  panel.emit('ready-to-show');
  assert.equal(panel.position, undefined);
  assert.deepEqual(panel.size, [400, 180]);
});



test('only the panel height is reused when its renderer is recreated', async () => {
  const main = await mainProcess({panelHeight: 900});
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'foreground', head: {target: 'compact'}});
  const panel = main.windows.at(-1);
  assert.deepEqual(panel.size, [400, 480], 'cached height is still clamped to this monitor');
  assert.equal(panel.options.height, 480, 'even the hidden window starts inside the monitor limit');
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 250});
  main.deliver({type: 'foreground', head: {target: 'none'}});
  main.deliver({type: 'foreground', head: {target: 'compact'}});
  assert.deepEqual(main.windows.at(-1).size, [400, 250]);
  assert.deepEqual(main.windows[0].size, [1280, 800]);
});

test('a tall monitor lets the compact panel grow beyond 600 pixels and shrink with its content', async () => {
  const main = await mainProcess({
    panelHeight: 784,
    cursor: () => ({x: 4400, y: 220}),
    displays: [{workArea: {x: 1200, y: 207, width: 3440, height: 1404}}],
  });
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'foreground', head: {target: 'compact'}});
  const panel = main.windows.at(-1);
  assert.equal(panel.options.height, 784, 'the cached large panel has no fixed pixel ceiling');
  assert.deepEqual(panel.size, [400, 784]);
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 264});
  assert.deepEqual(panel.size, [400, 264], 'less content shrinks the window');
  main.deliver({type: 'panel', instance: 2, generation: 1, action: 'height', height: 2000});
  assert.deepEqual(panel.size, [400, 1123], 'a large list is bounded by the work area');
  assert.deepEqual(panel.position, [4000, 207], 'the top tray anchor stays put');
});


test('closing a loading panel is not a navigation failure, but a live page failing still is', async () => {
  const main = await mainProcess();
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'foreground', head: {target: 'compact'}});
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
  main.deliver({type: 'foreground', head: {revision: 1, target: 'compact', anchor: [790, 590]}});
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
  assert.deepEqual(main.traffic.filter(m => m.type === 'panel_closed'), [{type: 'panel_closed', request: 1, blur: true, point: [790, 590]}]);
});

test('cancelled native requests cannot reappear after paint or a delayed reveal', async () => {
  const main = await mainProcess({nativePanel: true, deferClose: true});
  main.deliver({type: 'foreground', head: {revision: 1, target: 'compact'}});
  main.deliver({type: 'foreground', head: {revision: 1, target: 'none'}});
  const old = main.windows[1];
  main.deliver({type: 'foreground', head: {revision: 2, target: 'compact'}});
  old.emit('ready-to-show');
  main.deliver({type: 'panel_reveal', request: 1, instance: 2});
  assert.equal(old.visible, undefined);
  main.finishClosing();
  const current = main.windows[2];
  main.deliver({type: 'foreground', head: {revision: 1, target: 'none'}});
  current.emit('ready-to-show');
  main.deliver({type: 'panel_reveal', request: 2, instance: 3});
  assert.equal(current.visible, true, 'an older cancellation cannot close the newer request');
});

test('cancellation is terminal even when it overtakes the opening worker', async () => {
  const main = await mainProcess({nativePanel: true});
  main.deliver({type: 'foreground', head: {revision: 1, target: 'none'}}, {type: 'foreground', head: {revision: 1, target: 'compact'}});
  assert.equal(main.windows.length, 1, 'no cancelled renderer is created');
  main.windows[0].close();
  main.tick(60000);
  assert.deepEqual(main.quits, ['quit']);
});

test('a controller cancellation before the initial handshake creates no renderer', async () => {
  const config = {nativePanel: true, role: 'compact', panelRequest: 1, panelCancelled: true};
  const cancelled = await mainProcess(config);
  cancelled.deliver({type: 'foreground', head: {revision: 1, target: 'compact'}});
  assert.equal(cancelled.windows.length, 0);
  cancelled.tick(60000);
  assert.deepEqual(cancelled.quits, ['quit']);
  const reopened = await mainProcess({...config, startup: [{type: 'foreground', head: {revision: 2, target: 'compact'}}]});
  assert.equal(reopened.windows.length, 1, 'a later request still opens on this engine');
  reopened.tick(1000);
  assert.deepEqual(reopened.quits, []);
});

test('Escape dismisses a compact window before any page or React handler loads', async () => {
  const main = await mainProcess({backend: 'wayland'});
  main.deliver({type: 'foreground', head: {target: 'compact'}});
  const panel = main.windows[1];
  let prevented = false;
  panel.webContents.emit('before-input-event', {preventDefault() { prevented = true; }}, {type: 'keyDown', key: 'Escape'});
  assert.equal(prevented, true);
  assert.equal(panel.destroyed, true);
  assert.equal(main.windows[0].destroyed, false);
});

test('an open panel follows display work-area changes without new content', async () => {
  const displays = [{workArea: {x: 0, y: 0, width: 1920, height: 1080}}];
  const main = await mainProcess({displays, panelHeight: 1000, cursor: () => ({x: 1890, y: 1050})});
  main.deliver({type: 'foreground', head: {target: 'compact'}});
  const panel = main.windows[1];
  displays[0].workArea = {x: 0, y: 0, width: 1280, height: 720};
  main.screenEvents.emit('display-metrics-changed');
  assert.deepEqual(panel.getBounds(), {x: 880, y: 144, width: 400, height: 576});
  displays[0].workArea = {x: 200, y: 20, width: 800, height: 600};
  main.screenEvents.emit('display-removed');
  assert.deepEqual(panel.getBounds(), {x: 600, y: 140, width: 400, height: 480});
});


test('the compact surface rounds drawing and pointer input without cropping its centre', async () => {
  const main = await mainProcess();
  main.deliver({type: 'foreground', head: {target: 'compact'}});
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

for (const initial of ['present', 'absent', 'minimized']) test(`queued older main never overtakes the latest compact (${initial})`, async () => {
  const main = await mainProcess({nativePanel: true, initialHead: {revision: 0, target: initial === 'absent' ? 'none' : 'main'}});
  const board = main.windows[0];
  if (initial === 'minimized') board.minimized = true;
  const before = board && {shows: board.shows, focuses: board.focuses, restores: board.restores};
  main.deliver(
    {type: 'foreground', head: {revision: 1, target: 'main'}},
    {type: 'foreground', head: {revision: 2, target: 'compact', anchor: [790, 590]}},
  );
  assert.equal(main.windows.filter(w => w.options.frame).length, initial === 'absent' ? 0 : 1);
  if (board) assert.deepEqual({shows: board.shows, focuses: board.focuses, restores: board.restores}, before, 'no obsolete native main operations');
  const panel = main.windows.at(-1);
  panel.emit('ready-to-show');
  const ready = main.traffic.findLast(m => m.type === 'panel_ready');
  main.deliver({type: 'panel_reveal', request: 2, instance: ready.instance});
  assert.equal(panel.visible, true);
  assert.equal(panel.destroyed, false);
  assert.deepEqual(main.traffic.filter(m => m.type === 'panel_closed'), []);
});

test('a late old worker ticket cannot explicitly close the current panel', async () => {
  const main = await mainProcess({nativePanel: true, deferClose: true});
  main.deliver({type: 'foreground', head: {revision: 2, target: 'compact'}});
  const panel = main.windows.at(-1);
  main.deliver({type: 'foreground', head: {revision: 1, target: 'main'}});
  assert.equal(panel.closing, undefined);
  assert.deepEqual(main.traffic.filter(m => m.type === 'panel_closed'), []);
  panel.emit('ready-to-show');
  main.deliver({type: 'panel_reveal', request: 2, instance: 2});
  assert.equal(panel.visible, true);
});

test('chunk boundaries and a partial later frame never apply the preceding main head', async () => {
  const main = await mainProcess({nativePanel: true});
  const board = main.windows[0];
  const before = board.focuses;
  const old = JSON.stringify({type: 'foreground', head: {revision: 1, target: 'main'}}) + '\n';
  const next = JSON.stringify({type: 'foreground', head: {revision: 2, target: 'compact'}}) + '\n';
  main.raw(old + next.slice(0, 15));
  assert.equal(board.focuses, before);
  main.raw(next.slice(15, -2));
  assert.equal(board.focuses, before);
  main.raw(next.slice(-2));
  assert.equal(board.focuses, before);
  assert.equal(main.windows.at(-1).options.frame, false);
  main.deliver({type: 'foreground', head: {revision: 3, target: 'main'}});
  assert.equal(board.focuses, before + 1, 'a current main request still works');
});

test('separate readable events in the same turn drain before native presentation', async () => {
  const main = await mainProcess();
  const before = main.windows[0].focuses;
  main.raw(JSON.stringify({type: 'foreground', head: {revision: 1, target: 'main'}}) + '\n', false);
  main.raw(JSON.stringify({type: 'foreground', head: {revision: 2, target: 'compact'}}) + '\n', false);
  main.flush();
  assert.equal(main.windows[0].focuses, before);
});

test('startup uses only the latest complete foreground snapshot', async () => {
  const main = await mainProcess({nativePanel: true, startup: [
    {type: 'foreground', head: {revision: 1, target: 'main'}},
    {type: 'foreground', head: {revision: 2, target: 'compact'}},
  ]});
  assert.equal(main.windows.length, 1);
  assert.equal(main.windows[0].options.frame, false);
});

test('a superseded hidden main is retired and late paint cannot reveal it', async () => {
  const main = await mainProcess({nativePanel: true, paintMain: false, deferClose: true});
  const board = main.windows[0];
  main.deliver({type: 'foreground', head: {revision: 1, target: 'compact'}});
  assert.equal(board.closing, true);
  board.emit('ready-to-show');
  assert.equal(board.visible, undefined);
  main.finishClosing();
  assert.equal(board.destroyed, true);
});

test('current main restores the same minimized window and focuses it once', async () => {
  const main = await mainProcess();
  const board = main.windows[0];
  const before = board.focuses;
  board.minimized = true;
  main.deliver({type: 'foreground', head: {target: 'main'}});
  assert.equal(main.windows.length, 1);
  assert.equal(board.restores, 1);
  assert.equal(board.focuses, before + 1);
});

test('finishing a main show cannot reclaim focus taken by a newer native loader', async () => {
  const main = await mainProcess({nativePanel: true, paintMain: false});
  const board = main.windows[0];
  // The native show has completed, but its caller has not resumed. The
  // controller can present a loader while this browser process is stopped.
  board.afterShow = () => { board.focused = false; };
  board.emit('ready-to-show');
  assert.equal(board.visible, true);
  assert.equal(board.focuses, 1, 'show still focuses the requested main');
  assert.equal(board.focused, false, 'no later focus steals the native loader');
});

test('revealing the current native panel focuses it only once', async () => {
  const main = await mainProcess({nativePanel: true, role: 'compact'});
  const panel = main.windows[0];
  panel.emit('ready-to-show');
  const ready = main.traffic.find(message => message.type === 'panel_ready');
  main.deliver({type: 'panel_reveal', request: ready.request, instance: ready.instance});
  assert.equal(panel.visible, true);
  assert.equal(panel.focused, true);
  assert.equal(panel.focuses, 1);
});

test('deferred native close cannot replay an obsolete reopen or ready callback', async () => {
  const main = await mainProcess({nativePanel: true, deferClose: true});
  main.deliver({type: 'foreground', head: {revision: 1, target: 'compact'}});
  const old = main.windows.at(-1);
  main.deliver({type: 'foreground', head: {revision: 1, target: 'none'}});
  main.deliver({type: 'foreground', head: {revision: 2, target: 'compact'}});
  main.deliver({type: 'foreground', head: {revision: 3, target: 'main'}});
  old.emit('ready-to-show');
  main.deliver({type: 'panel_reveal', request: 1, instance: 2});
  main.finishClosing();
  assert.equal(main.windows.filter(w => !w.destroyed).length, 1);
  assert.equal(main.windows[0].options.frame, true);
});

test('renderer commands carry their presentation revision and queued stale actions are rejected', async () => {
  const main = await mainProcess({nativePanel: true});
  main.deliver({type: 'state', generation: 1, url: hub}, {type: 'foreground', head: {revision: 1, target: 'compact'}});
  const panel = main.windows.at(-1);
  panel.url = hub;
  const event = {sender: panel.webContents, senderFrame: panel.webContents.mainFrame};
  const pending = main.invoke(event, 'open_main').catch(() => {});
  assert.equal(main.traffic.findLast(m => m.type === 'request').revision, 1);
  main.raw(JSON.stringify({type: 'foreground', head: {revision: 2, target: 'compact'}}) + '\n', false);
  assert.throws(() => main.invoke(event, 'open_main'), /not the board/);
  main.flush();
  // This is the controller's older direct-action ticket, delivered behind the tray.
  main.deliver({type: 'foreground', head: {revision: 1, target: 'main'}});
  assert.equal(main.windows.at(-1).destroyed, false);
  main.tick(60000);
  await pending;
});

test('a coalesced new compact head retires the old presentation without relabelling its callbacks', async () => {
  const main = await mainProcess({nativePanel: true, deferClose: true});
  main.deliver({type: 'foreground', head: {revision: 1, target: 'compact'}});
  const old = main.windows.at(-1);
  old.emit('ready-to-show');
  main.deliver({type: 'panel_reveal', request: 1, instance: 2});
  old.emit('focus');
  // The controller reduced cancel r1 + reopen r2 before the socket became writable.
  main.deliver({type: 'foreground', head: {revision: 2, target: 'compact'}});
  assert.equal(old.closing, true);
  old.emit('blur');
  old.emit('ready-to-show');
  main.finishClosing();
  const current = main.windows.at(-1);
  assert.notEqual(current, old);
  current.emit('ready-to-show');
  main.deliver({type: 'panel_reveal', request: 1, instance: 2}, {type: 'panel_reveal', request: 2, instance: 3});
  assert.equal(current.visible, true);
  assert.equal(current.destroyed, false);
  assert.deepEqual(main.traffic.filter(m => m.type === 'panel_closed').map(m => m.request), [1]);
});
