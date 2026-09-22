import {useEffect, useState} from 'react';
import type {SourceState, Win} from '../lib/types';
import {windowKey} from '../lib/types';
import {ago, day, duration, fullStamp, num} from '../lib/format';
import {errorText, level, problemOf, sourceLabel, windowName} from '../lib/quota';
import {t} from '../i18n';
import {DEFAULT_PLAN, isValidPlan, PLAN_TOLERANCE, planAt, planTotal, type WeeklyPlan} from '../lib/plan';
import {PROVIDERS} from '../lib/providers';
import {planOf, setHidden, setPlan, usePrefs} from '../lib/prefs';
import {call} from '../lib/http';
import type {ResetStatus} from '../lib/resets';
import {ResetBanner, ResetNotice} from './ResetNotice';
import {Popover, SlidersIcon, SwitchRow} from './Popover';
import {ErrorLine} from './Kit';

function Meter({w, now, weekly}: {w: Win; now: number; weekly: WeeklyPlan}) {
  const state = level(w.remaining);
  const plan = planAt(w, now, weekly);
  const pace = plan && !plan.restDay ? plan.remaining : null;
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
  const delta = plan && !plan.restDay ? w.remaining - plan.remaining : 0;
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
        {plan?.restDay && <span className="plan-note">{t('limit.restDay')}</span>}
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
 * when it adds up to exactly 100%; days at 0 are rest days.
 */
function PlanEditor({source}: {source: SourceState}) {
  const prefs = usePrefs();
  const saved = planOf(prefs, source.id);
  const [draft, setDraft] = useState<WeeklyPlan>(saved);
  useEffect(() => setDraft(saved), [saved.join(',')]);
  const total = planTotal(draft);

  const change = (day: number, raw: string) => {
    const value = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
    const next = draft.map((share, i) => (i === day ? value : share));
    setDraft(next);
    if (isValidPlan(next)) setPlan(source.id, next);
  };

  return (
    <div className="plan-editor">
      <div className="plan-days">
        {draft.map((share, day) => (
          <label key={day} className={share === 0 ? 'is-rest' : ''}>
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
          <button type="button" className="link-button" onClick={() => setPlan(source.id, null)}>
            {t('plan.default')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Per-source settings: which windows to show, the weekly spending plan, and (for the board's owner) removing the source. */
function SourceSettings({source, board, owner, onRemoved}: {source: SourceState; board: string; owner: boolean; onRemoved: () => void}) {
  const {hidden} = usePrefs();
  const [error, setError] = useState<unknown>(null);
  const hiddenCount = source.windows.filter(w => hidden[windowKey(source.id, w.id)]).length;
  const hasWeekly = source.windows.some(w => w.kind === 'weekly');

  const remove = async () => {
    if (!confirm(t('source.removeConfirm', {source: sourceLabel(source)}))) return;
    setError(null);
    try {
      await call('DELETE', `/api/boards/${board}/sources/${source.id}`);
      onRemoved();
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <Popover label={t('source.settings', {source: sourceLabel(source)})} icon={<SlidersIcon />} badge={hiddenCount}>
      {source.windows.length > 1 && (
        <>
          <div className="popover-title">{t('source.show')}</div>
          {source.windows.map(w => {
            const key = windowKey(source.id, w.id);
            return (
              <SwitchRow key={w.id} on={!hidden[key]} onChange={on => setHidden(key, !on)} value={`${num(w.remaining)}%`}>
                {windowName(w)}
              </SwitchRow>
            );
          })}
          <div className="popover-note">{t('source.hiddenNote')}</div>
        </>
      )}
      {hasWeekly && (
        <>
          <div className="popover-title popover-section">{t('source.plan')}</div>
          <PlanEditor source={source} />
          <div className="popover-note">{t('source.planNote')}</div>
        </>
      )}
      {owner && (
        <div className="popover-section">
          <button type="button" className="popover-row is-danger" onClick={remove}>
            <span>{t('source.remove')}</span>
          </button>
          <div className="popover-note">{t('source.removeNote')}</div>
          <ErrorLine error={error} />
        </div>
      )}
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

export function SourceCard({
  source,
  now,
  resets,
  board,
  owner,
  onRemoved,
}: {
  source: SourceState;
  now: number;
  resets?: ResetStatus;
  board: string;
  owner: boolean;
  onRemoved: () => void;
}) {
  const prefs = usePrefs();
  const {hidden} = prefs;
  const meta = PROVIDERS[source.provider];
  const problem = problemOf(source);
  const visible = source.windows.filter(w => !hidden[windowKey(source.id, w.id)]);
  const weekly = planOf(prefs, source.id);
  const warn = source.stale || !!problem;
  // How fresh the numbers are lives in the colour of the logo's dot and in its tooltip.
  const status = problem ?? (source.successAt ? t('source.measured', {ago: ago(source.successAt, now)}) : errorText('waiting'));

  return (
    <article className="card">
      <div className="card-head">
        <span className={`provider-mark ${warn ? 'is-warn' : ''}`} title={status} aria-label={status} role="img">
          <img className="provider-logo" src={meta?.icon} alt="" />
          <i className={`dot dot-${warn ? 'warn' : 'ok'}`} />
        </span>
        <div className="card-title">
          <h2>{sourceLabel(source)}</h2>
          {source.plan && <span className="plan">{source.plan.replace(/^Claude\s+/i, '')}</span>}
        </div>
        {!!source.resets?.available && <FreeResets resets={source.resets} />}
        {(source.windows.length > 0 || owner) && <SourceSettings source={source} board={board} owner={owner} onRemoved={onRemoved} />}
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
