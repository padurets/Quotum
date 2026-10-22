import type {Cdp} from './cdp.js';
import {deadline} from './deadline.js';
import {formatLocale, setLocale} from '../ui/i18n/index.js';
import {timeRangeLabel} from '../ui/lib/timeRange.js';
import {PERIODS, periodLabel} from '../ui/lib/periods.js';

/** Compare the live caption's layout with the former plain text, outside native input. */
export async function captionGeometry(cdp:Pick<Cdp,'send'|'evaluate'>,signal:AbortSignal) {
  const labels:{text:string;selected:boolean}[]=[],original=formatLocale().startsWith('ru')?'ru':'en';
  try {
    for(const language of ['en','ru'] as const) {
      setLocale(language,false);
      labels.push(...PERIODS.map(period=>({text:periodLabel(period),selected:false})));
      for(let month=0;month<12;month++) {
        const from=new Date(2026,month,8,11,11).getTime();
        labels.push({text:timeRangeLabel({from,to:from+30*86_400_000}),selected:true});
      }
      for(const [day,hour,minute,length] of [[1,11,11,60],[8,18,18,60],[9,22,59,60],[9,23,59,60],[10,0,0,60],[30,23,59,1440],[28,11,11,4320]]) {
        const from=new Date(2026,8,day,hour,minute).getTime();
        labels.push({text:timeRangeLabel({from,to:from+length*60_000}),selected:true});
      }
    }
  } finally {setLocale(original,false);}
  const failures:{case:number;width:number;font:number;reason:string}[]=[];
  let checks=0,failed=false;
  try {
    for(const width of [320,360,480,679,680,681,1024,1280]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},signal);
      const result=await cdp.evaluate<{checks:number;failures:typeof failures}>(`(async()=>{
        await document.fonts.ready;
        const source=document.querySelector('.analytics-head');
        if(!source||source.hidden)throw Error('Caption geometry controls unavailable');
        const host=document.createElement('div');
        host.style.cssText='position:absolute;left:-20000px;top:0;width:${width}px';
        const old=source.cloneNode(true),current=source.cloneNode(true);
        old.style.position=current.style.position='static';
        const oldCaption=old.querySelector('.period-caption'),currentCaption=current.querySelector('.period-caption');
        if(!oldCaption||!currentCaption||currentCaption.children.length!==2||currentCaption.firstElementChild.getAttribute('aria-hidden')!=='true')throw Error('Caption geometry shape unavailable');
        const plain=document.createElement('span');oldCaption.replaceWith(plain);
        const clears=[old,current].map(root=>{
          const period=root.querySelector('.period'),first=period.querySelector('.icon-button'),clear=first.cloneNode(true);
          clear.classList.add('period-clear');period.insertBefore(clear,first);return clear;
        });
        host.append(old,current);document.body.append(host);
        const labels=${JSON.stringify(labels)},failures=[];let checks=0;
        const shape=(root,text)=>{
          const base=root.getBoundingClientRect(),rect=box=>[box.x-base.x,box.y-base.y,box.width,box.height];
          const range=document.createRange();range.selectNodeContents(text);
          return [...['.period','.period .text-button','.period-name','.period-name>svg',...Array.from(root.querySelectorAll('.period .icon-button'),(_,i)=>'.period .icon-button:nth-of-type('+(i+1)+')')].map(selector=>{
            const node=root.querySelector(selector);return node?.getClientRects().length?rect(node.getBoundingClientRect()):null;
          }),rect(text.getBoundingClientRect()),[...range.getClientRects()].map(rect)];
        };
        const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)?a.length===b.length&&a.every((v,i)=>same(v,b[i])):a===null||b===null?a===b:Math.abs(a-b)<=1/64;
        try {
          for(const font of [0,1]) {
            old.style.fontFamily=current.style.fontFamily=font?'system-ui':'';
            for(let index=0;index<labels.length;index++) {
              const label=labels[index].text;for(const clear of clears)clear.style.display=labels[index].selected?'':'none';
              plain.textContent=label;
              currentCaption.firstElementChild.textContent=label.replace(/\\d/g,'0');currentCaption.lastElementChild.textContent=label;
              checks++;
              if(!same(shape(old,plain),shape(current,currentCaption.lastElementChild)))failures.push({case:index,width:${width},font,reason:'Caption rectangles or wrapped lines changed'});
              if(currentCaption.lastElementChild.textContent!==label||getComputedStyle(currentCaption.firstElementChild).visibility!=='hidden'||getComputedStyle(currentCaption.lastElementChild).visibility!=='visible')throw Error('Caption visible words unavailable');
            }
          }
          return {checks,failures};
        } finally {host.remove();}
      })()`,signal);
      checks+=result.checks;failures.push(...result.failures);
    }
  } catch(error) {failed=true;throw error;}
  finally {
    try {await deadline(2000,cleanup=>cdp.send('Emulation.clearDeviceMetricsOverride',{},cleanup));}
    catch(error) {if(!failed)throw error;}
  }
  return {cases:labels.length,checks,failures};
}
