import React, {useMemo} from 'react';
import type {History as HistoryData, Kind, Overview, Win} from '../lib/types';
import {windowKey} from '../lib/types';
import {day, duration, num} from '../lib/format';
import {level, seriesName, sourceLabel} from '../lib/quota';
import {planAt, weeklyPlanLine, type WeeklyPlan} from '../lib/plan';
import {DASHES, PROVIDERS} from '../lib/providers';
import {planOf, setMuted, setPrefs, usePrefs, type Prefs} from '../lib/prefs';
import {Chart, type Line, type Marker, type PlanLine} from './Chart';
import type {Resets} from '../lib/resets';

/** How much future the chart keeps on its right, per range. */
const FUTURE: Record<string, number> = {'24h': 4 * 3_600_000, '7d': 86_400_000, '30d': 3 * 86_400_000};

function Segmented({value, onChange, options, label}: {value: string; onChange: (value: string) => void; options: [string, string][]; label: string}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={option} aria-pressed={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}

type Forecast = {text: string; tone: string; title: string};

/**
 * Where the current average pace leads. Weekly windows are judged against the start
 * of the rest day (everything should be spent by then); other windows against reset.
 */
function forecast(line: Line, live: Win | undefined, now: number, weekly: WeeklyPlan): Forecast {
  const none = {text: '—', tone: '', title: ''};
  const plan = live ? planAt(live, now, weekly) : null;
  if (!live?.resetAt || live.resetAt <= now) return none;
  if (plan?.restDay) return {text: 'выходной', tone: 'muted', title: 'Рабочие дни окна закончились, лимит не планируется'};

  const hours = line.coveredMs / 3_600_000;
  if (hours < 0.5) return {...none, title: 'Нужно хотя бы 30 минут непрерывных замеров'};
  const rate = line.consumed / hours;
  const title = `Средний темп за период: ${rate < 0.05 ? '≈ 0' : num(rate, 1)} п.п./ч`;
  const deadline = plan?.deadline ?? live.resetAt;
  const target = plan?.weekly ? 'к выходному' : 'к сбросу';

  if (rate > 0.01) {
    const untilEmpty = (live.remaining / rate) * 3_600_000;
    const untilDeadline = deadline - now;
    if (untilEmpty < untilDeadline) {
      return {text: `закончится через ${duration(untilEmpty, true)}`, tone: untilEmpty < untilDeadline / 2 ? 'v-crit' : 'v-warn', title};
    }
  }
  const left = Math.max(0, live.remaining - (rate * (deadline - now)) / 3_600_000);
  if (left < 5) return {text: `уложится ${target}`, tone: '', title};
  return {text: `${target} останется ~${num(left)}%`, tone: plan?.weekly ? 'muted' : '', title};
}

function SeriesTable({lines, overview, now, prefs}: {lines: Line[]; overview: Overview | null; now: number; prefs: Prefs}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Лимит</th>
            <th>Сейчас</th>
            <th title="Сколько должно оставаться сейчас по плану расхода">План</th>
            <th>Расход за период</th>
            <th>Прогноз</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(line => {
            const live = overview?.sources.find(s => s.id === line.sourceId)?.windows.find(w => w.id === line.bucket);
            const weekly = planOf(prefs, line.sourceId);
            const plan = live ? planAt(live, now, weekly) : null;
            const delta = plan && live ? live.remaining - plan.remaining : 0;
            const outlook = forecast(line, live, now, weekly);
            return (
              <tr key={line.key}>
                <td>
                  <span className="swatch" style={{background: line.color}} />
                  {line.name}
                </td>
                <td className={line.current !== null ? `v-${level(line.current)}` : ''}>{line.current !== null ? `${num(line.current)}%` : '—'}</td>
                <td title={plan ? `${delta >= 0 ? 'Отстаёт от плана' : 'Опережает план'} на ${num(Math.abs(delta))} п.п.` : ''}>
                  {plan ? (
                    <>
                      {num(plan.remaining)}%
                      {Math.abs(delta) >= 3 && <small className={delta < 0 ? 'v-warn' : 'muted'}> {delta > 0 ? '+' : '−'}{num(Math.abs(delta))}</small>}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{line.consumed > 0 ? `${num(line.consumed, 1)} п.п.` : line.coveredMs ? 'не расходовался' : '—'}</td>
                <td className={outlook.tone} title={outlook.title}>
                  {outlook.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Combined history of every selected window, with its own legend and table view. */
export function History({history, overview, resets, now}: {history: HistoryData | null; overview: Overview | null; resets: Resets; now: number}) {
  const prefs = usePrefs();

  const lines: Line[] = useMemo(() => {
    if (!history) return [];
    const perSource: Record<string, number> = {};
    return history.series
      .filter(entry => entry.kind === prefs.kind && entry.points.length && !prefs.hidden[windowKey(entry.sourceId, entry.bucket)])
      .map(entry => {
        const index = (perSource[entry.sourceId] = (perSource[entry.sourceId] ?? -1) + 1);
        const source = overview?.sources.find(s => s.id === entry.sourceId);
        const live = source?.windows.find(w => w.id === entry.bucket);
        return {
          ...entry,
          key: windowKey(entry.sourceId, entry.bucket),
          name: seriesName(source ?? {provider: entry.provider, accountKey: 'default'}, entry.bucket, entry.label, entry.minutes),
          color: PROVIDERS[entry.provider]?.color ?? '#8b90b5',
          dash: DASHES[index % DASHES.length],
          current: live ? live.remaining : entry.points.at(-1)![1],
        };
      });
  }, [history, overview, prefs.kind, prefs.hidden]);

  const visible = useMemo(() => lines.filter(line => !prefs.muted[line.key]), [lines, prefs.muted]);
  const from = history ? Math.max(history.since, history.collectionStart) : now - 86_400_000;
  const measuredTo = history?.now ?? now;
  // Keep some future on the right, stretched to include an announced reset when close.
  const future = FUTURE[prefs.range] ?? FUTURE['24h'];
  const announced = resets.codex?.scheduled?.scheduledFor ?? null;
  // The future may take up to ~40% of the width; an announced reset further out is
  // pointed at from the right edge instead.
  const reach = measuredTo + (measuredTo - from) * 0.75;
  const to =
    announced && announced > measuredTo && announced + future * 0.25 > measuredTo + future
      ? Math.min(reach, announced + future * 0.25)
      : measuredTo + future;

  const markers: Marker[] = useMemo(() => {
    const list: Marker[] = [];
    if (announced && announced > from) {
      list.push({key: 'announced-codex', at: announced, label: 'объявлен сброс Codex', color: 'var(--accent)', strong: true});
    }
    const seen = new Set<string>();
    for (const line of visible) {
      const live = overview?.sources.find(s => s.id === line.sourceId)?.windows.find(w => w.id === line.bucket);
      if (!live?.resetAt || live.resetAt <= measuredTo || live.resetAt > to || !planAt(live, measuredTo, planOf(prefs, line.sourceId))) continue;
      const key = `${line.sourceId}@${Math.round(live.resetAt / 60_000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = overview?.sources.find(s => s.id === line.sourceId);
      list.push({key, at: live.resetAt, label: `сброс · ${source ? sourceLabel(source) : line.provider}`, color: line.color});
    }
    return list;
  }, [announced, visible, overview, from, to, measuredTo, prefs]);

  // One plan line per distinct weekly window; windows of a source that share a reset
  // (e.g. Claude weekly and Fable) share one plan.
  const planAvailable = prefs.kind === 'weekly' && visible.length > 0;
  const plans: PlanLine[] = useMemo(() => {
    if (!planAvailable || !prefs.showPlan) return [];
    const seen = new Map<string, PlanLine>();
    for (const line of visible) {
      const live = overview?.sources.find(s => s.id === line.sourceId)?.windows.find(w => w.id === line.bucket);
      // Idle rolling windows (reset = now + 7 days) have not started: no plan to show.
      if (!live?.resetAt || live.minutes !== 10080 || !planAt(live, now, planOf(prefs, line.sourceId))) continue;
      const key = `${line.sourceId}@${Math.round(live.resetAt / 3_600_000)}`;
      if (seen.has(key)) continue;
      const source = overview?.sources.find(s => s.id === line.sourceId);
      seen.set(key, {
        key,
        name: `план · ${source ? sourceLabel(source) : line.provider}`,
        color: line.color,
        runs: weeklyPlanLine(live.resetAt, from, to, planOf(prefs, line.sourceId)),
      });
    }
    return [...seen.values()];
  }, [visible, overview, from, to, now, planAvailable, prefs.showPlan, prefs.plans]);

  return (
    <section className="panel history" aria-label="История">
      <div className="panel-head">
        <h2>История остатка</h2>
        <div className="controls">
          <Segmented
            value={prefs.kind}
            onChange={value => setPrefs({kind: value as Kind})}
            options={[['weekly', 'Недельные'], ['session', '5-часовые']]}
            label="Тип окна"
          />
          <Segmented
            value={prefs.range}
            onChange={value => setPrefs({range: value})}
            options={[['24h', '24 ч'], ['7d', '7 дней'], ['30d', '30 дней']]}
            label="Период"
          />
        </div>
      </div>

      <div className="legend">
        {lines.map(line => (
          <button
            key={line.key}
            className="legend-item"
            aria-pressed={!prefs.muted[line.key]}
            onClick={() => setMuted(line.key, !prefs.muted[line.key])}
          >
            <svg width="18" height="6" aria-hidden="true">
              <line x1="1" x2="17" y1="3" y2="3" stroke={line.color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={line.dash || undefined} />
            </svg>
            <span>{line.name}</span>
            {line.current !== null && <b>{num(line.current)}%</b>}
          </button>
        ))}
        {!lines.length && <span className="legend-empty">Нет выбранных лимитов этого типа</span>}
        {planAvailable && (
          <button
            className="legend-item legend-plan"
            aria-pressed={prefs.showPlan}
            title="План расхода недели по дням; настраивается в карточке провайдера"
            onClick={() => setPrefs({showPlan: !prefs.showPlan})}
          >
            <svg width="18" height="6" aria-hidden="true">
              <line x1="1" x2="17" y1="3" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="1 4" />
            </svg>
            <span>План расхода</span>
          </button>
        )}
      </div>

      {history ? <Chart lines={visible} plans={plans} markers={markers} from={from} now={measuredTo} to={to} bucketMs={history.bucketMs} /> : <div className="chart chart-loading">Загружаем историю…</div>}
      {history && <SeriesTable lines={lines} overview={overview} now={now} prefs={prefs} />}
      {history && history.since < history.collectionStart && (
        <p className="footnote">История ведётся с {day(history.collectionStart)}. Разрыв линии — период без замеров.</p>
      )}
    </section>
  );
}
