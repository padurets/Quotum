import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tickKeyframes, tickPresentation} from '../lib/axisTicks';

const translation=(frame:Keyframe)=>Number(String(frame.transform).match(/translateX\(([-.\d]+)px\)/)?.[1]);

/** Sample WAAPI's piecewise linear properties after the effect's shared easing. */
function sample(frames:Keyframe[],progress:number){
  let index=0;
  while(index+1<frames.length&&Number(frames[index+1].offset)<=progress)index++;
  const before=frames[index],after=frames[Math.min(index+1,frames.length-1)];
  const fraction=before===after?0:(progress-Number(before.offset))/(Number(after.offset)-Number(before.offset));
  return {offset:translation(before)+(translation(after)-translation(before))*fraction,
    visible:before.visibility==='visible'||after.visibility==='visible'&&fraction>0};
}

test('a date near either clip edge is wholly omitted, never shortened into another date',()=>{
  for(const scale of [.5,.73,1]){
    const pose={a:1,b:0,offset:0};
    assert.equal(tickPresentation(48+12.113,44,pose,scale,48,691).visible,false,'the reported 14 October label cannot lose its leading digit');
    assert.equal(tickPresentation(691-12,44,pose,scale,48,691).visible,false);
    assert.equal(tickPresentation(100,44,pose,scale,48,691).visible,true);
    const moving={a:.58,b:20,offset:-scale*40};
    const view=tickPresentation(200,44,moving,scale,48,691);
    assert.equal(view.visible,true);
    assert.ok(Math.abs(200+translation({transform:view.transform})+moving.offset/scale-(moving.a*200+moving.b-40))<1e-8);
    assert.ok(!view.transform.includes('scale'),'the label is a translated sibling of the scaled data');
  }
});

test('animated dates keep constant glyph width and exactly follow the data through every intermediate pose',()=>{
  let visible=0,hidden=0;
  for(const [start,end] of [
    [{a:.58,b:20},{a:1.2,b:-40}],
    [{a:1.2,b:-40},{a:.58,b:20}],
    [{a:1,b:-300},{a:1,b:800}],
    [{a:1,b:800},{a:1,b:-300}],
  ])for(const x of [60,200,500,680]){
    const frames=tickKeyframes(x,44,start,end,48,691);
    for(let step=0;step<=1000;step++){
      const progress=step/1000,actual=sample(frames,progress),center=x+actual.offset;
      const expected=(start.a+(end.a-start.a)*progress)*x+start.b+(end.b-start.b)*progress;
      assert.ok(Math.abs(center-expected)<1e-8,'label and data use the same eased progress');
      assert.ok(frames.every(frame=>!String(frame.transform).includes('scale')));
      if(actual.visible){visible++;assert.ok(center-22>=48-1e-8&&center+22<=691+1e-8,'every visible glyph fits wholly in the time clip');}
      else hidden++;
      const fits=center-22>48+1e-8&&center+22<691-1e-8;
      if(fits)assert.equal(actual.visible,true,'an interior label is not hidden to evade edge checks');
    }
  }
  assert.ok(visible>1000&&hidden>1000,'the oracle observes both interior and edge portions of real movement');
});

test('stationary, oversized and out-of-bounds labels have explicit endpoint visibility',()=>{
  for(const [x,length,expected]of [[200,44,true],[50,44,false],[680,44,false],[200,700,false]] as const){
    const frames=tickKeyframes(x,length,{a:1,b:0},{a:1,b:0},48,691);
    for(const progress of [0,.1,.5,.99,1])assert.equal(sample(frames,progress).visible,expected);
  }
  for(const [start,end]of [[{a:1,b:1000},{a:2,b:1100}],[{a:1,b:-1000},{a:2,b:-1100}]]){
    const frames=tickKeyframes(200,44,start,end,48,691);
    for(const progress of [0,.2,.7,1])assert.equal(sample(frames,progress).visible,false);
  }
});
