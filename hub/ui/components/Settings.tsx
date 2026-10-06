import {useEffect, useState, type FormEvent, type ReactNode} from 'react';
import {t, type Key} from '../i18n';
import {call} from '../lib/http';
import {navigate, settingsHref, useLocation} from '../lib/router';
import {boardTitle, rereadSession, type Board, type Session, type User} from '../lib/session';
import {inApp, settingsSections, type AppState} from '../lib/app';
import {useApp} from '../lib/board';
import {Profile, Password, Browser} from './Account';
import {Devices, ConnectDevice} from './Machines';
import {Projects} from './Projects';
import {SharesTab, MembersTab} from './BoardDialog';
import {AppSection, Measuring} from './Desktop';
import {DeleteBoard} from './Header';
import {ErrorLine, Field} from './Kit';
import {ConnectionsPage} from './WidgetAdd';

type Section = {id: string; title: Key};
const PERSONAL: Section[] = [
  {id: 'profile', title: 'settings.profile'}, {id: 'connections', title: 'settings.connections'},
  {id: 'devices', title: 'connections.device'}, {id: 'projects', title: 'projects.manage'},
  {id: 'interface', title: 'settings.interface'}, {id: 'application', title: 'settings.application'},
];
const BOARD: Section[] = [{id: 'general', title: 'boardSettings.general'}, {id: 'members', title: 'admin.members'}, {id: 'data', title: 'boardSettings.data'}];

function SettingsFrame({title, sections, section, base, board, children}: {
  title: string; sections: Section[]; section: string; base: string; board: Board | null; children: ReactNode;
}) {
  const returnTo = settingsHref('/', board?.id);
  return <main className="settings-page">
    <div className="settings-heading"><a href={returnTo} onClick={event => {event.preventDefault(); navigate(returnTo);}}>← {t('settings.back', {board: board ? boardTitle(board) : t('boards.personalName')})}</a><h1>{title}</h1></div>
    <div className="settings-layout"><nav className="settings-nav" aria-label={title}>
      {sections.map(item => {const href = settingsHref(base + '/' + item.id, board?.id); return <a key={item.id} href={href} aria-current={section === item.id ? 'page' : undefined} onClick={event => {event.preventDefault(); navigate(href);}}>{t(item.title)}</a>;})}
    </nav><section key={section} className="panel settings-content">
      {sections.some(item => item.id === section) ? children : <p>{t('settings.unavailable')}</p>}
    </section></div>
  </main>;
}

function General({board}: {board: Board}) {
  const [name, setName] = useState(board.name), [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { await call('POST', '/api/boards/' + board.id, {name: name.trim()}); rereadSession(); }
    catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const leave = async () => {
    if (!confirm(t('boards.confirmLeave', {board: boardTitle(board)}))) return;
    try { await call('POST', '/api/boards/' + board.id + '/leave'); rereadSession(); navigate('/'); }
    catch (failure) { setError(failure); }
  };
  return <div className="dialog-form"><h2>{t('boardSettings.general')}</h2><p className="dialog-text">{t(board.personal ? 'boardSettings.personal' : 'boardSettings.shared')}</p>
    <form className="dialog-form" onSubmit={save}><Field label={t('boards.renameLabel')} value={name} placeholder={board.personal ? t('boards.personalName') : undefined} maxLength={80} disabled={board.role !== 'owner'} onChange={event => setName(event.target.value)} />
      {board.role === 'owner' && <div className="button-row is-start"><button className="button" disabled={busy || !board.personal && !name.trim()}>{t('account.save')}</button></div>}
    </form><ErrorLine error={error} />
    {!board.personal && <div className="settings-danger"><p>{t(board.role === 'owner' ? 'boards.deleteText' : 'boardSettings.leaveText')}</p><button className="button danger" onClick={() => board.role === 'owner' ? setDeleting(true) : void leave()}>{t(board.role === 'owner' ? 'boards.delete' : 'boardSettings.leave')}</button></div>}
    {deleting && <DeleteBoard board={board} onClose={() => {setDeleting(false); rereadSession();}} />}
  </div>;
}

export function Settings({user, board, boards, local, trustedKeys, refresh, onAppState}: {
  user: User; board: Board | null; boards: Board[]; local: boolean; trustedKeys: Session['trustedKeys'];
  refresh: () => Promise<void>; onAppState: (state: AppState) => void;
}) {
  const address = useLocation(), path = address.split('?')[0], appState = useApp();
  const boardPath = path.match(/^\/boards\/([^/]+)\/settings(?:\/([^/]+))?$/);
  const capabilities = settingsSections(local, inApp());
  const sections = PERSONAL.filter(item => item.id === 'profile' ? !local : item.id === 'application' ? capabilities.includes('app') || capabilities.includes('measuring') : true);
  const first = local ? inApp() ? 'application' : 'interface' : 'profile';
  const section = boardPath ? boardPath[2] ?? 'general' : path.split('/')[2] ?? first;
  const base = boardPath ? '/boards/' + boardPath[1] + '/settings' : '/settings';
  useEffect(() => {
    if (path === base) navigate(settingsHref(base + '/' + section, board?.id), true);
  }, [path, base, section, board?.id]);
  if (boardPath && (local || board?.id !== boardPath[1])) return <main><section className="panel settings-content"><ErrorLine error={null} /><p>{t('settings.unavailable')}</p></section></main>;
  const visible = boardPath ? (board?.personal ? BOARD.slice(0, 1) : BOARD) : sections;
  return <SettingsFrame title={boardPath ? t('boardSettings.forBoard', {board: boardTitle(board!)}) : t('header.settings')} sections={visible} section={section} base={base} board={board}>
    {boardPath ? section === 'general' ? <General board={board!} /> : section === 'members' ? <MembersTab board={board!} userId={user.id} /> : <SharesTab board={board!} /> :
      section === 'profile' ? <><Profile user={user} onChanged={refresh} /><Password /></> :
      section === 'connections' ? <ConnectionsPage userId={user.id} boards={boards} trustedKeys={trustedKeys} /> :
      section === 'devices' ? <><h2>{t('connections.device')}</h2><ul className="connections-list"><Devices local={local} /></ul>{!local && <ConnectDevice />}</> :
      section === 'projects' ? <Projects /> : section === 'interface' ? <><p className="dialog-text">{t('settings.browserScope')}</p><Browser title={t('settings.interface')} /></> :
      section === 'application' && appState ? <>{capabilities.includes('measuring') && <Measuring state={appState} onState={onAppState} />}{capabilities.includes('app') && <AppSection state={appState} onState={onAppState} />}</> : null}
  </SettingsFrame>;
}
