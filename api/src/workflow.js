import { id } from './ids.js';
import { statisticsResetTimestamp } from './statistics.js';

export const PRIORITIES = {
  NORMAL: { label: 'Обычный', slaMinutes: 120, weight: 1 },
  URGENT: { label: 'Срочный', slaMinutes: 60, weight: 2 },
  CRITICAL: { label: 'Критический', slaMinutes: 30, weight: 3 },
};

export const EXPERT_STATUSES = new Set(['AVAILABLE', 'BUSY', 'DND']);

const percentile = (values, value) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * value;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Math.round(sorted[lower]);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
};

const durationMinutes = (from, to) => {
  if (!from || !to) return null;
  const value = (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
};

export function addStage(task, stage, { at = new Date().toISOString(), actorId = 'system', meta = {} } = {}) {
  task.traceId ||= id('trace');
  task.stageHistory ||= [];
  task.stageHistory.push({ id: id('stage'), stage, at, actorId, meta });
  if (stage === 'QUESTION_RECEIVED') task.receivedAt ||= at;
  if (stage === 'AI_STARTED') task.generationStartedAt = at;
  if (stage === 'AI_READY' || stage === 'AI_DEGRADED') task.generationCompletedAt = at;
  if (stage === 'REVIEW_STARTED') task.reviewStartedAt = at;
  if (stage === 'ANSWER_DELIVERED') task.deliveredAt = at;
  return task;
}

export function ensureTaskShape(task) {
  task.traceId ||= `legacy-${task.id}`;
  task.priority ||= 'NORMAL';
  task.productName ||= task.ragMeta?.productName || null;
  task.specialty ||= null;
  task.stageHistory ||= [];
  task.internalComments ||= [];
  task.transferHistory ||= [];
  task.responseVersions ||= [];
  task.retryCount ||= 0;
  task.reviewPool ||= 'GENERAL';
  task.routingConfidence ??= null;
  task.routingReason ||= null;
  task.reminderHistory ||= [];
  task.slaMinutes ||= PRIORITIES[task.priority]?.slaMinutes || PRIORITIES.NORMAL.slaMinutes;
  return task;
}

export function taskTiming(task, now = new Date().toISOString()) {
  ensureTaskShape(task);
  const end = task.deliveredAt || task.approvedAt || (task.status === 'DELIVERED' ? task.updatedAt : now);
  const generation = durationMinutes(task.generationStartedAt || task.createdAt, task.generationCompletedAt);
  const queue = durationMinutes(task.generationCompletedAt || task.createdAt, task.reviewStartedAt || task.assignedAt || (task.status === 'WAITING_REVIEW' ? now : null));
  const review = durationMinutes(task.reviewStartedAt || task.assignedAt, task.discussion?.proposedAt || task.deliveredAt || task.approvedAt || (task.status === 'IN_REVIEW' ? now : null));
  const total = durationMinutes(task.createdAt, end);
  const elapsed = durationMinutes(task.createdAt, task.status === 'DELIVERED' ? end : now) || 0;
  const slaMinutes = task.slaMinutes || PRIORITIES[task.priority]?.slaMinutes || 120;
  return {
    generationMinutes: generation,
    queueMinutes: queue,
    reviewMinutes: review,
    discussionMinutes: durationMinutes(task.discussion?.proposedAt, task.deliveredAt || (task.status === 'DISCUSSION' ? now : null)),
    totalMinutes: total,
    elapsedMinutes: elapsed,
    slaMinutes,
    slaRemainingMinutes: Math.round((slaMinutes - elapsed) * 10) / 10,
    slaState: elapsed >= slaMinutes ? 'BREACHED' : elapsed >= slaMinutes * 0.75 ? 'RISK' : 'OK',
  };
}

export function estimateWaitMinutes(tasks, task) {
  const delivered = tasks.filter((item) => item.status === 'DELIVERED' && item.id !== task.id);
  const sameProduct = delivered.filter((item) => task.productName && item.productName === task.productName);
  const samePriority = delivered.filter((item) => (item.priority || 'NORMAL') === (task.priority || 'NORMAL'));
  const sample = (sameProduct.length >= 5 ? sameProduct : samePriority.length >= 5 ? samePriority : delivered)
    .map((item) => taskTiming(item).totalMinutes)
    .filter((value) => value != null && value > 0);
  if (!sample.length) return task.slaMinutes || PRIORITIES[task.priority]?.slaMinutes || 120;
  return Math.max(1, percentile(sample, 0.5));
}

export function delayReason(task) {
  const timing = taskTiming(task);
  if (timing.slaState !== 'BREACHED') return null;
  if (task.status === 'GENERATING') return task.ragMeta?.degraded ? 'Ошибка ИИ/RAG' : 'Формирование черновика';
  if (task.status === 'WAITING_REVIEW') return task.returnHistory?.length ? 'Повторное ожидание после возврата' : 'Ожидание свободного эксперта';
  if (task.status === 'IN_REVIEW') return 'Длительная экспертная проверка';
  if (task.status === 'DISCUSSION') return Date.now() >= Date.parse(task.discussion?.deadlineAt)
    ? 'Обсуждение: требуется решение автора ответа' : 'Коллективное обсуждение (24 часа)';
  return 'Общее время обработки';
}

export function chooseExpert(data, task) {
  const requiredRole = (task.reviewPool || 'GENERAL') === 'SPECIALIST' ? 'SPECIALIST' : 'EXPERT';
  const experts = data.users.filter((user) => user.isActive && user.role === requiredRole && (user.expertStatus || 'AVAILABLE') !== 'DND');
  const matching = experts.filter((user) => {
    const specialties = user.specialties || [];
    const products = user.products || [];
    return !specialties.length && !products.length
      || (task.specialty && specialties.includes(task.specialty))
      || (task.productName && products.includes(task.productName));
  });
  const candidates = matching.length ? matching : experts;
  return candidates
    .map((user) => ({
      user,
      workload: data.reviewTasks.filter((item) => item.assignedTo === user.id && item.status === 'IN_REVIEW').length,
      busyPenalty: user.expertStatus === 'BUSY' ? 2 : 0,
    }))
    .sort((a, b) => (a.workload + a.busyPenalty) - (b.workload + b.busyPenalty))[0]?.user || null;
}

export function buildAnalytics(data, { dateFrom, dateTo, productName, expertId, representativeId } = {}) {
  let tasks = data.reviewTasks.map((task) => ensureTaskShape({ ...task }));
  const resetAt = statisticsResetTimestamp(data);
  if (resetAt) tasks = tasks.filter((task) => new Date(task.createdAt).getTime() >= resetAt);
  if (dateFrom) tasks = tasks.filter((task) => new Date(task.createdAt) >= new Date(`${dateFrom}T00:00:00`));
  if (dateTo) tasks = tasks.filter((task) => new Date(task.createdAt) <= new Date(`${dateTo}T23:59:59.999`));
  if (productName) tasks = tasks.filter((task) => task.productName === productName);
  if (expertId) tasks = tasks.filter((task) => task.assignedTo === expertId || task.approvedBy === expertId);
  if (representativeId) tasks = tasks.filter((task) => task.representativeId === representativeId);

  const delivered = tasks.filter((task) => task.status === 'DELIVERED');
  const timings = delivered.map(taskTiming);
  const totalValues = timings.map((item) => item.totalMinutes).filter((value) => value != null);
  const stage = (key) => timings.map((item) => item[key]).filter((value) => value != null);
  const llmCalls = tasks.map((task) => task.ragMeta?.metrics).filter(Boolean);
  const sum = (values) => values.reduce((result, value) => result + Number(value || 0), 0);
  const average = (values) => values.length ? Math.round((sum(values) / values.length) * 10) / 10 : 0;
  const experts = data.users.filter((user) => ['EXPERT', 'SPECIALIST', 'MANAGER', 'ADMIN'].includes(user.role)).map((user) => {
    const owned = tasks.filter((task) => task.assignedTo === user.id && task.status === 'IN_REVIEW');
    const completed = delivered.filter((task) => task.approvedBy === user.id);
    const reviewMinutes = completed.map((task) => taskTiming(task).reviewMinutes).filter((value) => value != null);
    return {
      id: user.id,
      name: `${user.firstName} ${user.lastName}`,
      email: user.email,
      role: user.role,
      status: user.expertStatus || 'AVAILABLE',
      workload: owned.length,
      completed: completed.length,
      averageReviewMinutes: average(reviewMinutes),
      specialties: user.specialties || [],
      products: user.products || [],
    };
  });
  const products = [...new Set(tasks.map((task) => task.productName).filter(Boolean))].sort();
  const delayReasons = Object.entries(tasks.map(delayReason).filter(Boolean).reduce((acc, reason) => ({ ...acc, [reason]: (acc[reason] || 0) + 1 }), {}))
    .map(([reason, count]) => ({ reason, count }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      questions: tasks.length,
      delivered: delivered.length,
      active: tasks.filter((task) => ['GENERATING', 'WAITING_REVIEW', 'IN_REVIEW', 'DISCUSSION'].includes(task.status)).length,
      overdue: tasks.filter((task) => taskTiming(task).slaState === 'BREACHED' && task.status !== 'DELIVERED').length,
    },
    sla: {
      averageMinutes: average(totalValues),
      medianMinutes: percentile(totalValues, 0.5),
      p90Minutes: percentile(totalValues, 0.9),
      p95Minutes: percentile(totalValues, 0.95),
      withinTargetPercent: delivered.length ? Math.round(delivered.filter((task) => taskTiming(task).slaState !== 'BREACHED').length / delivered.length * 1000) / 10 : 0,
    },
    stages: {
      generationAverageMinutes: average(stage('generationMinutes')),
      queueAverageMinutes: average(stage('queueMinutes')),
      reviewAverageMinutes: average(stage('reviewMinutes')),
    },
    llm: {
      calls: llmCalls.length,
      averageLatencyMs: average(llmCalls.map((item) => item.totalDraftMs || item.latencyMs)),
      timeouts: tasks.filter((task) => String(task.ragMeta?.error || '').toLowerCase().includes('timeout')).length,
      emptyAnswers: tasks.filter((task) => String(task.ragMeta?.error || '').toLowerCase().includes('пуст')).length,
      retries: sum(tasks.map((task) => task.retryCount || 0)),
      promptTokens: sum(llmCalls.map((item) => item.promptTokens)),
      completionTokens: sum(llmCalls.map((item) => item.completionTokens)),
      estimatedCostRub: Math.round(sum(llmCalls.map((item) => item.estimatedCostRub || 0)) * 100) / 100,
      costConfigured: llmCalls.some((item) => item.estimatedCostRub != null),
    },
    experts,
    products,
    delayReasons,
  };
}
