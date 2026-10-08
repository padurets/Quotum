import {useEffect, useState, type FormEvent} from 'react';
import {call} from '../lib/http';
import {stamp} from '../lib/format';
import {setPrefs, usePrefs} from '../lib/prefs';
import type {TrackerHealth} from '../lib/resets';
import type {User} from '../lib/session';
import {known, rich, t} from '../i18n';
import {ErrorLine, Field, LanguageSelect} from './Kit';
import {SwitchRow} from './Popover';

type Status = {busy?: boolean; done?: boolean; error?: unknown};

/**
 * These forms change the account; nothing is filled in by the browser or a password
 * manager. Browsers ignore `off` on password fields but leave `new-password` empty.
 */
const blank = {autoComplete: 'off', 'data-1p-ignore': '', 'data-lpignore': 'true'};
const blankPassword = {...blank, autoComplete: 'new-password'};

/** Name and email; a new email needs the current password. */
export function Profile({user, onChanged}: {user: User; onChanged: () => Promise<void>}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>({});
  const newEmail = email.trim().toLowerCase() !== user.email;
  const changed = name.trim() !== user.name || newEmail;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setStatus({busy: true});
    try {
      await call('POST', '/api/account', {name: name.trim(), ...(newEmail ? {email: email.trim(), currentPassword: password} : {})});
      setPassword('');
      await onChanged();
      setStatus({done: true});
    } catch (error) {
      setStatus({error});
    }
  };

  return (
    <form className="drawer-section" onSubmit={save}>
      <h3>{t('account.profile')}</h3>
      <Field label={t('auth.name')} hint={t('auth.nameHint')} value={name} maxLength={80} required {...blank} onChange={e => (setName(e.target.value), setStatus({}))} />
      <Field label={t('auth.email')} type="email" value={email} required {...blank} onChange={e => (setEmail(e.target.value), setStatus({}))} />
      {newEmail && (
        <Field
          label={t('account.currentPassword')}
          hint={t('account.currentPasswordHint')}
          type="password"
          value={password}
          required
          {...blankPassword}
          onChange={e => setPassword(e.target.value)}
        />
      )}
      <ErrorLine error={status.error} />
      <div className="drawer-actions">
        {status.done && <span className="drawer-done">{t('account.saved')}</span>}
        <button className="button" disabled={!changed || status.busy}>
          {t('account.save')}
        </button>
      </div>
    </form>
  );
}

/** A new password; every other session of the person ends with the old one. */
export function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [status, setStatus] = useState<Status>({});

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setStatus({busy: true});
    try {
      await call('POST', '/api/account', {password: next, currentPassword: current});
      setCurrent('');
      setNext('');
      setStatus({done: true});
    } catch (error) {
      setStatus({error});
    }
  };

  return (
    <form className="drawer-section" onSubmit={save}>
      <h3>{t('account.password')}</h3>
      <Field label={t('account.currentPassword')} type="password" value={current} required {...blankPassword} onChange={e => (setCurrent(e.target.value), setStatus({}))} />
      <Field
        label={t('account.newPassword')}
        hint={t('auth.passwordHint')}
        type="password"
        value={next}
        required
        minLength={8}
        {...blankPassword}
        onChange={e => (setNext(e.target.value), setStatus({}))}
      />
      <ErrorLine error={status.error} />
      <div className="drawer-actions">
        {status.done && <span className="drawer-done">{t('account.passwordChanged')}</span>}
        <button className="button" disabled={!current || next.length < 8 || status.busy}>
          {t('account.changePassword')}
        </button>
      </div>
    </form>
  );
}

/** The hub reports tracker health as codes; an HTTP status is shown as is. */
function trackerDetail(detail: string) {
  const key = `tracker.${detail}`;
  return known(key) ? t(key) : detail;
}

/** How each tracker answered when last asked, read when shown: when it was checked changes every round, and nothing else here needs it. */
function Trackers() {
  const [trackers, setTrackers] = useState<TrackerHealth[]>([]);
  useEffect(() => {
    let shown = true;
    call<{trackers: TrackerHealth[]}>('GET', '/api/resets', undefined, 10_000).then(
      answer => shown && setTrackers(answer.trackers),
      () => {},
    );
    return () => void (shown = false);
  }, []);
  return (
    <div className="trackers">
      {trackers.map(tracker => (
        <div key={tracker.name} className="tracker" title={tracker.at ? t('settings.checkedAt', {time: stamp(tracker.at)}) : ''}>
          <i className={`dot ${tracker.ok === true ? 'dot-ok' : tracker.ok === false ? 'dot-warn' : 'dot-idle'}`} />
          <a href={tracker.url} target="_blank" rel="noopener noreferrer">
            {tracker.name}
          </a>
          <span>{trackerDetail(tracker.detail)}</span>
        </div>
      ))}
    </div>
  );
}

/** What this browser (or the app's window) keeps for itself: the language and reset announcements. */
export function Browser({title}: {title: string}) {
  const prefs = usePrefs();
  return (
    <section className="drawer-section">
      <h3>{title}</h3>
      <div className="field">
        {/* The select carries its own label for screen readers. */}
        <span aria-hidden="true">{t('common.language')}</span>
        <LanguageSelect />
      </div>
      <div className="drawer-switch">
        <SwitchRow on={prefs.showResets} onChange={on => setPrefs({showResets: on})}>
          {t('settings.resets')}
        </SwitchRow>
        {prefs.showResets && <Trackers />}
        <p className="drawer-note">
          {rich('settings.resetsNote', {
            claude: (
              <a href="https://claude-resets.com/" target="_blank" rel="noopener noreferrer">
                Claude Resets
              </a>
            ),
            codex: (
              <a href="https://codex-resets.com/" target="_blank" rel="noopener noreferrer">
                Codex Resets
              </a>
            ),
          })}
        </p>
      </div>
    </section>
  );
}
