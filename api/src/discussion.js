import { hasPermission } from './capabilities.js';

export const discussionRoles = ['EXPERT', 'SPECIALIST', 'ADMIN'];
export const discussionVisible = (user, task) => Boolean(task?.discussion) && hasPermission(user, 'reviews.view') && discussionRoles.includes(user.role);
export const tally = (discussion) => ({
  yes: (discussion?.votes || []).filter((v) => v.value === 'YES').length,
  no: (discussion?.votes || []).filter((v) => v.value === 'NO').length,
});

export function propose(task, user, answer, now = Date.now()) {
  if (!answer?.trim() || answer.trim().length < 3) throw new Error('Введите текст ответа.');
  if (task.discussion) archiveDiscussion(task, 'REPLACED', now);
  task.discussion = {
    version: (task.discussionHistory?.length || 0) + 1,
    proposedBy: user.id, proposedName: `${user.firstName} ${user.lastName}`,
    proposedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    answer: answer.trim(), edited: Boolean(task.discussionHistory?.some((d) => d.edited)) || answer.trim() !== task.aiDraft?.trim(), votes: [],
  };
  task.status = 'DISCUSSION';
  task.updatedAt = new Date(now).toISOString();
  task.finalAnswer = null;
  task.returnTo = null;
  return task.discussion;
}

export function archiveDiscussion(task, reason, now = Date.now()) {
  if (!task.discussion) return;
  task.discussionHistory ||= [];
  task.discussionHistory.push({ ...structuredClone(task.discussion), endedAt: new Date(now).toISOString(), reason });
  task.discussion = null;
}

export function voteBlock(user, task, version, now = Date.now()) {
  if (task?.status !== 'DISCUSSION' || !task.discussion) return 'Ответ уже отправлен или снят с обсуждения.';
  if (!discussionRoles.includes(user.role) || !hasPermission(user, 'reviews.manage')) return 'Нет права голосовать.';
  if (task.representativeId === user.id || task.discussion.proposedBy === user.id) return 'Нельзя голосовать за собственный вопрос или предложенный вами ответ.';
  if (task.discussion.version !== version) return 'Версия ответа изменилась. Обновите вопрос.';
  if (now >= Date.parse(task.discussion.deadlineAt)) return '24 часа голосования истекли. Обсуждение продолжается в комментариях.';
  return null;
}

export function recordVote(task, user, value, now = Date.now()) {
  task.discussion.votes = task.discussion.votes.filter((v) => v.userId !== user.id);
  task.discussion.votes.push({ userId: user.id, name: `${user.firstName} ${user.lastName}`, value, at: new Date(now).toISOString() });
  task.updatedAt = new Date(now).toISOString();
}

export function deliveryBlock(task, user, version, automatic = false, now = Date.now()) {
  if (task?.status !== 'DISCUSSION' || !task.discussion || task.discussion.version !== version) return 'unavailable';
  if (automatic) {
    const { yes, no } = tally(task.discussion);
    return now >= Date.parse(task.discussion.deadlineAt) && yes > no ? null : 'unavailable';
  }
  if (!hasPermission(user, 'reviews.manage')) return 'scope';
  if (user.role !== 'ADMIN' && task.discussion.proposedBy !== user.id) return 'owner';
  if (user.role !== 'ADMIN' && task.representativeId === user.id) return 'scope';
  return null;
}

export function pinnedOrder(userId, sort = 'desc') {
  return (a, b) => Number(b.status === 'WAITING_REVIEW' && b.returnTo === userId)
    - Number(a.status === 'WAITING_REVIEW' && a.returnTo === userId)
    || (sort === 'asc' ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
