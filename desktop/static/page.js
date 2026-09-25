// The app's own pages: "Starting…" (index.html) and "Error" (error.html), in the
// language of the system. The one thing they can ask of the app is to quit.
const ru = (navigator.language || '').toLowerCase().startsWith('ru');
const words = ru
  ? {
      starting: 'Quotum запускается…',
      startingText: 'Доска откроется через несколько секунд.',
      quitting: 'Quotum закрывается…',
      error: 'Доска Quotum не запустилась',
      errorText: 'Приложение пробовало несколько раз. Что случилось, записано в журнале:',
      quit: 'Выйти из Quotum',
    }
  : {
      starting: 'Quotum is starting…',
      startingText: 'The board opens in a few seconds.',
      quitting: 'Quotum is quitting…',
      error: 'The Quotum board did not start',
      errorText: 'The app tried several times. What happened is in its log:',
      quit: 'Quit Quotum',
    };
document.documentElement.lang = ru ? 'ru' : 'en';
const quitting = location.hash === '#quit';
for (const element of document.querySelectorAll('[data-text]')) {
  const key = quitting && element.dataset.text === 'starting' ? 'quitting' : element.dataset.text;
  element.textContent = words[key];
}
document.title = document.querySelector('h1').textContent;
const log = new URLSearchParams(location.search).get('log');
const where = document.getElementById('log');
if (where) where.textContent = log || 'hub.log';
if (quitting) for (const element of document.querySelectorAll('.not-quitting')) element.hidden = true;
document.getElementById('quit').addEventListener('click', () => window.__TAURI__?.core.invoke('quit'));
