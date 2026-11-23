// Open a capture window on a running demo, or write the local desktop reference PNG.
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {writeFileSync} = require('node:fs');
const path = require('node:path');
const {createInterface} = require('node:readline');
const {setTimeout: delay} = require('node:timers/promises');
const {app, BrowserWindow} = require('electron');
const installClock = require('./clock.cjs');

async function openWindow(url, offset, desktop) {
  const win = new BrowserWindow({
    width: desktop ? 1280 : 1440, height: desktop ? 800 : 900, useContentSize: true,
    frame: !desktop, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false},
  });
  const web = win.webContents;
  await win.loadURL('about:blank');
  web.debugger.attach('1.3');
  await web.debugger.sendCommand('Page.enable');
  const prefs = JSON.stringify({range: '7d', locked: true, filtersVisible: !desktop});
  await web.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: '(' + installClock.toString() + ')(' + offset + ');' +
      (desktop ? 'localStorage.setItem("quotum.locale","en");' : '') +
      'if (!localStorage.getItem("quotum.prefs")) localStorage.setItem("quotum.prefs",' + JSON.stringify(prefs) + ');',
  });
  await win.loadURL(url);
  if (desktop) web.setZoomFactor(0.8);
  return win;
}

async function captureDesktop(output, offset) {
  const seed = spawn('node', ['--import', 'tsx', 'demo/desktopCapture.ts'], {
    cwd: path.resolve(__dirname, '../../apps/hub'),
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {...process.env, NODE_OPTIONS: '--require=' + JSON.stringify(require.resolve('./clock.cjs'))},
  });
  // A failed spawn emits both error and close. Observe both while waiting for the URL.
  const closed = new Promise(resolve => seed.once('close', resolve));
  const stopped = once(seed, 'error').then(([error]) => { throw error; });
  const stop = () => seed.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const lines = createInterface({input: seed.stdout});
    const first = await Promise.race([lines[Symbol.asyncIterator]().next(), stopped]);
    if (first.done) throw new Error('The local showcase stopped before opening its board');
    const win = await openWindow(first.value, offset, true);
    const web = win.webContents;
    const ready = () => {
      const chart = document.querySelector('[data-widget="quota-history"]');
      return document.fonts.status === 'loaded' && document.querySelectorAll('.card').length === 3 &&
        chart?.querySelector('.legend-item') && chart.getBoundingClientRect().bottom <= innerHeight &&
        [...chart.querySelectorAll('[data-series] path.series')].filter(p => p.getAttribute('d')?.length > 120).length >= 5;
    };
    for (let i = 0; ; i++) {
      if (await web.executeJavaScript('(' + ready.toString() + ')()')) break;
      if (i === 100) throw new Error('The three local cards and their weekly trends did not fit and settle');
      await delay(100);
    }
    await web.debugger.sendCommand('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 0, y: 0});
    const {data} = await web.debugger.sendCommand('Page.captureScreenshot', {captureBeyondViewport: false});
    writeFileSync(output, Buffer.from(data, 'base64'));
  } finally {
    stop();
    await closed;
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

async function main() {
  const offset = Number(process.env.SHOWCASE_OFFSET_MS);
  if (!Number.isSafeInteger(offset)) throw new Error('Set SHOWCASE_OFFSET_MS before launching Electron');
  const board = process.argv.indexOf('--board');
  if (board !== -1) {
    const entry = new URL(process.argv[board + 1]);
    if (entry.protocol !== 'http:' || entry.hostname !== '127.0.0.1')
      throw new Error('Expected the demo’s loopback HTTP URL');
    const win = await openWindow(entry.href, offset, false);
    await once(win, 'closed');
  } else {
    const target = process.argv.at(-1);
    if (!target?.endsWith('.png')) throw new Error('Expected an output PNG path or --board URL');
    await captureDesktop(target, offset);
  }
}

app.whenReady().then(main).then(() => app.exit(0), error => {
  console.error(error.message);
  app.exit(1);
});
