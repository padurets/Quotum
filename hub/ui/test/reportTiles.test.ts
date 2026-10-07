import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReportTile} from '../lib/reportTiles';
import {drain} from '../lib/prepare';
import {composeReportsPrepared,reportSummary,REPORT_DAY} from '../../server/domain/reports';
test('packed report tiles preserve original days, replace revisions and leave committed leaves untouched',()=>{
  const tile=new ReportTile(),day=REPORT_DAY;
  const series={source:'s',meter:'costs',kind:'reported' as const,unit:'USD',intervals:[{from:0,to:day,amount:'5000000',valueObservedAt:10,revision:1}]};
  drain(tile.mergePrepared(0,day/4,[series]));
  const staged=drain(tile.clonePrepared());
  drain(staged.mergePrepared(0,day/4,[{...series,intervals:[{...series.intervals[0],amount:'4000000',revision:2}]}]));
  assert.equal(drain(tile.chunkPrepared(0,day/4))[0].intervals[0].amount,'5000000');
  const chunks=[{reportSeries:drain(tile.chunkPrepared(0,day/4))},{reportSeries:drain(staged.chunkPrepared(0,day/4))}];
  const composed=drain(composeReportsPrepared(chunks,0,day));
  assert.equal(composed[0].intervals.length,1);assert.equal(composed[0].intervals[0].amount,'4000000');
  assert.equal(reportSummary(composed[0].intervals,undefined,0,day/4,day).amount,null);
  assert.ok(tile.bytes>JSON.stringify(series).length,'byte leaves and overhead participate in the existing cache budget');
});
