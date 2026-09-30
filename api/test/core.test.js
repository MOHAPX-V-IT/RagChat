import test from 'node:test';
import assert from 'node:assert/strict';
import { id } from '../src/ids.js';
import { publicUser } from '../src/store.js';

test('generated identifiers preserve entity prefix and remain unique', () => {
  const first = id('review');
  const second = id('review');
  assert.match(first, /^review_[a-f0-9]{18}$/);
  assert.notEqual(first, second);
});

test('public user payload never contains a password hash', () => {
  const result = publicUser({
    id: 'usr_test', email: 'test@ragchat.local', role: 'REQUESTER',
    firstName: 'Тест', lastName: 'Пользователь', passwordHash: 'sensitive-hash', webPushSubscriptions: [{ endpoint: 'sensitive-endpoint' }],
  });
  assert.equal(result.email, 'test@ragchat.local');
  assert.equal(Object.hasOwn(result, 'passwordHash'), false);
  assert.equal(Object.hasOwn(result, 'webPushSubscriptions'), false);
});
