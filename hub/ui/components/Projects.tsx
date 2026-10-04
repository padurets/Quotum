import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {merging,renaming,restoring,shown,timeless,type ProjectGroup,type Projects as ProjectList} from '../lib/projects';
import {call} from '../lib/http';
import {stamp} from '../lib/format';
import {t} from '../i18n';
import {Modal,ErrorLine} from './Kit';
import {Popover} from './Popover';
import {Ago} from './Time';

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

export function ProjectsDialog({onClose}:{onClose:()=>void}) {
  return <Modal title={t('admin.projects')} onClose={onClose} wide><div className="dialog-body"><Projects/></div></Modal>;
}
