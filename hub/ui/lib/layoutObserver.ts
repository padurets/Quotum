const observers = new WeakMap<Element, Set<LayoutObserver>>();

/** Observes content, including while the grid adds its own empty room to the same box. */
export class LayoutObserver {
  private readonly native: ResizeObserver;
  private readonly targets = new Map<Element, ResizeObserverOptions | undefined>();
  private readonly pending = new Map<Element, number>();

  constructor(callback: ResizeObserverCallback) { this.native = new ResizeObserver(callback); }

  observe(target: Element, options?: ResizeObserverOptions) {
    this.targets.set(target, options);
    let listeners = observers.get(target);
    if (!listeners) observers.set(target, listeners = new Set());
    listeners.add(this);
    if (!this.pending.has(target)) this.native.observe(target, options);
  }

  unobserve(target: Element) {
    const frame = this.pending.get(target);
    if (frame !== undefined) cancelAnimationFrame(frame);
    this.pending.delete(target);
    this.targets.delete(target);
    observers.get(target)?.delete(this);
    this.native.unobserve(target);
  }

  disconnect() {
    for (const target of this.targets.keys()) this.unobserve(target);
    this.native.disconnect();
  }

  pause(target: Element) {
    if (this.pending.has(target)) return;
    this.native.unobserve(target);
    this.pending.set(target, requestAnimationFrame(() => {
      this.pending.delete(target);
      this.native.observe(target, this.targets.get(target));
    }));
  }
}

/**
 * A fill write intentionally resizes the measured root during observer delivery.
 * Keep the write before paint, but do not feed it back into that same delivery cycle.
 * Re-observing next frame also delivers any content changes made while paused.
 */
export function pauseLayoutObservers(target: Element) {
  for (const observer of observers.get(target) ?? []) observer.pause(target);
}
