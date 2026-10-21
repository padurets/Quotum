import type {Cdp} from './cdp.js';

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
  const panel=family==='funds'?'[data-widget="subscription-funds"]':'[data-widget="budget-history"]';
  const draft=await cdp.evaluate<string>(`(async () => {
    const prefs = JSON.parse(localStorage.getItem('quotum.prefs') || '{}');
    prefs.${family==='funds'?'funds':'money'} = {...prefs.${family==='funds'?'funds':'money'},version:1,unit:'USD'};
    localStorage.setItem('quotum.prefs', JSON.stringify(prefs));
    const session=await (await fetch('/api/session')).json(),board=new URL(location.href).searchParams.get('board')??session.boards.find(board=>board.personal)?.id;
    if(!board||!session.user)throw new Error('money selection needs its authenticated board');
    const url='/api/boards/'+encodeURIComponent(board)+'/filters',saved=await (await fetch(url)).json(),filters=saved.filters,ids=${JSON.stringify(ids)};
    if(${JSON.stringify(family)}==='funds'){
      filters.funds={mode:'include',values:[...new Set(ids.map(([source])=>source))]};
    }else{
      filters.wallet={mode:'only',values:ids.map(([source,meter])=>{const key=/^key:([^:]+):cap$/.exec(meter.replace(/^fx:[^:]+:/,''));return key?{source,kind:'keyCap',key:key[1]}:{source,kind:'balance'};})};
    }
    const response=await fetch(url,{method:'PUT',headers:{'content-type':'application/json','If-Match':'"'+saved.revision+'"'},body:JSON.stringify({filters,authority:saved.authority,replace:[${JSON.stringify(family==='funds'?'funds':'wallet')}]})});
    if(!response.ok)throw new Error('money selection save failed: '+response.status);
    return 'quotum.filters.'+JSON.stringify([session.user.id,board]);
  })()`);
  // The old tab can receive its saved defaults before reload; clear only this
  // benchmark tab's draft before the new document initializes its filter store.
  const clearing=await cdp.send<{identifier:string}>('Page.addScriptToEvaluateOnNewDocument',{source:`sessionStorage.removeItem(${JSON.stringify(draft)})`});
  const loaded = new Promise<void>((resolve, reject) => {
    const late = setTimeout(() => reject(new Error('money view reload did not finish')), 5000);
    cdp.on('Page.loadEventFired', () => {clearTimeout(late); resolve();});
  });
  await cdp.send('Page.reload');
  await loaded;
  if(clearing?.identifier)await cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:clearing.identifier});
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

/** The balance view keeps account and scoped-limit values inside their scale. */
export async function moneyView(cdp: Cdp, source: string, cappedSource: string, cap: string) {
  await selectMoney(cdp, [[source, 'balance'], [cappedSource, cap]]);
  await cdp.evaluate(`(() => {
    const panel=document.querySelector('[data-widget="budget-history"]'),svg=panel?.querySelector('.chart>svg');
    if(svg?.dataset.drawReady!=='true')throw new Error('budget plot is not ready');
    const paths=Array.from(panel.querySelectorAll('.series[d]:not([d=""])'));
    if(!paths.length)throw new Error('budget plot has no account line');
    for(const path of paths){const box=path.getBBox();if(box.y<0||box.y+box.height>svg.viewBox.baseVal.height)throw new Error('budget line left its scale');}
  })()`);
}
