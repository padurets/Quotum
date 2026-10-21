import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tickPresentation} from '../lib/axisTicks';

test('a date near either clip edge is wholly omitted, never shortened into another date',()=>{
  for(const scale of [.5,.73,1]){
    const pose={a:1,b:0,offset:0};
    assert.equal(tickPresentation(48+12.113,44,pose,scale,48,691).visible,false,'the reported 14 October label cannot lose its leading digit');
    assert.equal(tickPresentation(691-12,44,pose,scale,48,691).visible,false);
    assert.equal(tickPresentation(100,44,pose,scale,48,691).visible,true);
    const moving={a:.58,b:20,offset:-scale*40};
    const view=tickPresentation(200,44,moving,scale,48,691);
    assert.equal(view.visible,true);
    const [translate,unscale]=[...view.transform.matchAll(/[-.\d]+/g)].map(x=>Number(x[0]));
    assert.ok(Math.abs((unscale*200+translate)*moving.a+moving.b+moving.offset/scale-(moving.a*200+moving.b-40))<1e-8);
    assert.ok(Math.abs(unscale*moving.a-1)<1e-8,'persistent horizontal projection leaves the glyph width unchanged');
  }
});
