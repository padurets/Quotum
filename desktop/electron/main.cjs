'use strict';
// The GUI owns no measuring or account logic. fd 3 belongs only to its Rust parent.
const {app, BrowserWindow, ipcMain, protocol, session, shell, screen} = require('electron');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
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
let foreground = {revision: -1, target: 'none', anchor: null};
let appliedRevision = -1;
let reveal;
let reconciliation;
let target = 'quotum://localhost/index.html';
let generation = -1;
let quitting = false;
let idleExit;
const TRAY_GESTURE_MS = 500;
let buffer = '';
let nextId = 0;
let initialize;
const initialized = new Promise(resolve => { initialize = resolve; });
const pending = new Map();
function finish() { quitting = true; clearTimeout(idleExit); app.quit(); }
channel.on('error', finish);
channel.on('end', finish);
// Read all currently available frames before acting on foreground intent. A
// partial last frame delays reconciliation, even when an earlier one was complete.
function drain() {
  let chunk;
  while ((chunk = channel.read()) !== null) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      if (Buffer.byteLength(buffer.slice(0, end)) > 65536) return finish();
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { receive(JSON.parse(line)); } catch { finish(); return; }
    }
    if (Buffer.byteLength(buffer) > 65536) return finish();
  }
}
function scheduleReconcile() {
  if (reconciliation || quitting) return;
  reconciliation = setImmediate(() => {
    reconciliation = undefined;
    drain();
    if (!buffer && !quitting) reconcile();
  });
}
channel.on('readable', () => { drain(); scheduleReconcile(); });
function acceptForeground(head) {
  if (!head || !Number.isSafeInteger(head.revision) || head.revision < 0 || !['main', 'compact', 'none'].includes(head.target)) return finish();
  if (head.revision < foreground.revision || (head.revision === foreground.revision && foreground.target === 'none')) return;
  foreground = head;
}
function current(entry) {
  return !quitting && !entry.dismissed && !entry.window.isDestroyed() && surfaces.get(entry.role) === entry && foreground.target === entry.role && foreground.revision === entry.request;
}
function reconcile() {
  if (!engineConfig) return;
  const head = foreground;
  const panel = surfaces.get('compact');
  const main = surfaces.get('main');
  if (panel && head.target !== 'compact') dismiss(panel);
  // A main window that has already appeared remains usable behind the popup.
  // Cancel a superseded creation before it can acquire a native focus target.
  if (main && head.target !== 'main' && !main.revealed) dismiss(main);
  if (head.target !== 'none') openSurface(head.target, head.anchor, head.revision);
  else if (!surfaces.size) idle();
  appliedRevision = head.revision;
  const showing = reveal; reveal = undefined;
  const entry = surfaces.get('compact');
  if (showing && entry && current(entry) && entry.instance === showing.instance && entry.request === showing.request && entry.painted) entry.reveal();
}
function receive(message) {
  switch (message.type) {
    case 'init':
      if (initialize) {
        if (!path.isAbsolute(message.profile) || !path.isAbsolute(message.geometry)) return finish();
        fs.mkdirSync(message.profile, {recursive: true, mode: 0o700});
        app.setPath('userData', message.profile);
        acceptForeground(message.foreground);
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
        if (!entry.dismissed && (changed || !message.role || message.role === entry.role)) navigate(entry);
      }
      break;
    }
    case 'foreground':
      acceptForeground(message.head);
      break;
    case 'panel_reveal':
      reveal = message;
      break;
    case 'panel': {
      const entry = surfaces.get('compact');
      if (!entry || entry.instance !== message.instance || message.generation !== generation) break;
      if (message.action === 'height' && Number.isFinite(message.height) && message.height > 0 && message.height <= 100000) { engineConfig.panelHeight = entry.height = message.height; resizePanel(entry); }
      break;
    }
    case 'leave':
      target = 'quotum://localhost/index.html#quit';
      for (const entry of surfaces.values()) navigate(entry);
      break;
    case 'app_state':
      // The app's state, to the board of the hub's current start only, in the window's main frame.
      for (const entry of surfaces.values()) if (message.generation === generation) {
        if (entry.dismissed) continue;
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
        if (waiter.entry.dismissed || surfaces.get(waiter.entry.role) !== waiter.entry || generation !== waiter.generation) waiter.reject(new Error('stale window'));
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
    if (!quitting && !entry.dismissed && !window.isDestroyed() && error.code !== 'ERR_ABORTED') send({type: 'fault', process: 'navigation', reason: error.code || 'load failed'});
  });
}

ipcMain.handle('quotum:invoke', (event, command, args) => {
  const entry = [...surfaces.values()].find(e => event.sender === e.window.webContents);
  if (!entry || entry.dismissed || (entry.role === 'compact' && !current(entry)) || event.senderFrame !== entry.window.webContents.mainFrame || !policy.mayInvoke(event.senderFrame.url, target, command, entry.role)) throw new Error('not the board of the running hub');
  if (pending.size >= 16) throw new Error('too many pending app commands');
  const request = {command};
  if (['save_settings', 'save_desktop_settings', 'set_autostart', 'report_panel_height'].includes(command)) request.args = args;
  const message = {type: 'request', id: ++nextId, origin: event.senderFrame.url, role: entry.role, instance: entry.instance, revision: entry.request, generation, request};
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
function idle() {
  if (quitting) return;
  // A tray press can dismiss the panel before its activation reaches us. Keep
  // the gesture record alive for the matching release, without retaining a page.
  clearTimeout(idleExit);
  idleExit = setTimeout(() => { if (!surfaces.size) finish(); }, TRAY_GESTURE_MS);
}
app.on('window-all-closed', idle);
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
  const refit = () => { const panel = surfaces.get('compact'); if (panel && !panel.dismissed) resizePanel(panel); };
  screen.on('display-metrics-changed', refit);
  screen.on('display-removed', refit);
  scheduleReconcile();
});
function pointer() {
  try { return screen.getCursorScreenPoint(); } catch { return undefined; }
}
function reportClose(entry, blur = false) {
  if (current(entry)) foreground = {...foreground, target: 'none'};
  if (entry.role === 'compact' && !entry.closeReported) {
    entry.closeReported = true;
    const point = pointer();
    send({type: 'panel_closed', request: entry.request, blur, point: point ? [point.x, point.y] : null});
  }
}
function dismiss(entry, blur = false) {
  if (entry.dismissed || entry.window.isDestroyed()) return;
  reportClose(entry, blur);
  entry.dismissed = true;
  entry.window.close();
}
function resizePanel(entry) {
  if (entry.window.isDestroyed()) return;
  const area = (entry.anchor ? screen.getDisplayNearestPoint(entry.anchor) : screen.getDisplayMatching(entry.window.getBounds())).workArea;
  const width = Math.min(400, area.width);
  const height = Math.max(100, Math.min(Math.ceil(entry.height), Math.floor(area.height * 0.8)));
  const [currentWidth, currentHeight] = entry.window.getContentSize();
  if (currentWidth !== width || currentHeight !== height) entry.window.setContentSize(width, height);
  const radius = Math.min(Math.round(engineConfig.popupRadius ?? 12), Math.floor(width / 2), Math.floor(height / 2));
  const shapeKey = `${width}:${height}:${radius}`;
  if (typeof entry.window.setShape === 'function' && entry.shapeKey !== shapeKey) {
    const shape = [{x: 0, y: radius, width, height: height - 2 * radius}];
    for (let y = 0; y < radius; y++) {
      const dy = radius - y - 0.5;
      const inset = Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - dy * dy)));
      shape.push({x: inset, y, width: width - 2 * inset, height: 1}, {x: inset, y: height - y - 1, width: width - 2 * inset, height: 1});
    }
    entry.window.setShape(shape);
    entry.shapeKey = shapeKey;
  }
  placePanel(entry);
}
function placePanel(entry) {
  const point = entry.anchor;
  if (!point) return;
  const area = screen.getDisplayNearestPoint(point).workArea;
  const bounds = entry.window.getBounds();
  const x = Math.max(area.x, Math.min(point.x - bounds.width, area.x + area.width - bounds.width));
  const y = Math.max(area.y, Math.min(point.y - bounds.height, area.y + area.height - bounds.height));
  if (bounds.x !== x || bounds.y !== y) entry.window.setPosition(x, y);
}
function panelAnchor(anchor) {
  const backend = app.commandLine.getSwitchValue('ozone-platform');
  // XWayland supports placement even in a Wayland session; native Wayland owns it.
  if (backend !== 'x11' && (backend === 'wayland' || process.env?.WAYLAND_DISPLAY)) return;
  if (Array.isArray(anchor) && anchor.length === 2 && anchor.every(Number.isInteger)) return {x: anchor[0], y: anchor[1]};
  // A tray menu's activation has no coordinates. Capture the pointer once, before
  // loading the panel, so a later content resize cannot move it to another monitor.
  try { return screen.getCursorScreenPoint(); } catch { return; }
}
function openSurface(role, anchor, request) {
  clearTimeout(idleExit);
  if (role === 'main') { const panel = surfaces.get('compact'); if (panel && !panel.window.isDestroyed()) dismiss(panel); }
  const point = role === 'compact' ? panelAnchor(anchor) : undefined;
  const existing = surfaces.get(role);
  if (existing?.dismissed && !existing.window.isDestroyed()) return;
  if (role === 'compact' && existing && !existing.window.isDestroyed() && existing.request !== request) { dismiss(existing); return; }
  if (existing && !existing.window.isDestroyed()) {
    const changed = existing.request !== request || appliedRevision !== request;
    existing.request = request;
    if (changed) send({type: 'surface', role, instance: existing.instance, revision: request, open: true});
    if (role === 'compact' && changed) { existing.anchor = point; resizePanel(existing); }
    if (!existing.painted) return;
    if (role === 'compact' && engineConfig.nativePanel) {
      if (changed || !existing.readyReported) existing.ready();
    } else if (changed || !existing.revealed) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show(); existing.window.focus(); existing.revealed = true;
      if (existing.loaded && role === 'main') send({type: 'loaded', url: existing.window.webContents.getURL()});
      scheduleGraphics();
    }
    return;
  }
  const config = engineConfig;
  const compact = role === 'compact';
  const area = compact ? (point ? screen.getDisplayNearestPoint(point) : screen.getPrimaryDisplay()).workArea : undefined;
  const panelHeight = Number.isFinite(config.panelHeight) ? Math.max(100, config.panelHeight) : 180;
  const initialHeight = area ? Math.max(100, Math.min(panelHeight, Math.floor(area.height * 0.8))) : 800;
  let loaded = false;
  let geometry = {};
  try {
    if (compact) throw new Error('panel geometry is temporary');
    const saved = JSON.parse(fs.readFileSync(config.geometry, 'utf8'));
    const {x, y, width, height} = saved;
    if ([x, y, width, height].every(Number.isInteger) && width >= 480 && height >= 400 && width <= 16384 && height <= 16384 && screen.getAllDisplays().some(({workArea: a}) => x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + 40 > a.y)) geometry = {x, y, width, height};
  } catch {}
  const window = new BrowserWindow({
    title: 'Quotum', width: compact ? 400 : 1280, height: initialHeight, ...geometry, minWidth: compact ? 160 : 480, minHeight: compact ? 100 : 400,
    frame: !compact, hasShadow: !compact,
    alwaysOnTop: compact, skipTaskbar: compact, resizable: !compact,
    transparent: compact, backgroundColor: compact ? '#00000000' : '#0b0b0e', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true,
      devTools: config.inspect === true, spellcheck: false, navigateOnDragDrop: false,
    },
  });
  const entry = {window, role, instance: ++nextInstance, height: compact ? panelHeight : 180, anchor: point, dismissed: false, request, revealed: false};
  surfaces.set(role, entry);
  send({type: 'surface', role, instance: entry.instance, revision: entry.request, open: true});
  window.setMenu(null);
  if (compact) {
    window.on('focus', () => { entry.focused = true; });
    window.on('blur', () => {
      if (entry.revealed && current(entry) && (!config.nativePanel || entry.focused)) {
        dismiss(entry, true);
      }
    });
    window.on('move', () => resizePanel(entry));
  }
  entry.reveal = () => {
    if (!current(entry)) return;
    entry.revealed = true; window.show(); window.focus();
    send({type: 'panel_visible', request: entry.request});
    scheduleGraphics();
  };
  entry.ready = () => {
    if (!current(entry)) return;
    entry.readyReported = true;
    const handle = window.getNativeWindowHandle();
    send({type: 'panel_ready', request: entry.request, instance: entry.instance, handle: handle.readUInt32LE(0)});
  };
  window.once('ready-to-show', () => {
    if (quitting || entry.dismissed || window.isDestroyed() || surfaces.get(role) !== entry) return;
    entry.painted = true;
    scheduleReconcile();
  });
  const contents = window.webContents;
  if (compact) contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); dismiss(entry); }
  });
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
    if (entry.dismissed || window.isDestroyed()) return;
    if (!quitting && !belongs(contents.getURL(), target)) { navigate(entry); return; }
    loaded = true; entry.loaded = true;
    if (entry.revealed && !compact) send({type: 'loaded', url: contents.getURL()});
  });
  window.on('close', () => {
    reportClose(entry);
    entry.dismissed = true;
    if (loaded && !compact) {
      try { fs.writeFileSync(`${config.geometry}.new`, JSON.stringify(window.getNormalBounds())); fs.renameSync(`${config.geometry}.new`, config.geometry); } catch {}
    }
  });
  window.on('closed', () => {
    const current = surfaces.get(role) === entry;
    if (current) surfaces.delete(role);
    send({type: 'surface', role, instance: entry.instance, revision: entry.request, open: false});
    for (const [id, waiter] of pending) if (waiter.entry === entry) { clearTimeout(waiter.timer); pending.delete(id); waiter.reject(new Error('window closed')); }
    if (current && !quitting) scheduleReconcile();
  });
  navigate(entry);
  // The tray responds before Chromium has loaded the page. Once revealed, an
  // outside click must still dismiss it while the renderer is starting.
  if (compact) { resizePanel(entry); if (!config.nativePanel && current(entry)) { entry.revealed = true; window.show(); } }
}
