import type {ReactNode} from 'react';
import {t} from '../i18n';
import {Popover} from './Popover';

/** Devices and provider accounts have the same row, with their own status and actions. */
export function ConnectionRow({name,icon,detail,status,actions}:{name:string;icon:ReactNode;detail:ReactNode;status:ReactNode;actions:ReactNode}) {
  return <li className="popover-row connection-row">
    <span className="connection-icon">{icon}</span>
    <div className="connection-name"><b title={name}>{name}</b><small>{detail}</small><div className="connection-mobile-status">{status}</div></div>
    <div className="connection-status">{status}</div>
    <Popover label={t('connections.actions',{name})} up width={250} icon={<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="3" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="13" cy="8" r="1"/></svg>}>{actions}</Popover>
  </li>;
}
