import test from 'node:test';
import assert from 'node:assert/strict';
import { addStage, buildAnalytics, chooseExpert, ensureTaskShape, estimateWaitMinutes, taskTiming } from '../src/workflow.js';

const at = (minutes) => new Date(Date.UTC(2026, 7, 26, 10, minutes)).toISOString();

test('task timing separates generation, queue and expert review', () => {
  const task = ensureTaskShape({ id: 'review_1', status: 'DELIVERED', priority: 'NORMAL', createdAt: at(0), generationStartedAt: at(0), generationCompletedAt: at(5), reviewStartedAt: at(20), deliveredAt: at(35) });
  const timing = taskTiming(task, at(59));
  assert.equal(timing.generationMinutes, 5);
  assert.equal(timing.queueMinutes, 15);
  assert.equal(timing.reviewMinutes, 15);
  assert.equal(timing.totalMinutes, 35);
  assert.equal(timing.elapsedMinutes, 35, 'completed SLA must not grow after delivery');
  assert.equal(timing.slaState, 'OK');
});

test('SLA states cover risk and breach boundaries', () => {
  const base = { id: 'review_2', status: 'WAITING_REVIEW', priority: 'NORMAL', slaMinutes: 120, createdAt: at(0) };
  assert.equal(taskTiming({ ...base }, at(89)).slaState, 'OK');
  assert.equal(taskTiming({ ...base }, at(90)).slaState, 'RISK');
  assert.equal(taskTiming({ ...base }, at(120)).slaState, 'BREACHED');
});

test('stage history captures traceable workflow milestones', () => {
  const task = { id: 'review_3', createdAt: at(0) };
  addStage(task, 'QUESTION_RECEIVED', { at: at(0), actorId: 'usr_requester' });
  addStage(task, 'AI_STARTED', { at: at(1) });
  assert.match(task.traceId, /^trace_/);
  assert.deepEqual(task.stageHistory.map((item) => item.stage), ['QUESTION_RECEIVED', 'AI_STARTED']);
  assert.equal(task.receivedAt, at(0));
  assert.equal(task.generationStartedAt, at(1));
});

test('expert routing prefers matching available expert with lower workload', () => {
  const data = {
    users: [
      { id: 'a', role: 'EXPERT', isActive: true, expertStatus: 'AVAILABLE', products: ['Продукт B'] },
      { id: 'b', role: 'EXPERT', isActive: true, expertStatus: 'DND', products: ['Продукт B'] },
      { id: 'c', role: 'EXPERT', isActive: true, expertStatus: 'AVAILABLE', products: [] },
    ],
    reviewTasks: [{ id: 'owned', status: 'IN_REVIEW', assignedTo: 'c' }],
  };
  assert.equal(chooseExpert(data, { productName: 'Продукт B' }).id, 'a');
});

test('ETA uses median of completed comparable questions', () => {
  const delivered = [10, 20, 30, 40, 50].map((minutes, index) => ({ id: `done_${index}`, status: 'DELIVERED', priority: 'NORMAL', productName: 'Продукт B', createdAt: at(0), deliveredAt: at(minutes) }));
  assert.equal(estimateWaitMinutes(delivered, { id: 'current', priority: 'NORMAL', productName: 'Продукт B', slaMinutes: 120 }), 30);
});

test('analytics returns percentiles, LLM usage and expert load', () => {
  const tasks = [10, 20, 30, 40, 50].map((minutes, index) => ({ id: `done_${index}`, status: 'DELIVERED', priority: 'NORMAL', createdAt: at(0), deliveredAt: at(minutes), approvedBy: 'expert', assignedTo: 'expert', ragMeta: { metrics: { totalDraftMs: 1000, promptTokens: 100, completionTokens: 50, estimatedCostRub: 0.5 } } }));
  const analytics = buildAnalytics({ reviewTasks: tasks, users: [{ id: 'expert', role: 'EXPERT', firstName: 'Тест', lastName: 'Эксперт', email: 'expert@example.test' }] });
  assert.equal(analytics.sla.medianMinutes, 30);
  assert.equal(analytics.sla.p90Minutes, 46);
  assert.equal(analytics.llm.calls, 5);
  assert.equal(analytics.llm.promptTokens, 500);
  assert.equal(analytics.llm.estimatedCostRub, 2.5);
  assert.equal(analytics.experts[0].completed, 5);
});

test('analytics reset point excludes earlier tasks without deleting them', () => {
  const tasks = [{ id: 'before_reset', status: 'DELIVERED', createdAt: at(0), deliveredAt: at(10) }];
  const analytics = buildAnalytics({ reviewTasks: tasks, users: [], settings: { metricsResetAt: at(20) } });
  assert.equal(tasks.length, 1);
  assert.deepEqual(analytics.totals, { questions: 0, delivered: 0, active: 0, overdue: 0 });
  assert.equal(analytics.sla.withinTargetPercent, 0);
});
