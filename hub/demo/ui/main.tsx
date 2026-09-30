import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../../ui/style.css';
import {AppSection} from '../../ui/components/Desktop';
import {LOCALES, setLocale, t, useLocale} from '../../ui/i18n';
import type {AppState} from '../../ui/lib/app';
import {KEY_STORAGE} from '../key-storage';

type Scene = keyof typeof KEY_STORAGE;
const query = new URLSearchParams(location.search);
const initial = Object.hasOwn(KEY_STORAGE, query.get('state') ?? '') ? query.get('state') as Scene : 'keystore';
setLocale(query.get('lang') === 'ru' ? 'ru' : 'en');
const fixture = (scene: Scene, seq = 1): AppState => ({seq, agent: {state:'idle'}, providers:[], sessions:false, autostart:false, configPath:'', logPath:'', version:'demo', commit:'demo', secretKey:{...KEY_STORAGE[scene]}});

function Demo() {
  const locale = useLocale();
  const [scene, setScene] = useState<Scene>(initial);
  const [state, setState] = useState<AppState>(() => fixture(initial));
  // This entry runs only on the isolated demo server; it never calls a native bridge.
  Object.assign(globalThis, {__QUOTUM__: {invoke: async (command: string, args?: Record<string, unknown>) => {
    if (command === 'reset_secret_key') { const next = fixture('file', state.seq + 1); next.secretKey!.outcome = 'created'; setState(next); return next; }
    if (command === 'set_autostart') { const next = {...state, seq:state.seq + 1, autostart: !!args?.on}; setState(next); return next; }
    if (command === 'app_state') return state;
    if (command === 'quit') return null;
    throw new Error('unknown_demo_command');
  }}});
  const choose = (scene: Scene) => { setScene(scene); setState(fixture(scene, state.seq + 1)); };
  return <main className="auth">
    <div className="panel" style={{width:'min(620px, 100%)', padding:20}}>
      <h2>{t('trustedKeys.demoTitle')}</h2>
      <div className="button-row is-start">
        <select aria-label={t('trustedKeys.demoState')} value={scene} onChange={event => choose(event.target.value as Scene)}>{(Object.keys(KEY_STORAGE) as Scene[]).map(key => <option key={key} value={key}>{t(`trustedKeys.scene.${key}`)}</option>)}</select>
        <select aria-label={t('common.language')} value={locale} onChange={event => setLocale(event.target.value === 'ru' ? 'ru' : 'en')}>{Object.entries(LOCALES).map(([id, option]) => <option key={id} value={id}>{option.name}</option>)}</select>
      </div>
      <AppSection state={state} onState={setState}/>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
