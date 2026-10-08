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
  mine: {source: string; provider: string; shared: boolean; devices: string[]; accountLabel?: string}[];
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
    if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
      generation.current++;
      setShares(null);
      rereadSession();
    }
    setError(failure);
  };
  const load = useCallback(() => {
    const own = ++generation.current;
    call<Shares>('GET', `/api/boards/${encodeURIComponent(board.id)}/shares`).then(
      value => {if (own === generation.current) setShares(value);},
      failure => {if (own === generation.current) failed(failure);},
    );
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
    <>
      <section className="settings-section">
        <h2>{t('boardSettings.data')}</h2>
        {shares.shared.length ? (
          <ul className="settings-list">
            {shares.shared.map(s => (
              <li key={s.source} className="popover-row settings-list-row">
                <span className="settings-item-main share-name">
                  <Logo provider={s.provider} />
                  <b>{titles[s.source]?.title ?? providerName(s.provider)}</b>
                </span>
                <small className="settings-item-detail">{s.sharedBy && t('shares.sharedBy', {name: s.sharedBy})}</small>
                <div className="settings-item-actions">
                  {(board.role === 'owner' || s.mine) && (
                    <button type="button" className="button" onClick={() => change(s.source, false)}>
                      {t('shares.remove')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dialog-text">{t('shares.none')}</p>
        )}
      </section>
      <ErrorLine error={error} />
    </>
  );
}

export function MembersTab({board, userId}: {board: Board; userId: string}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState<string | null>(null);
  const [reset, setReset] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [allowed, setAllowed] = useState(true);
  const generation = useRef(0);
  const failed = (failure: unknown) => {
    if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
      generation.current++;
      setMembers([]);
      setInvite(null);
      setReset(false);
      setAllowed(false);
      rereadSession();
    }
    setError(failure);
  };
  const owner = board.role === 'owner';
  const load = useCallback(() => {
    const own = ++generation.current;
    call<Member[]>('GET', `/api/boards/${encodeURIComponent(board.id)}/members`).then(
      value => {
        if (own === generation.current) {
          setMembers(value);
          setAllowed(true);
          setError(null);
        }
      },
      failure => {if (own === generation.current) failed(failure);},
    );
  }, [board.id]);
  useEffect(() => {
    setMembers([]);
    setInvite(null);
    setAllowed(true);
    load();
    return () => {generation.current++;};
  }, [load]);

  const run = async <T,>(work: () => Promise<T>, apply: (value: T) => void) => {
    const own = generation.current;
    setError(null);
    try {
      const value = await work();
      if (own === generation.current) apply(value);
    } catch (failure) {
      if (own === generation.current) failed(failure);
    }
  };
  const remove = (member: Member) =>
    confirm(t('members.confirmRemove', {name: member.name})) &&
    run(() => call('DELETE', `/api/boards/${encodeURIComponent(board.id)}/members/${encodeURIComponent(member.id)}`), () => load());
  const create = () => run(() => call<{url: string}>('POST', `/api/boards/${encodeURIComponent(board.id)}/invites`), value => setInvite(value.url));
  const revoke = () =>
    confirm(t('members.confirmReset')) &&
    run(() => call('DELETE', `/api/boards/${encodeURIComponent(board.id)}/invites`), () => {
      setInvite(null);
      setReset(true);
    });

  if (!allowed) return <ErrorLine error={error} />;

  return (
    <>
      <section className="settings-section">
        <h2>{t('admin.members')}</h2>
        <ul className="settings-list">
          {members.map(m => (
            <li key={m.id} className="popover-row settings-list-row">
              <div className="settings-item-main">
                <b>{m.name}</b>
                <small>{m.email}</small>
              </div>
              <small className="settings-item-detail">{t(m.role === 'owner' ? 'members.owner' : 'members.member')}</small>
              <div className="settings-item-actions">
                {owner && m.role !== 'owner' && m.id !== userId && (
                  <button type="button" className="button" onClick={() => remove(m)}>
                    {t('members.remove')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {owner && (
        <section className="settings-section">
          <h2>{t('members.invite')}</h2>
          <p className="dialog-text">{t('members.inviteText')}</p>
          {invite ? (
            <CopyField value={invite} />
          ) : (
            <div className="button-row is-start is-wrap">
              <button type="button" className="button" onClick={create}>
                {t('members.createLink')}
              </button>
              <button type="button" className="button" onClick={revoke}>
                {t('members.resetLinks')}
              </button>
            </div>
          )}
          {reset && <p className="drawer-done">{t('members.linksReset')}</p>}
        </section>
      )}
      <ErrorLine error={error} />
    </>
  );
}
