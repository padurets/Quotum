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
let window;
let target = 'quotum://localhost/index.html';
let generation = -1;
let quitting = false;
let loaded = false;
let revealed = false;
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
      generation = message.generation;
      target = message.url;
      if (window && (message.force || !belongs(window.webContents.getURL(), target))) navigate(target);
      break;
    }
    case 'focus':
      if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
      break;
    case 'leave':
      target = 'quotum://localhost/index.html#quit';
      if (window) navigate(target);
      break;
    case 'close': finish(); break;
    case 'response': {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.value);
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
function navigate(url) {
  // Error messages can include the entry key. Log only an error code, never the URL.
  window.loadURL(url).catch(error => {
    if (!quitting && error.code !== 'ERR_ABORTED') send({type: 'fault', process: 'navigation', reason: error.code || 'load failed'});
  });
}

ipcMain.handle('quotum:invoke', (event, command, args) => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !policy.mayInvoke(event.senderFrame.url, target, command)) throw new Error('not the board of the running hub');
  if (pending.size >= 16) throw new Error('too many pending app commands');
  const request = {command};
  if (command === 'save_settings' || command === 'set_autostart') request.args = args;
  const message = {type: 'request', id: ++nextId, origin: event.senderFrame.url, request};
  if (Buffer.byteLength(JSON.stringify(message)) > 60000) throw new Error('app command too large');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(message.id); reject(new Error('app command timed out')); }, 60000);
    pending.set(message.id, {resolve, reject, timer});
    send(message);
  });
});
// Observability stays in the private transport; the page gets no extra command.
let graphicsPending = false;
let previousGraphics = '';
async function reportGraphics() {
  if (!window || quitting || graphicsPending) return;
  graphicsPending = true;
  try {
    const info = await app.getGPUInfo('complete');
    if (quitting || !window) return;
    const features = app.getGPUFeatureStatus();
    const message = {
      type: 'graphics', electron: process.versions.electron, chromium: process.versions.chrome,
      backend: app.commandLine.getSwitchValue('ozone-platform') || 'default',
      compositing: features.gpu_compositing || 'unknown', rasterization: features.rasterization || 'unknown',
      renderer: String(info.auxAttributes?.glRenderer || info.auxAttributes?.glImplementationParts || 'unknown').slice(0, 256),
    };
    const text = JSON.stringify(message);
    if (text !== previousGraphics) { previousGraphics = text; send(message); }
  } catch { /* GPU information can be unavailable during process teardown. */ }
  finally { graphicsPending = false; }
}
ipcMain.on('quotum:renderer-sandbox', (event, sandboxed) => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
  if (sandboxed !== true) { send({type: 'fault', process: 'renderer', reason: 'sandbox disabled'}); app.exit(1); }
});
app.on('gpu-info-update', reportGraphics);
app.on('child-process-gone', (_, details) => {
  if (!['clean-exit', 'killed'].includes(details.reason)) send({type: 'fault', process: details.type, reason: details.reason});
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
  let geometry = {};
  try {
    const saved = JSON.parse(fs.readFileSync(config.geometry, 'utf8'));
    const {x, y, width, height} = saved;
    if ([x, y, width, height].every(Number.isInteger) && width >= 480 && height >= 400 && width <= 16384 && height <= 16384 && screen.getAllDisplays().some(({workArea: a}) => x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + 40 > a.y)) geometry = {x, y, width, height};
  } catch {}
  window = new BrowserWindow({
    title: 'Quotum', width: 1280, height: 800, ...geometry, minWidth: 480, minHeight: 400,
    backgroundColor: '#0b0b0e', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true,
      devTools: config.inspect === true, spellcheck: false, navigateOnDragDrop: false,
    },
  });
  window.setMenu(null);
  window.once('ready-to-show', () => {
    if (quitting) return;
    window.show(); revealed = true;
    if (loaded) send({type: 'loaded', url: window.webContents.getURL()});
    void reportGraphics();
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
  contents.on('did-finish-load', () => { loaded = true; if (revealed) send({type: 'loaded', url: contents.getURL()}); });
  window.on('close', () => {
    if (loaded) {
      try { fs.writeFileSync(`${config.geometry}.new`, JSON.stringify(window.getNormalBounds())); fs.renameSync(`${config.geometry}.new`, config.geometry); } catch {}
    }
  });
  window.on('closed', () => { window = null; });
  navigate(target);
});
