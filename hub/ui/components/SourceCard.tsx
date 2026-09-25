import {memo, useEffect, useRef, useState, type CSSProperties} from 'react';
import {useNow} from '../lib/api';
import type {SourceState, Win} from '../lib/types';
import {windowKey} from '../lib/types';
import {ago, day, duration, fullStamp, num} from '../lib/format';
import {errorText, freshness, level, problemOf, PULSE_FOR, sourceLabel, windowName} from '../lib/quota';
import {t, useLocale} from '../i18n';
import {Agents} from './Agents';
import {DEFAULT_PLAN, isValidPlan, PLAN_NOTE_FROM, planAt, planTotal, type WeeklyPlan} from '../lib/plan';
import {LOGOS} from './logos';
import {cardId, colorOf, planOf, weeklyPlanOf, withColor, withHidden, withName, withPlan, withPlanned, withWindowHidden, type Arrange} from '../lib/view';
import {CARD_COLORS, MIDDLE_STEP, PROVIDERS} from '../lib/providers';
import {call} from '../lib/http';
import type {Board} from '../lib/session';
import type {ResetStatus} from '../lib/resets';
import {ResetBanner, ResetNotice} from './ResetNotice';
import {HideRow, Popover, SlidersIcon, SwitchRow, TakeOffIcon} from './Popover';
import {ErrorLine} from './Kit';

function Meter({w, measuredAt, now, weekly}: {w: Win; measuredAt: number | null; now: number; weekly: WeeklyPlan | null}) {
  const state = level(w.remaining);
  const plan = planAt(w, measuredAt, now, weekly);
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

function Limit({w, measuredAt, now, weekly}: {w: Win; measuredAt: number | null; now: number; weekly: WeeklyPlan | null}) {
  const state = level(w.remaining);
  const plan = planAt(w, measuredAt, now, weekly);
  // A limit used up is past any plan: how far ahead of it says nothing more.
  const delta = plan && !plan.done && w.remaining > 0 ? w.remaining - plan.remaining : 0;
  return (
    <div className="limit">
      <div className="limit-top">
        <span className="limit-name">{windowName(w)}</span>
        <span className={`limit-value v-${state}`}>
          {num(w.remaining)}
          <small>%</small>
        </span>
      </div>
      <Meter w={w} measuredAt={measuredAt} now={now} weekly={weekly} />
      <div className="limit-bottom">
        <span title={w.resetAt ? fullStamp(w.resetAt) : ''}>
          {w.resetAt
            ? w.resetAt > now
              ? t('limit.resetsIn', {time: duration(w.resetAt - now)})
              : t('limit.resetPassed')
            : t('limit.resetUnknown')}
        </span>
        {Math.round(-delta) >= PLAN_NOTE_FROM && (
          <span className="ahead" title={t(plan?.weekly ? 'limit.aheadHint' : 'limit.aheadHintReset')}>
            {t('limit.ahead', {value: num(-delta)})}
          </span>
        )}
        {plan?.weekly && Math.round(delta) >= PLAN_NOTE_FROM && (
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
  const saved = weeklyPlanOf(arrange.view, source.id);
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

/** A card's name as the board's owner sets it; empty gives back the automatic one. */
function CardName({source, arrange}: {source: SourceState; arrange: Arrange}) {
  const saved = arrange.view.names[source.id] ?? '';
  const [name, setName] = useState(saved);
  useEffect(() => setName(saved), [saved]);
  // A click outside closes the panel before the field blurs: what was typed is also
  // saved when the field goes away with it.
  const latest = useRef({name, saved, arrange});
  latest.current = {name, saved, arrange};
  const save = () => {
    const {name, saved, arrange} = latest.current;
    if (name.trim() !== saved) arrange.update(view => withName(view, source.id, name));
  };
  useEffect(() => save, []);
  return (
    <div className="popover-pad card-name">
      <input
        value={name}
        maxLength={60}
        placeholder={t('source.namePlaceholder')}
        aria-label={t('source.name')}
        onChange={event => setName(event.target.value)}
        onBlur={save}
        onKeyDown={event => event.key === 'Enter' && save()}
      />
    </div>
  );
}

/** The hues of CARD_COLORS, in its order. */
const HUE_NAMES = ['source.hue.blue', 'source.hue.teal', 'source.hue.purple', 'source.hue.orange', 'source.hue.grey'] as const;

/**
 * A card's colour on the chart and in the table: a row of hues, and under it the steps
 * of lightness of the chosen one. The provider's colour is where the card starts; picking
 * it again, or resetting, gives the card back the provider's.
 */
function CardColor({source, arrange}: {source: SourceState; arrange: Arrange}) {
  const own = PROVIDERS[source.provider]?.color;
  const chosen = arrange.view.colors[source.id];
  const current = chosen ?? own;
  const hue = CARD_COLORS.findIndex(steps => current !== undefined && steps.includes(current));
  const choose = (color: string) => arrange.update(view => withColor(view, source.id, color === own ? null : color));
  return (
    <div className="popover-pad">
      <div className="color-hues" role="group" aria-label={t('source.color')}>
        {CARD_COLORS.map((steps, i) => {
          const color = i === hue ? current! : steps[MIDDLE_STEP];
          return (
            <button
              key={steps[MIDDLE_STEP]}
              type="button"
              className="color-choice"
              style={{background: color}}
              aria-pressed={i === hue}
              aria-label={t(HUE_NAMES[i])}
              onClick={() => choose(color)}
            />
          );
        })}
        {chosen && (
          <button type="button" className="link-button" onClick={() => arrange.update(view => withColor(view, source.id, null))}>
            {t('source.colorReset')}
          </button>
        )}
      </div>
      {hue >= 0 && (
        <div className="color-steps" role="group" aria-label={t('source.colorSteps')}>
          {CARD_COLORS[hue].map((color, step) => (
            <button
              key={color}
              type="button"
              style={{background: color}}
              aria-pressed={color === current}
              aria-label={t('source.colorStep', {step: step + 1, count: CARD_COLORS[hue].length})}
              onClick={() => choose(color)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A card's menu. The board's owner names the card, gives it a colour, picks its limits,
 * sets the weekly plan or switches it off, hides it; on a shared board the owner, or whoever's devices measure it, also
 * takes it off the board.
 */
function SourceSettings({source, arrange, board, onChanged}: {source: SourceState; arrange: Arrange; board: Board; onChanged: () => void}) {
  const [error, setError] = useState<unknown>(null);
  const hidden = new Set(arrange.view.windows);
  const hasWeekly = source.windows.some(w => w.kind === 'weekly');
  const planned = planOf(arrange.view, source.id) !== null;
  const owner = arrange.owner;
  const takeOff = !board.personal && (owner || source.mine);

  const unshare = async () => {
    setError(null);
    try {
      await call('DELETE', `/api/boards/${encodeURIComponent(board.id)}/shares/${encodeURIComponent(source.id)}`);
      onChanged();
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <Popover label={t('source.settings', {source: sourceLabel(source)})} icon={<SlidersIcon />}>
      {owner && (
        <>
          <div className="popover-title">{t('source.name')}</div>
          <CardName source={source} arrange={arrange} />
        </>
      )}
      {owner && source.windows.length > 1 && (
        <>
          <div className="popover-title popover-section">{t('source.show')}</div>
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
      {owner && (
        <>
          <div className="popover-title popover-section">{t('source.color')}</div>
          <CardColor source={source} arrange={arrange} />
        </>
      )}
      {owner && (
        <div className="popover-section">
          <SwitchRow on={planned} onChange={on => arrange.update(view => withPlanned(view, source.id, on))}>
            {t('source.plan')}
          </SwitchRow>
          {planned && hasWeekly && (
            <>
              <PlanEditor source={source} arrange={arrange} />
              <div className="popover-note">{t('source.planNote')}</div>
            </>
          )}
        </div>
      )}
      {owner && <HideRow onHide={() => arrange.update(view => withHidden(view, cardId(source.id), true))}>{t('widget.hide')}</HideRow>}
      {takeOff && (
        <div className={owner ? '' : 'popover-section'}>
          <button type="button" className="popover-row is-danger" onClick={unshare}>
            <TakeOffIcon />
            <span>{t('source.takeOff')}</span>
          </button>
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

export const SourceCard = memo(function SourceCard({
  source,
  resets,
  arrange,
  board,
  onChanged,
}: {
  source: SourceState;
  resets?: ResetStatus;
  arrange: Arrange;
  board: Board | null;
  onChanged: () => void;
}) {
  useLocale();
  const now = useNow();
  const problem = problemOf(source);
  const hidden = new Set(arrange.view.windows);
  const visible = source.windows.filter(w => !hidden.has(windowKey(source.id, w.id)));
  const weekly = planOf(arrange.view, source.id);
  const warn = source.stale || !!problem;
  const age = source.successAt === null ? Infinity : now - source.successAt;
  // How fresh the numbers are lives in the colour of the logo's dot and in its tooltip;
  // trouble is also told under the limits, where it moves no meter out of line.
  const status = problem ?? (source.successAt ? t('source.measured', {ago: ago(source.successAt, now)}) : errorText('waiting'));

  return (
    <article className="card" style={{'--card-color': colorOf(arrange.view, source.id, source.provider)} as CSSProperties}>
      <div className="card-head">
        <span className={`provider-mark ${warn ? 'is-warn' : ''}`} title={status} aria-label={status} role="img">
          <img className="provider-logo" src={LOGOS[source.provider]} alt="" />
          {warn ? (
            <i className="dot dot-warn" />
          ) : (
            <i className={`dot dot-fresh ${age < PULSE_FOR ? 'is-pulsing' : ''}`} style={{'--fresh': freshness(age)} as CSSProperties} />
          )}
        </span>
        <div className="card-title">
          <h2>{sourceLabel(source)}</h2>
          {source.plan && <span className="plan">{source.plan.replace(/^Claude\s+/i, '')}</span>}
        </div>
        {!!source.resets?.available && <FreeResets resets={source.resets} />}
        {board && (arrange.owner || (!board.personal && source.mine)) && <SourceSettings source={source} arrange={arrange} board={board} onChanged={onChanged} />}
      </div>

      <div className="limits">
        {visible.map(w => (
          <Limit key={w.id} w={w} measuredAt={source.successAt} now={now} weekly={weekly} />
        ))}
        {!source.windows.length && <div className="card-empty">{errorText(source.error ?? 'waiting')}</div>}
        {!!source.windows.length && !visible.length && <div className="card-empty">{t('card.allHidden')}</div>}
      </div>
      {warn && !!source.windows.length && <p className="card-status">{status}</p>}
      <ResetBanner status={resets} now={now} />
      <ResetNotice status={resets} now={now} />
      {/* The card's tray, always there so the card never changes height: the agents running on it, on the right. */}
      <footer className="card-foot">
        <Agents sessions={source.sessions ?? []} now={now} />
      </footer>
    </article>
  );
});
