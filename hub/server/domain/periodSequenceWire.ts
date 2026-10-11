import type {PeriodReply} from './periodRead.js';
import type {ValueChange,ValuePath} from './valueChanges.js';

type Sequence={paths:ValuePath[];pieces:unknown[][]};
type Packed=Sequence&{pathEncoding:'prefix';changes:ValueChange[][]};

/** Only exact replay programs use this layout, never arbitrary supplier data. */
function* sequences(reply:PeriodReply):Generator<Sequence>{
  for(const scope of ['quota','budget','funds'] as const){
    const part=reply[scope];
    if(part?.state==='complete'&&part.value.tape?.fixed?.shift?.window)yield part.value.tape.fixed.shift.window;
  }
  if(reply.sessions?.state==='complete'&&reply.sessions.value.fixed?.shift?.window)yield reply.sessions.value.fixed.shift.window;
  if(reply.values?.state==='complete')for(const value of reply.values.value)if(value.states)yield value.states;
}

/** Adjacent changes of the same field compress together without changing any number. */
export function packPeriodSequences(reply:PeriodReply,reserve:(bytes:number)=>void){
  const packed=new WeakMap<object,Packed>();
  for(const sequence of sequences(reply)){
    const original=JSON.stringify(sequence);reserve(original.length*6+128);
    reserve(sequence.paths.length*64+sequence.pieces.length*80);
    const changes:ValueChange[][]=Array.from({length:sequence.paths.length},()=>[]);
    const pieces=sequence.pieces.map((piece,index)=>{
      for(const change of piece.at(-1) as ValueChange[]){reserve(96+change.length*16);changes[change[0]].push([index,...change.slice(1)] as ValueChange);}
      return piece.slice(0,-1);
    });
    let previous:ValuePath=[];
    const paths=sequence.paths.map(path=>{
      let shared=0;while(shared<previous.length&&shared<path.length&&previous[shared]===path[shared])shared++;
      reserve(64+(path.length-shared+1)*16);
      const tail=[shared,...path.slice(shared)];previous=path;return tail;
    });
    const value:Packed={...sequence,paths,pieces,pathEncoding:'prefix',changes};
    if(JSON.stringify(value).length<original.length)packed.set(sequence,value);
  }
  return packed;
}

/** Charge new paths and tuple containers before restoring the original replay program. */
export function expandPeriodSequences(reply:PeriodReply,reserve:(bytes:number)=>void){
  for(const sequence of sequences(reply)){
    const value=sequence as Packed;if(value.pathEncoding===undefined)continue;
    if(value.pathEncoding!=='prefix'||!Array.isArray(value.changes)||value.changes.length!==value.paths.length)throw new Error('invalid_period_sequence');
    let length=0,bytes=value.paths.length*16+value.pieces.length*80;
    for(const path of value.paths){
      const shared=path[0];
      if(typeof shared!=='number'||!Number.isSafeInteger(shared)||shared<0||shared>length)throw new Error('invalid_period_sequence');
      length=shared+path.length-1;bytes+=64+length*16;
    }
    for(const row of value.changes){
      if(!Array.isArray(row))throw new Error('invalid_period_sequence');
      for(const change of row){
        if(!Array.isArray(change)||change.length<1||change.length>4||!Number.isSafeInteger(change[0])||change[0]<0||change[0]>=value.pieces.length)throw new Error('invalid_period_sequence');
        bytes+=96+change.length*16;
      }
    }
    reserve(bytes);
    let previous:ValuePath=[];
    value.paths=value.paths.map(path=>previous=[...previous.slice(0,path[0] as number),...path.slice(1)]);
    for(const piece of value.pieces)piece.push([]);
    // A diff replaces a parent or its descendants, never both in one piece.
    // Its independent edits can therefore be restored in path order.
    for(const [path,row] of value.changes.entries())for(const change of row)(value.pieces[change[0]].at(-1) as ValueChange[]).push([path,...change.slice(1)] as ValueChange);
    delete (value as Partial<Packed>).pathEncoding;delete (value as Partial<Packed>).changes;
  }
}
