import {useCallback, useEffect, useState, type FormEvent} from 'react';
import {useNow} from '../lib/api';
import {ago, duration} from '../lib/format';
import {PROVIDERS} from '../lib/providers';
import {merging, renaming, restoring, shown, timeless, type ProjectGroup, type Projects as ProjectList} from '../lib/projects';
import {errorText} from '../lib/quota';
import {call} from '../lib/http';
import {LOGOS} from './logos';
import {CopyField, ErrorLine, Field, Modal, Segmented} from './Kit';
import {Popover} from './Popover';
import {t} from '../i18n';

export type MachinesTab = 'devices' | 'projects' | 'connect';

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

/**
 * A name renamed in place: the pencil opens a field, Enter saves, Escape leaves it as it
 * was. What an empty name means is the caller's.
 */
function InlineName({
  name: current,
  label,
  renameLabel,
  placeholder,
  maxLength,
  save: store,
}: {
  name: string;
  label: string;
  renameLabel: string;
  placeholder?: string;
  maxLength?: number;
  save: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await store(name!.trim());
      setName(null);
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
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={label}
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
      <b title={current}>{current}</b>
      <button type="button" className="icon-button" aria-label={renameLabel} title={renameLabel} onClick={() => setName(current)}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M10.5 3.5l2 2M3 13l.6-2.6L11 3a1.4 1.4 0 0 1 2 2l-7.4 7.4z" />
        </svg>
      </button>
    </span>
  );
}

/** A device's name, renamed in place; an empty name gives back the one the machine reports. */
function DeviceName({device, onRenamed}: {device: Device; onRenamed: () => void}) {
  return (
    <InlineName
      name={device.name}
      label={t('devices.nameLabel')}
      renameLabel={t('devices.rename', {name: device.name})}
      placeholder={device.reported}
      maxLength={80}
      save={async name => {
        await call('POST', `/api/devices/${encodeURIComponent(device.id)}`, {name});
        onRenamed();
      }}
    />
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
              <td>{device.lastSeenAt ? ago(device.lastSeenAt, now) : '—'}</td>
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

/**
 * The projects of the reader's machines with their agent time, which the reader renames,
 * merges and gives back their own names; every change applies to all the time kept. The
 * rules are in ui/lib/projects.ts.
 */
function Projects() {
  const now = useNow();
  const [list, setList] = useState<ProjectList | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [merge, setMerge] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    call<ProjectList>('GET', '/api/projects').then(answer => {
      setList(answer);
      setSelected([]);
    }, setError);
  }, []);
  useEffect(load, [load]);

  /** A change, then the list anew: another tab may have changed it too. */
  const change = async (url: string, body: object) => {
    setError(null);
    try {
      await call('POST', url, body);
    } finally {
      setMerge(false);
      load();
    }
  };
  const failing = (url: string, body: object) => change(url, body).catch(setError);

  if (!list) return <ErrorLine error={error} />;
  if (!list.projects.length) return <p className="admin-empty">{t('projects.empty')}</p>;
  const chosen = list.projects.filter(group => group.name !== null && selected.includes(group.name));
  const toggle = (group: ProjectGroup, on: boolean) => setSelected(current => (on ? [...current, group.name!] : current.filter(name => name !== group.name)));
  return (
    <>
      <p className="dialog-text">{t('projects.caption', {days: list.keptDays})}</p>
      <ErrorLine error={error} />
      <div className="table-wrap">
        <table className="admin-table projects-table">
          <thead>
            <tr>
              <th />
              <th>{t('projects.project')}</th>
              <th>{t('projects.machines')}</th>
              <th>{t('projects.time')}</th>
              <th>{t('projects.last')}</th>
            </tr>
          </thead>
          <tbody>
            {list.projects.map(group => {
              const from = shown(group);
              const unknown = timeless(group);
              return (
                <tr key={group.name ?? ''}>
                  <td>
                    {group.name !== null && (
                      <input
                        type="checkbox"
                        aria-label={t('projects.select', {name: group.name})}
                        checked={selected.includes(group.name)}
                        onChange={event => toggle(group, event.target.checked)}
                      />
                    )}
                  </td>
                  <td>
                    {group.name === null ? (
                      <span className="project-none">{t('projects.none')}</span>
                    ) : (
                      <InlineName
                        name={group.name}
                        label={t('projects.nameLabel')}
                        renameLabel={t('projects.rename', {name: group.name})}
                        save={name => change('/api/projects', renaming(group, name))}
                      />
                    )}
                    {from.length > 0 && (
                      <small>
                        {t('projects.from')}{' '}
                        {from.map((name, i) => (
                          <span key={name} className="project-from">
                            {name}
                            <button
                              type="button"
                              className="link-button"
                              aria-label={t('projects.restore', {name})}
                              title={t('projects.restore', {name})}
                              onClick={() => failing('/api/projects/restore', restoring(name))}
                            >
                              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                                <path d="M4 4l8 8M12 4l-8 8" />
                              </svg>
                            </button>
                            {i < from.length - 1 && ', '}
                          </span>
                        ))}
                      </small>
                    )}
                  </td>
                  <td>{group.machines.map(machine => machine.name).join(', ') || '—'}</td>
                  <td>{unknown ? '—' : duration(group.agentMs)}</td>
                  <td>{unknown ? '—' : ago(group.lastAt, now)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {chosen.length >= 2 && (
        <div className="projects-bar">
          <Popover label={t('projects.merge')} trigger={t('projects.merge')} triggerClass="button" align="left" up open={merge} onOpenChange={setMerge}>
            <div className="popover-title">{t('projects.mergeInto')}</div>
            {chosen.map(target => (
              <button key={target.name} type="button" className="popover-row" onClick={() => failing('/api/projects', merging(chosen, target))}>
                <span>{target.name}</span>
              </button>
            ))}
          </Popover>
        </div>
      )}
    </>
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
                <small>{token.lastUsedAt ? t('connect.used', {ago: ago(token.lastUsedAt, now)}) : t('connect.unused')}</small>
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
 * The reader's own machines, wherever their data is shown, the projects their agents
 * worked on, and the ways to connect more. The desktop app's board connects no other
 * machine: only the machines and the projects.
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
  const tabs: [MachinesTab, string][] = [
    ['devices', t('admin.devices')],
    ['projects', t('admin.projects')],
    ...(local ? [] : [['connect', t('admin.connect')] as [MachinesTab, string]]),
  ];
  const shownTab = local && tab === 'connect' ? 'devices' : tab;
  return (
    <Modal title={t('machines.title')} onClose={onClose} wide>
      <Segmented label={t('admin.sections')} options={tabs} value={shownTab} onChange={onTab} />
      <div className="dialog-body">
        {shownTab === 'devices' && <Devices local={local} />}
        {shownTab === 'projects' && <Projects />}
        {shownTab === 'connect' && <Connect />}
      </div>
    </Modal>
  );
}
