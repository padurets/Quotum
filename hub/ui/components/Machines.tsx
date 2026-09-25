import {useCallback, useEffect, useState, type FormEvent} from 'react';
import {useNow} from '../lib/api';
import {ago, stamp} from '../lib/format';
import {PROVIDERS} from '../lib/providers';
import {errorText} from '../lib/quota';
import {call} from '../lib/http';
import {LOGOS} from './logos';
import {CopyField, ErrorLine, Field, Modal, Segmented} from './Kit';
import {t} from '../i18n';

export type MachinesTab = 'devices' | 'connect';

type Device = {
  id: string;
  /** The name given on the hub, else the one the machine reports. */
  name: string;
  reported: string;
  os: string;
  arch: string;
  agent: string;
  via: 'code' | 'token';
  lastSeenAt: number | null;
  sources: {provider: string; source: string; seenAt: number}[];
  failures: {provider: string; error: string; detail: string | null; at: number}[];
};
type Token = {id: string; name: string; hint: string; createdAt: number; lastUsedAt: number | null};

const origin = () => location.origin;
const tokenName = (token: {name: string}) => token.name || t('connect.tokenDefault');

/** The agents of a device: the providers it delivers, and the ones whose client failed there. */
function Agents({device}: {device: Device}) {
  const providers = [...new Set([...device.sources.map(s => s.provider), ...device.failures.map(f => f.provider)])];
  if (!providers.length) return <>—</>;
  return (
    <span className="agent-icons">
      {providers.map(provider => {
        const failure = device.failures.find(f => f.provider === provider);
        const title = [PROVIDERS[provider]?.name ?? provider, failure && errorText(failure.error), failure?.detail].filter(Boolean).join(' — ');
        return (
          <span key={provider} className={`agent-icon ${failure ? 'is-failing' : ''}`} title={title}>
            <img src={LOGOS[provider]} alt={title} />
          </span>
        );
      })}
    </span>
  );
}

/** A device's name, renamed in place; an empty name gives back the one the machine reports. */
function DeviceName({device, onRenamed}: {device: Device; onRenamed: () => void}) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await call('POST', `/api/devices/${encodeURIComponent(device.id)}`, {name: name!.trim()});
      setName(null);
      onRenamed();
    } catch (failure) {
      setError(failure);
    }
  };
  if (name !== null) {
    return (
      <form className="inline-rename" onSubmit={save}>
        <input
          autoFocus
          value={name}
          maxLength={80}
          placeholder={device.reported}
          aria-label={t('devices.nameLabel')}
          onChange={event => setName(event.target.value)}
          onKeyDown={event => event.key === 'Escape' && (event.stopPropagation(), setName(null))}
        />
        <button className="button">{t('boards.save')}</button>
        <ErrorLine error={error} />
      </form>
    );
  }
  return (
    <span className="device-name">
      <b>{device.name}</b>
      <button type="button" className="icon-button" aria-label={t('devices.rename', {name: device.name})} title={t('devices.rename', {name: device.name})} onClick={() => setName(device.name)}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M10.5 3.5l2 2M3 13l.6-2.6L11 3a1.4 1.4 0 0 1 2 2l-7.4 7.4z" />
        </svg>
      </button>
    </span>
  );
}

/** The reader's devices; on the desktop app's board, its one machine, which cannot be disconnected (it is the app's own agent). */
function Devices({local}: {local: boolean}) {
  const now = useNow();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    call<Device[]>('GET', '/api/devices').then(setDevices, setError);
  }, []);
  useEffect(load, [load]);

  const revoke = async (device: Device) => {
    if (!confirm(t('devices.confirmRevoke', {name: device.name}))) return;
    setError(null);
    try {
      await call('DELETE', `/api/devices/${encodeURIComponent(device.id)}`);
      load();
    } catch (failure) {
      setError(failure);
    }
  };

  if (!devices) return <ErrorLine error={error} />;
  if (!devices.length) return <p className="admin-empty">{t(local ? 'local.devicesEmpty' : 'devices.empty')}</p>;
  return (
    <div className="table-wrap">
      <ErrorLine error={error} />
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t('devices.device')}</th>
            <th>{t('devices.agents')}</th>
            <th>{t('devices.seen')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {devices.map(device => (
            <tr key={device.id}>
              <td>
                <DeviceName device={device} onRenamed={load} />
                <small>
                  {device.name !== device.reported && `${device.reported} · `}
                  {device.os}
                  {!local && ` · ${t(device.via === 'code' ? 'devices.viaCode' : 'devices.viaToken')}`}
                </small>
              </td>
              <td>
                <Agents device={device} />
              </td>
              <td title={device.lastSeenAt ? stamp(device.lastSeenAt) : undefined}>{device.lastSeenAt ? ago(device.lastSeenAt, now) : '—'}</td>
              <td>
                {!local && (
                  <button type="button" className="link-button danger" onClick={() => revoke(device)}>
                    {t('devices.revoke')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Connect() {
  const now = useNow();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{secret: string; name: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    call<Token[]>('GET', '/api/tokens').then(setTokens, setError);
  }, []);
  useEffect(load, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await call<Token & {secret: string}>('POST', '/api/tokens', {name: name.trim()});
      setCreated({secret: token.secret, name: tokenName(token)});
      setName('');
      load();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: Token) => {
    if (!confirm(t('connect.confirmRevoke', {name: tokenName(token)}))) return;
    setError(null);
    try {
      await call('DELETE', `/api/tokens/${encodeURIComponent(token.id)}`);
      setCreated(null);
      load();
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <div className="connect">
      <section className="connect-way">
        <h3>{t('connect.codeTitle')}</h3>
        <p>{t('connect.codeText')}</p>
        <CopyField value={`npx quotum connect ${origin()}`} />
      </section>

      <section className="connect-way">
        <h3>{t('connect.tokenTitle')}</h3>
        <p>{t('connect.tokenText')}</p>
        {created ? (
          <div className="token-created">
            <CopyField label={t('connect.tokenShownOnce', {name: created.name})} value={created.secret} secret />
            <CopyField label={t('connect.run')} value={`QUOTUM_HUB_URL=${origin()} QUOTUM_HUB_TOKEN=${created.secret} npx quotum run`} />
            <button type="button" className="link-button" onClick={() => setCreated(null)}>
              {t('connect.done')}
            </button>
          </div>
        ) : (
          <form className="inline-form" onSubmit={create}>
            <Field label={t('connect.name')} placeholder={t('connect.namePlaceholder')} value={name} onChange={e => setName(e.target.value)} maxLength={80} />
            <button type="submit" className="button primary" disabled={busy}>
              {t('connect.create')}
            </button>
          </form>
        )}
        <ErrorLine error={error} />
        {tokens.length > 0 && (
          <ul className="token-list">
            {tokens.map(token => (
              <li key={token.id}>
                <span>
                  <b>{tokenName(token)}</b> <span className="mono">{token.hint}</span>
                </span>
                <small title={token.lastUsedAt ? stamp(token.lastUsedAt) : undefined}>{token.lastUsedAt ? t('connect.used', {ago: ago(token.lastUsedAt, now)}) : t('connect.unused')}</small>
                <button type="button" className="link-button danger" onClick={() => revoke(token)}>
                  {t('connect.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The reader's own machines, wherever their data is shown, and the ways to connect more.
 * The desktop app's board connects no other machine: only the list.
 */
export function MachinesDialog({
  tab,
  onTab,
  onClose,
  local,
}: {
  tab: MachinesTab;
  onTab: (tab: MachinesTab) => void;
  onClose: () => void;
  local: boolean;
}) {
  if (local) {
    return (
      <Modal title={t('machines.title')} onClose={onClose} wide>
        <div className="dialog-body">
          <Devices local />
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={t('machines.title')} onClose={onClose} wide>
      <Segmented
        label={t('admin.sections')}
        options={[
          ['devices', t('admin.devices')],
          ['connect', t('admin.connect')],
        ]}
        value={tab}
        onChange={onTab}
      />
      <div className="dialog-body">
        {tab === 'devices' && <Devices local={false} />}
        {tab === 'connect' && <Connect />}
      </div>
    </Modal>
  );
}
