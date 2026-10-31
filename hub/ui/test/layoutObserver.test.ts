import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

function fixture() {
  const frames=new Map<number,()=>void>(),native:Observer[]=[];
  let serial=0;
  class Observer {
    targets=new Map<Element,ResizeObserverOptions|undefined>();
    constructor(readonly callback:ResizeObserverCallback){native.push(this);}
    observe(target:Element,options?:ResizeObserverOptions){this.targets.set(target,options);}
    unobserve(target:Element){this.targets.delete(target);}
    disconnect(){this.targets.clear();}
  }
  const context={exports:{} as typeof import('../lib/layoutObserver'),ResizeObserver:Observer,
    requestAnimationFrame:(run:()=>void)=>{const id=++serial;frames.set(id,run);return id;},cancelAnimationFrame:(id:number)=>frames.delete(id)};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../lib/layoutObserver.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return {...context.exports,native,frames,paint:()=>{const ready=[...frames.values()];frames.clear();ready.forEach(run=>run());}};
}

test('a grid fill pauses every observer of its root, keeping other roots and deep measurements live',()=>{
  const f=fixture(),root={} as Element,other={} as Element,row={} as Element;
  const a=new f.LayoutObserver(()=>{}),b=new f.LayoutObserver(()=>{});
  a.observe(root);a.observe(other);b.observe(root,{box:'border-box'});b.observe(row);
  f.pauseLayoutObservers(root);
  assert.equal(f.native[0].targets.has(root),false);assert.equal(f.native[1].targets.has(root),false);
  assert.equal(f.native[0].targets.has(other),true);assert.equal(f.native[1].targets.has(row),true);
  f.pauseLayoutObservers(root);assert.equal(f.frames.size,2,'repeated fills share each pending subscription');
  f.paint();
  assert.equal(f.native[0].targets.has(root),true);assert.equal(f.native[1].targets.get(root)?.box,'border-box');
  assert.equal(f.frames.size,0,'rearming does not create a permanent frame loop');
});

test('a content change during the pause reaches its original callback on re-observation',()=>{
  const f=fixture(),root={} as Element;let height=100,seen=0;
  const observer=new f.LayoutObserver(entries=>{seen=entries[0].contentRect.height;});observer.observe(root);
  f.pauseLayoutObservers(root);height=150;f.paint();
  assert.ok(f.native[0].targets.has(root));
  f.native[0].callback([{target:root,contentRect:{height}}] as ResizeObserverEntry[],f.native[0] as unknown as ResizeObserver);
  assert.equal(seen,150);
});

test('unmount and replacement cancel pending subscriptions without resurrecting detached roots',()=>{
  const f=fixture(),old={} as Element,next={} as Element;
  const observer=new f.LayoutObserver(()=>{});observer.observe(old);
  f.pauseLayoutObservers(old);observer.unobserve(old);observer.observe(next);f.paint();
  assert.equal(f.native[0].targets.has(old),false);assert.equal(f.native[0].targets.has(next),true);
  f.pauseLayoutObservers(next);observer.disconnect();assert.equal(f.frames.size,0);f.paint();
  assert.equal(f.native[0].targets.size,0);
  f.pauseLayoutObservers(next);assert.equal(f.frames.size,0,'disconnected observers leave the shared registry');
});
