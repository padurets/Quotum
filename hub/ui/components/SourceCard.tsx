import {memo, useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import type {Card, Win} from '../lib/types';
import {MEASURE_INTERVAL, windowKey, type MeasureIntervalMs} from '../lib/types';
import {countdown, countdownChangesAt, duration, earliest, num, stamp} from '../lib/format';
import {cadenceChangesAt, cadenceOf, dotChangesAt, dotOf, errorText, level, problemOf, resetLine, resetLineChangesAt, windowName} from '../lib/quota';
import {t, useLocale} from '../i18n';
import {DEFAULT_PLAN, isValidPlan, planAt, planChangesAt, planNote, planTotal, type WeeklyPlan} from '../lib/plan';
import {logoOf} from './logos';
import {MeterBar} from './Meter';
import {KeyScaleSettings} from './KeyScaleSettings';
import {MoneyCard,AccessMark} from './MoneyCard';
import {cardId, colorOf, isWindowHidden, planOf, weeklyPlanOf, withColor, withHidden, withName, withPlan, withPlanned, withWindowHidden, type Arrange} from '../lib/view';
import {CARD_COLORS, MIDDLE_STEP, PROVIDERS} from '../lib/providers';
import {call} from '../lib/http';
import {useCadence, useCard, useConnection, useMine, useRefresh, useResetsFor, useSessions, useSourceAccess, useTitle} from '../lib/board';
import {providerOf} from '../../server/domain/providers';
import {useClock} from '../lib/clock';
import {FreeResets} from './ResetMarks';
import {Tray} from './Tray';
import {EyeOffIcon, HideRow, Popover, SlidersIcon, SwitchRow, TakeOffIcon} from './Popover';
import {RefreshAction} from './RefreshAction';
import {refreshChangesAt, refreshPending, refreshText} from '../lib/refresh';
import {ErrorLine, Segmented} from './Kit';
import {useBubble} from './Tooltip';

/** Where the plan expects the limit to be now: a mark on its meter, in whole percent, moved when that changes. */
function PlanMark({w, measuredAt, weekly}: {w: Win; measuredAt: number | null; weekly: WeeklyPlan | null}) {
  const now = useClock(now => planChangesAt(w, measuredAt, now, weekly));
  const plan = planAt(w, measuredAt, now, weekly);
  const pace = plan && !plan.done ? Math.round(plan.remaining) : null;
  return (
    <b
      className="pace"
      data-time="plan"
      hidden={pace === null}
      style={pace === null ? undefined : {left: `${pace}%`}}
      title={pace === null ? undefined : t('limit.paceHint', {value: num(pace)})}
    />
  );
}

/** How far ahead of the plan or behind it the limit is, when that is worth a word. */
function PlanNote({w, measuredAt, weekly}: {w: Win; measuredAt: number | null; weekly: WeeklyPlan | null}) {
  const now = useClock(now => planChangesAt(w, measuredAt, now, weekly));
  const note = planNote(w, measuredAt, now, weekly);
  if (note?.key === 'ahead') {
    return (
      <span className="ahead" data-time="plan" title={t(note.weekly ? 'limit.aheadHint' : 'limit.aheadHintReset')}>
        {t('limit.ahead', {value: num(note.value)})}
      </span>
    );
  }
  if (note?.key === 'behind') {
    return (
      <span className="plan-note" data-time="plan" title={t('limit.behindHint')}>
        {t('limit.behind', {value: num(note.value)})}
      </span>
    );
  }
  return <span data-time="plan" />;
}

/** When the limit resets: in how long, that the time has passed, or that it is not known. */
export function ResetLine({w, short = false}: {w: Win; short?: boolean}) {
  const now = useClock(now => resetLineChangesAt(w, now));
  const reset = resetLine(w, now);
  if (short && reset.key !== 'resetsIn') return null;
  const text = reset.key === 'resetsIn' ? t('limit.resetsIn', {time: duration(reset.inMs)}) : t(`limit.${reset.key}`);
  const date = w.resetAt ? stamp(w.resetAt) : '';
  return (
    <span data-time="reset" title={short ? [text, date].filter(Boolean).join('\n') : date} aria-label={short ? text : undefined}>
      {short && reset.key === 'resetsIn' ? duration(reset.inMs) : text}
    </span>
  );
}

/** The same remaining-quota meter in a card and in the tray's compact rows. */
export function LimitMeter({w, children}: {w: Win; children?: ReactNode}) {
  return <MeterBar remaining={w.remaining} label={windowName(w).replaceAll(' · ', '\n')}>{children}</MeterBar>;
}

function Limit({w, measuredAt, weekly}: {w: Win; measuredAt: number | null; weekly: WeeklyPlan | null}) {
  const state = level(w.remaining);
  return (
    <div className="limit">
      <div className="limit-top">
        <span className="limit-name">{windowName(w)}</span>
        <span className={`limit-value v-${state}`}>
          {num(w.remaining)}
          <small>%</small>
        </span>
      </div>
      <LimitMeter w={w}>
        <PlanMark w={w} measuredAt={measuredAt} weekly={weekly} />
      </LimitMeter>
      <div className="limit-bottom">
        <ResetLine w={w} />
        <PlanNote w={w} measuredAt={measuredAt} weekly={weekly} />
      </div>
    </div>
  );
}

/**
 * The weekly spending plan of one source, one whole percent per day. It is saved only
 * when it adds up to exactly 100%; a day at 0 has no spending planned.
 */
function PlanEditor({source, arrange}: {source: Card; arrange: Arrange}) {
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
function CardName({source, arrange}: {source: Card; arrange: Arrange}) {
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
function CardColor({source, arrange}: {source: Card; arrange: Arrange}) {
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

/** The selected value comes only from events, including while a save is awaiting its HTTP reply. */
function Frequency({source, board}: {source: Card; board: string}) {
  useLocale();
  const mine = useMine(source.id);
  const byHub = providerOf(source.provider)?.measuredBy === 'hub';
  const connection = useConnection();
  const connected = connection.status === 'live' || connection.status === 'polling';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const save = async (intervalMs: MeasureIntervalMs) => {
    if (!mine || !connected || sending.current || intervalMs === source.measureIntervalMs) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      await call('POST', `/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(source.id)}/frequency`, {intervalMs});
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      sending.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const options = Object.entries(MEASURE_INTERVAL) as [keyof typeof MEASURE_INTERVAL, MeasureIntervalMs][];
  const selected = options.find(([, value]) => value === source.measureIntervalMs)![0];
  return (
    <>
      <div className="popover-title popover-section">{t('frequency.title')}</div>
      {mine ? (
        <div className="popover-pad">
          <Segmented
            label={t('frequency.title')}
            radioName={`frequency-${source.id}`}
            disabled={!connected}
            busy={pending}
            value={selected}
            onChange={key => void save(MEASURE_INTERVAL[key])}
            options={options.map(([key, value]) => [key, value === null ? t('frequency.auto') : num(value / 60_000), t(`frequency.${key}`)])}
          />
        </div>
      ) : <div className="popover-note">{t(`frequency.${selected}`)}</div>}
      <div className="popover-note">{t(byHub?'frequency.hubHint':'frequency.hint')}</div>
      <details className="popover-note">
        <summary className="link-button">{t('frequency.aboutAuto')}</summary>
        {byHub?<><p>{t('frequency.hubAuto')}</p><p>{t('frequency.hubMinimum')}</p></>:<><p>{t('frequency.autoActivity')}</p><p>{t('frequency.autoLimits')}</p><p>{t('frequency.autoMinimum')}</p></>}
      </details>
      <ErrorLine error={error} />
    </>
  );
}

/** A card's menu: holders choose frequency, readers refresh, and the board's owner arranges its view. */
function SourceSettings({source, title, arrange, boardId, takeOff}: {source: Card; title: string; arrange: Arrange; boardId: string; takeOff: boolean}) {
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const hidden = new Set(arrange.view.windows);
  const hasWeekly = source.windows.some(w => w.kind === 'weekly');
  const planned = planOf(arrange.view, source.id) !== null;
  const owner = arrange.owner;

  const unshare = async () => {
    setError(null);
    try {
      await call('DELETE', `/api/boards/${encodeURIComponent(boardId)}/shares/${encodeURIComponent(source.id)}`);
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <Popover label={t('source.menu', {source: title})} icon={<SlidersIcon />} open={open} onOpenChange={setOpen} width={288}>
      {owner && (
        <>
          <div className="popover-title popover-section">{t('source.name')}</div>
          <CardName source={source} arrange={arrange} />
        </>
      )}
      <Frequency key={`${boardId}:${source.id}`} source={source} board={boardId} />
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
      {owner && !!source.keysCount && open && <KeyScaleSettings source={source} board={boardId} arrange={arrange}/>}
      {owner && (
        <>
          <div className="popover-title popover-section">{t('source.color')}</div>
          <CardColor source={source} arrange={arrange} />
        </>
      )}
      {owner && source.windows.length>0 && (
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
      <div className={owner ? 'popover-section' : undefined}>
        <RefreshAction id={source.id} board={boardId} onAccepted={() => setOpen(false)} />
        {owner && <HideRow section={false} onHide={() => arrange.update(view => withHidden(view, cardId(source.id), true))}>{t('widget.hide')}</HideRow>}
      </div>
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

/**
 * A card whose every limit its board hides: it says so where the limits would be, that
 * the measurements go on, and lets the board's owner bring them back in one go.
 */
function AllHidden({source, arrange}: {source: Card; arrange: Arrange}) {
  const showAll = () => arrange.update(view => source.windows.reduce((next, w) => withWindowHidden(next, windowKey(source.id, w.id), false), view));
  return (
    <div className="card-empty">
      <EyeOffIcon />
      <b>{t('card.allHidden')}</b>
      <span>{t(arrange.owner ? 'card.allHiddenNote' : 'card.allHiddenByOwner')}</span>
      {arrange.owner && (
        <button type="button" className="text-button card-empty-action" onClick={showAll}>
          {t('card.showAll')}
        </button>
      )}
    </div>
  );
}

/**
 * The logo and the dot by it: how fresh the numbers are, or trouble, and in its tooltip
 * when they were measured and when the next measurement comes and why. It is what of a
 * card changes with time: it renders at those moments, the card does not.
 */
export function CardMark({source}: {source: Card}) {
  const pace = useCadence(source.id);
  const refresh = useRefresh(source.id);
  const pending = refreshPending(refresh);
  const outcome = refresh?.request?.status;
  const failed = outcome === 'failed' || outcome === 'unavailable' || outcome === 'no_result';
  const paced = {...source, cadence: pace};
  const now = useClock(now => {
    const cadence = cadenceOf(paced, now);
    return earliest(
      dotChangesAt(source, now),
      cadenceChangesAt(paced, now),
      cadence?.when === 'nextIn' ? countdownChangesAt(cadence.next, now) : null,
      refresh?.request ? refreshChangesAt(refresh, now) : null,
    );
  });
  const problem = problemOf(source);
  const dot = dotOf(source, now);
  const partial=source.inventory?.complete===false;
  const warn=dot.warn||failed||partial;
  // How the measurements go lives in the logo's dot alone: its colour (how fresh, or in
  // trouble) and its tooltip; a line of its own would only repeat it and make the card taller.
  const status = problem ?? (source.successAt ? t('source.measured', {at: stamp(source.successAt)}) : errorText('waiting'));
  // Then when the next measurement comes (how soon, and the time) and why, each a line of its own.
  const cadence = cadenceOf(paced, now);
  const lines = [
    ...(refresh?.request ? refreshText(refresh, now).split('\n') : []),
    status,
    ...(partial?[t('money.inventoryPartial'),t('money.inventory',{count:source.inventory!.observed})]:[]),
    ...(!pending && cadence ? (cadence.when === 'nextSoon' ? [t('source.nextSoon')] : [t('source.nextIn', {time: countdown(cadence.next - now)}), stamp(cadence.next)]) : []),
    ...(!pending && cadence ? [t(`source.why.${cadence.why}`)] : []),
  ];
  // The dot's tooltip is one bubble everywhere: under the pointer on a desktop (style.css),
  // and for a while after a tap on a touch screen, which has nothing to hover.
  const [tip, setTip] = useState(false);
  const [hovered, setHovered] = useState(false);
  const bubble = useBubble(tip || hovered);
  useEffect(() => {
    if (!tip) return;
    const hide = (event?: Event) => {
      if (event?.target instanceof Node && bubble.current?.contains(event.target)) return;
      setTip(false);
    };
    const timer = setTimeout(hide, 4000);
    document.addEventListener('pointerdown', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', hide);
    };
  }, [tip]);
  return (
    <span
      className={`provider-mark ${warn ? 'is-warn' : ''} ${tip ? 'is-tipped' : ''}`}
      data-time="mark"
      data-refresh={outcome ?? 'idle'}
      aria-label={lines.join('\n')}
      role="img"
      onPointerEnter={event => event.pointerType !== 'touch' && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerUp={event => event.pointerType === 'touch' && setTip(true)}
    >
      <img className="provider-logo" src={logoOf(source.provider)} alt="" />
      {pending ? (
        <i className="spinner" aria-hidden="true" />
      ) : warn ? (
        <i className="dot dot-warn" />
      ) : (
        <i className={`dot dot-fresh ${dot.pulsing ? 'is-pulsing' : ''}`} style={{'--fresh': dot.fresh} as CSSProperties} />
      )}
      <span className="dot-tip glass" ref={bubble} aria-hidden="true">
        {lines.map((line, index) => (
          <span key={index}>{line}</span>
        ))}
      </span>
    </span>
  );
}

/** The card's tray: news of resets for everyone, free resets, the agents running on it. */
function CardTray({source}: {source: Card}) {
  const sessions = useSessions(source.id);
  const resets = useResetsFor(source.provider);
  const access = useSourceAccess(source.id);
  return <Tray resets={resets} news={access && <AccessMark id={source.id}/>} current={!!source.resets?.available&&<FreeResets resets={source.resets}/>} sessions={sessions} />;
}

/**
 * A source of the board. It reads its own card, pace, agents and news from the page's
 * state, by `id`: what changes of another source does not render it.
 */
export const SourceCard = memo(function SourceCard({id, arrange, boardId, personal}: {id: string; arrange: Arrange; boardId: string; personal: boolean}) {
  useLocale();
  const source = useCard(id);
  const title = useTitle(id, arrange.view.names);
  const mine = useMine(id);
  if (!source) return null;
  const visible = source.windows.filter(w => !isWindowHidden(arrange.view, source.id, w.id));
  const weekly = planOf(arrange.view, source.id);
  const takeOff = !personal && (arrange.owner || mine);

  return (
    <article className="card" data-card={id} style={{'--card-color': colorOf(arrange.view, source.id, source.provider)} as CSSProperties}>
      <div className="card-head">
        <CardMark source={source} />
        <div className="card-heading">
          <div className="card-title"><h2 title={title}>{title}</h2>
            {source.plan&&<span className="plan">{source.plan.replace(/^Claude\s+/i,'')}</span>}
          </div>
          {(source.meters||providerOf(source.provider))&&<small className="resource-type">{t(source.meters||providerOf(source.provider)?.measuredBy==='hub'?'resource.budget':'resource.subscription')}</small>}
        </div>
        <SourceSettings key={boardId} source={source} title={title} arrange={arrange} boardId={boardId} takeOff={takeOff} />
      </div>

      <div className="limits">
        {source.meters&&<MoneyCard source={source} board={boardId} view={arrange.view}/>}
        {visible.map(w => (
          <Limit key={w.id} w={w} measuredAt={source.successAt} weekly={weekly} />
        ))}
        {!source.windows.length && !source.meters?.length && <div className="card-empty">{errorText(source.error ?? 'waiting')}</div>}
        {!!source.windows.length && !visible.length && <AllHidden source={source} arrange={arrange} />}
      </div>
      <CardTray source={source} />
    </article>
  );
});
