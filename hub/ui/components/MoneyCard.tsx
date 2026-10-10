import {useMeasurementClock,useMeasurementTime} from '../lib/measurementClock';
import type {ReactNode} from 'react';
import {QUOTA_IDS} from '../../server/domain/meters';
import type {Card, View} from '../lib/types';
import type {KeyPart, Meter} from '../../server/domain/meters';
import {currencySymbol, type CurrencyContext} from '../../server/domain/currency';
import {useSourceAccess, useCurrencyContext} from '../lib/board';
import {
  amountText,
  amountUnitLabel,
  capName,
  budgetView,
  budgetVisible,
  balanceGroups,
  balanceRoleLabel,
  money,
  keyName,
  capLeft,
  capPercent,
  capStale,
  capChangesAt,
  accessTone,
  accessChangesAt,
  ACCESS_WARNING_MS,
  type BudgetLimit,
} from '../lib/money';
import {stamp, day, countdown, duration, countdownChangesAt, earliest} from '../lib/format';
import {useClock} from '../lib/clock';
import {t} from '../i18n';
import {ApiError, messageOf} from '../lib/http';
import {ErrorLine} from './Kit';
import {Popover} from './Popover';
import {KeyIcon, StatusMark, WarningIcon} from './StatusMark';
import {MeterBar, PercentLimit, ResetText} from './Meter';
import {level, resetLineChangesAt} from '../lib/quota';
import {useShownKeys} from '../lib/moneyKeys';
import {rateText} from '../lib/currencySettings';

function KeyStatus({part, cap}: {part: BudgetLimit['part']; cap: Meter}) {
  const now = useMeasurementClock((now) =>
    earliest(part.expiresAt !== null && part.expiresAt > now ? part.expiresAt : null, capChangesAt(cap, now)),
  );
  const stale = capStale(cap, now);
  const inactive = part.disabled || (part.expiresAt !== null && part.expiresAt <= now);
  const status = inactive
    ? t('money.inactive')
    : part.presence === 'missing'
      ? t('money.missing')
      : stale
        ? t('money.stale')
        : '';
  return (
    <small
      data-time="key-status"
      className={`key-status${stale ? ' cap-stale' : ''}${inactive ? ' is-inactive' : ''}`}
      role="img"
      title={status}
      aria-label={status || undefined}
      aria-hidden={!status}
    />
  );
}
function CapStatus({part, cap}: {part?: KeyPart; cap?: Meter}) {
  const now = useMeasurementClock((now) =>
    earliest(
      part?.expiresAt != null && part.expiresAt > now ? part.expiresAt : null,
      cap ? capChangesAt(cap, now) : null,
    ),
  );
  const inactive = !!part && (part.disabled || (part.expiresAt !== null && part.expiresAt <= now));
  const status = inactive
    ? t('money.inactive')
    : part?.presence === 'missing'
      ? t('money.missing')
      : !cap
        ? t('quota.unavailable')
        : capStale(cap, now)
          ? t('money.stale')
          : '';
  const detail = status && cap ? `${status}\n${stamp(cap.at)}` : status;
  return (
    <small
      data-time="key-status"
      className={`key-status${inactive ? ' is-inactive' : ''}`}
      role="img"
      title={detail}
      aria-label={detail || undefined}
      aria-hidden={!status}
    />
  );
}
export function CapReset({meter, short = false}: {meter: Meter; short?: boolean}) {
  const now = useMeasurementClock((now) => (meter.resetAt === null ? null : countdownChangesAt(meter.resetAt, now)));
  const historical=useMeasurementTime()!==null;
  const unknown = meter.resetAt === null && meter.scope !== 'lifetime';
  const text =
    historical&&meter.resetAt!==null?stamp(meter.resetAt):meter.resetAt === null
      ? unknown
        ? short
          ? '—'
          : t('limit.resetUnknown')
        : ''
      : meter.resetAt > now
        ? short
          ? countdown(meter.resetAt - now)
          : t('limit.resetsIn', {time: duration(meter.resetAt - now)})
        : t('limit.resetPassed');
  return (
    <span
      data-time="cap-reset"
      title={unknown ? t('limit.resetUnknown') : meter.resetAt !== null ? stamp(meter.resetAt) : ''}
    >
      {text}
    </span>
  );
}
/** Monetary caps keep their amounts around the shared segmented meter. */
export function CapMetrics({
  cap,
  name,
  detail = name,
  status,
  compact = false,
}: {
  cap: Meter | undefined;
  name: string;
  detail?: string;
  status?: import('react').ReactNode;
  compact?: boolean;
}) {
  const percent = cap ? capPercent(cap) : null,
    remaining = percent === null ? null : 100 - percent;
  const value = cap ? amountText(capLeft(cap), cap.unit) : '—',
    unit = cap ? amountUnitLabel(cap.unit) : '';
  const label = (
    <span className="cap-label">
      <span>{name}</span>
      {status}
    </span>
  );
  const bar = <MeterBar remaining={cap ? remaining : null} label={name} />;
  const reset = cap ? <CapReset meter={cap} short={compact} /> : <span>{t('money.stale')}</span>;
  if (compact)
    return (
      <div className="compact-limit is-money">
        <div className="compact-window-name">
          <span title={detail}>{label}</span>
        </div>
        <small className="compact-reset">{reset}</small>
        {bar}
        <strong className="limit-value" title={cap ? money(capLeft(cap), cap.unit, true) : undefined}>
          {value}
          <small>{unit}</small>
        </strong>
      </div>
    );
  return (
    <div className="limit money-limit">
      <div className="limit-top">
        <span className="limit-name" title={detail}>
          {label}
        </span>
        <span
          className={`limit-value v-${remaining === null ? 'ok' : level(remaining)}`}
          title={cap ? money(capLeft(cap), cap.unit, true) : undefined}
        >
          {value}
          <small>{unit}</small>
        </span>
      </div>
      {bar}
      <div className="limit-bottom">
        <span>{cap ? t('money.of', {amount: money(cap.limit, cap.unit)}) : t('quota.unavailable')}</span>
        {cap && remaining === null ? <span>{t('money.exhausted')}</span> : reset}
      </div>
    </div>
  );
}
function BudgetKeyMetrics({
  limit,
  context,
  compact = false,
}: {
  limit: BudgetLimit;
  context: CurrencyContext;
  compact?: boolean;
}) {
  const {part, meter: cap} = limit;
  const percent = capPercent(limit.native),
    remaining = percent === null ? null : 100 - percent;
  const symbol = limit.unavailable ? context.target.symbol : currencySymbol(cap.unit, context);
  const left = limit.unavailable ? '— ' + symbol : money(capLeft(cap), cap.unit, false, context),
    value = left.slice(0, -symbol.length - 1);
  const detail = [keyName(part), part.includeByok ? t('money.byok') : ''].filter(Boolean).join('\n');
  const stale = part.presence === 'missing' || cap.stale;
  const bar = <MeterBar remaining={remaining} label={keyName(part)} />;
  if (compact)
    return (
      <div className={`compact-limit is-money${stale ? ' is-stale' : ''}`}>
        <div className="compact-window-name">
          <span title={detail}>
            <span>
              {keyName(part)}
              <KeyStatus part={part} cap={cap} />
            </span>
          </span>
        </div>
        <small className="compact-reset">
          <CapReset meter={cap} short />
        </small>
        {bar}
        <strong
          className="limit-value"
          title={limit.unavailable ? '' : money(capLeft(cap), cap.unit, true, context)}
        >
          {value}
          <small>{symbol}</small>
        </strong>
      </div>
    );
  return (
    <div className={`limit money-limit${stale ? ' is-stale' : ''}`}>
      <div className="limit-top">
        <span className="limit-name" title={detail}>
          {keyName(part)}
          <KeyStatus part={part} cap={cap} />
        </span>
        <span
          className={`limit-value v-${remaining === null ? 'ok' : level(remaining)}`}
          title={limit.unavailable ? '' : money(capLeft(cap), cap.unit, true, context)}
        >
          {value}
          <small>{symbol}</small>
        </span>
      </div>
      {bar}
      <div className="limit-bottom">
        <span title={limit.unavailable ? '' : money(cap.limit, cap.unit, true, context)}>
          {t('money.of', {
            amount: limit.unavailable ? '— ' + symbol : money(cap.limit, cap.unit, false, context),
          })}
        </span>
        {remaining === null ? <span>{t('money.exhausted')}</span> : <CapReset meter={cap} />}
      </div>
    </div>
  );
}
export function KeyMetrics({
  part,
  meters,
  compact = false,
}: {
  part: KeyPart;
  meters: readonly Meter[];
  compact?: boolean;
}) {
  const cap = meters.find((m) => m.id === `key:${part.id}:cap`);
  if (!cap) return null;
  return (
    <CapMetrics
      cap={cap}
      name={keyName(part)}
      detail={[keyName(part), part.includeByok ? t('money.byok') : ''].filter(Boolean).join('\n')}
      status={<CapStatus part={part} cap={cap} />}
      compact={compact}
    />
  );
}
export function QuotaCard({
  source,
  ids = QUOTA_IDS,
  compact = false,
}: {
  source: Pick<Card,'meters'>;
  ids?: readonly string[];
  compact?: boolean;
}) {
  return (
    <>
      {ids.map((id) => {
        const cap = source.meters?.find((m) => m.id === id),
          used = cap ? capPercent(cap) : null;
        const detail = cap
          ? `${money(capLeft(cap), cap.unit, true)}\n${t('money.of', {amount: money(cap.limit, cap.unit, true)})}\n${cap.resetAt === null ? t('limit.resetUnknown') : stamp(cap.resetAt)}${used === null ? `\n${t('money.exhausted')}` : ''}`
          : t('quota.unavailable');
        return (
          <PercentLimit
            key={id}
            name={capName({id, scope: null, label: null})}
            remaining={used === null ? null : 100 - used}
            valueTitle={detail}
            status={<CapStatus cap={cap} />}
            reset={<QuotaReset resetAt={cap?.resetAt ?? null} short={compact} />}
            compact={compact}
          />
        );
      })}
    </>
  );
}
function QuotaReset({resetAt, short}: {resetAt: number | null; short: boolean}) {
  const now = useMeasurementClock((now) => resetLineChangesAt({resetAt}, now));
  const historical=useMeasurementTime()!==null;
  if(historical)return <span>{resetAt===null?t('limit.resetUnknown'):stamp(resetAt)}</span>;
  return <ResetText resetAt={resetAt} now={now} short={short} />;
}
export function QuotaMark({source}: {source: Card}) {
  if (!source.quota || source.quota.complete) return null;
  const text = messageOf(
    new ApiError(400, 'connector_quota_' + (source.quota.generation ? 'partial' : source.quota.issue)),
  );
  return (
    <StatusMark label={text} tone="warn" trigger={<WarningIcon />}>
      <p className="tray-panel-lead">{text}</p>
      <p>{t('quota.budgetOnly')}</p>
    </StatusMark>
  );
}
export function MoneyCard({
  source,
  board,
  view,
  compact = false,
  tray = false,
}: {
  source: Card;
  board: string;
  view?: View;
  compact?: boolean;
  tray?: boolean;
}) {
  const context = useCurrencyContext(source.id);
  const {keys, meters, error} = useShownKeys(source, view, board);
  return <MoneyValues source={source} keys={keys} meters={meters} error={error} compact={compact} tray={tray} context={context}/>;
}

type MoneySource=Pick<Card,'id'|'provider'|'meters'|'currencyUnavailable'|'creditBalance'>;
export function MoneyValues({source,keys,meters,error=null,compact=false,tray=false,context}:{source:MoneySource;keys:KeyPart[];meters:Meter[];error?:unknown;compact?:boolean;tray?:boolean;context:CurrencyContext}) {
  const {remaining, limits} = budgetView(source, keys, meters, context),
    groups = remaining.values;
  const credit=source.provider==='codex';
  const native=source.meters?.find(m=>m.id==='balance:credits'&&!m.conversion);
  const displayUnavailable =
    !groups.length && (source.currencyUnavailable || balanceGroups(source).some((g) => !g.total.stale));
  const composition = groups.filter((group) => group.components.length || group.approximate);
  const proof = groups[0]?.total.conversion;
  const referenceRate = proof && (proof.steps ?? [proof.rate]).find((r) => r.source !== 'manual' && r.source !== 'codex-default');
  const quoted = referenceRate && new Date(referenceRate.date);
  const quoteDate = quoted
    ? day(new Date(quoted.getUTCFullYear(), quoted.getUTCMonth(), quoted.getUTCDate()).getTime())
    : '';
  const rateSources = proof
    ? [
        ...new Set(
          (proof.steps ?? [proof.rate]).map((r) =>
            r.source === 'manual' ? t('money.personalRate') : r.source === 'codex-default' ? t('money.defaultEstimate') : r.source.toUpperCase(),
          ),
        ),
      ].join(', ')
    : '';
  const conversion = proof
    ? t(!referenceRate ? 'money.fixedEstimate' : 'money.currencyEstimate', {
        amount: money(proof.original.amount, proof.original.unit, true, context, proof.original.scale),
        source: rateSources,
        date: quoteDate,
      })
    : '';
  const breakdown = (
    <div className="money-breakdown">
      {credit&&proof&&<p>{(proof.steps??[proof.rate]).filter(leg=>leg.base==='credits:codex').map(leg=><span className="currency-equation" key={leg.id}>1 {t('money.codexCredit')} = {money(leg.to,'USD',true,context)}</span>)}</p>}
      {credit&&native&&<section><p>{money(native.amount,native.unit,true,context,native.scale)}</p><p>{stamp(native.at)}</p><CreditLastKnown source={source}/>{!composition.length&&conversion&&<p className="popover-note">{conversion}</p>}</section>}
      {composition.map(({total, components, approximate}) => (
        <section key={total.id}>
          <div
            className={`money-breakdown-total${total.stale ? ' is-stale' : ''}`}
            title={[
              money(total.amount, total.unit, true, context, total.scale),
              stamp(total.at),
              total.stale ? t('money.stale') : '',
            ]
              .filter(Boolean)
              .join('\n')}
          >
            <strong>{currencySymbol(total.unit, context)}</strong>
            <span>
              {approximate ? '≈ ' : ''}
              {money(total.amount, total.unit, false, context, total.scale)}
            </span>
          </div>
          {components.map(({meter, role}) => (
            <div
              key={meter.id}
              className={meter.stale ? 'is-stale' : ''}
              title={[
                money(meter.amount, meter.unit, true, context, meter.scale),
                stamp(meter.at),
                meter.stale ? t('money.stale') : '',
              ]
                .filter(Boolean)
                .join('\n')}
            >
              <span>{balanceRoleLabel(role)}</span>
              <span>
                {approximate ? '≈ ' : ''}
                {money(meter.amount, meter.unit, false, context, meter.scale)}
              </span>
            </div>
          ))}
          {approximate && conversion && <p className="popover-note">{conversion}</p>}
        </section>
      ))}
    </div>
  );
  if(tray)return <FundsMark source={source} groups={groups} context={context} native={native} rateSources={rateSources} quoteDate={quoteDate} displayUnavailable={!!displayUnavailable}/>;
  return (
    <div className="money-body">
      <div className="money-balance">
        <span>{t(credit?'money.additionalFunds':'money.accountBalance')}</span>
        <div className="money-balance-values">
          <CreditBalanceValue source={source} breakdown={breakdown}>
          {!groups.length ? (
            <span
              className="limit-value"
              title={
                displayUnavailable
                  ? t('money.noDisplayBalance', {currency: context.target.symbol})
                  : t('money.noBalance')
              }
            >
              —<small>{context.target.symbol}</small>
            </span>
          ) : (
            groups.map(({total, approximate}) => {
              const formatted = money(total.amount, total.unit, false, context, total.scale),
                symbol = currencySymbol(total.unit, context),
                amount = formatted.slice(0, -symbol.length - 1);
              const value = (
                <span
                  key={total.id}
                  className={`limit-value${total.stale ? ' is-stale' : ''}`}
                  data-money={total.amount}
                  title={[
                    money(total.amount, total.unit, true, context, total.scale),
                    stamp(total.at),
                    approximate ? conversion : '',
                    total.stale ? t('money.stale') : '',
                  ]
                    .filter(Boolean)
                    .join('\n')}
                >
                  {approximate ? '≈ ' : ''}
                  {amount}
                  <small>{symbol}</small>
                </span>
              );
              return composition.length || credit ? (
                <Popover
                  key={total.id}
                  label={`${t('money.breakdown')}: ${approximate ? '≈ ' : ''}${formatted}`}
                  trigger={value}
                  triggerClass="money-balance-trigger"
                  up
                >
                  {breakdown}
                </Popover>
              ) : (
                value
              );
            })
          )}
          </CreditBalanceValue>
        </div>
      </div>
      <div className="limits money-limits">
        {limits.map((limit) => (
          <BudgetKeyMetrics key={limit.scope.id} limit={limit} context={context} compact={compact} />
        ))}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}
/** Subscription funds share the budget value and disclosure, in the existing footer. */
function FundsMark({source,groups,context,native,rateSources,quoteDate,displayUnavailable}:{source:MoneySource;groups:ReturnType<typeof budgetView>['remaining']['values'];context:CurrencyContext;native?:Meter;rateSources:string;quoteDate:string;displayUnavailable:boolean}) {
  const now=useMeasurementClock(now=>creditChangesAt(source,now));
  const unlimited=source.creditBalance?.status==='unlimited';
  const stale=!!source.creditBalance&&(now>source.creditBalance.at+source.creditBalance.staleAfterMs||!['finite','unlimited'].includes(source.creditBalance.status))||!unlimited&&!!native?.stale;
  const values=groups.map(({total,approximate})=>({total,text:(approximate?'≈ ':'')+money(total.amount,total.unit,false,context,total.scale)}));
  if(!values.length&&!native&&!unlimited)return null;
  const nativeText=native&&money(native.amount,native.unit,true,context,native.scale);
  const label=[t('money.additionalFunds'),unlimited?t('money.unlimited'):nativeText,stale?t('money.lastKnown'):null].filter(Boolean).join('\n');
  const proof=groups[0]?.total.conversion,creditRate=proof&&(proof.steps??[proof.rate]).find(leg=>leg.base==='credits:codex');
  return <span className="funds-tray"><StatusMark label={label} className="funds-mark" tone={stale||displayUnavailable?'warn':undefined} align="right" trigger={<>
    <svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M20 8V5H6a3 3 0 0 0 0 6h14v9H6a3 3 0 0 1-3-3V8m17 3h1v5h-5v-5h4m-1 2.5h.01"/></svg>
    {unlimited?<b>∞</b>:values.length?values.map(({total,text})=><b className="funds-value" data-money={total.amount} key={total.id}>{text}</b>):<b className="funds-value">{nativeText}</b>}
  </>}>
    <div className="tray-panel-head">
      <p className="tray-panel-lead">{unlimited?t('money.unlimited'):nativeText}</p>
      {stale&&<p className="tray-panel-when">{t('money.lastKnown')}</p>}
      {(unlimited?source.creditBalance:native)&&<p className="tray-panel-when">{stamp((unlimited?source.creditBalance:native)!.at)}</p>}
    </div>
    {!unlimited&&creditRate&&<dl className="tray-panel-table">
      <div><dt>1 {t('money.codexCredit')}</dt><dd>{rateText(creditRate.to)} USD</dd></div>
      <div><dt>{t('money.rate')}</dt><dd>{rateSources}</dd></div>
      {quoteDate&&<div><dt>{t('money.rateDate')}</dt><dd>{quoteDate}</dd></div>}
    </dl>}
    {displayUnavailable&&<p>{t('money.noDisplayBalance',{currency:context.target.symbol})}</p>}
  </StatusMark></span>;
}
function creditChangesAt(source: MoneySource, now: number) {
  const status = source.creditBalance;
  return status && now <= status.at + status.staleAfterMs ? status.at + status.staleAfterMs + 1 : null;
}
function CreditBalanceValue({source, breakdown, children}: {source: MoneySource; breakdown: ReactNode; children: ReactNode}) {
  const now = useMeasurementClock(now => creditChangesAt(source, now));
  const status = creditBalanceText(source, now);
  if (!status) return children;
  const value = <span data-time="credit-status" className="limit-value money-balance-status">{status}</span>;
  return source.meters?.some(m => m.id === 'balance:credits' && !m.conversion)
    ? <Popover label={t('money.breakdown')} trigger={value} triggerClass="money-balance-trigger" up>{breakdown}</Popover>
    : value;
}
function CreditLastKnown({source}: {source: MoneySource}) {
  const now = useMeasurementClock(now => creditChangesAt(source, now));
  return creditBalanceText(source, now) || source.meters?.some(m => m.id === 'balance:credits' && m.stale)
    ? <p data-time="credit-last-known">{t('money.lastKnown')}</p> : null;
}
/** Status is independent of the last numeric value and its quota windows. */
function creditBalanceText(source:MoneySource,now:number):string|null {
  if(source.provider!=='codex')return null;
  const status=source.creditBalance;
  if(!status)return t('money.notReported');
  if(now>status.at+status.staleAfterMs)return t('money.stale');
  switch(status.status){
    case 'finite':return null;
    case 'unlimited':return t('money.unlimited');
    case 'invalid':return t('money.invalidBalance');
    case 'unsupported':return t('money.unsupportedBalance');
    default:return t('money.creditUnavailable');
  }
}
/** Safe supplier facts use the existing news mark, with their own freshness. */
export function BalanceMark({source}: {source: Card}) {
  const context = useCurrencyContext(source.id),
    unavailable =
      !budgetView(source, [], source.meters ?? [], context).remaining.values.length &&
      (source.currencyUnavailable || balanceGroups(source).some((g) => !g.total.stale));
  const status = source.balanceStatus,credit=source.creditBalance;
  const now = useClock((now) =>
    earliest(status && now <= status.at + status.staleAfterMs ? status.at + status.staleAfterMs + 1 : null,credit&&now<=credit.at+credit.staleAfterMs?credit.at+credit.staleAfterMs+1:null),
  );
  if(!budgetVisible(source))return null;
  const creditText=creditBalanceText(source,now);
  if(source.provider==='codex'&&creditText&&credit?.status!=='unlimited')return <span data-time="balance-status"><StatusMark label={creditText} tone="warn" trigger={<WarningIcon/>}><p>{creditText}</p>{credit&&<p>{stamp(credit.at)}</p>}</StatusMark></span>;
  if (!unavailable && (!status || (status.isAvailable && !status.partial))) return null;
  const lines = [
    ...(unavailable ? [t('money.noDisplayBalance', {currency: context.target.symbol})] : []),
    ...(status && !status.isAvailable ? [t('money.balanceUnavailable')] : []),
    ...(status?.issues.includes('empty_balances')
      ? [t('money.noBalance')]
      : status?.partial
        ? [t('money.balancePartial')]
        : []),
    ...(status
      ? [stamp(status.at), ...(now > status.at + status.staleAfterMs ? [t('money.stale')] : [])]
      : []),
  ];
  const tone = status && !status.isAvailable ? 'crit' : 'warn';
  return (
    <span data-time="balance-status">
      <StatusMark label={lines.join('\n')} tone={tone} trigger={<WarningIcon />}>
        <div className="tray-panel-head">
          {lines.map((line, index) => (
            <p key={index} className={index ? 'tray-panel-when' : 'tray-panel-lead'}>
              {line}
            </p>
          ))}
        </div>
      </StatusMark>
    </span>
  );
}

export function AccessMark({id}: {id: string}) {
  const access = useSourceAccess(id);
  const now = useClock((now) => accessChangesAt(access, now));
  if (!access) return null;
  const tone = accessTone(access, now);
  if (tone === null) return null;
  const text = access.error ? new ApiError(400, access.error) : null;
  const expiry =
    access.expiryKind === 'unknown'
      ? t('sources.unknownExpiry')
      : access.expiresAt === null
        ? t('sources.noExpiry')
        : access.expiresAt <= now
          ? t('money.expired')
          : t('money.expirySoon', {time: stamp(access.expiresAt)});
  const lead = text ? messageOf(text) : expiry;
  const expiringSoon =
    tone !== 'crit' &&
    access.expiresAt !== null &&
    access.expiresAt > now &&
    access.expiresAt - now <= ACCESS_WARNING_MS;

  return (
    <span data-time="access-expiry">
      <StatusMark
        label={lead}
        className="access-mark"
        tone={tone === 'neutral' ? undefined : tone}
        trigger={
          <>
            <KeyIcon />
            {expiringSoon && <span>{countdown(access.expiresAt! - now)}</span>}
          </>
        }
      >
        <div className="tray-panel-head">
          <p className="tray-panel-lead">{lead}</p>
          {text && <p className="tray-panel-when">{expiry}</p>}
        </div>
      </StatusMark>
    </span>
  );
}
