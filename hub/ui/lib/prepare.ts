import {drain, type Preparation} from '../../server/domain/prepare';
export {drain, type Preparation} from '../../server/domain/prepare';

export type PreparationEnv = {now(): number; post(run: () => void): void; dispose?(): void};
type Job = {work: Preparation<unknown>; valid: () => boolean; ready: (value: unknown) => void};

/** One latest job per owner; queued messages retain owners, never abandoned buffers. */
export class Preparations {
  private readonly jobs = new Map<object, Job>();
  private readonly queue: object[] = [];
  private pending = false;
  private disposed = false;
  constructor(private readonly env: PreparationEnv, private readonly quantum = 1) {}

  replace<T>(owner: object, work: Preparation<T>, valid: () => boolean, ready: (value: T) => void) {
    if (this.disposed) {work.return(undefined as T); return;}
    this.cancel(owner);
    this.jobs.set(owner, {work, valid, ready: value => ready(value as T)});
    if (!this.queue.includes(owner)) this.queue.push(owner);
    this.post();
  }

  cancel(owner: object) {
    const job = this.jobs.get(owner);
    if (!job) return;
    this.jobs.delete(owner);
    const index = this.queue.indexOf(owner);
    if (index >= 0) this.queue.splice(index, 1);
    job.work.return(undefined);
  }

  private post() {
    if (this.pending || !this.jobs.size || this.disposed) return;
    this.pending = true;
    this.env.post(() => {this.pending = false; this.slice();});
  }

  private slice() {
    if (this.disposed) return;
    const owner = this.queue.shift();
    const job = owner && this.jobs.get(owner);
    if (owner && job) {
      if (!job.valid()) this.cancel(owner);
      else {
        const deadline = this.env.now() + this.quantum;
        let step: IteratorResult<void, unknown> | undefined;
        do {
          for (let n = 0; n < 16; n++) {step = job.work.next(); if (step.done) break;}
        } while (!step!.done && this.env.now() < deadline);
        if (this.jobs.get(owner) === job) {
          if (step!.done) {
            this.jobs.delete(owner);
            if (job.valid()) job.ready(step!.value);
          } else this.queue.push(owner);
        }
      }
    }
    this.post();
  }

  dispose() {
    this.disposed = true;
    for (const owner of this.jobs.keys()) this.cancel(owner);
    this.queue.length = 0;
    this.env.dispose?.();
  }
  get size() {return this.jobs.size;}
}

let scheduler: Preparations | null = null;
export function preparations(): Preparations | null {
  if (typeof window === 'undefined') return null;
  if (!scheduler) {
    const channel = new MessageChannel();
    let next: (() => void) | null = null;
    channel.port1.onmessage = () => {const run = next; next = null; run?.();};
    scheduler = new Preparations({now: () => performance.now(), post: run => {next = run; channel.port2.postMessage(null);}, dispose: () => {channel.port1.close(); channel.port2.close();}});
  }
  return scheduler;
}

export function prepare<T>(owner: object, work: Preparation<T>, valid: () => boolean, ready: (value: T) => void, scheduler = preparations()) {
  if (scheduler) scheduler.replace(owner, work, valid, ready);
  else {const value = drain(work); if (valid()) ready(value);}
}

/** Cancellation settles the owner as well as releasing its generator's staged buffers. */
export function prepareAsync<T>(owner:object,work:Preparation<T>,valid:()=>boolean,scheduler=preparations()):Promise<T|null> {
  return new Promise((resolve,reject)=>{
    function* guarded():Preparation<T>{let complete=false;try{yield;const value=yield*work;complete=true;return value;}catch(error){complete=true;reject(error);return undefined as T;}finally{if(!complete)resolve(null);}}
    const guardedWork=guarded();guardedWork.next();
    prepare(owner,guardedWork,valid,value=>resolve(value),scheduler);
  });
}
