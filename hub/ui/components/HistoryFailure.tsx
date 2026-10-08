import {createElement} from 'react';
import type {Shown} from '../lib/history';
import {t} from '../i18n';

/** A failed reader leaves time navigation and the other resource family available. */
export function HistoryFailure({error,retry}:{error:Shown['error'];retry:()=>void}) {
  return error ? createElement('div',{className:'history-error'},
    createElement('p',{className:'form-error'},t(error==='history_limit'?'money.historyLimit':'analytics.failed')),
    createElement('button',{type:'button',className:'button',onClick:retry},t('analytics.retry')),
  ) : null;
}
