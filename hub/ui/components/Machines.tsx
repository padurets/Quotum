import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {stamp} from '../lib/format';
import {PROVIDERS} from '../lib/providers';
import {merging, renaming, restoring, shown, timeless, type ProjectGroup, type Projects as ProjectList} from '../lib/projects';
import {errorText} from '../lib/quota';
import {call} from '../lib/http';
import {logoOf} from './logos';
import {CopyField, ErrorLine, Field, Modal} from './Kit';
import {Popover} from './Popover';
import {rich, t} from '../i18n';
import {Ago} from './Time';
import {ConnectedAccounts,ConnectSource,ConnectionRow} from './Connections';
import type {Session} from '../lib/session';

import type {Credential} from '../../server/store/credentials';

export type ConnectionsStart = 'list' | 'connect';

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
            <img src={logoOf(provider)} alt={title} />
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
  focus = 0,
  save: store,
}: {
  name: string;
  label: string;
  renameLabel: string;
  placeholder?: string;
  maxLength?: number;
  /** Takes the keyboard each time this changes to another number: the row a rename led to. */
  focus?: number;
  save: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Closed, the field gives the keyboard back to the pencil that opened it.
  const pencil = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  useEffect(() => {
    if (name === null && back.current) pencil.current?.focus();
    back.current = false;
  }, [name]);
  useEffect(() => {
    if (focus) pencil.current?.focus();
  }, [focus]);
  const close = () => {
    back.current = true;
    setError(null);
    setName(null);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    // Saved as it was: nothing to store, so a name with spaces at its ends is not changed by trimming.
    if (name === current || name!.trim() === current) return close();
    try {
      await store(name!.trim());
      close();
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
          onKeyDown={event => event.key === 'Escape' && (event.stopPropagation(), close())}
        />
        <button className="button">{t('boards.save')}</button>
        <ErrorLine error={error} />
      </form>
    );
  }
  return (
    <span className="device-name">
      <b title={current}>{current}</b>
      <button ref={pencil} type="button" className="icon-button" aria-label={renameLabel} title={renameLabel} onClick={() => setName(current)}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M10.5 3.5l2 2M3 13l.6-2.6L11 3a1.4 1.4 0 0 1 2 2l-7.4 7.4z" />
        </svg>
      </button>
    </span>
  );
}

/** The reader's devices; on the desktop app's board, its one machine, which cannot be disconnected (it is the app's own agent). */
function Devices({local}: {local: boolean}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [renaming,setRenaming]=useState<Device|null>(null),[name,setName]=useState('');
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

  const rename = async(event:FormEvent) => {
    event.preventDefault();if(!renaming)return;
    try {await call('POST',`/api/devices/${encodeURIComponent(renaming.id)}`,{name:name.trim()});setRenaming(null);load();}catch(failure){setError(failure);}
  };
  return <>
    {error&&<li><ErrorLine error={error}/></li>}
    {devices?.length===0&&<li className="admin-empty">{t(local?'local.devicesEmpty':'devices.empty')}</li>}
    {devices?.map(device=><ConnectionRow key={device.id} name={device.name}
      icon={<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>}
      detail={<><span>{device.os}</span><span className="connection-detail"><Agents device={device}/></span></>}
      status={<span title={device.lastSeenAt?stamp(device.lastSeenAt):undefined}>{device.lastSeenAt?<Ago at={device.lastSeenAt}/>:t('connect.unused')}</span>}
      actions={<><button className="popover-row" onClick={()=>{setError(null);setName(device.name);setRenaming(device);}}><span>{t('connections.rename')}</span></button>{!local&&<button className="popover-row danger" onClick={()=>void revoke(device)}><span>{t('devices.revoke')}</span></button>}</>}
    />)}
    {renaming&&<Modal title={t('devices.rename',{name:renaming.name})} onClose={()=>setRenaming(null)}>
      <form className="dialog-form" onSubmit={rename}><Field label={t('devices.nameLabel')} value={name} maxLength={80} placeholder={renaming.reported} autoFocus onChange={e=>setName(e.target.value)}/><ErrorLine error={error}/><div className="button-row"><button className="button" type="button" onClick={()=>setRenaming(null)}>{t('common.cancel')}</button><button className="button primary">{t('boards.save')}</button></div></form>
    </Modal>}
  </>;
}

/**
 * The projects of the reader's machines, with the machines and when they last worked, which
 * the reader renames, merges and gives back their own names; every change applies to all
 * the time kept. The rules are in ui/lib/projects.ts.
 */
function Projects() {
  const [list, setList] = useState<ProjectList | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [merge, setMerge] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The row a rename led to, chosen in the list that came after it: the keyboard goes there,
  // each time anew (a new number), though it was the same row the time before.
  const [landing, setLanding] = useState<{name: string; n: number} | null>(null);
  const load = useCallback(
    () =>
      call<ProjectList>('GET', '/api/projects').then(
        answer => {
          setList(answer);
          setSelected([]);
          return answer;
        },
        failure => {
          setError(failure);
          return null;
        },
      ),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  /** A change, then the list anew (another tab may have changed it too), which it gives back. */
  const change = async (url: string, body: object) => {
    setError(null);
    setLanding(null);
    let answer: ProjectList | null = null;
    try {
      await call('POST', url, body);
    } finally {
      setMerge(false);
      answer = await load();
    }
    return answer;
  };
  /** A rename, then the keyboard on the first of `names` listed: the new name, or those given back. */
  const rename = async (group: ProjectGroup, name: string) => {
    const answer = await change('/api/projects', renaming(group, name));
    // Given back, each name goes its own way: its own first, where machines reported it.
    const names = name ? [name] : [...group.reported].sort((a, b) => Number(b === group.name) - Number(a === group.name));
    const found = names.find(one => answer?.projects.some(listed => listed.name === one));
    if (found) setLanding(before => ({name: found, n: (before?.n ?? 0) + 1}));
  };
  const failing = (url: string, body: object) => change(url, body).catch(setError);

  if (!list) return <ErrorLine error={error} />;
  if (!list.projects.length) return <p className="admin-empty">{t('projects.empty')}</p>;
  const chosen = list.projects.filter(group => group.name !== null && selected.includes(group.name));
  const toggle = (group: ProjectGroup, on: boolean) => {
    const next = on ? [...selected, group.name!] : selected.filter(name => name !== group.name);
    setSelected(next);
    // The menu goes with its button; chosen again later, it waits to be opened.
    if (next.length < 2) setMerge(false);
  };
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
                        focus={landing?.name === group.name ? landing.n : 0}
                        save={name => rename(group, name)}
                      />
                    )}
                    {from.length > 0 && (
                      <small className="project-froms">
                        <span>{t('projects.from')}</span>
                        {from.map(name => (
                          <span key={name} className="project-from">
                            <span title={name}>{name}</span>
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
                          </span>
                        ))}
                      </small>
                    )}
                  </td>
                  <td>{group.machines.map(machine => machine.name).join(', ') || '—'}</td>
                  <td title={unknown || !group.lastAt ? undefined : stamp(group.lastAt)}>{unknown ? '—' : <Ago at={group.lastAt} />}</td>
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
              <button key={target.name} type="button" className="popover-row" title={target.name!} onClick={() => failing('/api/projects', merging(chosen, target))}>
                <span>{target.name}</span>
              </button>
            ))}
          </Popover>
        </div>
      )}
    </>
  );
}

function ConnectDevice() {
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
    <div className="dialog-form">
        <p>{t('connect.codeText')}</p>
        <CopyField value={`npx quotum connect ${origin()}`} />
      <details className="connection-tokens"><summary>{t('connect.tokenTitle')}</summary><div className="dialog-form">
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
                <small title={token.lastUsedAt ? stamp(token.lastUsedAt) : undefined}>{token.lastUsedAt ? rich('connect.used', {ago: <Ago at={token.lastUsedAt} />}) : t('connect.unused')}</small>
                <button type="button" className="link-button danger" onClick={() => revoke(token)}>
                  {t('connect.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div></details>
    </div>
  );
}

/** Connections belong to the person; projects are managed from agent activity. */
export function ProjectsDialog({onClose}:{onClose:()=>void}) {
  return <Modal title={t('admin.projects')} onClose={onClose} wide><div className="dialog-body"><Projects/></div></Modal>;
}

export function ConnectionsDialog({start,onClose,local,userId,trustedKeys}:{start:ConnectionsStart;onClose:()=>void;local:boolean;userId:string;trustedKeys:Session['trustedKeys']}) {
  const [kind,setKind]=useState<'device'|'openrouter'|null>(local&&start==='connect'?'openrouter':null);
  const [open,setOpen]=useState(start==='connect'&&!local);
  const [replace,setReplace]=useState<Credential|null>(null);
  const back=()=>{setKind(null);setReplace(null);};
  const choose=(next:'device'|'openrouter')=>{setOpen(false);setKind(next);};
  const title=kind==='device'?t('connections.connectDevice'):kind==='openrouter'?t(replace?'sources.replace':'sources.connect'):t('machines.title');
  return <Modal key={kind??'list'} title={title} onClose={onClose} wide={!kind}>
    {kind?<div className="dialog-form">
      <button type="button" className="link-button connection-back" onClick={back}>← {t('connections.back')}</button>
      {kind==='device'?<ConnectDevice/>:<ConnectSource userId={userId} local={local} trustedKeys={trustedKeys} replace={replace} onClose={back}/>}
    </div>:<div className="dialog-body">
      <div className="connections-toolbar">{local?<button className="button primary" onClick={()=>choose('openrouter')}>{t('admin.connect')}</button>:<Popover label={t('admin.connect')} trigger={t('admin.connect')} triggerClass="button primary" open={open} onOpenChange={setOpen} align="left">
        <button className="popover-row" onClick={()=>choose('device')}><span>{t('connections.device')}</span></button>
        <button className="popover-row" onClick={()=>choose('openrouter')}><span>OpenRouter</span></button>
      </Popover>}</div>
      <ul className="connections-list"><Devices local={local}/><ConnectedAccounts userId={userId} trustedKeys={trustedKeys} onReplace={record=>{setReplace(record);choose('openrouter');}}/></ul>
    </div>}
  </Modal>;
}
