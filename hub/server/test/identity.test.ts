import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {googleSubject} from '../identity/google.js';

const start = 1_800_000_000_000;

test('a verified Google subject survives token rotation; invalid or expired tokens yield no identity', () => {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const key = {...publicKey.export({format: 'jwk'}), kid: 'test-key'};
  const make = (iat: number, sub = 'subject-one', exp = start / 1000 + 3600) => {
    const head = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'test-key'})).toString('base64url');
    const body = Buffer.from(JSON.stringify({iss: 'https://accounts.google.com', aud: 'local-cli', sub, iat, exp})).toString('base64url');
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };

  const first = googleSubject(make(start / 1000 - 120), [key], start);
  assert.ok(first);
  assert.equal(googleSubject(make(start / 1000 - 10), [key], start), first, 'rotation keeps the account');
  assert.notEqual(googleSubject(make(start / 1000 - 10, 'different'), [key], start), first);
  assert.equal(googleSubject(make(start / 1000 - 120, 'subject-one', start / 1000 - 1), [key], start), null);
  assert.equal(googleSubject(make(start / 1000 - 120).replace(/.$/, '!'), [key], start), null);
});
