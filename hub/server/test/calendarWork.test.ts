import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarCurve,calendarProof,calendarProjection} from '../domain/calendarWork.js';
import {calendarPartition,calendarCells} from '../domain/workCalendar.js';
import {drain} from '../domain/prepare.js';
import type {Stretch} from '../domain/work.js';
import {expandPeriod,periodDictionary} from '../domain/periodWire.js';
import {compactJSON} from '../history.js';

const M=60_000,H=60*M,NOW=Date.UTC(2026,9,20,13,17,29);
const row=(from:number,to:number):Stretch=>({from,to} as Stretch);
test('anonymous calendar sweeps match raw exact cells across clipping, gaps and parallel work',()=>{
  const range={from:NOW-25*H+123,to:NOW},cut=NOW-37_123,known=range.from+12_345,retained=range.from+111,retention=90*24*H,period=25*H;
  const rows=[row(range.from-1_000,NOW-H),row(range.from+5_678,range.from+2*H+7),row(NOW-70*M+13,NOW-5*M+17),row(NOW-17*M,NOW+H)];
  for(const available of [null,known]){
    const proof={...drain(calendarProof(rows,range,cut,available,retained,()=>{})),retentionMs:retention,periodMs:period};
    const {curve}=calendarCurve(proof,range,cut,available,()=>{}),edges=calendarPartition(range);
    const expected=drain(calendarCells(rows,edges,edges.slice(1).map((_,i)=>i),cut,available,retained,retention,range,period)).map(([,c])=>c);
    assert.deepEqual(calendarProjection(edges,range,cut,available,retained,retention,period,[{from:range.from,to:cut,curve}]),expected);
    const basis={run:'r',revision:'1',evaluatedAt:NOW,evidenceCut:cut,range};
    const reply={basis,calendar:{state:'complete' as const,basis:{...basis,calendarKey:'k',filterKey:'f',workAuthority:'a'},value:{zone:'UTC',availableFrom:available,retainedFrom:retained,cursor:'c',edges,cells:expected,proof}}};
    const dictionary=periodDictionary(reply,()=>{}),text=compactJSON(reply,dictionary.replacer),wire=JSON.parse(text);
    assert.equal(wire.calendar.value.cells,undefined);assert.deepEqual(expandPeriod(wire),reply);assert.ok(text.length<JSON.stringify(reply).length/8);
    assert.deepEqual(proof.sources.map(s=>s.id),['work']);assert.ok(!text.includes('producer'));
    assert.throws(()=>calendarCurve({...proof,sources:[{...proof.sources[0],id:'source-id'}]},range,cut,available,()=>{}),/invalid_calendar_proof/);
  }
});
