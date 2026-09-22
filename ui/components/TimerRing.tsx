import React, {useEffect, useRef} from 'react';
import type {Overview} from '../lib/types';
import {countdown} from '../lib/format';

const SIZE = 22;
const RADIUS = 8.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Resting orientation: the arc starts at twelve o'clock. */
const REST = -90;
/** Spin speed while a collection runs, degrees per second. */
const SPIN = 257;
/** How far ahead of the resting point the spin starts to slow down, in seconds of travel. */
const BRAKE_S = 0.35;
/** A spinning arc never gets shorter than this share, so the motion stays readable. */
const MIN_BUSY_ARC = 0.12;

/**
 * Share of the current collection cycle that has elapsed. While a collection runs the
 * server still reports the start it was scheduled for; afterwards, the next start one
 * interval later. Both describe the same cycle, so the value is continuous across the
 * end of a collection.
 */
export function cycleProgress(data: Pick<Overview, 'collecting' | 'nextAt' | 'intervalMs'>, now: number) {
  const start = data.collecting ? data.nextAt : data.nextAt - data.intervalMs;
  return Math.min(1, Math.max(0, (now - start) / data.intervalMs));
}

/**
 * The collection clock as a ring that fills over each two-minute cycle. While a
 * collection runs it also spins; when it ends, the spin carries on and eases into the
 * resting position, so the arc glides into its value instead of snapping. The exact
 * countdown lives in the tooltip, so the header never changes width.
 */
export function TimerRing({data, now, offline}: {data: Overview | null; now: number; offline: boolean}) {
  const svg = useRef<SVGSVGElement>(null);
  const arc = useRef<SVGCircleElement>(null);
  const motion = useRef({angle: REST, shown: 0, last: 0, frame: 0});
  const busy = !!data?.collecting;
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const state = motion.current;
    const draw = () => {
      svg.current?.style.setProperty('transform', `rotate(${state.angle}deg)`);
      arc.current?.setAttribute('stroke-dasharray', `${CIRCUMFERENCE * state.shown} ${CIRCUMFERENCE}`);
    };
    const target = () => {
      const current = dataRef.current;
      if (!current) return 0;
      const progress = cycleProgress(current, Date.now());
      return current.collecting ? Math.max(MIN_BUSY_ARC, progress) : progress;
    };
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const step = (time: number) => {
      const dt = state.last ? Math.min(0.1, (time - state.last) / 1000) : 0;
      state.last = time;
      const spinning = !!dataRef.current?.collecting;

      let resting = false;
      if (spinning && !reduced) {
        state.angle += SPIN * dt;
      } else {
        // Travel forward to the next resting point at spin speed, braking near it.
        const rest = REST + 360 * Math.ceil((state.angle - REST) / 360);
        const distance = rest - state.angle;
        if (distance < 0.3) {
          state.angle = REST;
          resting = true;
        } else state.angle += Math.min(SPIN, distance / BRAKE_S) * dt;
      }

      const goal = target();
      state.shown += (goal - state.shown) * (1 - Math.exp(-dt / 0.25));
      draw();

      if (resting && !spinning && Math.abs(goal - state.shown) < 0.001) {
        state.last = 0;
        state.frame = 0;
        return;
      }
      state.frame = requestAnimationFrame(step);
    };

    if (!state.frame) {
      state.last = 0;
      state.frame = requestAnimationFrame(step);
    }
    return () => {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, [busy]);

  // At rest the arc simply follows the clock, once a second.
  useEffect(() => {
    const state = motion.current;
    if (state.frame || !data) return;
    state.shown = cycleProgress(data, now);
    arc.current?.setAttribute('stroke-dasharray', `${CIRCUMFERENCE * state.shown} ${CIRCUMFERENCE}`);
  }, [now, data]);

  const left = data && !busy ? Math.max(0, data.nextAt - now) : 0;
  const title = !data
    ? 'Подключаемся к сервису'
    : offline
      ? 'Нет связи с сервисом'
      : busy
        ? 'Идёт замер'
        : `Следующий замер через ${countdown(left)}`;

  return (
    <span className={`ring ${offline ? 'is-warn' : ''}`} title={title} role="timer" aria-label={title}>
      <svg ref={svg} viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true">
        <circle className="ring-track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} />
        <circle ref={arc} className="ring-progress" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeDasharray={`0 ${CIRCUMFERENCE}`} />
      </svg>
    </span>
  );
}
