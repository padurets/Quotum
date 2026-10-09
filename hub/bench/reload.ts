import type {Cdp} from './cdp.js';
import {deadline} from './deadline.js';

/** The reload command and its load event share the existing five-second bound. */
export async function reload(cdp: Pick<Cdp, 'send' | 'on' | 'off'>) {
  await deadline(5000, async signal => {
    let loaded = () => {}, cancel = () => {};
    const event = new Promise<void>((resolve, reject) => {
      loaded = resolve;
      cancel = () => reject(signal.reason);
      cdp.on('Page.loadEventFired', loaded);
      signal.addEventListener('abort', cancel, {once: true});
    });
    // A cancelled command can reject before its event is awaited.
    void event.catch(() => {});
    try {
      await cdp.send('Page.reload', {}, signal);
      await event;
    } finally {
      cdp.off('Page.loadEventFired', loaded);
      signal.removeEventListener('abort', cancel);
    }
  });
}
