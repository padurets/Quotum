import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryLimitOutput,observeHistoryLimits,type HistoryLimitReport} from '../historyLimit.js';
import {ReadError} from '../../server/historyRead.js';
import {HistoryLimit} from '../../server/history.js';

const body={version:1,evaluatedAt:12345,selection:{mode:'live',periodMs:86400000},quota:{},sessions:{},sourceWork:{},calendar:{},privateLabel:'SYNTHETIC_PRIVATE'};
const sample:HistoryLimitReport={event:'history_limit',physicalAttemptBound:false,stage:'input',limit:{requested:11,reserved:90,budget:100},evaluatedAt:12345,selection:{mode:'live',periodMs:86400000},quota:true,wallet:false,funds:false,sessions:true,sourceWork:true,calendar:true};

for(const stage of ['input','preparation','work-access'] as const)test('the demo retains the original '+stage+' refusal without changing its promise',async()=>{
  const cause=new HistoryLimit({requested:11,reserved:90,budget:100}),error=new ReadError(413,'history_limit',stage,cause),pending=Promise.reject(error),reports:HistoryLimitReport[]=[];
  const signal=new AbortController().signal;
  class Reader {readAsync(board:string,user:string,raw:unknown,seen?:AbortSignal){assert.equal(board,'board');assert.equal(user,'user');assert.equal(raw,body);assert.equal(seen,signal);return pending;}}
  const restore=observeHistoryLimits(Reader,{ReadError,HistoryLimit},report=>reports.push(report));
  try{
    const result=new Reader().readAsync('board','user',body,signal);assert.equal(result,pending);
    await assert.rejects(result,actual=>actual===error);
    assert.deepEqual(reports,[{...sample,stage}]);assert.equal(error.cause,cause);
    assert.equal(JSON.stringify(reports).includes('SYNTHETIC_PRIVATE'),false);
  }finally{restore();}
});

test('graceful sections and other failures stay silent, and a broken observer preserves the original rejection',async()=>{
  for(const outcome of ['section','other','observer'] as const){
    const error=outcome==='other'?new ReadError(503,'unavailable'):new ReadError(413,'history_limit','preparation',new HistoryLimit());
    const result=outcome==='section'?Promise.resolve('{"quota":{"state":"error","error":"history_limit"}}'):Promise.reject(error);let emitted=0;
    class Reader {readAsync(_board:string,_user:string,_raw:unknown){return result;}}
    const restore=observeHistoryLimits(Reader,{ReadError,HistoryLimit},()=>{emitted++;throw new Error('observer failed');});
    try{
      const seen=new Reader().readAsync('board','user',body);assert.equal(seen,result);
      if(outcome==='section')assert.equal(await seen,await result);else await assert.rejects(seen,actual=>actual===error);
      assert.equal(emitted,outcome==='observer'?1:0);
    }finally{restore();}
  }
});

test('reports omit unexpected cause fields and stop after four refusals',async()=>{
  const reports:HistoryLimitReport[]=[],cause=new HistoryLimit(Object.assign({requested:11,reserved:90,budget:100},{privateLabel:'SYNTHETIC_PRIVATE'}));
  class Reader {readAsync(_board:string,_user:string,_raw:unknown){return Promise.reject(new ReadError(413,'history_limit','input',cause));}}
  const restore=observeHistoryLimits(Reader,{ReadError,HistoryLimit},report=>reports.push(report));
  try{
    for(let i=0;i<8;i++)await assert.rejects(new Reader().readAsync('board','user',body));
    assert.equal(reports.length,4);assert.deepEqual(reports[0],sample);assert.equal(JSON.stringify(reports).includes('SYNTHETIC_PRIVATE'),false);
  }finally{restore();}
});

test('stderr forwarding accepts split reports and rejects arbitrary, incomplete or oversized output',()=>{
  const reports:HistoryLimitReport[]=[],output=new HistoryLimitOutput(report=>reports.push(report)),line=JSON.stringify(sample)+'\n';
  output.add(Buffer.from('backend private SYNTHETIC_PRIVATE\n'));
  output.add(Buffer.from(JSON.stringify({...sample,privateLabel:'SYNTHETIC_PRIVATE'})+'\n'));
  output.add(Buffer.from('x'.repeat(4096)));output.add(Buffer.from('\n'));
  for(const byte of Buffer.from(line))output.add(Buffer.from([byte]));
  assert.deepEqual(reports,[sample]);
  output.add(Buffer.from(JSON.stringify(sample)));assert.equal(reports.length,1);
  output.add(Buffer.from('\n'));assert.equal(reports.length,2);
  for(let i=0;i<8;i++)output.add(Buffer.from(line));assert.equal(reports.length,4);
  assert.equal(JSON.stringify(reports).includes('SYNTHETIC_PRIVATE'),false);
});

test('stderr forwarding never passes malformed classifications or reservation numbers',()=>{
  const reports:HistoryLimitReport[]=[],output=new HistoryLimitOutput(report=>reports.push(report));
  for(const change of [{stage:'private'},{physicalAttemptBound:true},{evaluatedAt:-1},{limit:{requested:1,reserved:1,budget:100}},{limit:{requested:Infinity,reserved:1,budget:100}},{selection:{mode:'range',from:1,to:2,label:'private'}},{sessions:'yes'}])output.add(Buffer.from(JSON.stringify({...sample,...change})+'\n'));
  assert.deepEqual(reports,[]);
  const broken=new HistoryLimitOutput(()=>{throw new Error('writer failed');});assert.doesNotThrow(()=>broken.add(Buffer.from(JSON.stringify(sample)+'\n')));
});
