/** A checked subset of the UI catalogs for native delivery; no second translation table. */
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function prepareText(here, hub) {
  const result = {};
  for (const language of ['en', 'ru']) {
    const module = await import(pathToFileURL(path.join(hub, `ui/i18n/${language}.ts`)));
    result[language] = Object.fromEntries(Object.entries(module[language]).filter(([key]) => (key.startsWith('desktop.') && !['desktop.total', 'desktop.working'].includes(key)) || key.startsWith('kind.')));
  }
  const parameters = value => [...value.matchAll(/\{\w+\}/g)].map(m => m[0]).sort().join(',');
  for (const [key, value] of Object.entries(result.en)) {
    if (typeof value !== 'string' || typeof result.ru[key] !== 'string' || parameters(value) !== parameters(result.ru[key])) throw new Error(`invalid native translation: ${key}`);
  }
  mkdirSync(path.join(here, 'resources'), {recursive: true});
  writeFileSync(path.join(here, 'resources/desktop-i18n.json'), JSON.stringify(result));
}
