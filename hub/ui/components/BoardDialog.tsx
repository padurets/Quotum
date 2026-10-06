import {useCallback, useEffect, useRef, useState} from 'react';
import {PROVIDERS} from '../lib/providers';
import {ApiError, call} from '../lib/http';
import {rereadSession, type Board} from '../lib/session';
import {useTitles} from '../lib/board';
import {logoOf} from './logos';
import {CopyField, ErrorLine} from './Kit';
import {t} from '../i18n';

type Shares = {
  shared: {source: string; provider: string; sharedBy: string; mine: boolean}[];
  mine: {source: string; provider: string; shared: boolean; devices: string[]}[];
};
type Member = {id: string; name: string; email: string; role: 'owner' | 'member'};

const providerName = (provider: string) => PROVIDERS[provider]?.name ?? provider;
const Logo = ({provider}: {provider: string}) => <img className="share-logo" src={logoOf(provider)} alt="" />;

/**
 * What a shared board shows and what the reader could add to it. Everyone shares what
 * their own devices measure; the board's owner, or whoever shared a card, takes it off.
 * The board shows the change when the hub tells it.
 */
export function SharesTab({board}: {board: Board}) {
  const titles = useTitles();
  const [shares, setShares] = useState<Shares | null>(null);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const failed = (failure: unknown) => {
    if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {setShares(null); rereadSession();}
    setError(failure);
  };
  const load = useCallback(() => {
    const own = ++generation.current;
    call<Shares>('GET', `/api/boards/${encodeURIComponent(board.id)}/shares`).then(value => {if (own === generation.current) setShares(value);}, failure => {if (own === generation.current) failed(failure);});
  }, [board.id]);
  useEffect(() => {setShares(null); load(); return () => {generation.current++;};}, [load]);

  const change = async (source: string, share: boolean) => {
    setError(null);
    try {
      const path = `/api/boards/${encodeURIComponent(board.id)}/shares`;
      await (share ? call('POST', path, {source}) : call('DELETE', `${path}/${encodeURIComponent(source)}`));
      load();
    } catch (failure) {
      failed(failure);
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
                  <b>{titles[s.source]?.title ?? providerName(s.provider)}</b>
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
      <ErrorLine error={error} />
    </div>
  );
}

export function MembersTab({board, userId}: {board: Board; userId: string}) {
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
