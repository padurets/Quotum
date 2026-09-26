/**
 * Runs with the browser preferring these languages, whatever the machine running the tests
 * prefers: its region decides how a date and a clock read (en-AU writes "9:24 pm").
 */
export function preferring<T>(tags: string[], run: () => T): T {
  const own = Object.getOwnPropertyDescriptor(navigator, 'languages');
  Object.defineProperty(navigator, 'languages', {value: tags, configurable: true});
  try {
    return run();
  } finally {
    if (own) Object.defineProperty(navigator, 'languages', own);
    else delete (navigator as {languages?: readonly string[]}).languages;
  }
}
