import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesDashboard, manualReminderBlock } from '../src/sales-dashboard.js';

const now = Date.parse('2026-08-31T12:00:00.000Z');

const data = () => ({
  users: [
    { id: 'rep', firstName: 'Иван', lastName: 'Сотрудник', role: 'REQUESTER', isActive: true },
    { id: 'expert', firstName: 'Анна', lastName: 'Эксперт', role: 'EXPERT', isActive: true, expertStatus: 'BUSY' },
  ],
  conversations: [{ id: 'chat', title: 'Продукт B' }],
  messages: [{ id: 'question', content: 'Как применять?', createdAt: '2026-08-31T11:20:00.000Z' }],
  reviewTasks: [{
    id: 'review', conversationId: 'chat', questionMessageId: 'question', representativeId: 'rep', assignedTo: 'expert',
    status: 'IN_REVIEW', reviewPool: 'GENERAL', assignedAt: '2026-08-31T11:25:00.000Z', createdAt: '2026-08-31T11:20:00.000Z',
    reminderHistory: [],
  }],
});

test('sales dashboard puts delayed assigned work first and aggregates the teams', () => {
  const dashboard = buildSalesDashboard(data(), now);

  assert.equal(dashboard.summary.questions, 1);
  assert.equal(dashboard.summary.attention, 1);
  assert.equal(dashboard.summary.overdue, 1);
  assert.equal(dashboard.attention[0].elapsedMinutes, 35);
  assert.equal(dashboard.attention[0].canRemind, true);
  assert.equal(dashboard.representatives[0].active, 1);
  assert.equal(dashboard.experts[0].overdue, 1);
});

test('manual reminder is delayed for 15 minutes and rate-limited for five minutes', () => {
  const task = data().reviewTasks[0];
  assert.match(manualReminderBlock({ ...task, assignedAt: '2026-08-31T11:50:00.000Z' }, now).error, /через 5 мин/i);
  task.reminderHistory = [{ type: 'MANUAL_MANAGER_REMINDER', at: '2026-08-31T11:58:00.000Z', recipients: ['expert'] }];
  assert.equal(manualReminderBlock(task, now).status, 429);
  assert.equal(manualReminderBlock({ ...task, reminderHistory: [] }, now), null);
});

test('sales dashboard starts from the configured statistics reset point', () => {
  const snapshot = data();
  snapshot.settings = { metricsResetAt: '2026-08-31T12:00:00.000Z' };
  const dashboard = buildSalesDashboard(snapshot, now);
  assert.deepEqual(dashboard.summary, {
    questions: 0, delivered: 0, active: 0, overdue: 0, attention: 0,
    averageResponseMinutes: 0, withinSlaPercent: 0, positiveRatingPercent: 0, ratings: 0,
  });
  assert.equal(dashboard.representatives[0].questions, 0);
  assert.equal(dashboard.experts[0].workload, 0);
});
