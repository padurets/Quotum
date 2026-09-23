import {useCallback, useEffect, useState} from 'react';
import {PROVIDERS} from '../lib/providers';
import {call} from '../lib/http';
import {boardTitle, type Board} from '../lib/session';
import {LOGOS} from './logos';
import {CopyField, ErrorLine, Modal, Segmented} from './Kit';
import {SwitchRow} from './Popover';
import {t} from '../i18n';

export type BoardTab = 'shares' | 'members';

type Shares = {
  shared: {source: string; provider: string; sharedBy: string; mine: boolean}[];
  mine: {source: string; provider: string; shared: boolean; devices: string[]}[];
};
type Member = {id: string; name: string; email: string; role: 'owner' | 'member'};

const providerName = (provider: string) => PROVIDERS[provider]?.name ?? provider;
const Logo = ({provider}: {provider: string}) => <img className="share-logo" src={LOGOS[provider]} alt="" />;

/**
 * What a shared board shows and what the reader could add to it. Everyone shares what
 * their own devices measure; the board's owner, or whoever shared a card, takes it off.
 */
function SharesTab({board, titles, onChanged}: {board: Board; titles: Map<string, string>; onChanged: () => void}) {
  const [shares, setShares] = useState<Shares | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    call<Shares>('GET', `/api/boards/${encodeURIComponent(board.id)}/shares`).then(setShares, setError);
  }, [board.id]);
  useEffect(load, [load]);

  const change = async (source: string, share: boolean) => {
    setError(null);
    try {
      const path = `/api/boards/${encodeURIComponent(board.id)}/shares`;
      await (share ? call('POST', path, {source}) : call('DELETE', `${path}/${encodeURIComponent(source)}`));
      load();
      onChanged();
    } catch (failure) {
      setError(failure);
    }
  };

  if (!shares) return <ErrorLine error={error} />;
  return (
    <div className="connect">
      <section className="connect-way">
        <h3>{t('shares.onBoard')}</h3>
        {shares.shared.length ? (
          <ul className="token-list">
            {shares.shared.map(s => (
              <li key={s.source}>
                <span className="share-name">
                  <Logo provider={s.provider} />
                  <b>{titles.get(s.source) ?? providerName(s.provider)}</b>
                </span>
                <small>{s.sharedBy && t('shares.sharedBy', {name: s.sharedBy})}</small>
                {(board.role === 'owner' || s.mine) && (
                  <button type="button" className="link-button danger" onClick={() => change(s.source, false)}>
                    {t('shares.remove')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('shares.none')}</p>
        )}
      </section>
      <section className="connect-way">
        <h3>{t('shares.mine')}</h3>
        <p>{t('shares.mineText')}</p>
        {shares.mine.length ? (
          <div className="share-switches">
            {shares.mine.map(s => (
              <SwitchRow key={s.source} on={s.shared} onChange={on => change(s.source, on)} value={s.devices.join(', ') || undefined}>
                <span className="share-name">
                  <Logo provider={s.provider} />
                  {providerName(s.provider)}
                </span>
              </SwitchRow>
            ))}
          </div>
        ) : (
          <p className="admin-empty">{t('shares.mineEmpty')}</p>
        )}
      </section>
      <ErrorLine error={error} />
    </div>
  );
}

function MembersTab({board, userId, onChanged}: {board: Board; userId: string; onChanged: () => void}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState<string | null>(null);
  const [reset, setReset] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const owner = board.role === 'owner';
  const load = useCallback(() => {
    call<Member[]>('GET', `/api/boards/${encodeURIComponent(board.id)}/members`).then(setMembers, setError);
  }, [board.id]);
  useEffect(load, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure);
    }
  };
  const remove = (member: Member) =>
    confirm(t('members.confirmRemove', {name: member.name})) &&
    run(async () => {
      await call('DELETE', `/api/boards/${encodeURIComponent(board.id)}/members/${encodeURIComponent(member.id)}`);
      load();
      onChanged();
    });
  const create = () => run(async () => setInvite((await call<{url: string}>('POST', `/api/boards/${encodeURIComponent(board.id)}/invites`)).url));
  const revoke = () =>
    confirm(t('members.confirmReset')) &&
    run(async () => {
      await call('DELETE', `/api/boards/${encodeURIComponent(board.id)}/invites`);
      setInvite(null);
      setReset(true);
    });

  return (
    <div className="connect">
      <ul className="token-list">
        {members.map(m => (
          <li key={m.id}>
            <span>
              <b>{m.name}</b> <span className="mono">{m.email}</span>
            </span>
            <small>{t(m.role === 'owner' ? 'members.owner' : 'members.member')}</small>
            {owner && m.role !== 'owner' && m.id !== userId && (
              <button type="button" className="link-button danger" onClick={() => remove(m)}>
                {t('members.remove')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {owner && (
        <section className="connect-way">
          <h3>{t('members.invite')}</h3>
          <p>{t('members.inviteText')}</p>
          {invite ? (
            <CopyField value={invite} />
          ) : (
            <div className="button-row is-start">
              <button type="button" className="button" onClick={create}>
                {t('members.createLink')}
              </button>
              <button type="button" className="link-button danger" onClick={revoke}>
                {t('members.resetLinks')}
              </button>
            </div>
          )}
          {reset && <p className="drawer-done">{t('members.linksReset')}</p>}
        </section>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/** A shared board's people and what they share with it. */
export function BoardDialog({
  board,
  userId,
  tab,
  titles,
  onTab,
  onClose,
  onChanged,
}: {
  board: Board;
  userId: string;
  tab: BoardTab;
  /** The cards' names on the board, for what is shared already. */
  titles: Map<string, string>;
  onTab: (tab: BoardTab) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <Modal title={boardTitle(board)} onClose={onClose} wide>
      <Segmented
        label={t('admin.sections')}
        options={[
          ['shares', t('shares.title')],
          ['members', t('admin.members')],
        ]}
        value={tab}
        onChange={onTab}
      />
      <div className="dialog-body">
        {tab === 'shares' && <SharesTab board={board} titles={titles} onChanged={onChanged} />}
        {tab === 'members' && <MembersTab board={board} userId={userId} onChanged={onChanged} />}
      </div>
    </Modal>
  );
}
