import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';
import {activityClockConsumer} from './activityClockFixture';
import {PageClock} from '../lib/clock';
import {arbiter} from './seriesFocusFixture';
import {num,workHours} from '../lib/format';
import {atOnce} from '../lib/activity';

/** Real composed legend entries and numerical consumers, with the controller's DOM fixture. */
test('legend emphasis remains usable during shared replacement without changing its preparation or numerical cohort',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true});
  const credit=(project:string,from:number,to:number,sessionId=project)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:project,startedAt:NOW-H,identity:{kind:'stable',sessionId}}]);
  credit('Keep project',NOW-20*M,NOW-18*M);h.events.flush();await flush();
  const d=await drawings(h),focus=arbiter(),paint=consumer({...h,...d},{focus:focus.controller});
  const clock=new PageClock({now:()=>NOW,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}}),legends:ReturnType<typeof activityClockConsumer>[]=[];
  let summary:ReturnType<typeof activityClockConsumer>|undefined,held:ReturnType<typeof h.hold>|undefined;
  const bind=(entries:any[])=>{
    for(const entry of entries){
      const legend=activityClockConsumer('LegendItem',clock,h.period,entry);legends.push(legend);legend.render();
      const key=legend.element().props.children[0].props['data-series-key'];
      let button=focus.buttons.find(button=>button.dataset.seriesKey===key);
      if(!button){button=focus.buttons.find(button=>!button.attached)!;assert.ok(button);button.dataset.seriesKey=key;button.attached=true;}
    }
    focus.controller.refresh();
  };
  try{
    focus.buttons.forEach(button=>{button.attached=false;});
    const a=paint.settle();assert.equal(a.entries.length,2);bind(a.entries);
    summary=activityClockConsumer('Totals',clock,h.period,a.totals);const baseline=summary.render();assert.ok(baseline.includes('data-agent-ms="180000"'));
    const previewed=a.entries.find((entry:any)=>entry.name==='Keep project')!;
    const previewButton=focus.buttons.find(button=>button.dataset.seriesKey.endsWith(previewed.groupKey))!;
    const selectedButton=focus.buttons.find(button=>button.attached&&button!==previewButton)!;
    held=h.hold();credit(previewed.name,NOW-19*M,NOW-16*M,'Keep replacement');h.events.flush();await flush();
    const pending=paint.render();assert.equal(pending.entries.length,2);assert.deepEqual(pending.paths,a.paths);
    const reads=h.requests.length,parent=paint.queuedParent(),child=paint.queuedChild(),renders=summary.renders;
    focus.click(selectedButton);assert.equal(selectedButton.pressed,'true');assert.equal(summary.render(),baseline);assert.equal(summary.renders,renders,'S changes paint without notifying numerical consumers');
    focus.hover(previewButton);assert.equal(focus.controller.get(),previewButton.dataset.seriesKey);
    const checkPreview=(entry:any)=>{
      const html=summary!.render(),values=[...html.matchAll(/<b[^>]*>(.*?)<\/b>/g)].map(match=>match[1]),group=entry.group;
      assert.deepEqual(values,[workHours(group.agentMs),workHours(group.activeMs),num(group.agents),atOnce(group.agentMs,group.activeMs)],'all four H metrics use the committed group');
      assert.ok(html.includes(`data-agent-ms="${group.agentMs}"`));
    };
    checkPreview(previewed);
    const unchanged=paint.render();assert.equal(unchanged.totals.history,a.totals.history);assert.deepEqual(unchanged.paths,a.paths);
    assert.equal(paint.queuedParent(),parent);assert.equal(paint.queuedChild(),child);assert.equal(h.requests.length,reads);
    held.release();await flush();
    const current=h.period.activitySummaryAt('project',NOW,previewed.groupKey).by.project.find((group:any)=>group.key===previewed.groupKey);
    assert.deepEqual([current.agentMs,current.activeMs,current.agents,current.agentMs/current.activeMs],[5*M,4*M,2,1.25],'the shared owner has adopted B before either preparation commits');
    summary.update(paint.render().totals);
    checkPreview(previewed);assert.deepEqual(paint.render().paths,a.paths);
    paint.finishParent();const queued=paint.render();summary.update(queued.totals);
    assert.equal(queued.totals.history,a.totals.history);checkPreview(previewed);assert.deepEqual(queued.paths,a.paths);
    paint.finishChild();const b=paint.settle();assert.equal(b.entries.length,2);bind(b.entries);
    const next=b.entries.find((entry:any)=>entry.groupKey===previewed.groupKey)!;
    assert.notEqual(next.group.agentMs,previewed.group.agentMs,'B changes the previewed group before its drawing commits');
    summary.update(b.totals);checkPreview(next);
    assert.equal(selectedButton.pressed,'true','ordinary data arrival preserves the chosen identity');focus.send('pointerout',previewButton);
    assert.ok(summary.update(b.totals).includes('data-agent-ms="360000"'),'the default summary still describes the entire new shared cohort');
    assert.equal(b.entries.reduce((sum:number,entry:any)=>sum+entry.group.agentMs,0),6*M);assert.equal(h.pool.activeFlights,0);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
  }finally{held?.release();await flush();summary?.close();legends.forEach(legend=>legend.close());focus.cleanup();paint.close();d.close();await h.close();}
});
