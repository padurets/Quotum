import {useCallback, useEffect, useRef, useState} from 'react';
import {PROVIDERS} from '../lib/providers';
import {ApiError, call} from '../lib/http';
import {rereadSession, type Board} from '../lib/session';
import {useConnectionsRevision,useTitles} from '../lib/board';
import {logoOf} from './logos';
import {CopyField, ErrorLine} from './Kit';
import {t} from '../i18n';
import type {BudgetAccess} from '../../server/domain/resources';

type SessionDevice={id:string;name:string;disconnected:boolean;enabled:boolean;since:number|null;revision:string};
type Shares = {
  sessionDevices?:SessionDevice[];
  shared: {source: string; provider: string; sharedBy: string; mine: boolean;budget?:BudgetAccess}[];
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
export function SharesTab({board,userId=''}:{board:Board;userId?:string}) {
  const revision=useConnectionsRevision();
  const reading=useRef<AbortController|null>(null);
  const titles = useTitles();
  const [shares, setShares] = useState<Shares | null>(null);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const budgetRequest = useRef<object|null>(null);
  const [pending,setPending]=useState<string|null>(null);
  const failed = (failure: unknown) => {
    if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
      generation.current++;
      budgetRequest.current=null;
      setPending(null);
      reading.current?.abort();setShares(null);
      rereadSession();
    }
    setError(failure);
  };
  const load=useCallback(()=>{
    reading.current?.abort();const abort=new AbortController();reading.current=abort;
    const own=++generation.current;
    call<Shares>('GET',`/api/boards/${encodeURIComponent(board.id)}/shares`,undefined,12_000,abort.signal).then(
      value=>{if(!abort.signal.aborted&&own===generation.current)setShares(value);},
      failure=>{if(!abort.signal.aborted&&own===generation.current)failed(failure);},
    );
  },[board.id,userId]);
  useEffect(()=>{setShares(null);setPending(null);setError(null);budgetRequest.current=null;load();return()=>{generation.current++;budgetRequest.current=null;reading.current?.abort();};},[load]);
  const seenRevision=useRef(revision);
  useEffect(()=>{if(seenRevision.current!==revision){seenRevision.current=revision;load();}},[load,revision]);

  const mutate=async(method:'POST'|'PUT'|'DELETE',path:string,body?:object,item?:string)=>{
    if(budgetRequest.current)return;
    const own={};budgetRequest.current=own;setPending(item??path);setError(null);
    try{await call(method,path,body);}
    catch(failure){if(budgetRequest.current===own){if(failure instanceof ApiError&&failure.status===404&&failure.code!=='board_not_found'&&item)setError(failure);else failed(failure);}}
    finally{if(budgetRequest.current===own){budgetRequest.current=null;setPending(null);load();}}
  };
  const change=(source:string,share:boolean)=>{
    const path=`/api/boards/${encodeURIComponent(board.id)}/shares`;
    return mutate(share?'POST':'DELETE',share?path:`${path}/${encodeURIComponent(source)}`,share?{source}:undefined,source);
  };
  const budget=(source:string,enabled:boolean,expectedRevision:string)=>mutate('PUT',`/api/boards/${encodeURIComponent(board.id)}/shares/${encodeURIComponent(source)}/budget`,{enabled,expectedRevision},source);
  const sessions=(device:SessionDevice,enabled:boolean)=>mutate('PUT',`/api/boards/${encodeURIComponent(board.id)}/shares/devices/${encodeURIComponent(device.id)}/sessions`,{enabled,expectedRevision:device.revision},device.id);
  if (!shares) return <ErrorLine error={error} />;
  return (
    <>
      <section className="settings-section">
        <h2>{t('shares.subscriptions')}</h2>
        {shares.shared.some(s=>s.mine&&s.provider==='codex')&&<p className="dialog-text">{t('shares.budgetHelp')}</p>}
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
                  {s.mine&&s.provider==='codex'&&s.budget&&<label title={t('shares.budgetHelp')}><input type="checkbox" checked={s.budget.enabled} disabled={pending!==null} onChange={event=>void budget(s.source,event.target.checked,s.budget!.revision)}/>{t('shares.includeBudget')}</label>}
                  {(board.role === 'owner' || s.mine) && (
                    <button type="button" className="button" disabled={pending!==null} onClick={()=>void change(s.source,false)}>
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
      <section className="settings-section">
        <h2>{t('shares.sessionDevices')}</h2>
        <p className="dialog-text">{t('shares.sessionDevicesHelp')}</p>
        {shares.sessionDevices?.length?<ul className="settings-list">{shares.sessionDevices.map(device=><li key={device.id} className="popover-row settings-list-row">
          <span className="settings-item-main"><b>{device.name}</b></span>
          <small className="settings-item-detail">{device.disconnected?t('shares.disconnected'):null}</small>
          <div className="settings-item-actions"><label><input type="checkbox" checked={device.enabled} disabled={pending!==null} onChange={event=>void sessions(device,event.target.checked)}/>{t('shares.deviceSessions')}</label></div>
        </li>)}</ul>:<p className="dialog-text">{t('shares.noDevices')}</p>}
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
