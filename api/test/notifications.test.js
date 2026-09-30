import test from 'node:test';
import assert from 'node:assert/strict';
import { markAllNotificationsRead } from '../src/notifications.js';

test('marks every unread notification of the current user as read', () => {
  const notifications = [
    { id: 'notice_1', userId: 'usr_current', isRead: false },
    { id: 'notice_2', userId: 'usr_current', isRead: true },
    { id: 'notice_3', userId: 'usr_other', isRead: false },
  ];

  assert.equal(markAllNotificationsRead(notifications, 'usr_current'), 1);
  assert.equal(notifications[0].isRead, true);
  assert.equal(notifications[1].isRead, true);
  assert.equal(notifications[2].isRead, false);
});

test('is idempotent when the user has no unread notifications', () => {
  const notifications = [{ id: 'notice_1', userId: 'usr_current', isRead: true }];

  assert.equal(markAllNotificationsRead(notifications, 'usr_current'), 0);
  assert.equal(notifications[0].isRead, true);
});
