import {useState, type FormEvent} from 'react';
import {call} from '../lib/http';
import {clock} from '../lib/format';
import {setPrefs, usePrefs} from '../lib/prefs';
import type {TrackerHealth} from '../lib/resets';
import type {User} from '../lib/session';
import {known, rich, t} from '../i18n';
import {ErrorLine, Field, LanguageSelect, Modal} from './Kit';
import {SwitchRow} from './Popover';

type Status = {busy?: boolean; done?: boolean; error?: unknown};

/**
 * These forms change the account; nothing is filled in by the browser or a password
 * manager. Browsers ignore `off` on password fields but leave `new-password` empty.
 */
const blank = {autoComplete: 'off', 'data-1p-ignore': '', 'data-lpignore': 'true'};
const blankPassword = {...blank, autoComplete: 'new-password'};

/** Name and email; a new email needs the current password. */
function Profile({user, onChanged}: {user: User; onChanged: () => Promise<void>}) {
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
function Password() {
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

/** What this browser keeps for itself: the language and reset announcements. */
function Browser({trackers}: {trackers: TrackerHealth[]}) {
  const prefs = usePrefs();
  return (
    <section className="drawer-section">
      <h3>{t('account.browser')}</h3>
      <div className="field">
        {/* The select carries its own label for screen readers. */}
        <span aria-hidden="true">{t('common.language')}</span>
        <LanguageSelect />
      </div>
      <div className="drawer-switch">
        <SwitchRow on={prefs.showResets} onChange={on => setPrefs({showResets: on})}>
          {t('settings.resets')}
        </SwitchRow>
        {prefs.showResets && (
          <div className="trackers">
            {trackers.map(tracker => (
              <div key={tracker.name} className="tracker" title={tracker.at ? t('settings.checkedAt', {time: clock(tracker.at)}) : ''}>
                <i className={`dot ${tracker.ok === true ? 'dot-ok' : tracker.ok === false ? 'dot-warn' : 'dot-idle'}`} />
                <a href={tracker.url} target="_blank" rel="noopener noreferrer">
                  {tracker.name}
                </a>
                <span>{trackerDetail(tracker.detail)}</span>
              </div>
            ))}
          </div>
        )}
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

const SignOutIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11l3-3-3-3M13.5 8H6" />
  </svg>
);

/** The person's own things, in a panel on the side: who is signed in (and signing out), profile, password, this browser's settings. */
export function AccountPanel({
  user,
  trackers,
  onChanged,
  onSignedOut,
  onClose,
}: {
  user: User;
  trackers: TrackerHealth[];
  onChanged: () => Promise<void>;
  onSignedOut: () => void;
  onClose: () => void;
}) {
  const signOut = async () => {
    await call('POST', '/api/auth/logout').catch(() => {});
    onSignedOut();
  };
  return (
    <Modal title={t('account.title')} onClose={onClose} side>
      <div className="account-card">
        <span className="avatar is-large">{user.name.slice(0, 1).toUpperCase()}</span>
        <div>
          <b>{user.name}</b>
          <span>{user.email}</span>
        </div>
        <button type="button" className="sign-out" onClick={signOut}>
          <SignOutIcon />
          {t('account.signOut')}
        </button>
      </div>
      <Profile user={user} onChanged={onChanged} />
      <Password />
      <Browser trackers={trackers} />
    </Modal>
  );
}
