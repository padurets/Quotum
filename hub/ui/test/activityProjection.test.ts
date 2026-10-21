import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,consumer,NOW} from './periodRuntimeFixture';

const common=(history:any)=>{
  if(!history)return history;
  const {series:_quota,meterSeries:_money,moneyWork:_moneyWork,...frame}=history;
  return structuredClone(frame);
};
const exact=(actual:any,expected:any,label:string)=>assert.deepEqual(structuredClone(actual),structuredClone(expected),label);

for(const fixed of [false,true])test(`actual Activity ${fixed?'cold fixed sharing':'live projection'} preserves common fields and ordinary readers`,{timeout:10_000},async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed}),d=await drawings(h);
  const entry=(h.period as any).tapes.get('quota'),accounting=entry?.accounting,activity=(h.period as any).activity;
  const originalProject=accounting.project,originalActivity=activity.project;
  let accountingCalls=0,activityCalls=0,last:any;
  try{
    assert.ok(fixed?entry.tape.fixed?.quota.length>0:accounting.quota.size>0,'positive actual quota accounting, including packed fixed rows');
    assert.ok(activity&&h.period.get().rows.length>0,'positive actual producer work');
    const raw=d.loader.get().history;
    assert.ok(raw&&raw.series.length>0,'a real admitted history, not a blank frame');
    const oracle=h.period.project(raw,'quota',NOW);
    (h.period as any).forgetProjection(['quota']);
    accounting.project=function(...args:any[]){accountingCalls++;return originalProject.apply(this,args);};
    activity.project=function(...args:any[]){activityCalls++;return originalActivity.apply(this,args);};
    // Both full-component hook names reach Activity's own slots. Ordinary History
    // and Forecast below use two other slot arrays on this SAME loader.
    const readActivity=()=>last=d.renderActivity();
    const view=consumer({...h,...d,render:readActivity,renderActivity:readActivity});
    view.render();
    assert.ok(last?.history,'the actual Activity component invoked its reader');
    exact(common(last.history),common(oracle),'all common Activity fields, cells and authority');
    const activityAccounting=accountingCalls,activityProjects=activityCalls;
    const ordinary=d.render(),forecast=d.renderForecast();
    exact(ordinary.history,oracle,'ordinary History keeps complete quota/money projection');
    exact(forecast.history,oracle,'Forecast full history hook keeps complete projection');
    assert.ok(ordinary.history!.series.length>0&&forecast.history!.series.length>0);
    if(fixed){
      assert.equal(activityAccounting,1,'Activity populates the original cold full frame');
      assert.equal(accountingCalls,1,'ordinary and Forecast reuse that full frame');
      assert.equal(activityProjects,1,'one original activity projection');
      assert.equal(activityCalls,1,'fixed Activity projection is not duplicated');
      assert.equal(last.history,ordinary.history,'shared full frame identity');
      assert.equal(ordinary.history,forecast.history,'Forecast shares the same cold result');
    }else{
      assert.equal(accountingCalls-activityAccounting,2,'ordinary History and Forecast still execute full live accounting');
      assert.equal(activityProjects,1,'Activity preserves the original activity projector');
      assert.equal(activityAccounting,0,'activity-only live projection must not visit quota/money accounting');
    }
  }finally{
    accounting.project=originalProject;activity.project=originalActivity;
    try{d.close();}finally{await h.close();}
  }
});
