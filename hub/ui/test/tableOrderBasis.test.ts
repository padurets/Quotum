import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {evaluatedRange} from '../../server/domain/period';

test('quota and budget order clocks retain the same basis as cells while a discarded prefix reloads',()=>{
  const H=3_600_000,now=10*H;
  let reads=0;
  const tape={selection:{mode:'live',periodMs:H},rangeKey:'1h',tape:{from:now-H},accounting:{
    quotaWorkSlope:()=>{reads++;return {slope:1,next:now+1000};},changesAt:()=>{reads++;return now+500;},
  }};
  const source=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
  const methods=source.slice(source.indexOf('  quotaOrderAt('),source.indexOf('  private workBoundary('));
  const context={evaluatedRange,exports:{} as {Order: new()=>any}};
  runInNewContext(ts.transpileModule(`export class Order {tapes=new Map();${methods}}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  const order=new context.exports.Order();order.tapes.set('quota',tape);order.tapes.set('budget',tape);
  const line={sourceId:'s',windowId:'w'};
  assert.equal(order.quotaOrderAt(line,now,'1h',true).slope,1);assert.equal(order.moneyOrderAt(now,'1h'),now+500);
  const before=reads;
  for(const at of [now-1,now-240_000]){
    const result=order.quotaOrderAt(line,at,'1h',true);
    assert.equal(result.slope,0);assert.equal(result.next,Infinity);
    assert.equal(order.moneyOrderAt(at,'1h'),null);
  }
  assert.equal(reads,before,'a retained range never schedules work from unavailable evidence');
  assert.equal(order.quotaOrderAt(line,now,'old-range',true).next,Infinity);assert.equal(order.moneyOrderAt(now,'old-range'),null);
  assert.equal(order.quotaOrderAt(line,now+1,'1h',true).slope,1,'ordinary forward time resumes the existing accounting clocks');
});
