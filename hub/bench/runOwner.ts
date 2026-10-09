import type {Browser} from './cdp.js';
import {deadline} from './deadline.js';

/** One run owns startup, pending tab creation and every auxiliary resource before awaiting it. */
export class RunOwner {
  private readonly cancellation = new AbortController();
  readonly signal = this.cancellation.signal;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly resources = new Set<() => Promise<void>>();
  private browser?: Browser;
  private launch?: Promise<Browser>;
  private closing?: Promise<void>;
  readonly failures: string[] = [];

  start(work: (signal: AbortSignal) => Promise<Browser>): Promise<Browser> {
    this.signal.throwIfAborted();
    this.launch = work(this.signal).then(browser => {
      this.browser = browser; browser.owner = this;
      this.signal.throwIfAborted();
      return browser;
    });
    return this.launch;
  }

  operation<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const promise = work();
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  /** Registration is allowed after cancellation so late create replies still acquire an owner. */
  resource(close: () => Promise<void>): () => Promise<void> {
    let closing: Promise<void> | undefined;
    const release = () => closing ??= close().then(() => {this.resources.delete(release);});
    this.resources.add(release);
    return release;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.cancellation.abort(new Error('benchmark cancelled'));
      const record = async (stage: string, work: () => Promise<unknown>, ms: number) => {
        try {await deadline(ms, work);} catch {this.failures.push(stage);}
      };
      // Startup has its own seven-second termination bound. Pending target creation gets five.
      await Promise.all([
        record('launch drain failed', async () => {await this.launch?.catch(() => {});}, 8_000),
        record('pending resource drain failed', async () => {await Promise.allSettled([...this.pending]);}, 5_100),
      ]);
      await record('resource cleanup failed', async () => {
        const results = await Promise.allSettled([...this.resources].map(close => close()));
        if (results.some(result => result.status === 'rejected')) throw new Error('resource cleanup failed');
      }, 5_100);
      await record('browser cleanup failed', async () => {await this.browser?.close();}, 8_000);
      if (this.failures.length) throw new Error(this.failures.join('; '));
    })();
  }
}
