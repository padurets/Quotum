import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkHistoryTransport, type HistoryRead} from '../lib/historyTransport';
import type {Chunk, HistoryReply} from '../../server/domain/history';
import type {MoneyWorkCells} from '../../server/domain/moneyWork';
import {HistoryTile} from '../lib/historyTiles';
import {drain} from '../lib/prepare';
import {activeHours} from '../lib/money';

const reply:HistoryReply={run:'run',now:120_000,historyStart:0,known:{work:0,sources:{}},chunks:[]};
const quota:HistoryRead={board:'board',scope:'quota',cell:60_000,from:0,to:120_000};
const budget:HistoryRead={...quota,scope:'budget',cell:300_000,to:600_000,meters:{ids:[['source','balance']],unit:'USD',work:true}};

test('one work event combines two visible tails while retaining their resolutions and selections',async()=>{
  const singles:HistoryRead[]=[],pairs:HistoryRead[][]=[];
  const transport=new WorkHistoryTransport({single:async read=>{singles.push(read);return reply;},pair:async(_board,reads)=>{pairs.push(reads);return {parts:reads.map(read=>({scope:read.scope,reply}))};}});
  assert.deepEqual(await Promise.all([transport.read(quota,undefined,1),transport.read(budget,undefined,1)]),[reply,reply]);
  assert.deepEqual(singles,[]);assert.deepEqual(pairs,[[quota,budget]]);
  await Promise.all([transport.read(quota,undefined,2),transport.read(budget,undefined,3)]);
  assert.equal(singles.length,2,'different events remain independent');
  await Promise.all([transport.read(quota,undefined,4),transport.read({...budget,meters:{...budget.meters!,work:false}},undefined,4)]);
  assert.equal(singles.length,4,'pure financial traffic is never coalesced as work');
});

test('cancelling one consumer leaves the other part live and cancelling both stops transport',async()=>{
  let finish:((value:{parts:{scope:'quota'|'budget';reply:HistoryReply}[]})=>void)|undefined,signal:AbortSignal|undefined;
  const transport=new WorkHistoryTransport({single:async()=>reply,pair:async(_board,_reads,current)=>{signal=current;return new Promise(resolve=>{finish=resolve;});}});
  const first=new AbortController(),second=new AbortController();
  const one=transport.read(quota,first.signal,1),two=transport.read(budget,second.signal,1);
  const rejected=assert.rejects(one,{name:'AbortError'});await Promise.resolve();first.abort();
  assert.equal(signal?.aborted,false);finish!({parts:[{scope:'quota',reply},{scope:'budget',reply}]});await rejected;assert.equal(await two,reply);
  const third=new AbortController(),fourth=new AbortController(),three=transport.read(quota,third.signal,2),four=transport.read(budget,fourth.signal,2);
  const both=Promise.all([assert.rejects(three,{name:'AbortError'}),assert.rejects(four,{name:'AbortError'})]);await Promise.resolve();third.abort();fourth.abort();
  assert.equal(signal?.aborted,true);finish!({parts:[{scope:'quota',reply},{scope:'budget',reply}]});await both;
});

test('money work survives staged tile replacement without mutating the published generation',()=>{
  const cell=60_000,known={work:0,sources:{source:0}},tile=new HistoryTile(0,cell);
  tile.readTo=60*cell;
  const empty:Omit<Chunk,'from'|'to'>={series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[]};
  const group:MoneyWorkCells={source:'source',unit:'USD',knownFrom:0,partial:false,edges:[],cells:[[1,60_000,120_000,'9007199254740993',60_000,120_000,60_000,'9007199254740993']]};
  tile.merge({from:0,to:60*cell,...empty,moneyWork:[group]},known);
  const before=tile.chunk(known),copy=drain(tile.staged({from:cell,to:2*cell,...empty,moneyWork:[{...group,cells:[[0,30_000,30_000,'1',30_000,30_000,60_000,'1']]}]},known));
  assert.deepEqual(tile.chunk(known),before);assert.equal(copy.chunk(known).moneyWork![0].cells[0][3],'1');assert.equal(before.moneyWork![0].cells[0][3],'9007199254740993');
  assert.equal(copy.chunk(known,true).moneyWork,undefined,'chart buffers do not carry work aggregates');
  assert.match(activeHours('32425917317067575400000'),/9.*007.*199.*254.*740.*993/);
});
