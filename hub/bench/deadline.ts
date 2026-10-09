/** A deadline owns cancellation as well as its timer; abandoned work cannot keep a waiter alive. */
export async function deadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort(parent?.reason);
  parent?.addEventListener('abort', cancel, {once: true});
  if (parent?.aborted) cancel();
  const timer = setTimeout(() => abort.abort(new Error('deadline exceeded')), Math.max(0, ms));
  let rejectAbort: () => void = () => {};
  try {
    abort.signal.throwIfAborted();
    return await Promise.race([work(abort.signal), new Promise<never>((_, reject) => {
      rejectAbort = () => reject(abort.signal.reason);
      abort.signal.addEventListener('abort', rejectAbort, {once: true});
      if (abort.signal.aborted) rejectAbort();
    })]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
    abort.signal.removeEventListener('abort', rejectAbort);
    abort.abort();
  }
}

/** DevTools replies are small. Bound headers and the entire body with the same cancellation. */
export async function devtoolsJson(url: string, signal: AbortSignal, method = 'GET', progress?: (stage: 'headers'|'body'|'parse', status?: number) => void): Promise<unknown> {
  progress?.('headers');
  const response = await fetch(url, {method, signal, redirect: 'error'});
  progress?.('body',response.status);
  if (!response.ok) {await response.body?.cancel(); throw new Error(`DevTools HTTP ${response.status}`);}
  const reader = response.body?.getReader();
  if (!reader) throw new Error('DevTools empty reply');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 16_384) throw new Error('DevTools reply exceeds 16 KiB');
      chunks.push(part.value);
    }
    progress?.('parse',response.status);
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
