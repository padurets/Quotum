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
