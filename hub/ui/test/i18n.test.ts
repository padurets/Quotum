import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LOCALES, rich, setLocale, t, type Locale, type Message} from '../i18n';
import {en} from '../i18n/en';

const placeholders = (message: Message) =>
  [...new Set((typeof message === 'string' ? [message] : Object.values(message)).flatMap(text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1])))].sort();

for (const [code, {catalog}] of Object.entries(LOCALES) as [Locale, (typeof LOCALES)[Locale]][]) {
  test(`${code}: translates every key, with the same placeholders`, () => {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort());
    for (const [key, message] of Object.entries(catalog)) {
      assert.deepEqual(placeholders(message), placeholders(en[key as keyof typeof en]), key);
      for (const text of typeof message === 'string' ? [message] : Object.values(message)) assert.ok(text.trim(), `${key} is empty`);
    }
  });

  test(`${code}: plural messages have every form the language needs`, () => {
    const needed = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const [key, message] of Object.entries(catalog)) {
      if (typeof message === 'string') continue;
      for (const form of needed) assert.ok(message[form], `${key} lacks "${form}"`);
    }
  });
}

test('messages fill placeholders and pick plural forms of the current language', () => {
  setLocale('ru');
  assert.deepEqual([1, 2, 5, 21].map(count => t('history.days', {count})), ['1 день', '2 дня', '5 дней', '21 день']);
  assert.equal(t('limit.resetsIn', {time: '2 ч'}), 'сброс через 2 ч');
  setLocale('en');
  assert.deepEqual([1, 7].map(count => t('history.days', {count})), ['1 day', '7 days']);
  assert.equal(t('limit.resetsIn'), 'resets in {time}', 'a missing parameter stays visible');
  const nodes = rich('device.enterCode', {command: 'CODE'});
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0], 'Enter the code shown by ');
});
