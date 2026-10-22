import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarProof} from '../domain/calendarWork.js';
import {calendarCells,calendarPartition} from '../domain/workCalendar.js';
import {expandCalendar,packCalendar} from '../domain/workCalendarWire.js';
import {drain} from '../domain/prepare.js';
import type {Stretch} from '../domain/work.js';

const H=3_600_000,now=Date.UTC(2026,9,22,11,27,29,509);
function fixture(){
  const range={from:now-30*24*H+17,to:now-23},cut=range.to-37_123,known=range.from+12_345,retained=range.from-24*H;
  const basis={run:'run',revision:'102984',evaluatedAt:now,evidenceCut:cut,range,calendarKey:'calendar',workAuthority:'work',filterKey:'filter'};
  const rows=Array.from({length:180},(_,i)=>({from:range.from+i*3*H+123,to:range.from+i*3*H+(i%3+1)*H-17} as Stretch));
  const edges=calendarPartition(range),retention=90*24*H;
  const cells=drain(calendarCells(rows,edges,edges.slice(1).map((_,i)=>i),cut,known,retained,retention,range)).map(([,cell])=>cell);
  const proof={...drain(calendarProof(rows,range,cut,known,retained,()=>{})),retentionMs:retention};
  const part={state:'complete' as const,basis,value:{zone:'UTC',availableFrom:known,retainedFrom:retained,cursor:'cursor',edges,cells,proof}};
  const wire=packCalendar(part,basis,()=>{})!;
  const {proof:_proof,...value}=part.value;
  const residentWire=packCalendar({...part,value},basis,()=>{})!;
  let resident=0;expandCalendar(structuredClone(residentWire),basis,bytes=>{resident+=bytes;});
  return {basis,part,wire,resident};
}

test('calendar decoding releases its anonymous sweep while retaining exact numeric cells and proof',()=>{
  const h=fixture();let outstanding=0,peak=0,released=0;
  const decoded=expandCalendar(structuredClone(h.wire),h.basis,bytes=>{outstanding+=bytes;peak=Math.max(peak,outstanding);},bytes=>{assert.ok(bytes<=outstanding);outstanding-=bytes;released+=bytes;});
  assert.deepEqual(decoded,h.part);
  assert.ok(h.part.value.cells.some(cell=>(cell.agentMs??0)>0));
  assert.ok(released>0,'the temporary sweep must end before the next reply section is decoded');
  assert.ok(peak>outstanding);
  assert.equal(outstanding,h.resident,'only the same restored basis, edges and numeric cells remain in addition to the wire body');
});

test('every refused calendar allocation releases only admitted sweep staging and preserves the original error',()=>{
  const h=fixture(),sizes:number[]=[];
  expandCalendar(structuredClone(h.wire),h.basis,bytes=>{sizes.push(bytes);},()=>{});
  assert.ok(sizes.length>10);
  for(let denied=2;denied<sizes.length;denied++){
    let call=0,outstanding=0,released=0;const error=new Error('denied allocation '+denied);
    assert.throws(()=>expandCalendar(structuredClone(h.wire),h.basis,bytes=>{if(call++===denied)throw error;outstanding+=bytes;},bytes=>{assert.ok(bytes<=outstanding);outstanding-=bytes;released+=bytes;}),actual=>actual===error);
    assert.equal(outstanding,h.resident,'a rejected builder cannot retain scratch or release restored cell capacity');
    if(denied>2)assert.ok(released>0);
  }
});

for(const failure of ['invalid proof','overflow'] as const)test('calendar '+failure+' releases its temporary sweep without hiding the decode failure',()=>{
  const h=fixture(),wire=structuredClone(h.wire);assert.ok(wire.state==='complete'&&wire.value.proof);
  if(failure==='invalid proof')wire.value.proof.patterns[0][1]=-1;
  else {
    wire.value.proof.patterns=[[0,Number.MAX_SAFE_INTEGER,H,-Number.MAX_SAFE_INTEGER]];
    wire.value.proof.sources[0].blocks=[Math.ceil(h.basis.range.from/H),0];
  }
  let outstanding=0,released=0;
  assert.throws(()=>expandCalendar(wire,h.basis,bytes=>{outstanding+=bytes;},bytes=>{assert.ok(bytes<=outstanding);outstanding-=bytes;released+=bytes;}),failure==='invalid proof'?/invalid_source_work/:/calendar_overflow/);
  assert.ok(released>0);
  assert.equal(outstanding,h.resident);
});
