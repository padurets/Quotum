import type {Cdp} from './cdp.js';

/** A saved radio remains focused, so the next native arrow can save another choice. */
export async function frequencyKeys(cdp: Cdp) {
  await cdp.evaluate(`(() => {
    const trigger = document.querySelector('.card-head .picker > button');
    if (!trigger) throw new Error('no card menu');
    trigger.focus(); trigger.click();
  })()`);
  await cdp.evaluate(`(async () => {
    const end = Date.now() + 5000;
    while (!document.querySelector('.popover [role=radiogroup] input:checked')) {
      if (Date.now() > end) throw new Error('no measuring-frequency group');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    document.querySelector('.popover [role=radiogroup] input:checked').focus();
  })()`);
  for (const index of [1, 2]) {
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39});
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39});
    await cdp.evaluate(`(async () => {
      const end = Date.now() + 5000;
      const group = () => document.querySelector('.popover [role=radiogroup]');
      while (group()?.getAttribute('aria-busy') === 'true' || group()?.querySelector('.is-on')?.textContent !== '${index}') {
        if (Date.now() > end) throw new Error('frequency arrow ${index} did not save');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const radio = group().querySelectorAll('input')[${index}];
      if (!radio.checked || document.activeElement !== radio) throw new Error('saving frequency lost native radio focus');
    })()`);
  }
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
}

/** A zero cap keeps the scale's origin unchanged when balances become spending. */
export async function moneyView(cdp: Cdp, source: string, cappedSource: string, cap: string) {
  await cdp.evaluate(`(() => {
    const prefs = JSON.parse(localStorage.getItem('quotum.prefs') || '{}');
    prefs.money = {unit: 'USD', view: 'balance', selected: {USD: ${JSON.stringify([[source, 'balance'], [cappedSource, cap]])}}};
    prefs.muted = {};
    localStorage.setItem('quotum.prefs', JSON.stringify(prefs));
  })()`);
  const loaded = new Promise<void>((resolve, reject) => {
    const late = setTimeout(() => reject(new Error('money view reload did not finish')), 5000);
    cdp.on('Page.loadEventFired', () => {clearTimeout(late); resolve();});
  });
  await cdp.send('Page.reload');
  await loaded;
  await cdp.evaluate(`(async () => {
    const end = Date.now() + 5000;
    while (document.querySelectorAll('.history [data-series]').length !== 2) {
      if (Date.now() > end) throw new Error('money selection did not load');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })()`);
  await cdp.evaluate(`document.querySelector('.history .panel-head button').click()`);
  for (const label of ['Spending', 'Balance', 'Spending']) {
    await cdp.evaluate(`(async () => {
      const button = Array.from(document.querySelectorAll('.popover .segmented button')).find(b => b.textContent === ${JSON.stringify(label)});
      if (!button) throw new Error('no money view control');
      button.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const series = document.querySelector('[data-series="${source} balance"]');
      if (!series?.getAttribute('d')) throw new Error('money line disappeared');
      const box = series.getBBox(), height = series.ownerSVGElement.viewBox.baseVal.height;
      if (box.y < 0 || box.y + box.height > height) throw new Error('switching money view left the line outside its new scale');
    })()`);
  }
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
}
