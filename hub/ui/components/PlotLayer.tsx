import type {ReactNode, Ref} from 'react';

type Geometry = {width: number; height: number};

/** SVG keeps its coordinates; only its HTML owner moves on each input frame. */
export function PlotLayer({width, height, scale, left, right, children, under = false, main = false, clipRef, top = 0, bottom = 0}: Geometry & {
  scale: number; left: number; right: number; children: ReactNode;
  under?: boolean; main?: boolean; clipRef?: Ref<HTMLDivElement>; top?: number; bottom?: number;
}) {
  const artwork = <div className="plot-move" data-plot-main={main || undefined} style={{left: -left * scale, width: width * scale}}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <g className="slides">{children}</g>
    </svg>
  </div>;
  return (
    <div className={`plot-layer${under ? ' is-under' : ''}`} style={top || bottom ? {clipPath: `inset(${top / height * 100}% 0 ${bottom / height * 100}% 0)`} : undefined}>
      <div ref={clipRef} className={`plot-clip${clipRef ? ' is-band' : ''}`} style={{left: left * scale, right: right * scale}}>
        {clipRef ? <div className="plot-crop"><div className="plot-crop"><div className="plot-unclip">{artwork}</div></div></div> : artwork}
      </div>
    </div>
  );
}

/** Two translated clips intersect at the bar edges; the last translation restores the artwork. */
export function clipPlot(frame: HTMLDivElement, from: number, to: number, width: number) {
  const left = parseFloat(frame.style.left), right = parseFloat(frame.style.right);
  const span = width - left - right;
  const a = Math.max(0, Math.min(span, from - left)), b = Math.max(a, Math.min(span, to - left));
  const visible = b > a && span > 0;
  if (frame.style.visibility !== (visible ? '' : 'hidden')) frame.style.visibility = visible ? '' : 'hidden';
  const offsets = visible ? [a, b - a - span, span - b] : [0, 0, 0];
  let content = frame.firstElementChild as HTMLElement;
  for (const offset of offsets) {
    const transform = offset ? `translateX(${offset}px)` : '';
    if (content.style.transform !== transform) content.style.transform = transform;
    content = content.firstElementChild as HTMLElement;
  }
}

/** Readouts and selection stay above the moving artwork, outside its time clip. */
export function PlotOverlay({width, height, children}: Geometry & {children: ReactNode}) {
  return <div className="plot-overlay"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">{children}</svg></div>;
}
