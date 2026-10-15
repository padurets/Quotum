import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Chunk} from '../../server/domain/history';
import type {MoneyWorkCells} from '../../server/domain/moneyWork';
import {HistoryTile} from '../lib/historyTiles';
import {drain} from '../lib/prepare';
import {activeHours} from '../lib/money';

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
