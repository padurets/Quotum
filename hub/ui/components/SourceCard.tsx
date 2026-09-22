import {useEffect, useState} from 'react';
import type {SourceState, Win} from '../lib/types';
import {windowKey} from '../lib/types';
import {ago, day, duration, fullStamp, num} from '../lib/format';
import {errorText, level, problemOf, sourceLabel, windowName} from '../lib/quota';
import {t} from '../i18n';
import {DEFAULT_PLAN, isValidPlan, PLAN_TOLERANCE, planAt, planTotal, type WeeklyPlan} from '../lib/plan';
import {LOGOS} from './logos';
import {cardId, planOf, withHidden, withPlan, withWindowHidden, type Arrange} from '../lib/view';
import type {ResetStatus} from '../lib/resets';
import {ResetBanner, ResetNotice} from './ResetNotice';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';

function Meter({w, now, weekly}: {w: Win; now: number; weekly: WeeklyPlan}) {
  const state = level(w.remaining);
  const plan = planAt(w, now, weekly);
  const pace = plan && !plan.done ? plan.remaining : null;
  return (
    <div className="meter" role="progressbar" aria-label={windowName(w)} aria-valuenow={Math.round(w.remaining)} aria-valuemin={0} aria-valuemax={100}>
      <span className="meter-track">
        <i className={`fill fill-${state}`} style={{width: `${Math.max(w.remaining, 1)}%`}} />
      </span>
      {pace !== null && <b className="pace" style={{left: `${pace}%`}} title={t('limit.paceHint', {value: num(pace)})} />}
    </div>
  );
}

function Limit({w, now, weekly}: {w: Win; now: number; weekly: WeeklyPlan}) {
  const state = level(w.remaining);
  const plan = planAt(w, now, weekly);
  const delta = plan && !plan.done ? w.remaining - plan.remaining : 0;
  return (
    <div className="limit">
      <div className="limit-top">
        <span className="limit-name">{windowName(w)}</span>
        <span className={`limit-value v-${state}`}>
          {num(w.remaining)}
          <small>%</small>
        </span>
      </div>
      <Meter w={w} now={now} weekly={weekly} />
      <div className="limit-bottom">
        <span title={w.resetAt ? fullStamp(w.resetAt) : ''}>
          {w.resetAt
            ? w.resetAt > now
              ? t('limit.resetsIn', {time: duration(w.resetAt - now)})
              : t('limit.resetPassed')
            : t('limit.resetUnknown')}
        </span>
        {plan?.done && (
          <span className="plan-note" title={t('limit.planDoneHint')}>
            {t('limit.planDone')}
          </span>
        )}
        {delta < -PLAN_TOLERANCE && (
          <span className="ahead" title={t(plan?.weekly ? 'limit.aheadHint' : 'limit.aheadHintReset')}>
            {t('limit.ahead', {value: num(-delta)})}
          </span>
        )}
        {plan?.weekly && delta > PLAN_TOLERANCE && (
          <span className="plan-note" title={t('limit.behindHint')}>
            {t('limit.behind', {value: num(delta)})}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The weekly spending plan of one source, one whole percent per day. It is saved only
 * when it adds up to exactly 100%; a day at 0 has no spending planned.
 */
function PlanEditor({source, arrange}: {source: SourceState; arrange: Arrange}) {
  const saved = planOf(arrange.view, source.id);
  const [draft, setDraft] = useState<WeeklyPlan>(saved);
  useEffect(() => setDraft(saved), [saved.join(',')]);
  const total = planTotal(draft);

  const change = (day: number, raw: string) => {
    const value = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
    const next = draft.map((share, i) => (i === day ? value : share));
    setDraft(next);
    if (isValidPlan(next)) arrange.update(view => withPlan(view, source.id, next));
  };

  return (
    <div className="plan-editor">
      <div className="plan-days">
        {draft.map((share, day) => (
          <label key={day} className={share === 0 ? 'is-zero' : ''}>
            <span>{day + 1}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={share}
              aria-label={t('plan.day', {day: day + 1})}
              onChange={event => change(day, event.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="plan-foot">
        <span className={total === 100 ? 'muted' : 'v-warn'}>{total === 100 ? t('plan.total') : t('plan.totalWrong', {total})}</span>
        {saved.join() !== DEFAULT_PLAN.join() && (
          <button type="button" className="link-button" onClick={() => arrange.update(view => withPlan(view, source.id, null))}>
            {t('plan.default')}
          </button>
        )}
      </div>
    </div>
  );
}

/** How the board's owner sets up a card: which limits it shows, the weekly plan, and hiding it. */
function SourceSettings({source, arrange}: {source: SourceState; arrange: Arrange}) {
  const hidden = new Set(arrange.view.windows);
  const hiddenCount = source.windows.filter(w => hidden.has(windowKey(source.id, w.id))).length;
  const hasWeekly = source.windows.some(w => w.kind === 'weekly');

  return (
    <Popover label={t('source.settings', {source: sourceLabel(source)})} icon={<SlidersIcon />} badge={hiddenCount}>
      {source.windows.length > 1 && (
        <>
          <div className="popover-title">{t('source.show')}</div>
          {source.windows.map(w => {
            const key = windowKey(source.id, w.id);
            return (
              <SwitchRow key={w.id} on={!hidden.has(key)} onChange={on => arrange.update(view => withWindowHidden(view, key, !on))} value={`${num(w.remaining)}%`}>
                {windowName(w)}
              </SwitchRow>
            );
          })}
        </>
      )}
      {hasWeekly && (
        <>
          <div className="popover-title popover-section">{t('source.plan')}</div>
          <PlanEditor source={source} arrange={arrange} />
          <div className="popover-note">{t('source.planNote')}</div>
        </>
      )}
      <HideRow onHide={() => arrange.update(view => withHidden(view, cardId(source.id), true))}>{t('source.hide')}</HideRow>
    </Popover>
  );
}

/** Free resets of the limits the account holds: a count by the settings button, the rest in its tooltip. */
function FreeResets({resets}: {resets: NonNullable<SourceState['resets']>}) {
  const text = [
    t('card.freeResets', {count: resets.available}),
    resets.expiresAt ? t('card.freeResetsUntil', {date: day(resets.expiresAt)}) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className="free-resets" title={`${text}\n${t('card.freeResetsHint')}`} aria-label={text} role="img">
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5" />
      </svg>
      {resets.available}
    </span>
  );
}

export function SourceCard({source, now, resets, arrange}: {source: SourceState; now: number; resets?: ResetStatus; arrange: Arrange}) {
  const problem = problemOf(source);
  const hidden = new Set(arrange.view.windows);
  const visible = source.windows.filter(w => !hidden.has(windowKey(source.id, w.id)));
  const weekly = planOf(arrange.view, source.id);
  const warn = source.stale || !!problem;
  // How fresh the numbers are lives in the colour of the logo's dot and in its tooltip.
  const status = problem ?? (source.successAt ? t('source.measured', {ago: ago(source.successAt, now)}) : errorText('waiting'));

  return (
    <article className="card">
      <div className="card-head">
        <span className={`provider-mark ${warn ? 'is-warn' : ''}`} title={status} aria-label={status} role="img">
          <img className="provider-logo" src={LOGOS[source.provider]} alt="" />
          <i className={`dot dot-${warn ? 'warn' : 'ok'}`} />
        </span>
        <div className="card-title">
          <h2>{sourceLabel(source)}</h2>
          {source.plan && <span className="plan">{source.plan.replace(/^Claude\s+/i, '')}</span>}
        </div>
        {!!source.resets?.available && <FreeResets resets={source.resets} />}
        {arrange.owner && <SourceSettings source={source} arrange={arrange} />}
      </div>

      <div className="limits">
        {visible.map(w => (
          <Limit key={w.id} w={w} now={now} weekly={weekly} />
        ))}
        {!source.windows.length && <div className="card-empty">{errorText(source.error ?? 'waiting')}</div>}
        {!!source.windows.length && !visible.length && <div className="card-empty">{t('card.allHidden')}</div>}
      </div>
      <ResetBanner status={resets} now={now} />
      <ResetNotice status={resets} now={now} />
    </article>
  );
}
