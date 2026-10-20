import {useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject} from 'react';
import {pan} from '../lib/pan';

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

/** One arbiter supplies paint and the separate numerical reader with the same context. */
export class SeriesFocus {
  private selected:string|null=null;
  private readonly listeners=new Set<()=>void>();
  refresh=()=>{};
  reset=()=>{};
  get=()=>this.selected;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  attach(root:HTMLElement,phase:Pick<typeof pan,'shifting'|'active'|'onPhase'>=pan) {
    let hovered:HTMLButtonElement|null=null,focused:HTMLButtonElement|null=null,pinned:HTMLButtonElement|null=null;
    let dismissed=false,disposed=false,touchButton:HTMLButtonElement|null=null,timer:ReturnType<typeof setTimeout>|undefined;
    const buttonAt=(target:EventTarget|null)=>{
      const button=target instanceof Element?target.closest<HTMLButtonElement>('button.legend-item[data-series-key]'):null;
      return button&&root.contains(button)?button:null;
    };
    const clearPin=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;pinned=null;};
    const paint=()=>{
      const button=[hovered,focused,pinned].find(button=>button&&root.contains(button));
      const next=!dismissed&&!phase.shifting()&&phase.active()===null&&!root.querySelector('.chart > svg.is-panning')&&button?.getAttribute('aria-pressed')==='true'?button.dataset.seriesKey??null:null;
      if(next===this.selected)return;
      if(this.selected!==null)root.style.removeProperty(variable(this.selected));
      if(next!==null){root.style.setProperty('--chart-focus','.25');root.style.setProperty(variable(next),'1');}
      else root.style.removeProperty('--chart-focus');
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
      hovered=null;
      touchButton=buttonAt(event.target);clearPin();dismissed=false;
    };
    const click=(event:MouseEvent)=>{
      const button=touchButton;touchButton=null;
      if(!button||buttonAt(event.target)!==button)return;
      // The window receives click after React has committed the visibility toggle.
      queueMicrotask(()=>{if(disposed)return;if(button.isConnected&&button.getAttribute('aria-pressed')==='true'){
        pinned=button;timer=setTimeout(()=>{timer=undefined;pinned=null;paint();},4000);
      }paint();});
    };
    const outside=(event:PointerEvent)=>{if(pinned&&!pinned.contains(event.target as Node)){clearPin();paint();}};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){dismissed=true;clearPin();paint();}};
    this.refresh=paint;
    this.reset=()=>{hovered=focused=touchButton=null;dismissed=false;clearPin();paint();};
    root.addEventListener('pointerover',pointer);root.addEventListener('pointerout',pointer);
    root.addEventListener('focusin',focus);root.addEventListener('focusout',focus);root.addEventListener('pointerup',touch);
    addEventListener('pointerdown',outside);addEventListener('keydown',escape);addEventListener('click',click);
    const stop=phase.onPhase(paint);
    // The chart finishes its fold after the shared gesture phase has ended.
    const observer=new MutationObserver(paint);
    observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
    return()=>{
      root.removeEventListener('pointerover',pointer);root.removeEventListener('pointerout',pointer);
      root.removeEventListener('focusin',focus);root.removeEventListener('focusout',focus);root.removeEventListener('pointerup',touch);
      disposed=true;removeEventListener('pointerdown',outside);removeEventListener('keydown',escape);removeEventListener('click',click);stop();observer.disconnect();this.reset();
      this.refresh=this.reset=()=>{};
    };
  }
}

/** Interaction never renders the chart or rebuilds its prepared geometry. */
export function useSeriesFocus(panel:RefObject<HTMLElement|null>,context?:string) {
  const current=useRef<SeriesFocus|null>(null);if(!current.current)current.current=new SeriesFocus();
  const controller=current.current,previous=useRef(context);
  useLayoutEffect(()=>{if(context!==previous.current){controller.reset();previous.current=context;}controller.refresh();});
  useEffect(()=>panel.current?controller.attach(panel.current):undefined,[panel,controller]);
  return controller;
}
