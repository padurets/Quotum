import {setImmediate} from 'node:timers/promises';
import type {Preparation} from './domain/prepare.js';

/** Keep the shared reservation serial while allowing sockets and cancellation to run. */
export class PeriodPreparation {
  private pending=Promise.resolve();
  async run<T>(work:()=>Preparation<T>,signal?:AbortSignal,check:()=>void=()=>{}):Promise<T> {
    const before=this.pending;let release!:()=>void;
    const finished=new Promise<void>(resolve=>{release=resolve;});
    this.pending=before.then(()=>finished);
    let preparation:Preparation<T>|undefined;
    try {
      await wait(before,signal);
      preparation=work();
      for(;;){
        await setImmediate(undefined,{signal});
        signal?.throwIfAborted();check();
        const until=performance.now()+8;
        do {const step=preparation.next();if(step.done){check();return step.value;}}while(performance.now()<until);
      }
    }finally{try{preparation?.return(undefined as never);}finally{release();}}
  }
}

async function wait(turn:Promise<void>,signal?:AbortSignal) {
  if(!signal){await turn;return;}
  signal.throwIfAborted();let abort!:()=>void;
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{await Promise.race([turn,cancelled]);}finally{signal.removeEventListener('abort',abort);}
}
