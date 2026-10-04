import {t} from '../i18n';

export const KEYS_PER_PAGE = 10;

/** The same compact page arrows in card and chart settings. */
export function KeyPages({page,pages,previous,next,onPrevious,onNext}:{page:number;pages:number;previous:boolean;next:boolean;onPrevious:()=>void;onNext:()=>void}) {
  return <div className="button-row popover-pad">
    <button type="button" className="icon-button" aria-label={t('money.previous')} title={t('money.previous')} disabled={!previous} onClick={onPrevious}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m10 3-5 5 5 5"/></svg></button>
    <span className="page-number">{page} / {pages}</span>
    <button type="button" className="icon-button" aria-label={t('money.next')} title={t('money.next')} disabled={!next} onClick={onNext}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></button>
  </div>;
}
