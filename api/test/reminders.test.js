import test from 'node:test';
import assert from 'node:assert/strict';
import { reminderEventForTask } from '../src/reminders.js';

const now = Date.parse('2026-08-26T10:00:00.000Z');
const task = (minutes, reminderHistory = []) => ({
  status: 'IN_REVIEW', assignedAt: new Date(now - minutes * 60_000).toISOString(), reminderHistory,
});

test('first reviewer reminder becomes due at 15 minutes', () => {
  assert.equal(reminderEventForTask(task(14), now), null);
  assert.deepEqual(reminderEventForTask(task(15), now), { type: 'FIRST_REMINDER', elapsedMinutes: 15, notifySales: false });
});

test('sales escalation starts at 30 minutes after the first reminder', () => {
  const history = [{ type: 'FIRST_REMINDER' }];
  assert.equal(reminderEventForTask(task(29, history), now), null);
  assert.deepEqual(reminderEventForTask(task(30, history), now), { type: 'MANAGER_ESCALATION', elapsedMinutes: 30, notifySales: true });
});

test('sales receives only one escalation for a task', () => {
  const history = [{ type: 'FIRST_REMINDER' }, { type: 'MANAGER_ESCALATION' }];
  assert.equal(reminderEventForTask(task(45, history), now), null);
  assert.equal(reminderEventForTask(task(600, history), now), null);
});

test('legacy bucketed escalation also suppresses future notifications', () => {
  const history = [{ type: 'FIRST_REMINDER' }, { type: 'MANAGER_ESCALATION_4' }];
  assert.equal(reminderEventForTask(task(600, history), now), null);
});
