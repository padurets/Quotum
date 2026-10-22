import {useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject} from 'react';
import {pan} from '../lib/pan';
import {page} from '../lib/board';
import {matchesSource} from '../../server/domain/dataFilters';
import {workChange} from '../lib/workChanges';
import {effectiveFilters,filtersReady,onDataFilters} from '../lib/filterSelection';
import {legendHasSource,legendSelectionKey,type LegendSelection} from '../lib/legendSelection';

const variable = (key: string) => '--series-' + Array.from(key, letter => letter.codePointAt(0)!.toString(16)).join('-');
const styles=new Map<string,CSSProperties>();
const STYLE_LIMIT=512;

/** One inherited variable dims peers, another restores the chosen series in every layer. */
export const seriesFocusStyle = (key: string | readonly string[]): CSSProperties => {
  const keys=typeof key==='string'?[key]:key,identity=JSON.stringify(keys),kept=styles.get(identity);
  if(kept){styles.delete(identity);styles.set(identity,kept);return kept;}
  const values=keys.map(id=>`var(${variable(id)}, var(--chart-focus, 1))`);
  const style=Object.freeze({'--series-focus':values.length>1?`max(${values.join(', ')})`:values[0]??'var(--chart-focus, 1)'}) as CSSProperties;
  styles.set(identity,style);if(styles.size>STYLE_LIMIT)styles.delete(styles.keys().next().value!);
  return style;
};

/** Persistent emphasis and transient details share one local arbiter, never a data mask. */
export class SeriesFocus {
  private selected:string|null=null;
  private readonly chosen=new Set<string>();
  private readonly listeners=new Set<()=>void>();
  refresh=()=>{};
  reset=()=>{};
  dismiss=()=>{};
  get=()=>this.selected;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  attach(root:HTMLElement,phase:Pick<typeof pan,'shifting'|'active'|'onPhase'>=pan) {
    let hovered:HTMLButtonElement|null=null,focused:HTMLButtonElement|null=null,pinned:HTMLButtonElement|null=null;
    let dismissed=false,touchButton:HTMLButtonElement|null=null,timer:ReturnType<typeof setTimeout>|undefined;
    const painted=new Map<string,string>();
    const write=(key:string,value:string|undefined)=>{
      if(painted.get(key)===value)return;
      if(value===undefined){root.style.removeProperty(key);painted.delete(key);}
      else{root.style.setProperty(key,value);painted.set(key,value);}
    };
    const buttonAt=(target:EventTarget|null)=>{
      const button=target instanceof Element?target.closest<HTMLButtonElement>('button.legend-item[data-series-key]'):null;
      return button&&root.contains(button)?button:null;
    };
    const clearPin=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;pinned=null;};
    const paint=()=>{
      const buttons=Array.from(root.querySelectorAll<HTMLButtonElement>('button.legend-item[data-series-key]'));
      const represented=new Set(buttons.map(button=>button.dataset.seriesKey!));
      const button=[hovered,focused,pinned].find(button=>button&&root.contains(button));
      const next=!dismissed&&!phase.shifting()&&phase.active()===null&&!root.querySelector('.chart > svg.is-panning')?button?.dataset.seriesKey??null:null;
      const active=[...this.chosen].filter(key=>represented.has(key)),values=new Map<string,string>();
      if(next!==null||active.length)values.set('--chart-focus','.4');
      for(const key of active)values.set(variable(key),next===null?'1':'.65');
      if(next!==null)values.set(variable(next),'1');
      for(const key of painted.keys())if(!values.has(key))write(key,undefined);
      for(const [key,value] of values)write(key,value);
      for(const button of buttons){const pressed=String(this.chosen.has(button.dataset.seriesKey!));if(button.getAttribute('aria-pressed')!==pressed)button.setAttribute('aria-pressed',pressed);}
      if(next===this.selected)return;
      this.selected=next;for(const listener of this.listeners)listener();
    };
    const pointer=(event:PointerEvent)=>{
      if(event.pointerType==='touch')return;
      const next=buttonAt(event.type==='pointerout'?event.relatedTarget:event.target);
      if(next!==hovered){hovered=next;dismissed=false;}paint();
    };
    const focus=(event:FocusEvent)=>{
      const button=buttonAt(event.type==='focusout'?event.relatedTarget:event.target);
      const next=button?.matches(':focus-visible')?button:null;
      if(next!==focused){focused=next;dismissed=false;}paint();
    };
    const touch=(event:PointerEvent)=>{
      if(event.pointerType!=='touch')return;
      hovered=focused=null;
      touchButton=buttonAt(event.target);clearPin();dismissed=false;
    };
    const click=(event:MouseEvent)=>{
      const button=buttonAt(event.target),touched=button&&button===touchButton;touchButton=null;
      if(!button)return;
      const key=button.dataset.seriesKey!;
      if(this.chosen.has(key))this.chosen.delete(key);else this.chosen.add(key);
      if(touched){clearPin();pinned=button;timer=setTimeout(()=>{timer=undefined;pinned=null;paint();},4000);}
      paint();
    };
    const outside=(event:PointerEvent)=>{if(pinned&&!pinned.contains(event.target as Node)){clearPin();paint();}};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){dismissed=true;clearPin();paint();}};
    this.refresh=paint;
    this.dismiss=()=>{hovered=focused=touchButton=null;dismissed=false;clearPin();paint();};
    this.reset=()=>{this.chosen.clear();this.dismiss();};
    root.addEventListener('pointerover',pointer);root.addEventListener('pointerout',pointer);
    root.addEventListener('focusin',focus);root.addEventListener('focusout',focus);root.addEventListener('pointerup',touch);
    addEventListener('pointerdown',outside);addEventListener('keydown',escape);root.addEventListener('click',click);
    const stop=phase.onPhase(paint);
    // The chart finishes its fold after the shared gesture phase has ended.
    const observer=new MutationObserver(paint);
    observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
    paint();
    return()=>{
      root.removeEventListener('pointerover',pointer);root.removeEventListener('pointerout',pointer);
      root.removeEventListener('focusin',focus);root.removeEventListener('focusout',focus);root.removeEventListener('pointerup',touch);
      removeEventListener('pointerdown',outside);removeEventListener('keydown',escape);root.removeEventListener('click',click);stop();observer.disconnect();this.reset();
      this.refresh=this.reset=this.dismiss=()=>{};
    };
  }
}

/** Interaction never renders the chart or rebuilds its prepared geometry. */
export function useSeriesFocus(panel:RefObject<HTMLElement|null>,context?:string,selection?:LegendSelection,transient?:string) {
  const current=useRef<SeriesFocus|null>(null);if(!current.current)current.current=new SeriesFocus();
  const controller=current.current,previous=useRef({context,selection,transient}),latest=useRef(selection);
  latest.current=selection;
  useLayoutEffect(()=>{
    const before=previous.current,cards=Object.values(page.get().board?.cards??{}),filters=effectiveFilters();
    if(context!==before.context||selection&&before.selection&&filtersReady()&&legendSelectionKey(filters,selection,cards)!==legendSelectionKey(filters,before.selection,cards))controller.reset();
    else if(transient!==before.transient)controller.dismiss();
    previous.current={context,selection,transient};controller.refresh();
  });
  useEffect(()=>{
    if(!panel.current)return;
    const detach=controller.attach(panel.current);
    let filters=filtersReady()?effectiveFilters():undefined,board=page.get().board;
    const stopFilters=onDataFilters(()=>{
      if(!filtersReady())return;
      const next=effectiveFilters(),spec=latest.current,cards=Object.values(page.get().board?.cards??{});
      // Both rules use the same current inventory. Data arrivals are not filter edits.
      if(spec&&filters&&next&&legendSelectionKey(filters,spec,cards)!==legendSelectionKey(next,spec,cards))controller.reset();
      filters=next;
    });
    const stopBoard=page.listen((event,state)=>{
      const before=board;board=state.board;
      if(!board||before?.id!==board.id){controller.reset();return;}
      const kind=latest.current?.kind,activity=kind==='project'||kind==='device'||kind==='source';
      if(activity&&before?.workAuthority!==undefined&&before.workAuthority!==board.workAuthority)controller.reset();
      if(before?.lineup.some(id=>!board!.lineup.includes(id))){
        const removed=before.lineup.filter(id=>!board!.lineup.includes(id));
        if(!kind||removed.some(id=>legendHasSource(kind,before.cards[id])))controller.reset();
      }
      if((kind==='budget'||kind==='funds')&&before?.lineup.some(id=>{
        const old=before.cards[id],next=board!.cards[id];
        return old?.budget&&legendHasSource(kind,old)&&
          (old.budget.revision!==next?.budget?.revision||old.budget.enabled&&next?.budget?.enabled!==true);
      }))controller.reset();
      if(event.type==='hub'&&event.event.type==='history'&&activity){
        const data=event.event.data;
        const filters=effectiveFilters();
        if(workChange(data,board.lineup.filter(id=>!filters||matchesSource(filters,id))).retired)controller.reset();
      }
    });
    return()=>{stopFilters();stopBoard();detach();};
  },[panel,controller]);
  return controller;
}
