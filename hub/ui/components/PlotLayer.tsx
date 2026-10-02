import type {ReactNode, Ref} from 'react';

type Geometry = {width: number; height: number};

/** SVG keeps its coordinates; only its HTML owner moves on each input frame. */
export function PlotLayer({width, height, scale, left, right, children, under = false, main = false, clipRef, top = 0, bottom = 0}: Geometry & {
  scale: number; left: number; right: number; children: ReactNode;
  under?: boolean; main?: boolean; clipRef?: Ref<HTMLDivElement>; top?: number; bottom?: number;
}) {
  return (
    <div className={`plot-layer${under ? ' is-under' : ''}`} style={top || bottom ? {clipPath: `inset(${top / height * 100}% 0 ${bottom / height * 100}% 0)`} : undefined}>
      <div ref={clipRef} className={`plot-clip${clipRef ? ' is-band' : ''}`} style={{left: left * scale, right: right * scale}}>
        <div className="plot-move" data-plot-main={main || undefined} style={{left: -left * scale, width: width * scale}}>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
            <g className="slides">{children}</g>
          </svg>
        </div>
      </div>
    </div>
  );
}

/** Insets change the clip without laying out the SVG's ancestors on each frame. */
export function clipPlot(frame: HTMLDivElement, from: number, to: number, width: number) {
  const left = parseFloat(frame.style.left), right = parseFloat(frame.style.right);
  const span = width - left - right;
  const a = Math.max(0, Math.min(span, from - left)), b = Math.max(a, Math.min(span, to - left));
  const inset = span - b;
  const clip = a || inset ? `inset(0 ${inset}px 0 ${a}px)` : '';
  if (frame.style.clipPath !== clip) frame.style.clipPath = clip;
}

/** Readouts and selection stay above the moving artwork, outside its time clip. */
export function PlotOverlay({width, height, children}: Geometry & {children: ReactNode}) {
  return <div className="plot-overlay"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">{children}</svg></div>;
}
