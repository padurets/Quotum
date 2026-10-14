import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeScroll} from '../nativeScroll';
import type {Cdp} from '../cdp';

test('native wheel injection preserves direction and physical time without waiting for renderer ACKs',async()=>{
  const commands:{method:string;params:Record<string,number|string>}[]=[],acks:(()=>void)[]=[];let at=1_790_000_000_000,ready!:()=>void,finished=false;
  const injected=new Promise<void>(resolve=>ready=resolve);
  const cdp={send:(method:string,params:Record<string,number|string>)=>{commands.push({method,params});return new Promise<void>(resolve=>acks.push(resolve));}} as unknown as Pick<Cdp,'send'>;
  const running=nativeScroll(cdp,{x:100,y:200},25,10,async ms=>{assert.equal(ms,16);at+=ms;if(commands.length===4)ready();},()=>at).then(()=>{finished=true;});
  await injected;
  assert.equal(finished,false);assert.equal(commands.length,4,'every native event is injected while ACKs remain blocked');
  assert.ok(commands.every(command=>command.method==='Input.dispatchMouseEvent'&&command.params.type==='mouseWheel'));
  assert.equal(commands.reduce((sum,command)=>sum+Number(command.params.deltaX),0),-15);
  assert.ok(commands.slice(0,3).every(command=>Number(command.params.deltaX)<0));assert.equal(commands[3].params.deltaX,10);
  assert.deepEqual(commands.map(command=>command.params.timestamp),[1_790_000_000,1_790_000_000.016,1_790_000_000.032,1_790_000_000.048]);
  acks.forEach(resolve=>resolve());await running;
});

test('failed native delivery stops injection and preserves the original error',async()=>{
  const error=new Error('renderer unavailable');let calls=0;
  const cdp={send:()=>{calls++;return Promise.reject(error);}} as unknown as Pick<Cdp,'send'>;
  await assert.rejects(nativeScroll(cdp,{x:0,y:0},100,0,async()=>{}),error);assert.equal(calls,1);
});
