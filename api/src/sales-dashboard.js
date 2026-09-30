import { taskTiming } from './workflow.js';
import { statisticsResetTimestamp } from './statistics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const average = (values) => values.length
  ? Math.round(values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length * 10) / 10
  : 0;

const fullName = (user) => user ? `${user.firstName} ${user.lastName}` : 'Сотрудник не найден';

export function latestManualReminder(task) {
  return [...(task.reminderHistory || [])]
    .filter((item) => item.type === 'MANUAL_MANAGER_REMINDER')
    .sort((left, right) => new Date(right.at) - new Date(left.at))[0] || null;
}

export function manualReminderBlock(task, now = Date.now(), minimumMinutes = 15, cooldownMinutes = 5) {
  if (!task || task.status !== 'IN_REVIEW' || !task.assignedAt || !task.assignedTo) {
    return { status: 409, error: 'Напоминание доступно только для вопроса, который находится у эксперта в работе.' };
  }
  const elapsedMinutes = Math.floor((now - new Date(task.assignedAt).getTime()) / MINUTE_MS);
  if (elapsedMinutes < minimumMinutes) {
    return { status: 409, error: `Напоминание станет доступно через ${minimumMinutes - elapsedMinutes} мин.` };
  }
  const latest = latestManualReminder(task);
  if (latest) {
    const passedMinutes = Math.floor((now - new Date(latest.at).getTime()) / MINUTE_MS);
    if (passedMinutes < cooldownMinutes) {
      return { status: 429, error: `Эксперту уже напоминали. Повторите через ${cooldownMinutes - passedMinutes} мин.` };
    }
  }
  return null;
}

export function buildSalesDashboard(data, now = Date.now(), periodDays = 7) {
  const periodStart = Math.max(now - periodDays * DAY_MS, statisticsResetTimestamp(data));
  const tasks = data.reviewTasks.filter((task) => new Date(task.createdAt).getTime() >= periodStart).map((task) => ({ ...task }));
  const periodTasks = tasks.filter((task) => new Date(task.createdAt).getTime() >= periodStart);
  const delivered = periodTasks.filter((task) => task.status === 'DELIVERED');
  const deliveredTimings = delivered.map((task) => taskTiming({ ...task })).filter((timing) => timing.totalMinutes != null);
  const rated = data.messages.filter((message) => message.rating && new Date(message.ratedAt || message.createdAt).getTime() >= periodStart);
  const positiveRatings = rated.filter((message) => message.rating === 'UP').length;
  const activeStatuses = new Set(['GENERATING', 'WAITING_REVIEW', 'IN_REVIEW', 'DISCUSSION']);

  const attention = tasks
    .filter((task) => task.status === 'IN_REVIEW' && task.assignedAt && task.assignedTo)
    .map((task) => {
      const elapsedMinutes = Math.max(0, Math.floor((now - new Date(task.assignedAt).getTime()) / MINUTE_MS));
      const representative = data.users.find((user) => user.id === task.representativeId);
      const assignedExpert = data.users.find((user) => user.id === task.assignedTo);
      const conversation = data.conversations.find((item) => item.id === task.conversationId);
      const question = data.messages.find((message) => message.id === task.questionMessageId)?.content || '';
      const lastReminder = latestManualReminder(task);
      return {
        id: task.id,
        title: conversation?.title || 'Вопрос без названия',
        question,
        reviewPool: task.reviewPool || 'GENERAL',
        priority: task.priority || 'NORMAL',
        representative: representative ? { id: representative.id, name: fullName(representative) } : null,
        assignedExpert: assignedExpert ? { id: assignedExpert.id, name: fullName(assignedExpert), role: assignedExpert.role } : null,
        elapsedMinutes,
        isOverdue: elapsedMinutes >= 30,
        canRemind: elapsedMinutes >= 15 && (!lastReminder || now - new Date(lastReminder.at).getTime() >= 5 * MINUTE_MS),
        lastReminderAt: lastReminder?.at || null,
      };
    })
    .filter((task) => task.elapsedMinutes >= 15)
    .sort((left, right) => right.elapsedMinutes - left.elapsedMinutes);

  const representatives = data.users
    .filter((user) => user.isActive && user.role === 'REQUESTER')
    .map((user) => {
      const owned = periodTasks.filter((task) => task.representativeId === user.id);
      return {
        id: user.id,
        name: fullName(user),
        questions: owned.length,
        delivered: owned.filter((task) => task.status === 'DELIVERED').length,
        active: tasks.filter((task) => task.representativeId === user.id && activeStatuses.has(task.status)).length,
      };
    })
    .sort((left, right) => right.questions - left.questions || left.name.localeCompare(right.name, 'ru'));

  const experts = data.users
    .filter((user) => user.isActive && ['EXPERT', 'SPECIALIST'].includes(user.role))
    .map((user) => {
      const completed = delivered.filter((task) => task.approvedBy === user.id);
      const reviewMinutes = completed.map((task) => taskTiming({ ...task }).reviewMinutes).filter((value) => value != null);
      const current = tasks.filter((task) => task.assignedTo === user.id && task.status === 'IN_REVIEW');
      return {
        id: user.id,
        name: fullName(user),
        role: user.role,
        status: user.expertStatus || 'AVAILABLE',
        workload: current.length,
        overdue: current.filter((task) => now - new Date(task.assignedAt).getTime() >= 30 * MINUTE_MS).length,
        completed: completed.length,
        averageReviewMinutes: average(reviewMinutes),
      };
    })
    .sort((left, right) => right.overdue - left.overdue || right.workload - left.workload || left.name.localeCompare(right.name, 'ru'));

  return {
    generatedAt: new Date(now).toISOString(),
    periodDays,
    summary: {
      questions: periodTasks.length,
      delivered: delivered.length,
      active: periodTasks.filter((task) => activeStatuses.has(task.status)).length,
      overdue: attention.filter((task) => task.isOverdue).length,
      attention: attention.length,
      averageResponseMinutes: average(deliveredTimings.map((timing) => timing.totalMinutes)),
      withinSlaPercent: delivered.length ? Math.round(deliveredTimings.filter((timing) => timing.slaState !== 'BREACHED').length / delivered.length * 100) : 0,
      positiveRatingPercent: rated.length ? Math.round(positiveRatings / rated.length * 100) : 0,
      ratings: rated.length,
    },
    attention,
    representatives,
    experts,
  };
}
