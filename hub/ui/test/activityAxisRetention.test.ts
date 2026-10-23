import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityAxisFixture} from './activityAxisFixture';

const M=60000,H=3600000;

for(const periodMs of [2*M,3*M,6*M])test(`Activity retains its value projection while a six-minute range returns to a pending ${periodMs/M}-minute live period`,()=>{
  const to=12*M+17017;
  const f=activityAxisFixture(false,{range:{from:to-6*M,to},periodMs,now:to+1000,cells:[[10*M,H],[11*M,H]],warmup:false});
  const before=f.snapshot('ready fixed range'),token=f.begin();
  assert.equal(before.ratio,1);
  f.flush();f.pan.move(token,2);f.runFrame();f.settle();
  const active=f.snapshot('last accepted input');
  f.props.prepared=false;
  assert.equal(f.pan.finish(token),'live');
  assert.equal(f.commits.at(-1),null,'the actual controller returns to live');
  f.flush();
  const finalFrame=f.runFrame();
  const retained=(value:ReturnType<typeof f.snapshot>)=>{
    assert.equal(value.drawReady,'false','the previous prepared model still owns the paths');
    assert.equal(value.path,active.path,'the same positive artwork is retained');
    assert.equal(value.ratio,active.ratio,'the requested period cannot rescale retained artwork');
    assert.equal(value.lowBarY,active.lowBarY,'the positive bar keeps its height');
    assert.deepEqual(value.landmarks,active.landmarks,'the final time pose and value projection stay together');
    assert.deepEqual(value.labels,active.labels,'the scale describes the retained bars');
  };
  retained(finalFrame);f.settle();retained(f.snapshot('pending after React'));
  f.parentUpdate();f.flush();retained(f.snapshot('another pending publication'));
  f.props.prepared=true;f.stageModel();f.settle();
  const replacement=f.snapshot('ready live replacement');
  assert.equal(replacement.drawReady,'true');
  assert.equal(replacement.ratio,1,'the replacement owns its numeric basis');
  assert.deepEqual(replacement.labels,before.labels);
});

for(const periodMs of [H,24*H,72*H])test(`Activity retains interior dates until its 72-hour drawing is replaced by the ${periodMs/H}-hour live period`,()=>{
  const to=Date.UTC(2026,9,23,3,17,17),landmarks=[to-20*M,to-10*M];
  const f=activityAxisFixture(false,{range:{from:to-72*H,to},periodMs,now:to+1000,cells:landmarks.map(at=>[at,H]),landmarks,warmup:false});
  const visible=(value:ReturnType<typeof f.snapshot>)=>value.timeTicks.filter(tick=>tick.visible);
  const token=f.begin();f.flush();f.pan.move(token,2);f.runFrame();f.settle();
  const active=f.snapshot('last input');
  assert.deepEqual(visible(active).map(tick=>tick.at),[Date.UTC(2026,9,21),Date.UTC(2026,9,22)]);
  assert.ok(visible(active).every(tick=>tick.text&&tick.position>69&&tick.position<367),'both complete date labels lie inside the plot');
  f.props.prepared=false;
  assert.equal(f.pan.finish(token),'live');
  const retained=(value:ReturnType<typeof f.snapshot>)=>{
    assert.equal(value.path,active.path);
    assert.equal(value.ratio,active.ratio);
    assert.deepEqual(visible(value),visible(active),'retained artwork keeps its readable time landmarks');
  };
  retained(f.runFrame());f.flush();retained(f.snapshot('pending React commit'));
  f.settle();f.parentUpdate();f.flush();retained(f.snapshot('later pending publication'));
  assert.equal(f.snapshot('still pending').drawReady,'false');
  f.props.prepared=true;f.stageModel();f.settle();
  const replacement=f.snapshot('ready live drawing');
  assert.equal(replacement.drawReady,'true');
  assert.ok(visible(replacement).length>=2);
  assert.ok(visible(replacement).every(tick=>tick.at>=to+1000-periodMs&&tick.at<=to+1000),'replacement labels describe its own live period');
});

test('Activity keeps its fully known retained range until a partial replacement owns the drawing',()=>{
  // The query cutoff can advance before the hourly prune changes work authority.
  const now=1_800_000_000_000,cut=now-90*24*H,range={from:cut+77017,to:cut+3617017};
  const cells:[number,number][]=[[cut+6*M,42983],...[7,8,9,10].map(minute=>[cut+minute*M,M] as [number,number]),[cut+11*M,17017]];
  const f=activityAxisFixture(false,{range,now,cells,landmarks:[cut+7*M,cut+10*M],warmup:false});
  const initial=f.snapshot('fully known range');
  assert.equal(initial.hatch,null);
  f.props.prepared=false;f.props.unknownTo=cut+3*M;
  f.choose({...range,to:range.to+M});f.flush();
  const retained=f.snapshot('partial incoming answer, old drawing');
  assert.equal(retained.drawReady,'false');
  assert.equal(retained.path,initial.path);
  assert.equal(retained.hatch,null,'a confirmed null boundary belongs to the retained model');
  f.parentUpdate();f.flush();
  assert.equal(f.snapshot('another pending publication').hatch,null);
  f.props.prepared=true;f.stageModel();f.settle();
  const replacement=f.snapshot('partial replacement');
  assert.equal(replacement.drawReady,'true');
  assert.ok(replacement.hatch&&replacement.hatch.width>0,'the new model presents its actual unknown prefix');
});

const dateEnd=Date.UTC(2026,9,23,3,17,17);
const dates=[Date.UTC(2026,9,21),Date.UTC(2026,9,22)];
function retained72(periodMs:number){
  const landmarks=[dateEnd-20*M,dateEnd-10*M];
  const f=activityAxisFixture(false,{range:{from:dateEnd-72*H,to:dateEnd},periodMs,now:dateEnd+1000,cells:[dateEnd-4*H,dateEnd-3*H,...landmarks].map(at=>[at,H]),landmarks,warmup:false});
  f.pointerDown();f.flush();f.pointerMove(198);f.runFrame();f.settle();
  f.props.prepared=false;f.pointerUp();f.runFrame();f.flush();f.settle();
  assert.equal(f.snapshot('pending live').selected,null);
  return f;
}
const visibleDates=(value:ReturnType<ReturnType<typeof activityAxisFixture>['snapshot']>)=>value.timeTicks.filter(tick=>tick.visible).map(tick=>tick.at);

for(const periodMs of [H,24*H,72*H])for(const cancel of [false,true])test(`Activity keeps the displayed 72-hour scale and dates through another actual gesture before its ${periodMs/H}-hour replacement (${cancel?'cancel':'release'})`,()=>{
  const f=retained72(periodMs),before=f.snapshot('held'),token=f.pointerDown();
  const check=(label:string)=>{
    const value=f.snapshot(label);
    assert.equal(value.path,before.path,'the saved artwork is still displayed');
    assert.equal(value.drawReady,'false');
    assert.equal(value.ratio,1,`${label}: semantic selection cannot change the visible value scale`);
    assert.ok(value.lowBarY>=12&&value.lowBarY<272,'positive artwork stays inside the value clip');
    assert.ok(value.bars.some(bar=>bar.x>48&&bar.x<388&&bar.y>=12&&bar.y<272),'a positive bar is visible inside both plot axes');
    assert.ok(Math.abs(value.viewport.to-value.viewport.from-72*H)<1,'the native viewport retains its own duration');
    assert.deepEqual(visibleDates(value),dates,`${label}: both interior dates remain readable`);
  };
  check('pointer down before React');f.flush();check('pointer down after React');
  f.pointerMove(210);f.runFrame();check('move before React');f.flush();check('move after React');
  if(cancel)f.pan.cancel(token);else f.pointerUp(210);
  f.flush();check('stop before final RAF');f.runFrame();check('final RAF before React');f.flush();f.settle();check('settled stop');
  if(cancel)assert.deepEqual(f.snapshot('restored').landmarks,before.landmarks,'cancel restores the actual capture');
  else assert.ok(f.snapshot('committed').selected,'the actual release supplies semantic fixed bounds');
});

for(const periodMs of [H,24*H])test(`Activity labels an explicit ${periodMs/H}-hour projection while the saved numeric basis is still 72 hours`,()=>{
  const f=retained72(periodMs),before=f.snapshot('held');
  f.choose({from:dateEnd+1000-periodMs,to:dateEnd+1000});f.flush();
  const pending=f.snapshot('new explicit projection');
  const expected=periodMs===H?[Date.UTC(2026,9,23,2,30),Date.UTC(2026,9,23,2,45),Date.UTC(2026,9,23,3)]:[6,12,18,24].map(hour=>Date.UTC(2026,9,22,hour));
  assert.equal(pending.path,before.path);
  assert.ok(Math.abs(pending.viewport.to-pending.viewport.from-periodMs)<1);
  assert.deepEqual(visibleDates(pending),expected,'labels describe the visible duration with its normal readable density');
  f.props.prepared=true;f.stageModel();f.settle();
  const ready=f.snapshot('ready');
  assert.deepEqual(visibleDates(ready),expected);
  ready.landmarks.forEach((x,i)=>assert.ok(Math.abs(x-pending.landmarks[i])<1e-8,'readiness keeps positive-bar X'));
});

test('Activity labels the leading interior day after a historical 72-hour move and pending release',()=>{
  const landmarks=[dateEnd-24*H-20*M,dateEnd-24*H-10*M];
  const f=activityAxisFixture(false,{range:{from:dateEnd-72*H,to:dateEnd},periodMs:24*H,now:dateEnd+1000,cells:landmarks.map(at=>[at,H]),landmarks,warmup:false});
  f.pointerDown();f.flush();f.pointerMove(200+340/3);f.runFrame();f.settle();
  f.props.prepared=false;f.pointerUp();f.runFrame();f.flush();f.settle();
  const pending=f.snapshot('shifted historical viewport');
  assert.deepEqual(visibleDates(pending),[Date.UTC(2026,9,20),Date.UTC(2026,9,21)]);
  assert.equal(pending.ratio,1);
  f.props.prepared=true;f.stageModel();f.settle();
  const ready=f.snapshot('new numeric basis');
  assert.deepEqual(visibleDates(ready),visibleDates(pending));
  ready.landmarks.forEach((x,i)=>assert.ok(Math.abs(x-pending.landmarks[i])<1e-8));
});
