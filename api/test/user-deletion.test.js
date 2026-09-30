import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteUserAccount, findUserRecord } from '../src/user-deletion.js';

const createData = () => ({
  users: [
    { id: 'usr_admin', firstName: 'Анна', lastName: 'Администратор', email: 'admin@example.test', role: 'ADMIN', isActive: true, passwordHash: 'hash', createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'usr_expert', firstName: 'Елена', lastName: 'Эксперт', email: 'expert@example.test', role: 'EXPERT', isActive: true, passwordHash: 'hash', createdAt: '2026-08-02T00:00:00.000Z' },
  ],
  reviewTasks: [
    { id: 'review_1', status: 'IN_REVIEW', assignedTo: 'usr_expert', assignedAt: '2026-08-25T08:00:00.000Z', updatedAt: '2026-08-25T08:00:00.000Z' },
    { id: 'review_2', status: 'DELIVERED', assignedTo: 'usr_expert', assignedAt: '2026-08-24T08:00:00.000Z', updatedAt: '2026-08-24T09:00:00.000Z' },
  ],
  notifications: [
    { id: 'notice_1', userId: 'usr_expert' },
    { id: 'notice_2', userId: 'usr_admin' },
  ],
  settings: { faq: [], reminderMinutes: 120 },
});

test('deleting a user removes the account but preserves a historical identity snapshot', () => {
  const data = createData();
  const result = deleteUserAccount(data, 'usr_expert', '2026-08-25T10:00:00.000Z');

  assert.equal(result.user.email, 'expert@example.test');
  assert.equal(data.users.some((user) => user.id === 'usr_expert'), false);
  assert.equal(findUserRecord(data, 'usr_expert').deletedAt, '2026-08-25T10:00:00.000Z');
  assert.equal(Object.hasOwn(findUserRecord(data, 'usr_expert'), 'passwordHash'), false);
  assert.deepEqual(data.notifications.map((notice) => notice.id), ['notice_2']);
});

test('deleting an assigned expert releases active work without changing delivered history', () => {
  const data = createData();
  const result = deleteUserAccount(data, 'usr_expert', '2026-08-25T10:00:00.000Z');

  assert.deepEqual(result.releasedTaskIds, ['review_1']);
  assert.equal(data.reviewTasks[0].status, 'WAITING_REVIEW');
  assert.equal(data.reviewTasks[0].assignedTo, null);
  assert.match(data.reviewTasks[0].returnComment, /удалён администратором/i);
  assert.equal(data.reviewTasks[1].status, 'DELIVERED');
  assert.equal(data.reviewTasks[1].assignedTo, 'usr_expert');
});

test('deleting an unknown user does not mutate collections', () => {
  const data = createData();
  const before = structuredClone(data);
  assert.equal(deleteUserAccount(data, 'usr_missing'), null);
  assert.deepEqual(data, before);
});
