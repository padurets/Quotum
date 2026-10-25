import {test} from 'node:test';
import assert from 'node:assert/strict';
import childProcess, {spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import {kernelProbe, type ProcessIdentity} from '../browserProcess.js';

test('TSX-loaded kernel probe emits self-contained child code and bounded wait symbols', {
  skip: process.platform!=='linux'||process.arch!=='x64'||!process.getuid,
},async t=>{
  const originalSpawn=childProcess.spawn,originalNow=performance.now,uid=process.getuid!();
  const root:ProcessIdentity={pid:91,parent:process.pid,group:91,session:91,birth:'123',state:'S',
    minorFaults:null,majorFaults:null,userTicks:null,systemTicks:null,blockIoTicks:null};
  const fields=Array<string>(50).fill('0');fields[0]='S';fields[1]=String(root.parent);fields[2]=fields[3]='91';fields[19]='123';
  let symbol='pipe_read',calls=0,kills=0,unrefs=0;
  const pipes:{destroyed:boolean}[]=[];
  try{
    t.mock.method(performance,'now',()=>1000); // Test serialization, not host scheduler latency.
    t.mock.method(childProcess,'spawn',(command:string,args:readonly string[])=>{
      assert.equal(command,process.execPath);assert.equal(args[0],'-e');calls++;
      const files=new Map([
        ['/proc/91/stat','91 (fixture) '+fields.join(' ')],
        ['/proc/91/status',`Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`],
        ['/proc/91/wchan',symbol],['/proc/91/syscall','0 0x0 0 0 0 0 0 0 0\n'],
      ]),open=new Map<number,string>(),readOrder:string[]=[];let next=0,output='';
      const fs={constants:{O_RDONLY:0,O_NONBLOCK:1,O_NOFOLLOW:2},
        openSync:(file:string)=>{assert(files.has(file),'fixture contains every read');open.set(++next,file);return next;},
        readSync:(fd:number,b:Buffer,offset:number,length:number)=>{readOrder.push(open.get(fd)!);return Buffer.from(files.get(open.get(fd)!)!).copy(b,offset,0,length);},
        closeSync:(fd:number)=>{assert(open.delete(fd));},
        statSync:(file:string)=>{readOrder.push(file);assert.equal(file,'/proc/91/fd/0');return{isFile:()=>false,isFIFO:()=>true,isSocket:()=>false,
          isDirectory:()=>false,isCharacterDevice:()=>false,isBlockDevice:()=>false};},
      };
      // The emitted source must run without TSX's lexical helpers in a separate Node -e context.
      runInNewContext(args[1],{Buffer,require:(name:string)=>{assert.equal(name,'node:fs');return fs;},
        process:{argv:['node',args[2]],ppid:process.pid,getuid:()=>uid,hrtime:{bigint:()=>{readOrder.push('clock');return process.hrtime.bigint();}},stdout:{write:(text:string)=>{output+=text;}}}});
      assert.deepEqual(readOrder,['clock','/proc/91/stat','/proc/91/status','/proc/91/wchan','/proc/91/syscall',
        '/proc/91/fd/0','/proc/91/syscall','/proc/91/stat','/proc/91/status','clock'],'clock bounds enclose the original seven reads and descriptor stat');
      assert.equal(open.size,0,'fixture file handles close even when parsing fails');
      const pipe=()=>{const value=Object.assign(new EventEmitter(),{destroyed:false,destroy(){this.destroyed=true;}});pipes.push(value);return value;};
      const child=Object.assign(new EventEmitter(),{pid:92,stdout:pipe(),stderr:pipe(),kill(){kills++;return true;},unref(){unrefs++;}});
      queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(output));child.emit('exit',0);child.emit('close');});
      return child as unknown as childProcess.ChildProcess;
    });
    syncBuiltinESMExports();
    for(const [name,expected] of [['pipe_read','pipe_read'],['unknown_wait_symbol','unknown_wait_symbol'],
      ['0',null],['12345',null],['0xffffffff81234567',null],['ffffffff81234567',null],['deadbeef',null]] as const){
      symbol=name;
      const result=await kernelProbe(root,2000,new AbortController().signal);
      assert.equal(result.status,'observed',`self-contained child: ${name}`);
      assert.equal(result.identityStable,true);assert.deepEqual(result.wait,{kind:name==='pipe_read'?'pipe':name==='0'?'unavailable':'unknown',name:expected});
      assert.equal(result.syscall,0);assert.equal(result.fd.kind,'pipe');
      assert.equal(result.reaped,true);assert.equal(result.pipesClosed,true);assert.equal(result.released,true);
    }
    assert.equal(calls,7);assert.equal(kills,0);assert.equal(unrefs,7);assert(pipes.every(value=>value.destroyed));
  }finally{
    t.mock.restoreAll();syncBuiltinESMExports();
    assert.equal(childProcess.spawn,originalSpawn);assert.equal(spawn,originalSpawn);assert.equal(performance.now,originalNow);
  }
});
