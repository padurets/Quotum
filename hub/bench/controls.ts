import type {Cdp} from './cdp.js';
import {reload} from './reload.js';
import {deadline} from './deadline.js';
import type {Evidence} from './evidence.js';

/** A saved radio remains focused, so the next native arrow can save another choice. */
export async function frequencyKeys(cdp: Cdp) {
  await cdp.evaluate(`(() => {
    const trigger = document.querySelector('.card-head .picker > button');
    if (!trigger) throw new Error('no card menu');
    trigger.focus(); trigger.click();
  })()`);
  await cdp.evaluate(`(async () => {
    const end = Date.now() + 5000;
    while (!document.querySelector('.popover [role=radiogroup] input:checked')) {
      if (Date.now() > end) throw new Error('no measuring-frequency group');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    document.querySelector('.popover [role=radiogroup] input:checked').focus();
  })()`);
  for (const index of [1, 2]) {
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39});
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39});
    await cdp.evaluate(`(async () => {
      const end = Date.now() + 5000;
      const group = () => document.querySelector('.popover [role=radiogroup]');
      while (group()?.getAttribute('aria-busy') === 'true' || group()?.querySelector('.is-on')?.textContent !== '${index}') {
        if (Date.now() > end) throw new Error('frequency arrow ${index} did not save');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const radio = group().querySelectorAll('input')[${index}];
      if (!radio.checked || document.activeElement !== radio) throw new Error('saving frequency lost native radio focus');
    })()`);
  }
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
}

/** Each phase keeps its intended monetary selection across the page reload. */
export async function selectMoney(cdp: Cdp, ids: [string, string][], family:'budget'|'funds'='budget') {
  const panel=family==='funds'?'.subscription-funds':'.budget-history';
  await cdp.evaluate(`(() => {
    const prefs = JSON.parse(localStorage.getItem('quotum.prefs') || '{}');
    prefs.${family==='funds'?'funds':'money'} = {unit: 'USD', view: 'balance', selected: {USD: ${JSON.stringify(ids)}}};
    prefs.muted = {};
    localStorage.setItem('quotum.prefs', JSON.stringify(prefs));
  })()`);
  await reload(cdp);
  await cdp.evaluate(`(async () => {
    const end = Date.now() + 5000;
    let previous = '', stable = 0;
    while (stable < 3) {
      if (Date.now() > end) throw new Error('money selection did not load');
      await new Promise(requestAnimationFrame);
      const root = document.querySelector('${panel} .chart > svg');
      const series = Array.from(document.querySelectorAll('${panel} [data-series]'));
      const waiting = document.querySelector('.history.is-loading,.activity.is-loading,.budget-history.is-loading,.subscription-funds.is-loading,.chart>svg[data-draw-ready="false"]');
      const ready = root?.dataset.drawReady === 'true' && !waiting && series.length === ${ids.length} && series.every(line => Array.from(line.querySelectorAll('path.series')).some(path => path.getAttribute('d')));
      const box = root?.getBoundingClientRect(), size = box ? [box.x, box.y, box.width, box.height].join(':') : '';
      const moving = document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.target?.matches('.widget, .widget-body'));
      stable = ready && !moving && size === previous ? stable + 1 : 0;
      previous = size;
    }
  })()`);
}

/** A zero cap keeps the scale's origin unchanged when balances become spending. */
export async function moneyView(cdp: Cdp, source: string, cappedSource: string, cap: string, evidence?: Pick<Evidence, 'save'>) {
  await selectMoney(cdp, [[source, 'balance'], [cappedSource, cap]]);
  await cdp.evaluate(`document.querySelector('.budget-history .panel-head button').click()`);
  for (const [index, label] of ['Spending', 'Balance', 'Spending'].entries()) {
    try {
      await cdp.evaluate(`(async () => {
      const button = Array.from(document.querySelectorAll('.popover .segmented button')).find(b => b.textContent === ${JSON.stringify(label)});
      if (!button) throw new Error('no money view control');
      const evidence=window.__quotumMoneyViewEvidence={name:${JSON.stringify(label)},sourceId:${JSON.stringify(source)},frames:[],omitted:0};
      const read=window.__quotumMoneyViewRead=frame=>{
        const series=document.querySelector('[data-series="${source} balance"]');
        const paths=series?.matches('path')?[series]:Array.from(series?.querySelectorAll('path.series')||[]);
        const root=document.querySelector('.budget-history .chart > svg'),box=series?.getBBox(),height=series?.ownerSVGElement.viewBox.baseVal.height;
        return {frame,at:performance.now(),ready:root?.dataset.drawReady==='true',paths:paths.filter(path=>path.getAttribute('d')).length,
          from:Number(root?.dataset.drawFrom),to:Number(root?.dataset.drawTo),box:box?[box.x,box.y,box.width,box.height]:null,height};
      };
      evidence.before=read(-1);
      button.click();
      const end=Date.now()+5000;
      let frames=0;
      do {
        await new Promise(requestAnimationFrame);
        const record=read(frames);
        evidence.frames.push(record);if(evidence.frames.length>20){evidence.frames.shift();evidence.omitted++;}
        if (!record.paths) {evidence.firstMissing=record;throw new Error('money line disappeared while selecting ${label}');}
        if (record.box[1] < 0 || record.box[1] + record.box[3] > record.height) throw new Error('switching money view left the line outside its new scale');
        if (Date.now() > end) throw new Error('money view did not commit ${label}');
      } while (++frames < 2 || document.querySelector('.budget-history .chart > svg')?.dataset.drawReady !== 'true');
    })()`);
    } finally {
      if(evidence)try {
        const state=await deadline(5000,signal=>cdp.evaluate(`(async()=>{
          const state=window.__quotumMoneyViewEvidence;
          if(state?.firstMissing){state.after=[];for(let i=0;i<2;i++){await new Promise(requestAnimationFrame);state.after.push(window.__quotumMoneyViewRead(state.firstMissing.frame+i+1));}}
          return state;
        })()`,signal));
        evidence.save('money-view-'+index,state);
      } catch {evidence.save('money-view-'+index,{status:'unavailable'});}
    }
  }
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
}
