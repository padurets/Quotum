import {useCallback, useEffect, useState, type FormEvent} from 'react';
import {ago} from '../lib/format';
import {PROVIDERS} from '../lib/providers';
import {LOGOS} from './logos';
import {errorText} from '../lib/quota';
import {call} from '../lib/http';
import {boardTitle, type Board} from '../lib/session';
import {CopyField, ErrorLine, Field, Modal, Segmented} from './Kit';
import {rich, t} from '../i18n';

export type AdminTab = 'devices' | 'connect' | 'members';

type Device = {
  id: string;
  name: string;
  os: string;
  arch: string;
  agent: string;
  owner: string;
  via: 'code' | 'token';
  lastSeenAt: number | null;
  /** Owned by the reader: they can disconnect it (the board's owner can disconnect any). */
  mine: boolean;
  sources: {provider: string; source: string; seenAt: number}[];
  failures: {provider: string; error: string; detail: string | null; at: number}[];
};
type Token = {id: string; name: string; hint: string; createdByName: string; createdAt: number; lastUsedAt: number | null; mine: boolean};
type Member = {id: string; name: string; email: string; role: 'owner' | 'member'};

const origin = () => location.origin;
const tokenName = (token: {name: string}) => token.name || t('connect.tokenDefault');

/** The agents of a device: the providers it delivers, and the ones whose client failed there. */
function Agents({device}: {device: Device}) {
  const providers = [...new Set([...device.sources.map(s => s.provider), ...device.failures.map(f => f.provider)])];
  if (!providers.length) return <>—</>;
  return (
    <span className="agent-icons">
      {providers.map(provider => {
        const meta = PROVIDERS[provider];
        const failure = device.failures.find(f => f.provider === provider);
        const title = [meta?.name ?? provider, failure && errorText(failure.error), failure?.detail].filter(Boolean).join(' — ');
        return (
          <span key={provider} className={`agent-icon ${failure ? 'is-failing' : ''}`} title={title}>
            <img src={LOGOS[provider]} alt={title} />
          </span>
        );
      })}
    </span>
  );
}

function Devices({board, now}: {board: Board; now: number}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    call<Device[]>('GET', `/api/boards/${board.id}/devices`).then(setDevices, setError);
  }, [board.id]);
  useEffect(load, [load]);

  const revoke = async (device: Device) => {
    if (!confirm(t('devices.confirmRevoke', {name: device.name}))) return;
    setError(null);
    try {
      await call('DELETE', `/api/boards/${board.id}/devices/${device.id}`);
      load();
    } catch (failure) {
      setError(failure);
    }
  };

  if (!devices) return <ErrorLine error={error} />;
  if (!devices.length) return <p className="admin-empty">{t('devices.empty')}</p>;
  return (
    <div className="table-wrap">
      <ErrorLine error={error} />
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t('devices.device')}</th>
            <th>{t('devices.owner')}</th>
            <th>{t('devices.agents')}</th>
            <th>{t('devices.seen')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {devices.map(device => (
            <tr key={device.id}>
              <td>
                {device.name}
                <small>
                  {device.os} · {t(device.via === 'code' ? 'devices.viaCode' : 'devices.viaToken')}
                </small>
              </td>
              <td>{device.owner}</td>
              <td>
                <Agents device={device} />
              </td>
              <td>{device.lastSeenAt ? ago(device.lastSeenAt, now) : '—'}</td>
              <td>
                {(device.mine || board.role === 'owner') && (
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

function Connect({board, now}: {board: Board; now: number}) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{secret: string; name: string} | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    call<Token[]>('GET', `/api/boards/${board.id}/tokens`).then(setTokens, setError);
  }, [board.id]);
  useEffect(load, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const token = await call<Token & {secret: string}>('POST', `/api/boards/${board.id}/tokens`, {name: name.trim()});
      setCreated({secret: token.secret, name: tokenName(token)});
      setName('');
      load();
    } catch (failure) {
      setError(failure);
    }
  };

  const revoke = async (token: Token) => {
    if (!confirm(t('connect.confirmRevoke', {name: tokenName(token)}))) return;
    setError(null);
    try {
      await call('DELETE', `/api/boards/${board.id}/tokens/${token.id}`);
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
        <p>{rich('connect.tokenText', {flag: <code>--owner</code>})}</p>
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
            <button type="submit" className="button primary">
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
                <small>
                  {token.createdByName} · {token.lastUsedAt ? t('connect.used', {ago: ago(token.lastUsedAt, now)}) : t('connect.unused')}
                </small>
                {(token.mine || board.role === 'owner') && (
                  <button type="button" className="link-button danger" onClick={() => revoke(token)}>
                    {t('connect.revoke')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Members({board}: {board: Board}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    call<Member[]>('GET', `/api/boards/${board.id}/members`).then(setMembers, setError);
  }, [board.id]);

  const create = async () => {
    setError(null);
    try {
      setInvite((await call<{url: string}>('POST', `/api/boards/${board.id}/invites`)).url);
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <div className="connect">
      <ul className="token-list">
        {members.map(m => (
          <li key={m.id}>
            <span>
              <b>{m.name}</b> <span className="mono">{m.email}</span>
            </span>
            <small>{t(m.role === 'owner' ? 'members.owner' : 'members.member')}</small>
          </li>
        ))}
      </ul>
      {board.role === 'owner' && (
        <section className="connect-way">
          <h3>{t('members.invite')}</h3>
          <p>{t('members.inviteText')}</p>
          {invite ? (
            <CopyField value={invite} />
          ) : (
            <button type="button" className="button" onClick={create}>
              {t('members.createLink')}
            </button>
          )}
        </section>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/** Devices, ways to connect new ones, and members of the board on screen. */
export function BoardAdmin({board, tab, onTab, onClose, now}: {board: Board; tab: AdminTab; onTab: (tab: AdminTab) => void; onClose: () => void; now: number}) {
  const tabs: [AdminTab, string][] = [
    ['devices', t('admin.devices')],
    ['connect', t('admin.connect')],
  ];
  if (!board.personal) tabs.push(['members', t('admin.members')]);
  return (
    <Modal title={boardTitle(board)} onClose={onClose} wide>
      <Segmented label={t('admin.sections')} options={tabs} value={tab} onChange={onTab} />
      <div className="dialog-body">
        {tab === 'devices' && <Devices board={board} now={now} />}
        {tab === 'connect' && <Connect board={board} now={now} />}
        {tab === 'members' && !board.personal && <Members board={board} />}
      </div>
    </Modal>
  );
}
