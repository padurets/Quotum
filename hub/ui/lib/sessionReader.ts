import type {Session} from './session';

/** Authentication, refresh and unmount each invalidate every older request. */
export class SessionReader {
  private generation = 0;
  constructor(private readonly load: () => Promise<Session>, private readonly changed: (session: Session) => void, private readonly failed: (failed: boolean) => void) {}
  accept(next: Session): void { this.generation++; this.changed(next); this.failed(false); }
  invalidate(): void { this.generation++; }
  async refresh(): Promise<void> {
    const request = ++this.generation;
    try {
      const next = await this.load();
      if (request === this.generation) this.accept(next);
    } catch {
      if (request === this.generation) this.failed(true);
    }
  }
}
