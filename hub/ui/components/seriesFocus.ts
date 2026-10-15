import {useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject} from 'react';

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

/** Legend interaction changes paint only; prepared data and React consumers stay asleep. */
export function useSeriesFocus(panel: RefObject<HTMLElement | null>) {
  const refresh = useRef(() => {});
  useLayoutEffect(() => refresh.current());
  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    let hovered: HTMLButtonElement | null = null, focused: HTMLButtonElement | null = null, selected: string | null = null;
    const buttonAt = (target: EventTarget | null) => {
      const button = target instanceof Element ? target.closest<HTMLButtonElement>('button.legend-item[data-series-key]') : null;
      return button && root.contains(button) ? button : null;
    };
    const paint = () => {
      const button = hovered && root.contains(hovered) ? hovered : focused && root.contains(focused) ? focused : null;
      const next = button?.getAttribute('aria-pressed') === 'true' ? button.dataset.seriesKey ?? null : null;
      if (next === selected) return;
      if (selected !== null) root.style.removeProperty(variable(selected));
      if (next !== null) {
        root.style.setProperty('--chart-focus', '.25');
        root.style.setProperty(variable(next), '1');
      } else root.style.removeProperty('--chart-focus');
      selected = next;
    };
    const pointer = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      hovered = buttonAt(event.type === 'pointerout' ? event.relatedTarget : event.target);
      paint();
    };
    const focus = (event: FocusEvent) => {
      const button = buttonAt(event.type === 'focusout' ? event.relatedTarget : event.target);
      focused = button?.matches(':focus-visible') ? button : null;
      paint();
    };
    refresh.current = paint;
    root.addEventListener('pointerover', pointer);
    root.addEventListener('pointerout', pointer);
    root.addEventListener('focusin', focus);
    root.addEventListener('focusout', focus);
    return () => {
      root.removeEventListener('pointerover', pointer);
      root.removeEventListener('pointerout', pointer);
      root.removeEventListener('focusin', focus);
      root.removeEventListener('focusout', focus);
      if (selected !== null) root.style.removeProperty(variable(selected));
      root.style.removeProperty('--chart-focus');
      refresh.current = () => {};
    };
  }, [panel]);
}
