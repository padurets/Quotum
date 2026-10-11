import type {Card} from '../lib/types';
import {useClock} from '../lib/clock';
import {stamp,num} from '../lib/format';
import {quotaPeriods} from '../lib/subscription';
import {windowName} from '../lib/quota';
import {t} from '../i18n';
import {StatusMark,WarningIcon} from './StatusMark';

export function UsageWorkMark({source}:{source:Card}) {
  const now=useClock(now=>{const dates=source.usageWork?.filter(s=>s.expiresAt>now).map(s=>s.expiresAt)??[];return dates.length?Math.min(...dates):null;});
  const marks=source.usageWork?.filter(s=>s.expiresAt>now)??[];
  if(!marks.length)return null;
  const periods=quotaPeriods(source),label=t('usageWork.mark');
  return <span data-time="usage-work"><StatusMark tone="warn" label={label} trigger={<><WarningIcon/>{label}</>}>
    <div className="tray-panel-head"><strong>{label}</strong></div>
    {marks.map(mark=><div className="settings-section" key={mark.windowId}>
      <strong>{t(`usageWork.${mark.quality}`)}</strong>
      <p>{t('usageWork.growth',{window:periods.find(p=>p.id===mark.windowId)?windowName(periods.find(p=>p.id===mark.windowId)!):mark.windowId,value:num(mark.growth)})}</p>
      <p className="tray-panel-when">{stamp(mark.from)} — {stamp(mark.to)}</p>
    </div>)}
    <p>{t('usageWork.scope')}</p>
  </StatusMark></span>;
}
