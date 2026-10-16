import type {ReactNode} from 'react';
import {t} from '../i18n';
import {Popover} from './Popover';

/** Machines and measured subscriptions share the settings list's aligned columns. */
export function ConnectionRow({id,name,detail,status,actions,onOpen}:{id:string;name:string;detail:ReactNode;status:ReactNode;actions?:ReactNode;onOpen:()=>void}) {
  return <li className="settings-list-row popover-row">
    <button type="button" className="settings-item-open" data-connection-id={id} aria-haspopup="dialog" aria-label={name} onClick={onOpen}>
      <span className="settings-item-main"><b>{name}</b><small>{detail}</small></span>
      <span className="settings-item-detail">{status}</span>
    </button>
    {actions&&<div className="settings-item-actions"><Popover label={t('connections.actions',{name})} up width={250} icon={<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="3" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="13" cy="8" r="1"/></svg>}>{actions}</Popover></div>}
  </li>;
}
