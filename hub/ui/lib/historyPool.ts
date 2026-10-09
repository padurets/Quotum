type Flight = {role: 'visible' | 'ahead'};
type Candidate = {bytes: number; shownAt: number; drop(): void};
export type HistoryMember = {readonly estimatedBytes: number; evictionCandidates(): Candidate[]};
type Waiting = {owner: HistoryMember; flight: Flight; start(): void; cancel(): void};

/** Both resource families share the board's transport slots and retained tile budget. */
export class HistoryPool {
  private readonly members = new Set<HistoryMember>();
  private readonly active = new Map<Flight, Waiting>();
  private readonly waiting: Waiting[] = [];
  private readonly reservations = new Map<Flight, number>();
  private scheduled = false;

  constructor(readonly budget = 15 * 1024 * 1024) {}
  register(member: HistoryMember) {this.members.add(member);}
  get activeFlights() {return this.active.size;}
  get estimatedBytes() {return [...this.members].reduce((n, member) => n + member.estimatedBytes, 0) + [...this.reservations.values()].reduce((a,b) => a+b, 0);}
  isActive(flight: Flight) {return this.active.has(flight);}

  request(owner: HistoryMember, flight: Flight, start: () => void, cancel: () => void) {
    this.waiting.push({owner, flight, start, cancel}); this.schedule();
  }
  release(flight: Flight) {
    this.active.delete(flight); this.reservations.delete(flight);
    const index = this.waiting.findIndex(item => item.flight === flight);
    if (index !== -1) this.waiting.splice(index, 1);
    this.schedule();
  }
  private schedule() {
    if (this.scheduled || !this.waiting.length) return;
    this.scheduled = true;
    queueMicrotask(() => {this.scheduled = false; this.pump();});
  }
  private pump() {
    if(this.active.size===2&&this.waiting.some(item=>item.flight.role==='visible'&&![...this.active.values()].some(active=>active.owner===item.owner&&active.flight.role==='visible'))) {
      [...this.active.values()].find(item=>item.flight.role==='ahead')?.cancel();
    }
    while (this.active.size < 2) {
      const foreground = this.waiting.some(item => item.flight.role === 'visible');
      const index = this.waiting.findIndex(item => {
        if (item.flight.role === 'ahead') return !foreground && ![...this.active.keys()].some(flight => flight.role === 'ahead');
        return ![...this.active.values()].some(active => active.owner === item.owner && active.flight.role === 'visible');
      });
      if (index === -1) return;
      const [item] = this.waiting.splice(index, 1);
      this.active.set(item.flight, item); item.start();
    }
  }

  /** Staged growth is reserved before each yield; another family's visible tiles stay pinned. */
  reserve(flight: Flight, bytes: number) {
    const previous = this.reservations.get(flight) ?? 0;
    this.reservations.set(flight, bytes);
    if (this.trim()) return true;
    this.reservations.set(flight, previous);
    return false;
  }
  trim() {
    let bytes = this.estimatedBytes;
    if (bytes <= this.budget) return true;
    const candidates = [...this.members].flatMap(member => member.evictionCandidates()).sort((a,b) => a.shownAt - b.shownAt);
    for (const candidate of candidates) {
      candidate.drop(); bytes -= candidate.bytes;
      if (bytes <= this.budget) return true;
    }
    return false;
  }
}

export const historyPool = new HistoryPool();
