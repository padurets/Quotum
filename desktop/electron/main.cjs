'use strict';
// The GUI owns no measuring or account logic. fd 3 belongs only to its Rust parent.
const {app, BrowserWindow, ipcMain, protocol, session, shell, screen} = require('electron');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('./policy.cjs');
app.setName('Quotum');
app.setDesktopName('quotum.desktop');
app.enableSandbox();
if (process.argv.includes('--quotum-software-rendering')) app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme: 'quotum', privileges: {standard: true, secure: true, supportFetchAPI: true}}]);

const channel = new net.Socket({fd: 3, readable: true, writable: true});
channel.setEncoding('utf8');
const send = message => { if (!channel.destroyed) channel.write(`${JSON.stringify(message)}\n`); };
const surfaces = new Map();
let engineConfig;
let nextInstance = 0;
const requested = new Set();
let target = 'quotum://localhost/index.html';
let generation = -1;
let quitting = false;
let buffer = '';
let nextId = 0;
let initialize;
const initialized = new Promise(resolve => { initialize = resolve; });
const pending = new Map();
function finish() { quitting = true; app.quit(); }
channel.on('error', finish);
channel.on('end', finish);
channel.on('data', chunk => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 65536) return finish();
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try { receive(JSON.parse(line)); } catch { finish(); return; }
  }
});
function receive(message) {
  switch (message.type) {
    case 'init':
      if (initialize) {
        if (!path.isAbsolute(message.profile) || !path.isAbsolute(message.geometry)) return finish();
        fs.mkdirSync(message.profile, {recursive: true, mode: 0o700});
        app.setPath('userData', message.profile);
        initialize(message); initialize = null;
      }
      break;
    case 'state': {
      if (!Number.isSafeInteger(message.generation) || message.generation < generation) break;
      const next = new URL(message.url);
      if (!(next.protocol === 'quotum:' && next.host === 'localhost') && !(next.protocol === 'http:' && next.hostname === '127.0.0.1' && next.port)) return finish();
      const changed = message.generation !== generation || message.url !== target;
      generation = message.generation;
      target = message.url;
      // getURL() is the last committed document; an older navigation may be pending.
      if (message.force || changed) for (const entry of surfaces.values()) {
        if (changed || !message.role || message.role === entry.role) navigate(entry);
      }
      break;
    }
    case 'focus':
      if (!['main', 'compact'].includes(message.role)) return finish();
      openSurface(message.role); break;
    case 'panel': {
      const entry = surfaces.get('compact');
      if (!entry || entry.instance !== message.instance || message.generation !== generation) break;
      if (message.action === 'close') entry.window.close();
      if (message.action === 'main') { openSurface('main'); entry.window.close(); }
      if (message.action === 'height' && Number.isFinite(message.height) && message.height > 0 && message.height <= 100000) { entry.height = message.height; resizePanel(entry); }
      break;
    }
    case 'leave':
      target = 'quotum://localhost/index.html#quit';
      for (const entry of surfaces.values()) navigate(entry);
      break;
    case 'app_state':
      // The app's state, to the board of the hub's current start only, in the window's main frame.
      for (const entry of surfaces.values()) if (message.generation === generation) {
        const window = entry.window;
        try {
          if (policy.mayInvoke(window.webContents.mainFrame.url, target, 'app_state', entry.role)) window.webContents.send('quotum:state', message.state);
        } catch {
          // The page's renderer is gone: nobody to tell, and no fault of the app's. A page loaded again reads the state itself.
        }
      }
      break;
    case 'close': finish(); break;
    case 'response': {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id); clearTimeout(waiter.timer);
        if (surfaces.get(waiter.entry.role) !== waiter.entry || generation !== waiter.generation) waiter.reject(new Error('stale window'));
        else if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.value);
      }
      break;
    }
    default: finish();
  }
}
function belongs(url, destination) {
  if (policy.origin(url) !== policy.origin(destination)) return false;
  return policy.origin(destination) !== policy.OWN || new URL(url).pathname === new URL(destination).pathname;
}
function destination(role) {
  const url = new URL(target);
  if (role === 'compact' && url.protocol === 'http:') url.searchParams.set('view', 'compact');
  return url.href;
}
function navigate(entry) {
  const url = destination(entry.role);
  const window = entry.window;
  // Error messages can include the entry key. Log only an error code, never the URL.
  window.loadURL(url).catch(error => {
    if (!quitting && error.code !== 'ERR_ABORTED') send({type: 'fault', process: 'navigation', reason: error.code || 'load failed'});
  });
}

ipcMain.handle('quotum:invoke', (event, command, args) => {
  const entry = [...surfaces.values()].find(e => event.sender === e.window.webContents);
  if (!entry || event.senderFrame !== entry.window.webContents.mainFrame || !policy.mayInvoke(event.senderFrame.url, target, command, entry.role)) throw new Error('not the board of the running hub');
  if (pending.size >= 16) throw new Error('too many pending app commands');
  const request = {command};
  if (['save_settings', 'save_desktop_settings', 'set_autostart', 'report_panel_height'].includes(command)) request.args = args;
  const message = {type: 'request', id: ++nextId, origin: event.senderFrame.url, role: entry.role, instance: entry.instance, generation, request};
  if (Buffer.byteLength(JSON.stringify(message)) > 60000) throw new Error('app command too large');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(message.id); reject(new Error('app command timed out')); }, 60000);
    pending.set(message.id, {resolve, reject, timer, entry, generation}); send(message);
  });
});
// Observability stays in the private transport; the page gets no extra command.
let previousGraphics = '';
let graphicsTimer;
function scheduleGraphics() {
  clearTimeout(graphicsTimer);
  graphicsTimer = setTimeout(reportGraphics, 500);
  graphicsTimer.unref();
}
function reportGraphics() {
  if (!surfaces.size || quitting) return;
  // Read Chromium's cached policy. Routine logging needs no device enumeration or
  // subscription that could do work again whenever GPU information changes.
  const features = app.getGPUFeatureStatus();
  const message = {
    type: 'graphics', electron: process.versions.electron, chromium: process.versions.chrome,
    backend: app.commandLine.getSwitchValue('ozone-platform') || 'default',
    compositing: features.gpu_compositing || 'unknown', rasterization: features.rasterization || 'unknown',
  };
  const text = JSON.stringify(message);
  if (text !== previousGraphics) { previousGraphics = text; send(message); }
}
ipcMain.on('quotum:renderer-sandbox', (event, sandboxed) => {
  const entry = [...surfaces.values()].find(e => event.sender === e.window.webContents);
  if (!entry || event.senderFrame !== entry.window.webContents.mainFrame) return;
  if (sandboxed !== true) { send({type: 'fault', process: 'renderer', reason: 'sandbox disabled'}); app.exit(1); }
});
app.on('child-process-gone', (_, details) => {
  if (!['clean-exit', 'killed'].includes(details.reason)) {
    send({type: 'fault', process: details.type, reason: details.reason});
    scheduleGraphics();
  }
});
app.on('window-all-closed', finish);
app.on('before-quit', () => { quitting = true; });
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
process.on('uncaughtException', () => { send({type: 'fault', process: 'main', reason: 'uncaught exception'}); app.exit(1); });
process.on('unhandledRejection', () => { send({type: 'fault', process: 'main', reason: 'unhandled rejection'}); app.exit(1); });

send({type: 'ready'});
Promise.all([initialized, app.whenReady()]).then(([config]) => {
  if (quitting) return;
  const ownFiles = new Map([['/index.html', 'text/html'], ['/error.html', 'text/html'], ['/page.css', 'text/css'], ['/page.js', 'text/javascript']]);
  protocol.handle('quotum', request => {
    const url = new URL(request.url);
    const contentType = ownFiles.get(url.pathname);
    if (url.host !== 'localhost' || !contentType || request.method !== 'GET') return new Response(null, {status: 404});
    return new Response(fs.readFileSync(path.join(__dirname, 'static', url.pathname.slice(1))), {headers: {
      'Content-Type': `${contentType}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    }});
  });
  session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', event => event.preventDefault());
  engineConfig = config;
  requested.add(config.role ?? 'main');
  for (const role of requested) openSurface(role);
  requested.clear();
});
function resizePanel(entry) {
  if (entry.window.isDestroyed()) return;
  const area = screen.getDisplayMatching(entry.window.getBounds()).workArea;
  const width = Math.min(400, area.width);
  const height = Math.max(100, Math.min(Math.ceil(entry.height), 600, Math.floor(area.height * 0.8)));
  const [currentWidth, currentHeight] = entry.window.getContentSize();
  if (currentWidth !== width || currentHeight !== height) entry.window.setContentSize(width, height);
}
function openSurface(role) {
  if (!engineConfig) { requested.add(role); return; }
  const existing = surfaces.get(role);
  if (existing && !existing.window.isDestroyed()) { if (existing.window.isMinimized()) existing.window.restore(); existing.window.show(); existing.window.focus(); return; }
  const config = engineConfig;
  const compact = role === 'compact';
  let loaded = false;
  let revealed = false;
  let geometry = {};
  try {
    if (compact) throw new Error('panel geometry is temporary');
    const saved = JSON.parse(fs.readFileSync(config.geometry, 'utf8'));
    const {x, y, width, height} = saved;
    if ([x, y, width, height].every(Number.isInteger) && width >= 480 && height >= 400 && width <= 16384 && height <= 16384 && screen.getAllDisplays().some(({workArea: a}) => x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + 40 > a.y)) geometry = {x, y, width, height};
  } catch {}
  const window = new BrowserWindow({
    title: 'Quotum', width: compact ? 400 : 1280, height: compact ? 180 : 800, ...geometry, minWidth: compact ? 160 : 480, minHeight: compact ? 100 : 400,
    alwaysOnTop: compact, skipTaskbar: compact, resizable: !compact,
    backgroundColor: '#0b0b0e', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true,
      devTools: config.inspect === true, spellcheck: false, navigateOnDragDrop: false,
    },
  });
  const entry = {window, role, instance: ++nextInstance, height: 180};
  surfaces.set(role, entry);
  send({type: 'surface', role, instance: entry.instance, open: true});
  window.setMenu(null);
  if (compact) { window.on('blur', () => { if (revealed && !quitting) window.close(); }); window.on('move', () => resizePanel(entry)); }
  window.once('ready-to-show', () => {
    if (quitting) return;
    window.show(); revealed = true;
    if (loaded && !compact) send({type: 'loaded', url: window.webContents.getURL()});
    scheduleGraphics();
  });
  const contents = window.webContents;
  contents.on('will-frame-navigate', event => {
    const action = policy.navigation(event.url, target, event.isMainFrame);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'external') void shell.openExternal(event.url).catch(() => {});
  });
  contents.on('will-redirect', event => { if (!policy.allowed(event.url, target)) event.preventDefault(); });
  contents.setWindowOpenHandler(({url}) => { if (policy.external(url)) void shell.openExternal(url).catch(() => {}); return {action: 'deny'}; });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('render-process-gone', (_, details) => { if (!['clean-exit', 'killed'].includes(details.reason)) send({type: 'fault', process: 'renderer', reason: details.reason}); });
  contents.on('did-finish-load', () => {
    if (!quitting && !belongs(contents.getURL(), target)) { navigate(entry); return; }
    loaded = true;
    if (revealed && !compact) send({type: 'loaded', url: contents.getURL()});
  });
  window.on('close', () => {
    if (loaded && !compact) {
      try { fs.writeFileSync(`${config.geometry}.new`, JSON.stringify(window.getNormalBounds())); fs.renameSync(`${config.geometry}.new`, config.geometry); } catch {}
    }
  });
  window.on('closed', () => {
    if (surfaces.get(role) === entry) surfaces.delete(role);
    send({type: 'surface', role, instance: entry.instance, open: false});
    for (const [id, waiter] of pending) if (waiter.entry === entry) { clearTimeout(waiter.timer); pending.delete(id); waiter.reject(new Error('window closed')); }
  });
  navigate(entry);
}
