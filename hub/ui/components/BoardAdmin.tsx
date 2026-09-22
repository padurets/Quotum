import React, {useCallback, useEffect, useState} from 'react';
import {ago} from '../lib/format';
import {PROVIDERS} from '../lib/providers';
import {call, messageOf, type Board} from '../lib/session';
import {CopyField, ErrorLine, Field, Modal, Tabs} from './Kit';

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
  sources: {provider: string; source: string; seenAt: number}[];
};
type Token = {id: string; name: string; hint: string; createdByName: string; createdAt: number; lastUsedAt: number | null};
type Member = {id: string; name: string; email: string; role: 'owner' | 'member'};

const origin = () => location.origin;

function Devices({board, now}: {board: Board; now: number}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    call<Device[]>('GET', `/api/boards/${board.id}/devices`).then(setDevices, failure => setError(messageOf(failure)));
  }, [board.id]);
  useEffect(load, [load]);

  const revoke = async (device: Device) => {
    if (!confirm(`Отключить ${device.name}? Оно перестанет присылать данные на эту доску.`)) return;
    try {
      await call('DELETE', `/api/boards/${board.id}/devices/${device.id}`);
      load();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  if (!devices) return <ErrorLine message={error} />;
  if (!devices.length) return <p className="admin-empty">Пока ни одного устройства. Подключите первое на вкладке «Подключить».</p>;
  return (
    <div className="table-wrap">
      <ErrorLine message={error} />
      <table className="admin-table">
        <thead>
          <tr>
            <th>Устройство</th>
            <th>Владелец</th>
            <th>Агенты</th>
            <th>На связи</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {devices.map(device => (
            <tr key={device.id}>
              <td>
                {device.name}
                <small>
                  {device.os} · {device.via === 'code' ? 'по коду' : 'по токену'}
                </small>
              </td>
              <td>{device.owner}</td>
              <td>
                <span className="agent-icons">
                  {device.sources.length
                    ? device.sources.map(s => <img key={s.provider} src={PROVIDERS[s.provider]?.icon} alt={PROVIDERS[s.provider]?.name ?? s.provider} title={PROVIDERS[s.provider]?.name} />)
                    : '—'}
                </span>
              </td>
              <td>{device.lastSeenAt ? ago(device.lastSeenAt, now) : '—'}</td>
              <td>
                <button className="link-button danger" onClick={() => revoke(device)}>
                  Отключить
                </button>
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
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    call<Token[]>('GET', `/api/boards/${board.id}/tokens`).then(setTokens, failure => setError(messageOf(failure)));
  }, [board.id]);
  useEffect(load, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const token = await call<Token & {secret: string}>('POST', `/api/boards/${board.id}/tokens`, {name: name.trim() || 'Автоматика'});
      setCreated({secret: token.secret, name: token.name});
      setName('');
      load();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const revoke = async (token: Token) => {
    if (!confirm(`Отозвать токен «${token.name}»? Устройства, подключённые по нему, перестанут присылать данные.`)) return;
    try {
      await call('DELETE', `/api/boards/${board.id}/tokens/${token.id}`);
      if (created) setCreated(null);
      load();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  return (
    <div className="connect">
      <section className="connect-way">
        <h3>Своя машина — по одноразовому коду</h3>
        <p>Запустите на машине, где работают агенты. Команда покажет код — подтвердите его в браузере, и устройство будет присылать лимиты от вашего имени.</p>
        <CopyField value={`agent-limits connect ${origin()}`} />
      </section>

      <section className="connect-way">
        <h3>Много машин — токен доски</h3>
        <p>
          Для образов, виртуальных машин и контейнеров: пропишите токен один раз, и каждая запущенная машина сама появится на доске. Машины
          принадлежат тому, кто создал токен; если токен общий на несколько человек, передавайте владельца через <code>--owner</code> (имя или
          почта участника доски).
        </p>
        {created ? (
          <div className="token-created">
            <CopyField label={`Токен «${created.name}» — показывается один раз`} value={created.secret} secret />
            <CopyField label="Запуск" value={`agent-limits run --hub ${origin()} --token ${created.secret}`} />
            <button className="link-button" onClick={() => setCreated(null)}>
              Готово
            </button>
          </div>
        ) : (
          <form className="inline-form" onSubmit={create}>
            <Field label="Название" placeholder="например, «Образы разработки»" value={name} onChange={e => setName(e.target.value)} maxLength={80} />
            <button className="button primary">Создать токен</button>
          </form>
        )}
        <ErrorLine message={error} />
        {tokens.length > 0 && (
          <ul className="token-list">
            {tokens.map(token => (
              <li key={token.id}>
                <span>
                  <b>{token.name}</b> <span className="mono">{token.hint}</span>
                </span>
                <small>
                  {token.createdByName} · {token.lastUsedAt ? `использован ${ago(token.lastUsedAt, now)}` : 'ещё не использован'}
                </small>
                <button className="link-button danger" onClick={() => revoke(token)}>
                  Отозвать
                </button>
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
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<Member[]>('GET', `/api/boards/${board.id}/members`).then(setMembers, failure => setError(messageOf(failure)));
  }, [board.id]);

  const create = async () => {
    try {
      setInvite((await call<{url: string}>('POST', `/api/boards/${board.id}/invites`)).url);
    } catch (failure) {
      setError(messageOf(failure));
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
            <small>{m.role === 'owner' ? 'владелец' : 'участник'}</small>
          </li>
        ))}
      </ul>
      <section className="connect-way">
        <h3>Пригласить</h3>
        <p>Ссылка действует неделю и подходит нескольким людям. Участники видят лимиты друг друга и могут подключать устройства.</p>
        {invite ? (
          <CopyField value={invite} />
        ) : (
          <button className="button" onClick={create}>
            Создать ссылку
          </button>
        )}
        <ErrorLine message={error} />
      </section>
    </div>
  );
}

/** Devices, ways to connect new ones, and members of the board on screen. */
export function BoardAdmin({board, tab, onTab, onClose, now}: {board: Board; tab: AdminTab; onTab: (tab: AdminTab) => void; onClose: () => void; now: number}) {
  const tabs: [AdminTab, string][] = [
    ['devices', 'Устройства'],
    ['connect', 'Подключить'],
  ];
  if (!board.personal) tabs.push(['members', 'Участники']);
  return (
    <Modal title={board.name} onClose={onClose} wide>
      <Tabs label="Разделы доски" tabs={tabs} value={tab} onChange={onTab} />
      <div className="dialog-body">
        {tab === 'devices' && <Devices board={board} now={now} />}
        {tab === 'connect' && <Connect board={board} now={now} />}
        {tab === 'members' && !board.personal && <Members board={board} />}
      </div>
    </Modal>
  );
}
