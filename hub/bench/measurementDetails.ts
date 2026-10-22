import type {Cdp} from './cdp.js';

export type MeasurementCase={source:string;label:string;status:'fresh'|'stale'|'missing'|'live'};

/** The full disclosure must show every glyph, including the nested historical status label. */
export async function inspectMeasurementDetails(cdp:Pick<Cdp,'evaluate'>,reading:MeasurementCase){
  return cdp.evaluate<Record<string,unknown>>(`(async()=>{
    const expected=${JSON.stringify(reading)};let card,trigger;
    const wait=async(test)=>{const end=Date.now()+10000;while(!test()){if(Date.now()>end)throw Error('measurement disclosure did not become ready');await new Promise(r=>setTimeout(r,20));}};
    await wait(()=>{card=[...document.querySelectorAll('[data-widget]')].find(e=>e.dataset.widget==='source:'+expected.source);trigger=card?.querySelector('.card-head .picker>button');return trigger;});
    trigger.scrollIntoView({block:'center'});await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    // A newly available meter may add a node inside its already placed data area.
    const geometry=()=>[...document.querySelectorAll('.widgets>.widget,.card-primary')].map(e=>{const b=e.getBoundingClientRect();return[b.x+scrollX,b.y+scrollY,b.width,b.height];});
    const before=geometry();trigger.focus();trigger.click();
    const name=()=>[...card.querySelectorAll('.measurement-details .limit-name')].find(e=>e.textContent.includes(expected.label));
    await wait(()=>{
      const element=name(),status=element?.querySelector('.key-status'),value=element?.closest('.limit-top')?.querySelector('.limit-value')?.textContent;
      if(!element||card.querySelector('.measurement-details .period-status'))return false;
      if(expected.status==='live')return !status&&value?.includes('58');
      return !!element.querySelector('.cap-label')&&!!status&&(expected.status==='fresh'?status.getAttribute('aria-hidden')==='true':status.getAttribute('aria-hidden')!=='true')&&(expected.status==='missing'?value?.trim()==='—':value?.includes('58'));
    });
    const element=name(),leaf=element.querySelector('.cap-label>span')??element,status=element.querySelector('.key-status'),value=element.closest('.limit-top')?.querySelector('.limit-value'),popup=element.closest('.popover');
    if(!popup||!value)throw Error('measurement disclosure bypassed the shared surface or value');
    if(expected.status==='live'){if(status)throw Error('live fixture unexpectedly used the historical status wrapper');}
    else if(!status||!element.querySelector('.cap-label'))throw Error('historical fixture missed the nested status path');
    if(expected.status==='fresh'&&status.getAttribute('aria-hidden')!=='true')throw Error('fresh fixture was not fresh');
    if((expected.status==='stale'||expected.status==='missing')&&status.getAttribute('aria-hidden')==='true')throw Error('fixture status was unexpectedly hidden');
    if(expected.status==='missing'&&value.textContent.trim()!=='—')throw Error('missing fixture invented a value');
    if(expected.status!=='missing'&&!value.textContent.includes('58'))throw Error('fixture did not read the intended observation');
    element.scrollIntoView({block:'nearest'});await new Promise(requestAnimationFrame);
    const rect=b=>({left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}),panel=popup.getBoundingClientRect(),text=document.createRange();text.selectNodeContents(leaf);
    const glyphs=[...text.getClientRects()].filter(b=>b.width>0&&b.height>0),number=value.getBoundingClientRect(),failures=[];
    if(!glyphs.length)failures.push('no text glyphs');
    if(panel.left<-.5||panel.right>innerWidth+.5||panel.top<-.5||panel.bottom>innerHeight+.5)failures.push('popup outside viewport');
    if(document.documentElement.scrollWidth>innerWidth)failures.push('disclosure widened the page');
    if(popup.scrollWidth>popup.clientWidth+1)failures.push('disclosure needs horizontal scrolling');
    for(const b of [...glyphs,number,...(status?.getAttribute('aria-hidden')!=='true'&&status?[status.getBoundingClientRect()]:[])]){
      if(b.left<panel.left-.5||b.right>panel.right+.5||b.top<panel.top-.5||b.bottom>panel.bottom+.5)failures.push('text, status or value outside glass');
      for(let parent=leaf;parent&&parent!==popup;parent=parent.parentElement){const style=getComputedStyle(parent),box=parent.getBoundingClientRect();if(style.overflowX!=='visible'&&(b.left<box.left-.5||b.right>box.right+.5))failures.push('glyph clipped by ancestor');}
    }
    if(glyphs.some(b=>b.right>number.left+.5&&b.left<number.right-.5&&b.bottom>number.top+.5&&b.top<number.bottom-.5))failures.push('name overlaps value');
    const after=geometry();if(JSON.stringify(after)!==JSON.stringify(before))failures.push('opening disclosure moved widget geometry');
    const result={status:expected.status,label:leaf.textContent,panel:rect(panel),value:rect(number),glyphs:glyphs.map(rect),failures,geometryChanges:after.flatMap((box,i)=>JSON.stringify(box)===JSON.stringify(before[i])?[]:[{index:i,before:before[i],after:box}])};
    trigger.click();
    if(failures.length)throw Error('measurement disclosure: '+JSON.stringify(result));
    return result;
  })()`);
}
